package com.pocketserver.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Foreground service that keeps this phone usable as a server.
 *
 * Two servers run:
 *   PocketBase (native arm64 binary) on :8090 -> SQLite, users/auth, collections,
 *                                                admin UI and the static site host.
 *   Express (Capacitor Node runtime) on :8080 -> control panel + file manager.
 *
 * filesDir/sites.json may list more than one site: each gets its own PocketBase on its
 * own port, with its own database, files, backups and log (see SiteRegistry). Without
 * that file there is exactly one site on 8090 in filesDir/pb_data and filesDir/pb_public
 * — the folders every earlier version used — so an update needs no migration.
 *
 * This service holds a partial wake lock, keeps the app process (and therefore the
 * in-process Node runtime) alive, starts and restarts PocketBase, and owns the
 * cloudflared child process. It cannot talk to Express directly, so the panel drives it
 * through files in filesDir:
 *
 *   tunnel.command.json   {action, mode, port}      panel -> service
 *   service.command.json  {action, siteId?}         panel -> service
 *   tunnel.status.json    {state, mode, url, ...}   service -> panel
 *   logs/pocketbase.log, logs/cloudflared.log       service -> panel (diagnostics)
 *
 * Both bundled binaries are shipped as lib*.so inside jniLibs because Android 10+
 * forbids executing files from the app's writable data directory.
 */
public class ServerService extends Service {

    public static final String TAG = "PocketServer";
    public static final String ACTION_STOP = "com.pocketserver.app.STOP";

    static final String CHANNEL_ID = "pocket_server";
    static final int NOTIFICATION_ID = 4242;
    static final int POCKETBASE_PORT = 8090;
    static final int PANEL_PORT = 8080;

    private static final int MAX_RESTARTS = 5;
    private static final int TUNNEL_MAX_ATTEMPTS = 2;
    private static final long MAX_LOG_BYTES = 512 * 1024;
    private static final Pattern TUNNEL_URL = Pattern.compile("(https://[a-z0-9-]+\\.trycloudflare\\.com)");
    /** PocketBase prints http://0.0.0.0:8090/_/#/pbinstall/<jwt> — the token is what matters. */
    private static final Pattern INSTALLER_LINK = Pattern.compile("/_/#/pbinstall/([A-Za-z0-9._-]+)");
    private static final long INSTALLER_TTL_MS = 30L * 60L * 1000L;
    private static final int BACKUPS_KEPT = 7;

    private final AtomicBoolean running = new AtomicBoolean(false);

    /** One PocketBase per site, in the order the registry lists them. */
    private final List<SiteRuntime> sites = new ArrayList<>();
    private volatile Process cloudflared;

    private volatile String tunnelState = "stopped";
    private volatile String tunnelMode = "quick";
    private volatile String tunnelUrl = null;
    private volatile String tunnelMessage = "";
    /** Dashboard master switch: false stops PocketBase and the tunnel but keeps the panel. */
    private volatile boolean serversDesired = true;
    private volatile boolean tunnelStopping = false;
    private volatile boolean tunnelDnsFailure = false;
    private volatile int tunnelAttempt = 0;

    private int lastTunnelPort = PANEL_PORT;

    private Thread commandLoop;
    private PowerManager.WakeLock wakeLock;

    public static void start(Context context) {
        Intent intent = new Intent(context, ServerService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        new File(getFilesDir(), "logs").mkdirs();
        loadSites();

        createChannel();
        startForegroundCompat(buildNotification(notificationText()));
        acquireWakeLock();
        writePowerStatus();

        running.set(true);

        writeTunnelStatus();
        for (SiteRuntime runtime : sites) {
            Thread thread = new Thread(() -> superviseSite(runtime), "pocketbase-" + runtime.site.id);
            thread.setDaemon(true);
            thread.start();
        }

        commandLoop = new Thread(this::watchCommands, "service-commands");
        commandLoop.setDaemon(true);
        commandLoop.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            running.set(false);
            stopTunnelProcess();
            destroySites();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running.set(false);
        stopTunnelProcess();
        destroySites();
        releaseWakeLock();

        tunnelState = "stopped";
        tunnelUrl = null;
        tunnelMessage = "Service stopped.";
        writeTunnelStatus();

        super.onDestroy();
    }

    /* ------------------------------------------------------------------ *
     * Sites
     * ------------------------------------------------------------------ */

    /** One site's process and the two flags that shape its restart loop. */
    private static final class SiteRuntime {
        final SiteRegistry.Site site;
        volatile Process process;
        volatile boolean paused;
        volatile boolean restartRequested;

        SiteRuntime(SiteRegistry.Site site) {
            this.site = site;
        }
    }

    /**
     * Reads filesDir/sites.json once. No file means one site on 8090 out of pb_data and
     * pb_public, exactly as the build before this one ran — nothing is migrated.
     */
    private void loadSites() {
        SiteRegistry registry = SiteRegistry.load(getFilesDir(), POCKETBASE_PORT);
        for (String problem : registry.problems) {
            Log.w(TAG, problem);
            appendLog("pocketbase", "--- registry: " + problem + " ---");
        }
        for (SiteRegistry.Site site : registry.sites) {
            sites.add(new SiteRuntime(site));
            Log.i(TAG, "site " + site.id + " on :" + site.port + " — " + site.dataDir.getAbsolutePath());
        }
        publishSitesStatus();
    }

    /** The panel reads this list; the Windows supervisor writes the same shape. */
    private void publishSitesStatus() {
        JSONObject payload = new JSONObject();
        JSONArray list = new JSONArray();
        try {
            payload.put("at", isoNow(System.currentTimeMillis()));
            for (SiteRuntime runtime : sites) {
                Process process = runtime.process;
                JSONObject entry = new JSONObject();
                entry.put("id", runtime.site.id);
                entry.put("name", runtime.site.name);
                entry.put("port", runtime.site.port);
                entry.put("legacy", runtime.site.legacy);
                entry.put("state", process != null && !runtime.paused
                        ? "running"
                        : serversDesired && !runtime.paused ? "starting" : "stopped");
                entry.put("pid", processPid(process));
                entry.put("pbData", runtime.site.dataDir.getAbsolutePath());
                entry.put("publicDir", runtime.site.publicDir.getAbsolutePath());
                list.put(entry);
            }
            payload.put("sites", list);
        } catch (Exception error) {
            Log.w(TAG, "could not publish the site list", error);
            return;
        }
        writeJson(SiteRegistry.statusFile(getFilesDir()).getName(), payload);
    }

    /**
     * The pid is for the dashboard only. Process.pid() is API 26 and is not in every
     * android.jar this project is compiled against, so it is looked up instead of called.
     */
    private static Object processPid(Process process) {
        if (process == null) return JSONObject.NULL;
        try {
            return Process.class.getMethod("pid").invoke(process);
        } catch (Exception unavailable) {
            return JSONObject.NULL;
        }
    }

    private SiteRuntime siteById(String siteId) {
        String wanted = siteId == null ? "" : siteId.trim();
        if (wanted.isEmpty()) {
            for (SiteRuntime runtime : sites) {
                if (runtime.site.legacy) return runtime;
            }
            return sites.isEmpty() ? null : sites.get(0);
        }
        for (SiteRuntime runtime : sites) {
            if (runtime.site.id.equals(wanted)) return runtime;
        }
        return null;
    }

    private int primaryPort() {
        SiteRuntime runtime = siteById("");
        return runtime == null ? POCKETBASE_PORT : runtime.site.port;
    }

    /* ------------------------------------------------------------------ *
     * PocketBase
     * ------------------------------------------------------------------ */

    /** One thread per site: start it, log it, restart it, stop when told to. */
    private void superviseSite(SiteRuntime runtime) {
        SiteRegistry.Site site = runtime.site;
        int restarts = 0;

        while (running.get() && restarts <= MAX_RESTARTS) {
            // Switched off from the dashboard: stay idle instead of restarting.
            if (!serversDesired) {
                try {
                    Thread.sleep(500);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    break;
                }
                continue;
            }

            File binary = new File(getApplicationInfo().nativeLibraryDir, "libpocketbase.so");
            if (!binary.exists()) {
                Log.e(TAG, "PocketBase binary missing at " + binary.getAbsolutePath());
                updateNotification("PocketBase binary missing from the APK");
                return;
            }

            File dataDir = site.dataDir;
            File publicDir = site.publicDir;
            if (!dataDir.exists() && !dataDir.mkdirs()) {
                Log.e(TAG, "could not create " + dataDir.getAbsolutePath());
                return;
            }
            if (!publicDir.exists() && !publicDir.mkdirs()) {
                Log.e(TAG, "could not create " + publicDir.getAbsolutePath());
                return;
            }

            try {
                ProcessBuilder builder = new ProcessBuilder(site.serveArgs(binary.getAbsolutePath()));
                builder.directory(getFilesDir());
                builder.redirectErrorStream(true);
                builder.environment().put("HOME", getFilesDir().getAbsolutePath());
                builder.environment().put("TMPDIR", getCacheDir().getAbsolutePath());

                runtime.process = builder.start();
                Log.i(TAG, "PocketBase started for " + site.id);
                appendLog(site.logName, "--- started ---");
                publishSitesStatus();
                updateNotification(notificationText());

                try (BufferedReader reader = new BufferedReader(new InputStreamReader(runtime.process.getInputStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        Log.i("PocketBase", line);
                        appendLog(site.logName, line);
                        captureInstallerLink(line, site);
                    }
                }

                int exit = runtime.process.waitFor();
                runtime.process = null;
                publishSitesStatus();
                Log.w(TAG, "PocketBase for " + site.id + " exited with code " + exit);

                if (!running.get()) break;

                // A create-superuser or backup command needs the database to itself, and a
                // switched-off server waits here until the dashboard turns it back on.
                while ((runtime.paused || !serversDesired) && running.get()) {
                    try {
                        Thread.sleep(200);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                if (!running.get()) break;

                if (runtime.restartRequested) {
                    runtime.restartRequested = false;
                    restarts = 0;
                    appendLog(site.logName, "--- restarted from the dashboard ---");
                    continue;
                }

                restarts++;
                updateNotification("Restarting PocketBase (" + restarts + "/" + MAX_RESTARTS + ")");
                Thread.sleep(1500L * restarts);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception error) {
                Log.e(TAG, "PocketBase failed to run", error);
                appendLog(site.logName, "failed: " + error.getMessage());
                restarts++;
                updateNotification("PocketBase failed: " + error.getMessage());
                try {
                    Thread.sleep(2000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
    }

    private void destroySites() {
        for (SiteRuntime runtime : sites) destroySite(runtime);
    }

    private void destroySite(SiteRuntime runtime) {
        Process process = runtime.process;
        if (process == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            process.destroyForcibly();
        } else {
            process.destroy();
        }
    }

    /* ------------------------------------------------------------------ *
     * Command channel
     * ------------------------------------------------------------------ */

    private void watchCommands() {
        File tunnelCommand = new File(getFilesDir(), "tunnel.command.json");
        File serviceCommand = new File(getFilesDir(), "service.command.json");

        while (running.get()) {
            if (tunnelCommand.exists()) {
                JSONObject command = readCommand(tunnelCommand);
                if (command != null) {
                    String action = command.optString("action", "");
                    int port = command.optInt("port", PANEL_PORT);
                    String mode = command.optString("mode", "quick");
                    if ("start".equals(action)) {
                        startTunnel(port, mode);
                    } else if ("stop".equals(action)) {
                        stopTunnel("Stopped from the dashboard.");
                    }
                }
            }

            if (serviceCommand.exists()) {
                JSONObject command = readCommand(serviceCommand);
                if (command != null) {
                    String action = command.optString("action", "");
                    // No siteId means the site that owns the original folders, so an
                    // older dashboard keeps doing exactly what it did before.
                    String siteId = command.optString("siteId", "");
                    if ("restart-pocketbase".equals(action)) {
                        SiteRuntime runtime = siteById(siteId);
                        if (runtime == null) {
                            Log.w(TAG, "restart ignored: there is no site called \"" + siteId + "\"");
                        } else {
                            runtime.restartRequested = true;
                            destroySite(runtime);
                            appendLog(runtime.site.logName, "--- restart requested ---");
                        }
                    } else if ("restart-tunnel".equals(action)) {
                        startTunnel(lastTunnelPort, tunnelMode);
                    } else if ("create-superuser".equals(action)) {
                        createSuperuser(command.optString("email", ""), command.optString("password", ""), siteId);
                    } else if ("backup".equals(action)) {
                        runBackup(siteId);
                    } else if ("stop-servers".equals(action)) {
                        stopServers();
                    } else if ("start-servers".equals(action)) {
                        startServers();
                    }
                }
            }

            try {
                Thread.sleep(1000L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    @Nullable
    private JSONObject readCommand(File file) {
        JSONObject command = null;
        try {
            command = new JSONObject(readFile(file));
        } catch (Exception error) {
            Log.e(TAG, "unreadable command " + file.getName(), error);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
        return command;
    }

    /* ------------------------------------------------------------------ *
     * cloudflared tunnel
     * ------------------------------------------------------------------ */

    private synchronized void startTunnel(int port, String mode) {
        stopTunnelProcess();

        lastTunnelPort = port;
        tunnelMode = "named".equals(mode) ? "named" : "quick";
        tunnelAttempt = 0;
        launchTunnel();
    }

    /**
     * Cloudflared resolves its edge hosts with Go's own resolver, which looks for
     * /etc/resolv.conf. Android has no such file, so Go falls back to a resolver on
     * [::1]:53 — nothing listens there. The log then shows
     * "Failed to refresh DNS local resolver ... read: connection refused" and the tunnel
     * drops every time it re-resolves, which is what a flapping quick tunnel looks like.
     *
     * This binary is a cgo build, so GODEBUG=netdns=cgo makes it call the system
     * getaddrinfo() instead, and that goes through Android's netd like any other app.
     * If the forced resolver still cannot resolve, the tunnel is relaunched once with
     * explicit public resolvers as a second chance.
     */
    private synchronized void launchTunnel() {
        File binary = new File(getApplicationInfo().nativeLibraryDir, "libcloudflared.so");
        if (!binary.exists()) {
            tunnelState = "unavailable";
            tunnelUrl = null;
            tunnelMessage = "This build has no cloudflared binary — install the full APK to use the tunnel.";
            writeTunnelStatus();
            return;
        }

        List<String> command = new ArrayList<>();
        command.add(binary.getAbsolutePath());
        command.add("tunnel");
        command.add("--no-autoupdate");
        command.add("--loglevel");
        command.add("info");
        if (tunnelAttempt > 0) {
            command.add("--dns-resolver-addrs");
            command.add("1.1.1.1:53");
        }

        if ("named".equals(tunnelMode)) {
            String token = readTunnelToken();
            if (token.isEmpty()) {
                tunnelState = "error";
                tunnelMessage = "No Cloudflare tunnel token saved.";
                writeTunnelStatus();
                return;
            }
            command.add("run");
            command.add("--token");
            command.add(token);
        } else {
            command.add("--url");
            command.add("http://127.0.0.1:" + lastTunnelPort);
        }

        ProcessBuilder builder = new ProcessBuilder(command);
        try {
            builder.directory(getFilesDir());
            builder.redirectErrorStream(true);
            builder.environment().put("HOME", getFilesDir().getAbsolutePath());
            builder.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
            builder.environment().put("SSL_CERT_DIR", "/system/etc/security/cacerts");
            builder.environment().put("GODEBUG", withSystemResolver(builder.environment().get("GODEBUG")));

            tunnelStopping = false;
            cloudflared = builder.start();
            tunnelState = "starting";
            tunnelUrl = null;
            tunnelMessage = "named".equals(tunnelMode)
                    ? "Connecting the named tunnel…"
                    : "Waiting for Cloudflare to assign an address…";
            appendLog("cloudflared", "--- started (" + tunnelMode + ", port " + lastTunnelPort
                    + ", resolver " + (tunnelAttempt == 0 ? "system" : "1.1.1.1") + ") ---");
            writeTunnelStatus();
            updateNotification(notificationText());

            Process process = cloudflared;
            Thread reader = new Thread(() -> watchTunnelOutput(process), "cloudflared-log");
            reader.setDaemon(true);
            reader.start();
        } catch (Exception error) {
            Log.e(TAG, "cloudflared failed to start", error);
            tunnelState = "error";
            tunnelUrl = null;
            tunnelMessage = "cloudflared failed to start: " + error.getMessage();
            appendLog("cloudflared", "failed: " + error.getMessage());
            writeTunnelStatus();
        }
    }

    /** Keeps any other GODEBUG settings and forces Go to use the C library resolver. */
    private static String withSystemResolver(String existing) {
        if (existing == null || existing.trim().isEmpty()) return "netdns=cgo";
        if (existing.contains("netdns=")) return existing.replaceAll("netdns=[^,]*", "netdns=cgo");
        return existing + ",netdns=cgo";
    }

    private void watchTunnelOutput(Process process) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                Log.i("Cloudflared", line);
                appendLog("cloudflared", line);

                Matcher matcher = TUNNEL_URL.matcher(line);
                if (matcher.find()) {
                    tunnelUrl = matcher.group(1);
                    tunnelState = "running";
                    tunnelMessage = "Quick tunnel is live.";
                    writeTunnelStatus();
                    updateNotification(notificationText());
                } else if (line.toLowerCase().contains("registered tunnel connection")) {
                    tunnelState = "running";
                    tunnelMessage = "Named tunnel connected — the hostname is configured in Cloudflare.";
                    writeTunnelStatus();
                    updateNotification(notificationText());
                } else if (line.contains("failed to") || line.contains("ERR ")) {
                    tunnelState = "error";
                    tunnelMessage = line.trim();
                    if (isResolverFailure(line)) tunnelDnsFailure = true;
                    writeTunnelStatus();
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "tunnel log closed: " + error.getMessage());
        }

        int exit = -1;
        try {
            exit = process.waitFor();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }

        // A stopped or replaced process must not relaunch anything.
        if (process != cloudflared || tunnelStopping) return;

        if (tunnelDnsFailure && tunnelAttempt + 1 < TUNNEL_MAX_ATTEMPTS) {
            tunnelAttempt += 1;
            appendLog("cloudflared", "--- resolver failed (exit " + exit + "), retrying with explicit resolvers ---");
            launchTunnel();
            return;
        }

        if ("running".equals(tunnelState) || "starting".equals(tunnelState)) {
            tunnelState = "error";
            tunnelUrl = null;
            tunnelMessage = "cloudflared exited (" + exit + ").";
            appendLog("cloudflared", "--- exited " + exit + " ---");
            writeTunnelStatus();
            updateNotification(notificationText());
        }
    }

    private synchronized void stopTunnel(String message) {
        stopTunnelProcess();
        tunnelState = "stopped";
        tunnelUrl = null;
        tunnelMessage = message;
        appendLog("cloudflared", "--- stopped ---");
        writeTunnelStatus();
        updateNotification(notificationText());
    }

    private void stopTunnelProcess() {
        Process process = cloudflared;
        cloudflared = null;
        tunnelStopping = true;
        if (process == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            process.destroyForcibly();
        } else {
            process.destroy();
        }
    }

    /* ------------------------------------------------------------------ *
     * Superuser setup and backups
     * ------------------------------------------------------------------ */

    /**
     * PocketBase 0.23+ dropped "create an account by visiting /_/". At startup it prints
     * http://0.0.0.0:8090/_/#/pbinstall/<jwt> once, and that address does not open on a
     * phone, which is why the dashboard only ever showed a login form. The token is
     * caught here and republished with hosts that work (loopback and the Wi-Fi address).
     */
    private void captureInstallerLink(String line, SiteRegistry.Site site) {
        if (!line.contains("/_/#/pbinstall/")) return;

        Matcher matcher = INSTALLER_LINK.matcher(line);
        if (!matcher.find()) return;

        String token = matcher.group(1);
        String suffix = "/_/#/pbinstall/" + token;
        long now = System.currentTimeMillis();

        try {
            JSONObject payload = new JSONObject();
            payload.put("token", token);
            payload.put("path", suffix);
            payload.put("siteId", site.id);
            payload.put("port", site.port);
            payload.put("url", "http://127.0.0.1:" + site.port + suffix);
            payload.put("lanUrl", "http://" + lanIp() + ":" + site.port + suffix);
            payload.put("createdAt", isoNow(now));
            payload.put("expiresAt", isoNow(now + INSTALLER_TTL_MS));
            writeJson("installer.json", payload);
            appendLog(site.logName, "--- installer link captured (valid 30 minutes) ---");
        } catch (Exception error) {
            Log.w(TAG, "could not publish the installer link", error);
        }
    }

    /** Creates or resets a superuser through the PocketBase CLI, with the DB to itself. */
    private void createSuperuser(String email, String password, String siteId) {
        JSONObject result = new JSONObject();
        SiteRuntime runtime = siteById(siteId);
        String address = email == null ? "" : email.trim();
        try {
            result.put("at", isoNow(System.currentTimeMillis()));
            result.put("email", address);
            result.put("siteId", runtime == null ? siteId : runtime.site.id);
        } catch (Exception ignored) {
            // JSONObject.put only fails on invalid values, which these are not.
        }

        if (address.isEmpty() || !address.contains("@")) {
            finishSuperuser(result, false, "Enter a valid email address.");
            return;
        }
        if (password == null || password.length() < 8) {
            finishSuperuser(result, false, "PocketBase requires a password of at least 8 characters.");
            return;
        }

        if (runtime == null) {
            finishSuperuser(result, false, "There is no site called \"" + siteId + "\".");
            return;
        }

        File binary = new File(getApplicationInfo().nativeLibraryDir, "libpocketbase.so");
        File dataDir = runtime.site.dataDir;

        try {
            pauseSite(runtime);
            ProcessBuilder builder = new ProcessBuilder(
                    binary.getAbsolutePath(),
                    "superuser", "upsert", address, password,
                    "--dir=" + dataDir.getAbsolutePath());
            builder.directory(getFilesDir());
            builder.redirectErrorStream(true);
            builder.environment().put("HOME", getFilesDir().getAbsolutePath());
            builder.environment().put("TMPDIR", getCacheDir().getAbsolutePath());

            Process process = builder.start();
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null && output.length() < 4000) {
                    output.append(line).append('\n');
                }
            }
            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) process.destroyForcibly();
            int exit = finished ? process.exitValue() : -1;
            String text = output.toString().trim().replace(password, "***");

            if (exit == 0) {
                // Once a real account exists the installer token has no purpose.
                //noinspection ResultOfMethodCallIgnored
                clearInstallerFor(runtime.site.id);
                appendLog(runtime.site.logName, "--- superuser saved: " + address + " ---");
                finishSuperuser(result, true, "Superuser saved. Sign in at /_/ with that email and password.");
            } else {
                appendLog(runtime.site.logName, "--- superuser command failed (exit " + exit + ") ---");
                finishSuperuser(result, false, text.isEmpty() ? "PocketBase rejected the account (exit " + exit + ")." : text);
            }
        } catch (Exception error) {
            Log.e(TAG, "create-superuser failed", error);
            finishSuperuser(result, false, "Could not run PocketBase: " + error.getMessage());
        } finally {
            resumeSite(runtime);
        }
    }

    private void finishSuperuser(JSONObject result, boolean ok, String message) {
        try {
            result.put("ok", ok);
            result.put("message", message);
        } catch (Exception ignored) {
            // Nothing actionable: the keys are plain strings and a boolean.
        }
        writeJson("superuser-result.json", result);
    }

    /** Zips one site's pb_data into its pb_public/backups, downloadable from the phone. */
    private void runBackup(String siteId) {
        SiteRuntime runtime = siteById(siteId);
        if (runtime == null) {
            JSONObject missing = new JSONObject();
            try {
                missing.put("ok", false);
                missing.put("siteId", siteId);
                missing.put("error", "There is no site called \"" + siteId + "\".");
                missing.put("at", isoNow(System.currentTimeMillis()));
            } catch (Exception ignored) {
                // Plain string values only.
            }
            writeJson("backup.status.json", missing);
            return;
        }

        SiteRegistry.Site site = runtime.site;
        File dataDir = site.dataDir;
        File backupDir = site.backupDir;
        String name = "pb-" + stamp() + ".zip";
        JSONObject status = new JSONObject();

        try {
            status.put("siteId", site.id);
            status.put("port", site.port);
            if (!backupDir.exists() && !backupDir.mkdirs()) {
                throw new Exception("could not create " + backupDir.getAbsolutePath());
            }

            pauseSite(runtime);

            File part = new File(backupDir, name + ".part");
            long bytes;
            try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(part))) {
                bytes = zipTree(dataDir, dataDir, zip);
            }

            File target = new File(backupDir, name);
            if (!part.renameTo(target)) throw new Exception("could not finalize " + target.getAbsolutePath());

            int kept = pruneBackups(backupDir);
            status.put("ok", true);
            status.put("file", name);
            status.put("bytes", bytes);
            status.put("kept", kept);
            appendLog(site.logName, "--- backup written: " + name + " (" + (bytes / 1024) + " KiB) ---");
        } catch (Exception error) {
            Log.e(TAG, "backup failed", error);
            try {
                status.put("ok", false);
                status.put("error", error.getMessage());
            } catch (Exception ignored) {
                // See above: plain string values only.
            }
            appendLog(site.logName, "--- backup failed: " + error.getMessage() + " ---");
        } finally {
            resumeSite(runtime);
        }

        try {
            status.put("at", isoNow(System.currentTimeMillis()));
        } catch (Exception ignored) {
            // Plain string value.
        }
        writeJson("backup.status.json", status);
    }

    private long zipTree(File root, File dir, ZipOutputStream zip) throws Exception {
        long total = 0;
        File[] children = dir.listFiles();
        if (children == null) return 0;

        for (File child : children) {
            if (child.isDirectory()) {
                total += zipTree(root, child, zip);
                continue;
            }
            String relative = root.toURI().relativize(child.toURI()).getPath();
            zip.putNextEntry(new ZipEntry(relative));
            try (FileInputStream input = new FileInputStream(child)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) > 0) {
                    zip.write(buffer, 0, read);
                    total += read;
                }
            }
            zip.closeEntry();
        }
        return total;
    }

    private int pruneBackups(File dir) {
        File[] files = dir.listFiles((folder, fileName) -> fileName.startsWith("pb-") && fileName.endsWith(".zip"));
        if (files == null) return 0;

        ArrayList<File> sorted = new ArrayList<>();
        Collections.addAll(sorted, files);
        sorted.sort((left, right) -> Long.compare(right.lastModified(), left.lastModified()));

        int kept = 0;
        for (File file : sorted) {
            if (kept < BACKUPS_KEPT) {
                kept += 1;
            } else {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
        return kept;
    }

    /** Stops one site and waits until its process is gone; the other sites keep serving. */
    private void pauseSite(SiteRuntime runtime) {
        runtime.paused = true;
        destroySite(runtime);
        long deadline = System.currentTimeMillis() + 8000;
        while (runtime.process != null && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(100);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        publishSitesStatus();
    }

    private void resumeSite(SiteRuntime runtime) {
        runtime.paused = false;
        runtime.restartRequested = true;
        publishSitesStatus();
    }

    /* ------------------------------------------------------------------ *
     * Master on/off switch
     * ------------------------------------------------------------------ */

    private void stopServers() {
        serversDesired = false;
        stopTunnel("Servers were turned off from the dashboard.");
        destroySites();
        releaseWakeLock();
        for (SiteRuntime runtime : sites) {
            appendLog(runtime.site.logName, "--- servers stopped from the dashboard ---");
        }
        writePowerStatus();
        updateNotification(notificationText());
    }

    private void startServers() {
        serversDesired = true;
        acquireWakeLock();
        // Unblocks every site's supervisor and makes it start its PocketBase again.
        for (SiteRuntime runtime : sites) runtime.restartRequested = true;
        for (SiteRuntime runtime : sites) {
            appendLog(runtime.site.logName, "--- servers started from the dashboard ---");
        }
        writePowerStatus();
        updateNotification(notificationText());
    }

    /** Read by the panel: the service is the source of truth for on/off state. */
    private void writePowerStatus() {
        try {
            JSONObject status = new JSONObject();
            status.put("servers", serversDesired ? "on" : "off");
            status.put("at", isoNow(System.currentTimeMillis()));
            writeJson("power.status.json", status);
        } catch (Exception error) {
            Log.w(TAG, "could not write the power state", error);
        }
    }

    private String lanIp() {
        try {
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback()) continue;
                for (InterfaceAddress address : network.getInterfaceAddresses()) {
                    InetAddress ip = address.getAddress();
                    if (ip instanceof Inet4Address && ip.isSiteLocalAddress()) return ip.getHostAddress();
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "could not read the Wi-Fi address", error);
        }
        return "127.0.0.1";
    }

    private static String isoNow(long millis) {
        java.text.SimpleDateFormat format =
                new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date(millis));
    }

    private static String stamp() {
        java.text.SimpleDateFormat format =
                new java.text.SimpleDateFormat("yyyy-MM-dd-HHmm", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getDefault());
        return format.format(new java.util.Date());
    }

    private void writeJson(String fileName, JSONObject payload) {
        File file = new File(getFilesDir(), fileName);
        File tmp = new File(getFilesDir(), fileName + ".tmp");
        try (FileOutputStream output = new FileOutputStream(tmp)) {
            output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            Log.w(TAG, "could not write " + fileName, error);
            return;
        }
        if (!tmp.renameTo(file)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    /** True for the log lines cloudflared emits when it cannot resolve through Android. */
    private static boolean isResolverFailure(String line) {
        return line.contains("[::1]:53")
                || line.contains("Failed to refresh DNS local resolver")
                || line.contains("could not lookup srv records")
                || line.contains("error looking up Cloudflare edge IPs")
                || line.contains("no such host");
    }

    private String readTunnelToken() {
        try {
            JSONObject settings = new JSONObject(readFile(new File(getFilesDir(), "settings.json")));
            return settings.optString("tunnelToken", "").trim();
        } catch (Exception error) {
            return "";
        }
    }

    private void writeTunnelStatus() {
        try {
            JSONObject status = new JSONObject();
            status.put("state", tunnelState);
            status.put("mode", tunnelMode);
            status.put("url", tunnelUrl == null ? JSONObject.NULL : tunnelUrl);
            status.put("message", tunnelMessage);
            status.put("updatedAt", System.currentTimeMillis());

            File target = new File(getFilesDir(), "tunnel.status.json");
            File tmp = new File(getFilesDir(), "tunnel.status.json.tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(status.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(target)) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                //noinspection ResultOfMethodCallIgnored
                tmp.renameTo(target);
            }
        } catch (Exception error) {
            Log.e(TAG, "could not write tunnel status", error);
        }
    }

    /* ------------------------------------------------------------------ *
     * Logs + helpers
     * ------------------------------------------------------------------ */

    private synchronized void appendLog(String name, String line) {
        File dir = new File(getFilesDir(), "logs");
        if (!dir.exists() && !dir.mkdirs()) return;

        File file = new File(dir, name + ".log");
        if (file.length() > MAX_LOG_BYTES) {
            File old = new File(dir, name + ".log.1");
            //noinspection ResultOfMethodCallIgnored
            old.delete();
            //noinspection ResultOfMethodCallIgnored
            file.renameTo(old);
        }

        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            Log.w(TAG, "could not append log for " + name);
        }
    }

    private static String readFile(File file) throws IOException {
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = in.read(bytes);
            if (read <= 0) throw new IOException("empty file");
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }

    /* ------------------------------------------------------------------ *
     * Wake lock + notification
     * ------------------------------------------------------------------ */

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) return;
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PocketServer::servers");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
        Log.i(TAG, "partial wake lock held");
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Local servers",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps PocketBase, the control panel and the tunnel running");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private String notificationText() {
        if (!serversDesired) return "Servers off — open the dashboard to start them";
        if ("running".equals(tunnelState) && tunnelUrl != null) {
            return "Tunnel live: " + tunnelUrl;
        }
        if ("running".equals(tunnelState)) {
            return "Named tunnel connected";
        }
        if (sites.size() > 1) {
            StringBuilder ports = new StringBuilder();
            for (SiteRuntime runtime : sites) {
                if (ports.length() > 0) ports.append(", :");
                ports.append(runtime.site.port);
            }
            return sites.size() + " sites on :" + ports + " · panel on :" + PANEL_PORT;
        }
        return "PocketBase on :" + primaryPort() + " · panel on :" + PANEL_PORT;
    }

    /** The installer link belongs to one site: clear it only when that site got its account. */
    private void clearInstallerFor(String siteId) {
        File file = new File(getFilesDir(), "installer.json");
        try {
            String owner = new JSONObject(readFile(file)).optString("siteId", "");
            if (!owner.isEmpty() && !owner.equals(siteId)) return;
        } catch (Exception ignored) {
            // No link on disk, or an older one without a siteId: clearing it is safe.
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent openIntent = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stop = new Intent(this, ServerService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(
                this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent battery = new Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getPackageName()));
        PendingIntent batteryIntent = PendingIntent.getActivity(
                this, 2, battery, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("Pocket Server is running")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                .setContentIntent(openIntent)
                .setOngoing(true)
                // The int-based constructor is deprecated but is the only one that does not
                // require an Icon object on every supported API level.
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopIntent).build())
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_lock_idle_charging, "Battery", batteryIntent).build())
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(NOTIFICATION_ID, buildNotification(text));
    }
}
