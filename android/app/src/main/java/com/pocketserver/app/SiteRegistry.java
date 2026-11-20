package com.pocketserver.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The site registry: which PocketBase instances this phone runs, on which ports, and
 * where each one keeps its data.
 *
 * filesDir/sites.json is optional and read once, when the service starts:
 *
 * <pre>
 * { "version": 1, "sites": [
 *     { "id": "default", "name": "Primary", "port": 8090, "legacy": true },
 *     { "id": "second",  "name": "Second site", "port": 8091 } ] }
 * </pre>
 *
 * Without the file the phone runs exactly one site on 8090 out of filesDir/pb_data and
 * filesDir/pb_public — what every build before this one did. Nothing is moved or
 * migrated, so an existing install keeps working as it is. A site flagged "legacy"
 * (or carrying the id "default") keeps those original folders; any other site gets
 * filesDir/sites/&lt;id&gt;/pb_data, .../pb_public and logs/site-&lt;id&gt;.log.
 *
 * A broken entry is reported in {@link #problems} and skipped: the site that is already
 * serving traffic must still start. This class touches no Android API, so it is unit
 * tested on the JVM.
 */
public final class SiteRegistry {

    public static final String LEGACY_ID = "default";
    static final String LEGACY_NAME = "Primary site";
    static final int FIRST_EXTRA_PORT = 8091;
    static final int PANEL_PORT_LOW = 8080;
    static final int PANEL_PORT_HIGH = 8085;

    private static final Pattern ID_PATTERN = Pattern.compile("[a-z0-9][a-z0-9_-]{0,31}");
    private static final int MAX_NAME_LENGTH = 60;

    /** One PocketBase instance: its port and the folders it owns. */
    public static final class Site {
        public final String id;
        public final String name;
        public final int port;
        /** True for the site that keeps the folders every earlier version used. */
        public final boolean legacy;
        public final File dataDir;
        public final File publicDir;
        public final File backupDir;
        /** Log file name without ".log": "pocketbase" for the original site. */
        public final String logName;

        Site(String id, String name, int port, boolean legacy,
             File dataDir, File publicDir, File backupDir, String logName) {
            this.id = id;
            this.name = name;
            this.port = port;
            this.legacy = legacy;
            this.dataDir = dataDir;
            this.publicDir = publicDir;
            this.backupDir = backupDir;
            this.logName = logName;
        }

        /** The exact PocketBase command line for this site. */
        public List<String> serveArgs(String binaryPath) {
            List<String> args = new ArrayList<>(5);
            args.add(binaryPath);
            args.add("serve");
            args.add("--http=0.0.0.0:" + port);
            args.add("--dir=" + dataDir.getAbsolutePath());
            args.add("--publicDir=" + publicDir.getAbsolutePath());
            return args;
        }
    }

    public final List<Site> sites;
    public final List<String> problems;
    public final File file;

    private SiteRegistry(List<Site> sites, List<String> problems, File file) {
        this.sites = sites;
        this.problems = problems;
        this.file = file;
    }

    public static File registryFile(File dataRoot) {
        return new File(dataRoot, "sites.json");
    }

    /** What the panel reads: one entry per live site, the shape the Windows build writes. */
    public static File statusFile(File dataRoot) {
        return new File(dataRoot, "sites.status.json");
    }

    /** The site that owns the original folders, or the first one when there is none. */
    public Site legacyOrFirst() {
        for (Site site : sites) {
            if (site.legacy) return site;
        }
        return sites.isEmpty() ? null : sites.get(0);
    }

    /** A site by id; a blank id means the original site. Null when the id is unknown. */
    public Site byId(String id) {
        String wanted = id == null ? "" : id.trim();
        if (wanted.isEmpty()) return legacyOrFirst();
        for (Site site : sites) {
            if (site.id.equals(wanted)) return site;
        }
        return null;
    }

    public static SiteRegistry load(File dataRoot, int legacyPort) {
        List<String> problems = new ArrayList<>();
        File file = registryFile(dataRoot);

        if (!file.exists()) {
            List<Site> single = new ArrayList<>(1);
            single.add(build(LEGACY_ID, LEGACY_NAME, legacyPort, true, dataRoot));
            return new SiteRegistry(single, problems, file);
        }

        JSONArray list = null;
        try {
            JSONObject root = new JSONObject(read(file));
            list = root.optJSONArray("sites");
        } catch (Exception error) {
            problems.add("sites.json was ignored (" + error.getMessage() + ") — running the single site only.");
        }

        if (list == null || list.length() == 0) {
            if (!problems.isEmpty()) {
                // Already explained above.
            } else {
                problems.add("sites.json lists no sites — running the single site only.");
            }
            List<Site> single = new ArrayList<>(1);
            single.add(build(LEGACY_ID, LEGACY_NAME, legacyPort, true, dataRoot));
            return new SiteRegistry(single, problems, file);
        }

        // The site that owns pb_data is decided first, so it keeps its port even when a
        // later entry asks for the same one.
        List<JSONObject> ordered = new ArrayList<>();
        for (int index = 0; index < list.length(); index++) {
            JSONObject entry = list.optJSONObject(index);
            if (entry != null && wantsLegacy(entry)) ordered.add(entry);
        }
        for (int index = 0; index < list.length(); index++) {
            JSONObject entry = list.optJSONObject(index);
            if (entry != null && !wantsLegacy(entry)) ordered.add(entry);
        }

        Set<String> seenIds = new LinkedHashSet<>();
        Set<Integer> takenPorts = new LinkedHashSet<>();
        List<Site> sites = new ArrayList<>();
        boolean legacyTaken = false;

        for (JSONObject entry : ordered) {
            String id = cleanId(entry.optString("id", ""));
            if (id.isEmpty()) id = cleanId(entry.optString("name", ""));
            if (id.isEmpty()) {
                problems.add("a site entry has no usable id (lowercase letters, digits, - and _) — skipped.");
                continue;
            }
            if (!seenIds.add(id)) {
                problems.add("site \"" + id + "\" appears more than once — the extra entry was skipped.");
                continue;
            }

            boolean legacy = wantsLegacy(entry) && !legacyTaken;
            if (wantsLegacy(entry) && legacyTaken) {
                problems.add("site \"" + id + "\" also asked for the original data folder — it runs from sites/"
                        + id + " instead.");
            }

            int port = entry.optInt("port", 0);
            // A legacy entry without a port keeps the phone's usual 8090.
            if (port <= 0) port = legacy ? legacyPort : nextFreePort(takenPorts, legacyPort);
            if (!usablePort(port)) {
                problems.add("site \"" + id + "\" has no usable port — skipped.");
                seenIds.remove(id);
                continue;
            }
            if (!takenPorts.add(port)) {
                problems.add("site \"" + id + "\" asked for port " + port
                        + ", which another site already uses — skipped.");
                seenIds.remove(id);
                continue;
            }

            if (legacy) legacyTaken = true;
            sites.add(build(id, cleanName(entry.optString("name", ""), id), port, legacy, dataRoot));
        }

        if (sites.isEmpty()) {
            problems.add("sites.json had no usable site — running the single site only.");
            sites.add(build(LEGACY_ID, LEGACY_NAME, legacyPort, true, dataRoot));
        }
        return new SiteRegistry(sites, problems, file);
    }

    private static Site build(String id, String name, int port, boolean legacy, File dataRoot) {
        File root = legacy ? dataRoot : new File(new File(dataRoot, "sites"), id);
        File dataDir = new File(root, "pb_data");
        File publicDir = new File(root, "pb_public");
        String logName = legacy ? "pocketbase" : "site-" + id;
        return new Site(id, name, port, legacy, dataDir, publicDir, new File(publicDir, "backups"), logName);
    }

    private static boolean wantsLegacy(JSONObject entry) {
        return entry.optBoolean("legacy", false) || LEGACY_ID.equals(entry.optString("id", ""));
    }

    private static int nextFreePort(Set<Integer> taken, int legacyPort) {
        for (int port = FIRST_EXTRA_PORT; port <= 65535; port++) {
            if (port == legacyPort || taken.contains(port)) continue;
            if (port >= PANEL_PORT_LOW && port <= PANEL_PORT_HIGH) continue;
            return port;
        }
        return 0;
    }

    private static boolean usablePort(int port) {
        return port >= 1024 && port <= 65535 && !(port >= PANEL_PORT_LOW && port <= PANEL_PORT_HIGH);
    }

    private static String cleanId(String value) {
        String id = value == null ? "" : value.trim().toLowerCase(java.util.Locale.US);
        return ID_PATTERN.matcher(id).matches() ? id : "";
    }

    private static String cleanName(String value, String id) {
        String name = value == null ? "" : value.trim();
        if (name.isEmpty()) return id;
        return name.length() > MAX_NAME_LENGTH ? name.substring(0, MAX_NAME_LENGTH - 1) + "…" : name;
    }

    private static String read(File file) throws IOException {
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) {
            int read = input.read(bytes);
            if (read <= 0) throw new IOException("empty file");
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
