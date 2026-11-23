'use strict';

/**
 * Windows twin of android/app/src/main/java/com/pocketserver/app/ServerService.java.
 *
 * The control panel never spawns anything itself. It writes command files
 * (service.command.json, tunnel.command.json) and reads status files
 * (power.status.json, tunnel.status.json, installer.json, backup.status.json,
 * superuser-result.json, logs/*.log). On Android a foreground service plays the
 * other half of that conversation; on Windows this module does, byte for byte,
 * so public/nodejs/server.js and the UI stay untouched.
 *
 * Paths are relative to the folder that holds node.exe, so the whole thing is a
 * portable directory: copy it anywhere, including a USB stick.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeZipDir } = require('./zipdir');
const { loadSites, pathsFor, registryPath, statusPath } = require('./sites');

const IS_WIN = process.platform === 'win32';
const ROOT = path.resolve(process.env.POCKET_SERVER_ROOT || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.POCKET_SERVER_DATA || path.join(ROOT, 'data'));
const POCKETBASE_PORT = Number(process.env.POCKETBASE_PORT) || 8090;
const PANEL_PORT = Number(process.env.PORT) || 8080;

const PB_DATA = path.join(DATA_DIR, 'pb_data');
const SITE_DIR = path.join(DATA_DIR, 'pb_public');
// Private: never inside pb_public, which PocketBase serves to the public.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LOG_DIR = path.join(DATA_DIR, 'logs');

const FILES = {
  settings: path.join(DATA_DIR, 'settings.json'),
  installer: path.join(DATA_DIR, 'installer.json'),
  superuser: path.join(DATA_DIR, 'superuser-result.json'),
  backup: path.join(DATA_DIR, 'backup.status.json'),
  power: path.join(DATA_DIR, 'power.status.json'),
  tunnel: path.join(DATA_DIR, 'tunnel.status.json'),
  serviceCommand: path.join(DATA_DIR, 'service.command.json'),
  tunnelCommand: path.join(DATA_DIR, 'tunnel.command.json'),
};

const MAX_RESTARTS = 5;
const BACKUPS_KEPT = 7;
const INSTALLER_TTL_MS = 30 * 60 * 1000;
const MAX_LOG_BYTES = 512 * 1024;
const COMMAND_POLL_MS = 500;

const TUNNEL_URL = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;
const INSTALLER_PATH = /(\/_\/#\/pbinstall\/[A-Za-z0-9._-]+)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (...args) => console.log('[supervisor]', ...args);

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

function ensureDirs() {
  for (const dir of [DATA_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

/** Atomic write: the panel polls these files, so it must never see half a document. */
function writeJson(file, payload) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    log(`could not write ${path.basename(file)}:`, error.message);
    try {
      fs.unlinkSync(tmp);
    } catch (ignored) {
      /* nothing to clean up */
    }
    return false;
  }
}

function isoNow(millis = Date.now()) {
  return new Date(millis).toISOString();
}

/** Local time, matching the Android stamp: 2026-11-15-1040 */
function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function appendLog(name, line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${name}.log`);
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch (error) {
      /* first line of the day */
    }
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch (error) {
    log(`could not append the ${name} log:`, error.message);
  }
}

function pipeLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer.replace(/\r$/, ''));
    buffer = '';
  });
}

function lanIp() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

function resolveBinary(name) {
  const override = process.env[name === 'pocketbase' ? 'POCKETBASE_BIN' : 'CLOUDFLARED_BIN'];
  if (override) {
    const resolved = path.resolve(override);
    if (fs.existsSync(resolved)) return resolved;
    log(`POCKETBASE_BIN/CLOUDFLARED_BIN points at a missing file: ${resolved}`);
    return null;
  }
  const candidates = IS_WIN
    ? [path.join(ROOT, `${name}.exe`), path.join(ROOT, 'bin', `${name}.exe`)]
    : [path.join(ROOT, `${name}`), path.join(ROOT, 'bin', name), name];
  for (const candidate of candidates) {
    if (candidate === name) return name; // fall through to PATH, spawn() reports ENOENT
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readTunnelToken() {
  const settings = readJson(FILES.settings);
  return settings && typeof settings.tunnelToken === 'string' ? settings.tunnelToken.trim() : '';
}

/* ------------------------------------------------------------------ *
 * Supervisor
 * ------------------------------------------------------------------ */

class Supervisor {
  constructor() {
    this.stopping = false;
    this.serversDesired = true;
    // One PocketBase per site. Without data/sites.json this is the same single
    // site, on the same port and in the same folders, as the build before it.
    this.registry = loadSites({ dataDir: DATA_DIR, legacyPort: POCKETBASE_PORT });
    this.sites = this.registry.sites.map((config) => ({
      config,
      paths: pathsFor(config, DATA_DIR),
      child: null,
      paused: false,
      restartRequested: false,
    }));
    this.sitesStatusFile = statusPath(DATA_DIR);
    this.cloudflared = null;
    this.panelPid = null;
    this.busy = false;
    this.tunnelState = 'stopped';
    this.tunnelUrl = null;
    this.tunnelMessage = 'The tunnel is stopped.';
    this.tunnelMode = 'quick';
    this.tunnelPort = PANEL_PORT;
    // The site whose PocketBase the tunnel publishes; empty means the panel itself.
    this.tunnelSiteId = '';
    this.runtimeFile = path.join(DATA_DIR, 'runtime.json');
    this.timers = [];
  }

  start() {
    ensureDirs();
    for (const site of this.sites) {
      fs.mkdirSync(site.paths.pbData, { recursive: true });
      fs.mkdirSync(site.paths.publicDir, { recursive: true });
    }
    this.cleanupOrphans();
    this.writePowerStatus();
    if (this.tunnelState !== 'running') this.writeTunnelStatus();
    log(`root ${ROOT}`);
    log(`data ${DATA_DIR}`);
    log(`registry ${registryPath(DATA_DIR)} (${this.registry.source})`);
    for (const problem of this.registry.problems) log(problem);
    log(`panel port ${PANEL_PORT}, ${this.sites.length} site${this.sites.length === 1 ? '' : 's'}`);
    for (const site of this.sites) {
      log(`site ${site.config.id}: http://127.0.0.1:${site.config.port} — ${site.paths.pbData}`);
    }

    this.loops = this.sites.map((site) =>
      this.pocketbaseLoop(site).catch((error) => {
        log(`PocketBase supervisor for ${site.config.id} crashed:`, error.message);
        appendLog(site.paths.logName, `failed: ${error.message}`);
      }),
    );

    this.timers.push(setInterval(() => this.watchCommands(), COMMAND_POLL_MS));
    this.timers.push(setInterval(() => this.ensurePocketbaseRunning(), 15000));
    this.recordRuntime();
    return this;
  }

  /** One site by id; with no id the site that owns the original data folder. */
  site(siteId) {
    const id = typeof siteId === 'string' ? siteId.trim() : '';
    if (!id) return this.legacySite();
    return this.sites.find((entry) => entry.config.id === id) || null;
  }

  legacySite() {
    return this.sites.find((entry) => entry.config.legacy) || this.sites[0] || null;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];

    if (this.cloudflared) {
      appendLog('cloudflared', '--- stopped ---');
      this.kill(this.cloudflared);
      this.cloudflared = null;
    }
    for (const site of this.sites) {
      if (!site.child) continue;
      appendLog(site.paths.logName, '--- stopped with the launcher ---');
      this.kill(site.child);
      site.child = null;
    }
    try {
      fs.unlinkSync(this.runtimeFile);
    } catch (error) {
      /* nothing recorded */
    }
    await sleep(150);
  }

  /* ---------------- leftovers from a hard close ---------------- */

  recordRuntime() {
    // A child's exit event still fires while we shut down; writing then would leave a
    // pidfile behind for a run that has already ended.
    if (this.stopping) return;
    const legacy = this.legacySite();
    writeJson(this.runtimeFile, {
      launcherPid: process.pid,
      panelPid: this.panelPid,
      // A build from before the registry only knows this one key, so it is kept:
      // an older launcher must still be able to clear this run's leftovers.
      pocketbasePid: legacy && legacy.child ? legacy.child.pid || null : null,
      cloudflaredPid: this.cloudflared ? this.cloudflared.pid || null : null,
      sites: this.sites.map((site) => ({
        id: site.config.id,
        port: site.config.port,
        pocketbasePid: site.child ? site.child.pid || null : null,
      })),
      updatedAt: isoNow(),
    });
    this.writeSitesStatus();
  }

  /** Published for the panel and the launcher: never read sites.json twice differently. */
  writeSitesStatus() {
    writeJson(this.sitesStatusFile, {
      at: isoNow(),
      sites: this.sites.map((site) => ({
        id: site.config.id,
        name: site.config.name,
        port: site.config.port,
        legacy: site.config.legacy,
        state: site.child && !site.paused ? 'running' : this.serversDesired && !site.paused ? 'starting' : 'stopped',
        pid: site.child ? site.child.pid || null : null,
        pbData: site.paths.pbData,
        publicDir: site.paths.publicDir,
        logName: site.paths.logName,
      })),
    });
  }

  /** The panel is spawned by the launcher, but its pid belongs in the same record. */
  attachPanel(child) {
    this.panelPid = child && child.pid ? child.pid : null;
    this.recordRuntime();
  }

  static isAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means it exists but belongs to someone else.
      return error.code === 'EPERM';
    }
  }

  /**
   * Closing a console window on Windows ends the launcher without running a shutdown
   * handler, so pocketbase.exe and cloudflared.exe would keep running and hold their
   * ports. Their pids are recorded in runtime.json; the next start clears them out.
   */
  cleanupOrphans() {
    const previous = readJson(this.runtimeFile);
    if (!previous) return;

    const owner = Number(previous.launcherPid) || 0;
    if (owner && owner !== process.pid && Supervisor.isAlive(owner)) return; // another instance owns them

    // A record written before the site registry has no sites[] array: the flat keys
    // are read as well, so an upgrade still clears a dead pocketbase.exe on 8090.
    const pids = [Number(previous.panelPid) || 0, Number(previous.pocketbasePid) || 0, Number(previous.cloudflaredPid) || 0];
    if (Array.isArray(previous.sites)) {
      for (const entry of previous.sites) {
        if (entry && typeof entry === 'object') pids.push(Number(entry.pocketbasePid) || 0);
      }
    }

    // The panel goes first: it is what holds the port the next run wants.
    for (const pid of pids) {
      if (!pid || pid === process.pid) continue;
      if (!Supervisor.isAlive(pid)) continue;
      log(`clearing a leftover process from the last run (pid ${pid})`);
      try {
        if (IS_WIN) spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        else process.kill(pid, 'SIGKILL');
      } catch (error) {
        log(`could not stop pid ${pid}: ${error.message}`);
      }
    }

    try {
      fs.unlinkSync(this.runtimeFile);
    } catch (error) {
      /* already gone */
    }
  }

  /** Windows needs the whole tree gone; POSIX children usually exit on their own. */
  kill(child) {
    if (!child || child.killed) return;
    try {
      if (IS_WIN && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch (error) {
      log('could not stop a child process:', error.message);
    }
  }

  /* ---------------- PocketBase ---------------- */

  async pocketbaseLoop(site) {
    const { port } = site.config;
    let restarts = 0;

    while (!this.stopping) {
      if (!this.serversDesired || site.paused) {
        await sleep(250);
        continue;
      }

      const binary = resolveBinary('pocketbase');
      if (!binary) {
        appendLog(site.paths.logName, '--- pocketbase binary missing next to node.exe ---');
        await sleep(8000);
        continue;
      }

      fs.mkdirSync(site.paths.pbData, { recursive: true });
      fs.mkdirSync(site.paths.publicDir, { recursive: true });

      let child;
      try {
        child = spawn(
          binary,
          ['serve', `--http=0.0.0.0:${port}`, `--dir=${site.paths.pbData}`, `--publicDir=${site.paths.publicDir}`],
          {
            cwd: DATA_DIR,
            windowsHide: true,
            env: { ...process.env, HOME: DATA_DIR, TMPDIR: os.tmpdir() },
          },
        );
      } catch (error) {
        appendLog(site.paths.logName, `failed to start: ${error.message}`);
        await sleep(2000);
        continue;
      }

      site.child = child;
      appendLog(site.paths.logName, '--- started ---');
      this.recordRuntime();

      const onLine = (line) => {
        appendLog(site.paths.logName, line);
        this.captureInstaller(line, site);
      };
      pipeLines(child.stdout, onLine);
      pipeLines(child.stderr, onLine);

      const code = await new Promise((resolve) => {
        child.once('error', (error) => {
          appendLog(site.paths.logName, `failed: ${error.message}`);
          resolve(-1);
        });
        child.once('exit', (exitCode) => resolve(exitCode === null ? -1 : exitCode));
      });

      if (site.child === child) site.child = null;
      this.recordRuntime();
      appendLog(site.paths.logName, `--- exited ${code} ---`);
      if (this.stopping) return;

      if (site.restartRequested) {
        site.restartRequested = false;
        restarts = 0;
        appendLog(site.paths.logName, '--- restarted from the dashboard ---');
        continue;
      }
      if (site.paused || !this.serversDesired) continue;

      restarts += 1;
      if (restarts > MAX_RESTARTS) {
        appendLog(site.paths.logName, `--- gave up after ${MAX_RESTARTS} restarts ---`);
        await sleep(15000);
        restarts = 0;
        continue;
      }
      appendLog(site.paths.logName, `--- restarting (${restarts}/${MAX_RESTARTS}) ---`);
      await sleep(1500 * restarts);
    }
  }

  /** Safety net: a child that died without the loop noticing gets restarted. */
  ensurePocketbaseRunning() {
    if (this.stopping || !this.serversDesired) return;
    for (const site of this.sites) {
      if (site.child || site.paused) continue;
      site.restartRequested = true;
    }
  }

  captureInstaller(line, site) {
    if (!line.includes('/_/#/pbinstall/')) return;
    const match = INSTALLER_PATH.exec(line);
    if (!match) return;

    const suffix = match[1];
    const token = suffix.split('/').pop();
    const now = Date.now();
    const { port } = site.config;
    const wrote = writeJson(FILES.installer, {
      siteId: site.config.id,
      port,
      token,
      path: suffix,
      url: `http://127.0.0.1:${port}${suffix}`,
      lanUrl: `http://${lanIp()}:${port}${suffix}`,
      createdAt: isoNow(now),
      expiresAt: isoNow(now + INSTALLER_TTL_MS),
    });
    if (wrote) appendLog(site.paths.logName, '--- installer link captured (valid 30 minutes) ---');
  }

  /** Stop one site and wait for it, without touching the others. */
  async pauseSite(site) {
    site.paused = true;
    const child = site.child;
    if (child) this.kill(child);
    const deadline = Date.now() + 8000;
    while (site.child && Date.now() < deadline) await sleep(100);
    this.writeSitesStatus();
  }

  resumeSite(site) {
    site.paused = false;
    site.restartRequested = true;
    this.writeSitesStatus();
  }

  /* ---------------- cloudflared ---------------- */

  startTunnel(port, mode, siteId) {
    this.stopTunnelProcess();
    this.tunnelPort = Number(port) || PANEL_PORT;
    this.tunnelMode = mode === 'named' ? 'named' : 'quick';
    this.tunnelSiteId = typeof siteId === 'string' ? siteId : '';
    this.launchTunnel();
  }

  launchTunnel() {
    const binary = resolveBinary('cloudflared');
    if (!binary) {
      this.tunnelState = 'unavailable';
      this.tunnelUrl = null;
      this.tunnelMessage = 'cloudflared is not bundled in this folder — add cloudflared.exe to use the tunnel.';
      this.writeTunnelStatus();
      return;
    }

    const args = ['tunnel', '--no-autoupdate', '--loglevel', 'info'];
    if (this.tunnelMode === 'named') {
      const token = readTunnelToken();
      if (!token) {
        this.tunnelState = 'error';
        this.tunnelUrl = null;
        this.tunnelMessage = 'No Cloudflare tunnel token saved.';
        this.writeTunnelStatus();
        return;
      }
      args.push('run', '--token', token);
    } else {
      args.push('--url', `http://127.0.0.1:${this.tunnelPort}`);
    }

    let child;
    try {
      child = spawn(binary, args, {
        cwd: DATA_DIR,
        windowsHide: true,
        env: { ...process.env, HOME: DATA_DIR },
      });
    } catch (error) {
      this.tunnelState = 'error';
      this.tunnelMessage = `cloudflared failed to start: ${error.message}`;
      this.writeTunnelStatus();
      return;
    }

    this.cloudflared = child;
    this.recordRuntime();
    this.tunnelState = 'starting';
    this.tunnelUrl = null;
    this.tunnelMessage =
      this.tunnelMode === 'named'
        ? 'Connecting the named tunnel…'
        : 'Waiting for Cloudflare to assign an address…';
    const siteNote = this.tunnelSiteId ? `, site ${this.tunnelSiteId}` : '';
    appendLog('cloudflared', `--- started (${this.tunnelMode}, port ${this.tunnelPort}${siteNote}) ---`);
    this.writeTunnelStatus();

    const onLine = (line) => {
      appendLog('cloudflared', line);
      const url = TUNNEL_URL.exec(line);
      if (url) {
        this.tunnelUrl = url[1];
        this.tunnelState = 'running';
        this.tunnelMessage = 'Quick tunnel is live.';
        this.writeTunnelStatus();
      } else if (/registered tunnel connection/i.test(line)) {
        this.tunnelState = 'running';
        this.tunnelMessage = 'Named tunnel connected — the hostname is configured in Cloudflare.';
        this.writeTunnelStatus();
      } else if (/failed to |ERR |error/i.test(line) && this.tunnelState !== 'running') {
        this.tunnelState = 'error';
        this.tunnelMessage = line.trim();
        this.writeTunnelStatus();
      }
    };
    pipeLines(child.stdout, onLine);
    pipeLines(child.stderr, onLine);

    child.once('error', (error) => {
      appendLog('cloudflared', `failed: ${error.message}`);
      this.tunnelState = 'error';
      this.tunnelMessage = `cloudflared failed: ${error.message}`;
      this.writeTunnelStatus();
    });

    child.once('exit', (code) => {
      if (this.cloudflared !== child) return;
      this.cloudflared = null;
      this.recordRuntime();
      appendLog('cloudflared', `--- exited ${code} ---`);
      if (this.tunnelState === 'running' || this.tunnelState === 'starting') {
        this.tunnelState = 'error';
        this.tunnelUrl = null;
        this.tunnelMessage = `cloudflared exited (${code}).`;
        this.writeTunnelStatus();
      }
    });
  }

  stopTunnel(message) {
    this.stopTunnelProcess();
    this.tunnelState = 'stopped';
    this.tunnelUrl = null;
    this.tunnelMessage = message || 'Stopped from the dashboard.';
    appendLog('cloudflared', '--- stopped ---');
    this.writeTunnelStatus();
  }

  stopTunnelProcess() {
    const child = this.cloudflared;
    this.cloudflared = null;
    if (child) this.kill(child);
  }

  writeTunnelStatus() {
    writeJson(FILES.tunnel, {
      state: this.tunnelState,
      mode: this.tunnelMode,
      url: this.tunnelUrl,
      // Which site the address serves, and the port it reaches. Empty siteId means the
      // panel is what is published.
      port: this.tunnelPort,
      siteId: this.tunnelSiteId,
      message: this.tunnelMessage,
      updatedAt: Date.now(),
    });
  }

  /* ---------------- command channel ---------------- */

  watchCommands() {
    if (this.busy) return;

    const tunnel = this.takeCommand(FILES.tunnelCommand);
    if (tunnel) {
      const action = typeof tunnel.action === 'string' ? tunnel.action : '';
      if (action === 'start') this.startTunnel(tunnel.port, tunnel.mode, tunnel.siteId);
      else if (action === 'stop') this.stopTunnel('Stopped from the dashboard.');
      return;
    }

    const service = this.takeCommand(FILES.serviceCommand);
    if (!service) return;
    const action = typeof service.action === 'string' ? service.action : '';

    if (action === 'restart-pocketbase') {
      const site = this.site(service.siteId);
      if (!site) {
        log(`restart ignored: there is no site called "${service.siteId}"`);
        return;
      }
      appendLog(site.paths.logName, '--- restart requested ---');
      site.restartRequested = true;
      if (site.child) this.kill(site.child);
      return;
    }
    if (action === 'restart-tunnel') {
      this.startTunnel(this.tunnelPort, this.tunnelMode, this.tunnelSiteId);
      return;
    }
    if (action === 'stop-servers') {
      this.stopServers();
      return;
    }
    if (action === 'start-servers') {
      this.startServers();
      return;
    }
    if (action === 'create-superuser') {
      this.runExclusive(() => this.createSuperuser(service.email, service.password, service.siteId), service.siteId);
      return;
    }
    if (action === 'backup') {
      this.runExclusive(() => this.runBackup(service.siteId), service.siteId);
      return;
    }
    log(`ignored unknown service command: ${action}`);
  }

  takeCommand(file) {
    if (!fs.existsSync(file)) return null;
    let command = null;
    try {
      command = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      log(`unreadable command ${path.basename(file)}:`, error.message);
    }
    try {
      fs.unlinkSync(file);
    } catch (error) {
      /* already gone */
    }
    return command;
  }

  async runExclusive(job, siteId) {
    this.busy = true;
    try {
      await job();
    } catch (error) {
      log('command failed:', error.message);
      const site = this.site(siteId);
      appendLog(site ? site.paths.logName : 'pocketbase', `--- command failed: ${error.message} ---`);
    } finally {
      this.busy = false;
    }
  }

  /* ---------------- power switch ---------------- */

  writePowerStatus() {
    writeJson(FILES.power, { servers: this.serversDesired ? 'on' : 'off', at: isoNow() });
  }

  stopServers() {
    this.serversDesired = false;
    this.stopTunnel('Servers were turned off from the dashboard.');
    for (const site of this.sites) {
      if (site.child) this.kill(site.child);
      appendLog(site.paths.logName, '--- servers stopped from the dashboard ---');
    }
    this.writePowerStatus();
  }

  startServers() {
    this.serversDesired = true;
    for (const site of this.sites) site.restartRequested = true;
    const legacy = this.legacySite();
    if (legacy) appendLog(legacy.paths.logName, '--- servers started from the dashboard ---');
    this.writePowerStatus();
  }

  /* ---------------- superuser ---------------- */

  async createSuperuser(email, password, siteId) {
    const site = this.site(siteId);
    if (!site) {
      return this.finishSuperuser({ at: isoNow(), email: '', siteId: siteId || null }, false, `There is no site called "${siteId}".`);
    }
    const address = typeof email === 'string' ? email.trim() : '';
    const result = { at: isoNow(), email: address, siteId: site.config.id };

    if (!address.includes('@')) {
      return this.finishSuperuser(result, false, 'Enter a valid email address.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      return this.finishSuperuser(result, false, 'PocketBase requires a password of at least 8 characters.');
    }

    const binary = resolveBinary('pocketbase');
    if (!binary) {
      return this.finishSuperuser(result, false, 'The PocketBase binary is missing from this folder.');
    }

    await this.pauseSite(site);
    let output = '';
    let code = -1;
    try {
      const child = spawn(binary, ['superuser', 'upsert', address, password, `--dir=${site.paths.pbData}`], {
        cwd: DATA_DIR,
        windowsHide: true,
        env: { ...process.env, HOME: DATA_DIR },
      });
      pipeLines(child.stdout, (line) => {
        if (output.length < 4000) output += `${line}\n`;
      });
      pipeLines(child.stderr, (line) => {
        if (output.length < 4000) output += `${line}\n`;
      });
      code = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.kill(child);
          resolve(-1);
        }, 30000);
        child.once('exit', (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode === null ? -1 : exitCode);
        });
        child.once('error', () => {
          clearTimeout(timer);
          resolve(-1);
        });
      });
    } catch (error) {
      output = error.message;
    } finally {
      this.resumeSite(site);
    }

    const text = output.replace(password, '***').trim();
    if (code === 0) {
      const installer = readJson(FILES.installer);
      // Only clear the link this site printed — another site's is still useful.
      if (!installer || !installer.siteId || installer.siteId === site.config.id) {
        try {
          fs.unlinkSync(FILES.installer);
        } catch (error) {
          /* no installer link to clear */
        }
      }
      appendLog(site.paths.logName, `--- superuser saved: ${address} ---`);
      return this.finishSuperuser(result, true, 'Superuser saved. Sign in at /_/ with that email and password.');
    }
    appendLog(site.paths.logName, `--- superuser command failed (exit ${code}) ---`);
    return this.finishSuperuser(
      result,
      false,
      text || `PocketBase rejected the account (exit ${code}).`,
    );
  }

  finishSuperuser(result, ok, message) {
    writeJson(FILES.superuser, { ...result, ok, message });
  }

  /* ---------------- backups ---------------- */

  async runBackup(siteId) {
    const site = this.site(siteId);
    if (!site) {
      writeJson(FILES.backup, { ok: false, siteId: siteId || null, error: `There is no site called "${siteId}".`, at: isoNow() });
      return;
    }
    const name = `pb-${stamp()}.zip`;
    const target = path.join(site.paths.backups, name);
    const status = { siteId: site.config.id, port: site.config.port };

    try {
      await this.pauseSite(site);
      fs.mkdirSync(site.paths.backups, { recursive: true });
      const result = writeZipDir(site.paths.pbData, target);
      const kept = this.pruneBackups(site.paths.backups);
      Object.assign(status, { ok: true, file: name, bytes: result.sourceBytes, kept });
      appendLog(site.paths.logName, `--- backup written: ${name} (${Math.round(result.sourceBytes / 1024)} KiB, ${result.entries} files) ---`);
    } catch (error) {
      Object.assign(status, { ok: false, error: error.message });
      appendLog(site.paths.logName, `--- backup failed: ${error.message} ---`);
    } finally {
      this.resumeSite(site);
    }

    writeJson(FILES.backup, { ...status, at: isoNow() });
  }

  pruneBackups(backupDir) {
    let names = [];
    try {
      names = fs
        .readdirSync(backupDir)
        .filter((entry) => entry.startsWith('pb-') && entry.endsWith('.zip'));
    } catch (error) {
      return 0;
    }
    const sorted = names
      .map((entry) => {
        const file = path.join(backupDir, entry);
        return { file, at: fs.statSync(file).mtimeMs };
      })
      .sort((left, right) => right.at - left.at);

    let kept = 0;
    for (const item of sorted) {
      if (kept < BACKUPS_KEPT) {
        kept += 1;
        continue;
      }
      try {
        fs.unlinkSync(item.file);
      } catch (error) {
        /* leave it; the next backup prunes again */
      }
    }
    return kept;
  }
}

function start() {
  const supervisor = new Supervisor();
  supervisor.start();
  return supervisor;
}

module.exports = {
  Supervisor,
  start,
  paths: {
    ROOT,
    DATA_DIR,
    PB_DATA,
    SITE_DIR,
    LOG_DIR,
    BACKUP_DIR,
    SITES_FILE: registryPath(DATA_DIR),
    SITES_STATUS_FILE: statusPath(DATA_DIR),
    sitePaths: (site) => pathsFor(site, DATA_DIR),
  },
};
