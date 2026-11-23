'use strict';

// Must load before anything else: if a later require fails on the phone, this is the
// only thing that can report why (the panel itself never starts in that case).
const diag = require('./boot-diagnostics');
diag.install();

/**
 * Pocket Server — the Express backend.
 *
 * The same file runs in two places:
 *   1. On a PC for development:  node public/nodejs/server.js
 *   2. Inside the Android APK:   started automatically by @capawesome/capacitor-nodejs
 *
 * On the phone the plugin copies this project to
 * <filesDir>/capawesome_nodejs/nodejs-project/ and runs it with the embedded
 * Node.js 18 runtime. That folder is wiped on every app update, so everything
 * the user uploads is written to app.datadir() instead.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');

let express;
let multer;
try {
  express = require('express');
  multer = require('multer');
} catch (error) {
  // e.g. a dependency missing from the APK's copy of node_modules.
  diag.bootError(error, 'require(express|multer)');
  throw error;
}

const PORT = Number(process.env.PORT) || 8080;
const POCKETBASE_PORT = Number(process.env.POCKETBASE_PORT) || 8090;
const HOST = '0.0.0.0';


const APP_DIR = __dirname;
const WWW_DIR = path.join(APP_DIR, 'www');

const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB per file
const MAX_FILES_PER_REQUEST = 20;
const DEFAULT_PIN = '1234';
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Device bridge (only exists inside the APK)
 * ------------------------------------------------------------------ */

let bridge = null;
try {
  // Injected by the Node.js runtime; require('bridge') throws on a desktop.
  bridge = require('bridge');
} catch (error) {
  bridge = null;
}

/* The foreground service on Android and windows/supervisor.js on a PC do the same
 * job: they own the child processes and answer through the command files. Anything
 * that talks to that supervisor may therefore offer the device-only cards. */
const SUPERVISED = Boolean(bridge) || process.env.POCKET_SERVER_SUPERVISOR === '1';

function resolveDataDir() {
  if (bridge && bridge.app && typeof bridge.app.datadir === 'function') {
    try {
      return bridge.app.datadir();
    } catch (error) {
      console.error('[pocket-server] could not read app datadir:', error.message);
    }
  }
  // The Windows launcher may point the whole stack at a folder of its choosing; the
  // supervisor must read the same one or the command files land somewhere else.
  if (process.env.POCKET_SERVER_DATA) return path.resolve(process.env.POCKET_SERVER_DATA);
  // Desktop development: keep the data outside the folder that gets copied into
  // the APK, so a local run never ships its settings and uploads with the app.
  return path.join(APP_DIR, '..', '..', 'data');
}

const DATA_DIR = resolveDataDir();
// PocketBase serves this directory as the static website and the file manager
// writes here, so an upload is live at http://<phone>:8090/<name> immediately.
const SITE_DIR = path.join(DATA_DIR, 'pb_public');

/* data/sites.status.json is published by whoever owns the child processes: the Windows
 * supervisor or the Android service. Without it (a plain desktop run) there is one
 * site, on POCKETBASE_PORT. */
function safeToken(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(text) ? text : '';
}

function readSiteStatus() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sites.status.json'), 'utf8'));
    if (!parsed || !Array.isArray(parsed.sites)) return [];
    return parsed.sites
      .filter((site) => site && Number.isInteger(Number(site.port)))
      .map((site) => ({
        // The id and the log name index files below, so only plain names are accepted.
        id: safeToken(site.id),
        name: String(site.name || site.id || ''),
        port: Number(site.port),
        legacy: site.legacy === true,
        state: String(site.state || 'unknown'),
        // Absolute paths only: the file routes follow this one.
        publicDir:
          typeof site.publicDir === 'string' && path.isAbsolute(site.publicDir) ? site.publicDir : '',
        logName: safeToken(site.logName),
      }));
  } catch (error) {
    return [];
  }
}

const SITES = readSiteStatus();
const SITE_PORTS = new Set(SITES.map((site) => site.port));
const PRIMARY_SITE = SITES.find((site) => site.legacy) || SITES[0] || null;
const PRIMARY_SITE_PORT = PRIMARY_SITE ? PRIMARY_SITE.port : POCKETBASE_PORT;

/* Which site the dashboard is looking at. The page sends ?site=<id>; with no registry
 * (or a single site) every request resolves to the primary site, so a one-site install
 * behaves exactly as it did before the switcher existed. */
function siteById(id) {
  const wanted = typeof id === 'string' ? id.trim() : '';
  if (!wanted) return PRIMARY_SITE;
  return SITES.find((site) => site.id === wanted) || null;
}

function requestSite(req) {
  const wanted = req.query && typeof req.query.site === 'string' ? req.query.site : '';
  return siteById(wanted) || PRIMARY_SITE;
}

/** The public folder a request is about; the shared one when no site is known. */
function requestSiteDir(req) {
  const site = requestSite(req);
  return site && site.publicDir ? site.publicDir : SITE_DIR;
}

/** PocketBase's log for a site: logs/pocketbase.log, or logs/site-<id>.log for the others. */
function siteLogName(site) {
  if (!site) return 'pocketbase';
  if (site.logName) return site.logName;
  return site.legacy ? 'pocketbase' : `site-${site.id || 'site'}`;
}

/* Another app on the phone can already own 8080 (that is an EADDRINUSE). Rather than
 * dying, walk up to the next free port and publish the one that worked, so the UI can
 * find the panel wherever it landed. Every PocketBase port is skipped — not just 8090 —
 * because PocketBase answers /api/health too and would look like the panel. */
const PORT_CANDIDATES = (() => {
  const list = [];
  for (let offset = 0; offset < 6; offset += 1) {
    const candidate = PORT + offset;
    if (candidate !== POCKETBASE_PORT && candidate > 0 && candidate < 65536 && !SITE_PORTS.has(candidate)) {
      list.push(candidate);
    }
  }
  return list.length > 0 ? list : [PORT];
})();

let activePort = PORT_CANDIDATES[0];
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const TUNNEL_STATUS_FILE = path.join(DATA_DIR, 'tunnel.status.json');
const TUNNEL_COMMAND_FILE = path.join(DATA_DIR, 'tunnel.command.json');
const SERVICE_COMMAND_FILE = path.join(DATA_DIR, 'service.command.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
// Written by the Android service: the first-superuser installer token, the result of the
// last superuser command, and the state of the last database backup.
const INSTALLER_FILE = path.join(DATA_DIR, 'installer.json');
const SUPERUSER_RESULT_FILE = path.join(DATA_DIR, 'superuser-result.json');
const BACKUP_STATUS_FILE = path.join(DATA_DIR, 'backup.status.json');
// Zips live outside every web root. Until 1.9.x they were written into
// pb_public/backups, which PocketBase serves: anyone with the site address could
// download the whole database. Old zips there are still listed, and flagged.
const BACKUP_ROOT = path.join(DATA_DIR, 'backups');
const POWER_STATUS_FILE = path.join(DATA_DIR, 'power.status.json');
const INTEGRITY_FILE = path.join(DATA_DIR, 'integrity.json');

try {
  fs.mkdirSync(SITE_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (error) {
  diag.bootError(error, `mkdir ${SITE_DIR}`);
  throw error;
}

// Keep the runtime (and this HTTP server) alive while the app is in the
// background, so a transfer does not stop when the phone screen sleeps.
if (bridge && bridge.app && typeof bridge.app.on === 'function') {
  bridge.app.on('pause', (pauseLock) => {
    if (pauseLock && typeof pauseLock.release === 'function') pauseLock.release();
  });
}

/* ------------------------------------------------------------------ *
 * Settings and the PIN token
 * ------------------------------------------------------------------ */

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (parsed && typeof parsed.pin === 'string' && typeof parsed.secret === 'string') {
      return parsed;
    }
  } catch (error) {
    // First run, or an unreadable file: fall through and create fresh settings.
  }

  const fresh = { pin: DEFAULT_PIN, secret: crypto.randomBytes(32).toString('hex') };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fresh, null, 2), 'utf8');
  } catch (error) {
    console.error('[pocket-server] could not persist settings:', error.message);
  }
  return fresh;
}

let settings = loadSettings();

/* Sessions are 256-bit random tokens issued on unlock. They are stored on disk so a
 * restart does not sign every device out, expire after 30 days of inactivity, are
 * capped at 10 devices, and are all revoked when the PIN changes. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 10;

let sessions = loadSessions();

function loadSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (error) {
    // No sessions yet.
  }
  return {};
}

function saveSessions() {
  try {
    const tmp = `${SESSIONS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sessions), 'utf8');
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (error) {
    console.error('[pocket-server] could not persist sessions:', error.message);
  }
}

function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  for (const [key, value] of Object.entries(sessions)) {
    if (!value || now - value.lastSeen > SESSION_TTL_MS) delete sessions[key];
  }

  sessions[token] = { created: now, lastSeen: now };

  const ordered = Object.entries(sessions).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  while (ordered.length > MAX_SESSIONS) {
    const [oldest] = ordered.shift();
    delete sessions[oldest];
  }

  saveSessions();
  return token;
}

function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length !== 64) return false;
  const session = sessions[candidate];
  if (!session) return false;
  if (Date.now() - session.lastSeen > SESSION_TTL_MS) {
    delete sessions[candidate];
    saveSessions();
    return false;
  }
  session.lastSeen = Date.now();
  return true;
}

function revokeSessions() {
  sessions = {};
  saveSessions();
}

const loginAttempts = new Map();
const rateBuckets = new Map();

// Simple per-IP request bucket; the login route has its own stricter limit.
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip || 'unknown'}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Too many requests. Slow down and try again shortly.' });
      return;
    }
    next();
  };
}

function tooManyAttempts(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (Date.now() > record.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const record = loginAttempts.get(ip);
  if (!record || Date.now() > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    return;
  }
  record.count += 1;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function attempt(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

function safeName(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input
    .normalize('NFC')
    .replace(/[\/\\\u0000-\u001f\u007f]/g, '')
    .trim();
  const base = path.basename(cleaned);
  if (!base || base === '.' || base === '..') return null;
  if (base.startsWith('.')) return null;
  if (base.length > 180) return null;
  return base;
}

// multer hands file names back as latin1-decoded bytes; repair real UTF-8 names.
function decodeUploadName(original) {
  if (typeof original !== 'string' || !original) return 'upload';
  const repaired = Buffer.from(original, 'latin1').toString('utf8');
  return repaired.includes('\uFFFD') ? original : repaired;
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let index = 1;
  while (fs.existsSync(path.join(dir, candidate)) && index < 1000) {
    candidate = `${stem} (${index})${ext}`;
    index += 1;
  }
  return candidate;
}

function lanAddresses() {
  const addresses = [];
  const interfaces = attempt(() => os.networkInterfaces(), {});
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push({ name, address: entry.address });
      }
    }
  }
  addresses.sort((a, b) => {
    const score = (item) => (item.name === 'wlan0' ? 0 : item.name.startsWith('wlan') ? 1 : 2);
    return score(a) - score(b) || a.address.localeCompare(b.address);
  });
  return addresses;
}

async function listFiles(dir = SITE_DIR) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    try {
      const info = await fsp.stat(path.join(dir, entry.name));
      files.push({ name: entry.name, size: info.size, modified: info.mtime.toISOString() });
    } catch (error) {
      // File vanished mid-listing; skip it.
    }
  }
  files.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return files;
}

async function fileTotals(dir = SITE_DIR) {
  const files = await listFiles(dir);
  return {
    count: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
  };
}

/* ------------------------------------------------------------------ *
 * Upload handling
 * ------------------------------------------------------------------ */

const storage = multer.diskStorage({
  // req.query is parsed by now; req.body is not, because this is a multipart request.
  destination: (req, file, done) => {
    const dir = requestSiteDir(req);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      done(error);
      return;
    }
    done(null, dir);
  },
  filename: (req, file, done) => {
    const dir = requestSiteDir(req);
    const name = safeName(decodeUploadName(file.originalname)) || `upload-${Date.now()}`;
    done(null, uniqueName(dir, name));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_REQUEST },
});

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');

// cloudflared connects from 127.0.0.1, so trusting loopback is what makes req.ip
// the real public client address instead of the tunnel host.
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
      "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; frame-ancestors *; " +
      "base-uri 'none'; form-action 'self'",
  );
  next();
});

app.use('/api', rateLimit('api', 240, 60 * 1000));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pocket-Token');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: '32kb' }));

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Public: lets the UI tell "server is waking up" from "wrong PIN".
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) {
    res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    return;
  }

  const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
  if (pin !== settings.pin) {
    recordFailedAttempt(ip);
    res.status(401).json({ error: 'Wrong PIN.' });
    return;
  }

  loginAttempts.delete(ip);
  res.json({ token: issueToken() });
});

app.use('/api', (req, res, next) => {
  if (!tokenMatches(req.get('x-pocket-token'))) {
    res.status(401).json({ error: 'Locked. Enter the PIN to continue.' });
    return;
  }
  next();
});

app.get('/api/status', async (req, res) => {
  const memory = process.memoryUsage();
  const site = requestSite(req);
  const sitePort = site ? site.port : PRIMARY_SITE_PORT;
  const totals = await fileTotals(requestSiteDir(req));

  res.json({
    status: 'online',
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    port: activePort,
    host: HOST,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: process.arch,
    cpuCount: attempt(() => os.cpus().length, null),
    loadAverage: attempt(() => os.loadavg(), null),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      total: attempt(() => os.totalmem(), null),
      free: attempt(() => os.freemem(), null),
    },
    addresses: lanAddresses(),
    files: totals,
    // panelPort/sitePort are the explicit names the UI prefers; port/pocketbase.port
    // stay for compatibility with older copies of the dashboard.
    panelPort: activePort,
    sitePort,
    pocketbase: { port: sitePort, siteDirectory: requestSiteDir(req) },
    siteId: site ? site.id : '',
    sites: SITES,
    defaultPin: settings.pin === DEFAULT_PIN,
  });
});

app.post('/api/pin', (req, res) => {
  const currentPin = typeof req.body?.currentPin === 'string' ? req.body.currentPin.trim() : '';
  const newPin = typeof req.body?.newPin === 'string' ? req.body.newPin.trim() : '';

  if (currentPin !== settings.pin) {
    res.status(401).json({ error: 'Current PIN is wrong.' });
    return;
  }
  if (!/^\d{4,8}$/.test(newPin)) {
    res.status(400).json({ error: 'The new PIN must be 4 to 8 digits.' });
    return;
  }

  settings = { ...settings, pin: newPin };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    res.status(500).json({ error: 'Could not save the new PIN on this device.' });
    return;
  }

  // Changing the PIN signs every other device out.
  revokeSessions();
  res.json({ token: issueToken() });
});

/** The port a tunnel must reach: the selected site's PocketBase, else the legacy one. */
function tunnelPortFor(site) {
  return site && Number.isInteger(site.port) ? site.port : POCKETBASE_PORT;
}

// Built per request: the panel port is only known once the listener is up, and the site
// port depends on which site the dashboard is showing.
const tunnelTargets = (site) => ({ panel: activePort, site: tunnelPortFor(site) });

function hasNamedTunnelToken() {
  return typeof settings.tunnelToken === 'string' && settings.tunnelToken.length >= 20;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

/** Hands a command to the foreground service through an atomic file swap. */
function writeServiceCommand(command) {
  const payload = { id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), ...command };
  const tmp = `${SERVICE_COMMAND_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, SERVICE_COMMAND_FILE);
  return payload;
}

app.get('/api/tunnel', (req, res) => {
  const status = readJsonFile(TUNNEL_STATUS_FILE);
  const site = requestSite(req);
  // The tunnel can only be spawned by the Android service, so a browser on the PC
  // can see the state but should not offer to start it.
  res.json({
    status: status || { state: 'stopped' },
    targets: tunnelTargets(site),
    // Names the site behind the "Hosted site" choice so the card can label it.
    site: { id: site ? site.id : '', name: site ? site.name || site.id : '', port: tunnelPortFor(site) },
    available: SUPERVISED,
    // The token itself never leaves the device: only whether one is stored.
    named: { configured: hasNamedTunnelToken() },
    watch: tunnelWatch.snapshot(),
  });
});

app.post('/api/tunnel', (req, res) => {
  const action = req.body?.action === 'start' ? 'start' : req.body?.action === 'stop' ? 'stop' : null;
  if (!action) {
    res.status(400).json({ error: 'action must be "start" or "stop".' });
    return;
  }

  const target = req.body?.target === 'site' ? 'site' : 'panel';
  const mode = req.body?.mode === 'named' ? 'named' : 'quick';
  // Which site the tunnel publishes. Without an id the selected site's PocketBase is
  // used (the primary one on a single-site install, exactly as before).
  const requestedSite = typeof req.body?.siteId === 'string' ? req.body.siteId.trim() : '';
  const site = requestedSite ? siteById(requestedSite) : requestSite(req);

  if (requestedSite && !site) {
    res.status(400).json({ error: `There is no site called "${requestedSite}".` });
    return;
  }

  if (mode === 'named' && !hasNamedTunnelToken()) {
    res.status(400).json({ error: 'Add and save a Cloudflare tunnel token first.' });
    return;
  }

  const command = {
    id: crypto.randomBytes(8).toString('hex'),
    action,
    target,
    mode,
    port: target === 'panel' ? activePort : tunnelPortFor(site),
    // The service echoes this into tunnel.status.json, so the card can say which site
    // the public address serves even after the dashboard switches site.
    siteId: target === 'panel' ? '' : site ? site.id : '',
    at: new Date().toISOString(),
  };

  // The foreground service watches this file, because the Node runtime cannot spawn
  // processes on Android. Written atomically so the service never reads half a file.
  try {
    const tmp = `${TUNNEL_COMMAND_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(command), 'utf8');
    fs.renameSync(tmp, TUNNEL_COMMAND_FILE);
  } catch (error) {
    res.status(500).json({ error: `Could not send the command to the tunnel service: ${error.message}` });
    return;
  }

  res.json({ accepted: command });
});

app.post('/api/tunnel/token', (req, res) => {
  const raw = typeof req.body?.token === 'string' ? req.body.token.trim() : '';

  if (raw === '') {
    settings = { ...settings, tunnelToken: undefined };
    delete settings.tunnelToken;
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    } catch (error) {
      res.status(500).json({ error: 'Could not save the token on this device.' });
      return;
    }
    res.json({ configured: false });
    return;
  }

  // Cloudflare tunnel tokens are long base64url strings; anything with whitespace or
  // quotes would be nonsense (and we never pass them through a shell anyway).
  if (raw.length < 20 || /[\s"'`]/.test(raw)) {
    res.status(400).json({ error: 'That does not look like a Cloudflare tunnel token.' });
    return;
  }

  settings = { ...settings, tunnelToken: raw };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    res.status(500).json({ error: 'Could not save the token on this device.' });
    return;
  }

  res.json({ configured: true });
});

app.get('/api/logs', async (req, res) => {
  const source = req.query.source === 'cloudflared' ? 'cloudflared' : 'pocketbase';
  const wanted = Math.min(Math.max(Number(req.query.lines) || 200, 10), 1000);
  // One tunnel serves the whole panel, so only PocketBase's log belongs to a site.
  const site = requestSite(req);
  const name = source === 'pocketbase' ? siteLogName(site) : source;
  const file = path.join(LOG_DIR, `${name}.log`);

  let text = '';
  let updatedAt = null;
  try {
    text = await fsp.readFile(file, 'utf8');
    updatedAt = (await fsp.stat(file)).mtime.toISOString();
  } catch (error) {
    // Nothing logged yet, or this build never started the service.
  }

  res.json({
    source,
    file: `${name}.log`,
    siteId: site ? site.id : '',
    updatedAt,
    empty: text.trim().length === 0,
    lines: text.split('\n').filter((line) => line.length > 0).slice(-wanted),
  });
});

app.post('/api/service', (req, res) => {
  const action = req.body?.action;
  if (action !== 'restart-pocketbase' && action !== 'restart-tunnel') {
    res.status(400).json({ error: 'Unknown service action.' });
    return;
  }

  try {
    const site = requestSite(req);
    res.json({ accepted: writeServiceCommand({ action, siteId: site ? site.id : '' }) });
  } catch (error) {
    res.status(500).json({ error: `Could not reach the service: ${error.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Own addresses
 * ------------------------------------------------------------------ */

/* settings.json keeps { "domains": { "<site id>": "shop.example.com" } }. This device
 * does not create the DNS route: a named Cloudflare tunnel's public hostnames point at
 * each site's port in the Cloudflare dashboard. The mapping is kept here so the tunnel
 * card can show it, open it and prove which server the address really reaches. */
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A bare lowercase hostname, "" to clear it, or null when it is not one. */
function cleanHostname(input) {
  if (typeof input !== 'string') return null;
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  if (!text) return '';
  return HOSTNAME_PATTERN.test(text) ? text : null;
}

/** Every site this panel knows, with the address settings.json holds for it. */
function domainList() {
  const stored = settings.domains && typeof settings.domains === 'object' ? settings.domains : {};
  const sites =
    SITES.length > 0 ? SITES : [{ id: 'default', name: 'This site', port: POCKETBASE_PORT, legacy: true }];
  return sites.map((site) => {
    const id = site.id || 'default';
    const hostname = typeof stored[id] === 'string' ? stored[id] : '';
    return { id, name: site.name || id, port: site.port, hostname, url: hostname ? `https://${hostname}` : '' };
  });
}

app.get('/api/domains', (req, res) => {
  const site = requestSite(req);
  res.json({
    sites: domainList(),
    siteId: (site && site.id) || 'default',
    namedTunnel: hasNamedTunnelToken(),
  });
});

app.post('/api/domains', (req, res) => {
  const site = requestSite(req);
  const id = (site && site.id) || 'default';
  const hostname = cleanHostname(req.body?.hostname);

  if (hostname === null) {
    res.status(400).json({ error: 'Use a hostname like shop.example.com — no https:// and no path.' });
    return;
  }

  const stored = { ...(settings.domains && typeof settings.domains === 'object' ? settings.domains : {}) };
  if (!hostname) {
    delete stored[id];
  } else {
    const takenBy = Object.keys(stored).find((key) => key !== id && stored[key] === hostname);
    if (takenBy) {
      res.status(409).json({ error: `That address is already set for ${takenBy}.` });
      return;
    }
    stored[id] = hostname;
  }

  settings = { ...settings, domains: stored };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    res.status(500).json({ error: 'Could not save the address on this device.' });
    return;
  }

  res.json({ sites: domainList(), siteId: id });
});

/** Asks the saved address who answers there: this site's PocketBase, the panel, or nobody. */
app.post('/api/domains/check', async (req, res) => {
  const entry = domainList().find((item) => item.id === ((requestSite(req) || {}).id || 'default'));
  if (!entry || !entry.hostname) {
    res.status(400).json({ error: 'Save an address for this site first.' });
    return;
  }

  try {
    const response = await fetch(`https://${entry.hostname}/api/health`, {
      signal: AbortSignal.timeout(6000),
    });
    const body = await response.json().catch(() => null);
    // PocketBase answers { code: 200 }, the panel { ok: true }: which one matters.
    const kind = body && body.code === 200 ? 'site' : body && body.ok === true ? 'panel' : 'unknown';
    res.json({ hostname: entry.hostname, status: response.status, kind, ok: kind === 'site' });
  } catch (error) {
    res.json({ hostname: entry.hostname, status: 0, kind: 'unreachable', ok: false, error: error.message });
  }
});

/* ------------------------------------------------------------------ *
 * PocketBase superuser
 * ------------------------------------------------------------------ */

// PocketBase 0.23+ has no "create the account at /_/" flow: it prints a 30-minute
// installer link at startup, which the service captures into installer.json.
/** installer.json and superuser-result.json name their site once there is more than one. */
function scopedJson(file, siteId) {
  const value = readJsonFile(file);
  if (!value) return null;
  const owner = typeof value.siteId === 'string' ? value.siteId : '';
  if (owner && siteId && owner !== siteId) return null;
  return value;
}

app.get('/api/superuser', (req, res) => {
  const site = requestSite(req);
  const siteId = site ? site.id : '';
  const installer = scopedJson(INSTALLER_FILE, siteId);
  const result = scopedJson(SUPERUSER_RESULT_FILE, siteId);
  const expiresAt = installer && installer.expiresAt ? Date.parse(installer.expiresAt) : 0;
  const expired = expiresAt > 0 && expiresAt < Date.now();

  res.json({
    needsSetup: Boolean(installer) && !expired,
    installer: installer
      ? { url: installer.url, lanUrl: installer.lanUrl, expiresAt: installer.expiresAt, expired }
      : null,
    result: result || null,
    siteId,
    available: SUPERVISED,
  });
});

app.post('/api/superuser', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'PocketBase requires a password of at least 8 characters.' });
    return;
  }
  if (password.length > 200) {
    res.status(400).json({ error: 'That password is too long.' });
    return;
  }
  if (!SUPERVISED) {
    res.status(501).json({ error: 'Only the phone app or the Windows launcher can create the superuser.' });
    return;
  }

  const target = requestSite(req);
  try {
    // Only clear the result this site would read; another site's is still useful.
    const previous = scopedJson(SUPERUSER_RESULT_FILE, target ? target.id : '');
    if (previous) fs.unlinkSync(SUPERUSER_RESULT_FILE);
  } catch (error) {
    // No previous result to clear.
  }

  try {
    const accepted = writeServiceCommand({
      action: 'create-superuser',
      email,
      password,
      siteId: target ? target.id : '',
    });
    // The password goes to the service and nowhere else — not to the browser, not to a log.
    delete accepted.password;
    res.json({ accepted });
  } catch (error) {
    res.status(500).json({ error: `Could not reach the service: ${error.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Backups
 * ------------------------------------------------------------------ */

/** data/backups/<site id> — the supervisor and the phone service write here too. */
function backupDirFor(site) {
  return path.join(BACKUP_ROOT, (site && site.id) || 'default');
}

/** One folder's zips; `public` marks the ones PocketBase serves over HTTP. */
async function listBackups(dir, isPublic) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
      const info = await fsp.stat(path.join(dir, entry.name));
      files.push({ name: entry.name, bytes: info.size, modified: info.mtime.toISOString(), public: isPublic === true });
    }
    files.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return files;
  } catch (error) {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Server power switch
 * ------------------------------------------------------------------ */

function powerState() {
  const status = readJsonFile(POWER_STATUS_FILE);
  // No file yet (first launch on an older build): assume on.
  return { on: !status || status.servers !== 'off', at: status ? status.at : null };
}

app.get('/api/power', (req, res) => {
  res.json({ ...powerState(), available: SUPERVISED });
});

app.post('/api/power', (req, res) => {
  if (typeof req.body?.on !== 'boolean') {
    res.status(400).json({ error: 'on must be true or false.' });
    return;
  }
  if (!SUPERVISED) {
    res.status(501).json({ error: 'The switch needs the phone app or the Windows launcher.' });
    return;
  }
  try {
    writeServiceCommand({ action: req.body.on ? 'start-servers' : 'stop-servers' });
    res.json({ accepted: true, on: req.body.on });
  } catch (error) {
    res.status(500).json({ error: `Could not reach the service: ${error.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * File integrity
 * ------------------------------------------------------------------ */

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Records a checksum for every uploaded file so corruption is detectable later. */
async function recordIntegrity(names, dir = SITE_DIR) {
  // Integrity tracking covers the original site's files; other sites are not tracked.
  if (!names.length || dir !== SITE_DIR) return;
  const map = readJsonFile(INTEGRITY_FILE) || {};

  for (const name of names) {
    try {
      const target = path.join(SITE_DIR, name);
      const info = await fsp.stat(target);
      map[name] = { sha256: await hashFile(target), size: info.size, at: new Date().toISOString() };
    } catch (error) {
      // File vanished between the write and the hash; nothing to record.
    }
  }

  try {
    writeJsonAtomic(INTEGRITY_FILE, map);
  } catch (error) {
    console.warn(`[pocket-server] could not save checksums: ${error.message}`);
  }
}

function forgetIntegrity(names) {
  const map = readJsonFile(INTEGRITY_FILE);
  if (!map) return;
  let changed = false;
  for (const name of names) {
    if (map[name]) {
      delete map[name];
      changed = true;
    }
  }
  if (!changed) return;
  try {
    writeJsonAtomic(INTEGRITY_FILE, map);
  } catch (error) {
    // Not fatal: the next verification reports the file as untracked.
  }
}

app.get('/api/integrity', async (req, res) => {
  const map = readJsonFile(INTEGRITY_FILE) || {};
  const files = await listFiles();
  const present = new Set(files.map((file) => file.name));

  const changed = [];
  const missing = [];
  const untracked = [];
  let checked = 0;

  for (const file of files) {
    const record = map[file.name];
    if (!record) {
      untracked.push(file.name);
      continue;
    }
    if (record.size !== file.size) {
      changed.push(file.name);
      continue;
    }
    if (checked >= 2000) continue; // bound the work on a phone
    try {
      const digest = await hashFile(path.join(SITE_DIR, file.name));
      checked += 1;
      if (digest !== record.sha256) changed.push(file.name);
    } catch (error) {
      changed.push(file.name);
    }
  }

  for (const name of Object.keys(map)) {
    if (!present.has(name)) missing.push(name);
  }

  res.json({ ok: changed.length === 0 && missing.length === 0, checked, changed, missing, untracked });
});

app.get('/api/backup', async (req, res) => {
  const site = requestSite(req);
  const privateDir = backupDirFor(site);
  const exposedDir = path.join(requestSiteDir(req), 'backups');
  const files = [
    ...(await listBackups(privateDir, false)),
    ...(await listBackups(exposedDir, true)),
  ].sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  const publicCount = files.filter((file) => file.public).length;
  res.json({
    status: readJsonFile(BACKUP_STATUS_FILE),
    files,
    siteId: site ? site.id : '',
    directory: privateDir,
    publicDirectory: publicCount > 0 ? exposedDir : '',
    publicCount,
    enabled: settings.backupEnabled !== false,
  });
});

// A private zip is not reachable through PocketBase, so the panel hands it out with
// the session token. The old public zips answer here too, for one place to download.
app.get('/api/backup/:name/download', (req, res) => {
  const name = safeName(req.params.name);
  if (!name || !name.endsWith('.zip')) {
    res.status(400).json({ error: 'Invalid backup name.' });
    return;
  }

  const site = requestSite(req);
  const target = [
    path.join(backupDirFor(site), name),
    path.join(requestSiteDir(req), 'backups', name),
  ].find((file) => fs.existsSync(file));

  if (!target) {
    res.status(404).json({ error: 'Backup not found.' });
    return;
  }
  res.download(target, name);
});

app.post('/api/backup', (req, res) => {
  if (!SUPERVISED) {
    res.status(501).json({ error: 'Backups need the phone app or the Windows launcher.' });
    return;
  }
  try {
    const site = requestSite(req);
    res.json({ accepted: writeServiceCommand({ action: 'backup', siteId: site ? site.id : '' }) });
  } catch (error) {
    res.status(500).json({ error: `Could not reach the service: ${error.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Tunnel watchdog and nightly backup
 * ------------------------------------------------------------------ */

const tunnelWatch = {
  url: null,
  checks: 0,
  failures: 0,
  restarts: 0,
  lastOkAt: null,
  lastError: null,
  downSince: null,
  lastRestartAt: 0,
  snapshot() {
    return {
      url: this.url,
      checks: this.checks,
      failures: this.failures,
      restarts: this.restarts,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      downSince: this.downSince,
    };
  },
};

/** Polls the public URL; three failures in a row ask the service for a fresh tunnel. */
async function watchdogTick() {
  const status = readJsonFile(TUNNEL_STATUS_FILE) || {};
  const url = typeof status.url === 'string' ? status.url : null;
  tunnelWatch.url = url;

  if (!url || status.state === 'stopped' || status.state === 'unavailable') {
    tunnelWatch.failures = 0;
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', cache: 'no-store' });
    clearTimeout(timer);
    if (response.status >= 500) throw new Error(`HTTP ${response.status} from the tunnel`);

    tunnelWatch.checks += 1;
    tunnelWatch.failures = 0;
    tunnelWatch.lastOkAt = new Date().toISOString();
    tunnelWatch.downSince = null;
    tunnelWatch.lastError = null;
  } catch (error) {
    clearTimeout(timer);
    tunnelWatch.checks += 1;
    tunnelWatch.failures += 1;
    tunnelWatch.lastError = error.name === 'AbortError' ? 'no answer within 8 s' : error.message;
    if (!tunnelWatch.downSince) tunnelWatch.downSince = new Date().toISOString();

    if (tunnelWatch.failures >= 3 && Date.now() - tunnelWatch.lastRestartAt > 5 * 60 * 1000) {
      tunnelWatch.failures = 0;
      tunnelWatch.restarts += 1;
      tunnelWatch.lastRestartAt = Date.now();
      try {
        writeServiceCommand({ action: 'restart-tunnel' });
        console.warn('[pocket-server] tunnel unanswered three times — asked the service to restart it');
      } catch (writeError) {
        console.warn(`[pocket-server] could not request a tunnel restart: ${writeError.message}`);
      }
    }
  }
}

let backupAttemptedDay = null;

/** One backup a day, in the quiet 03:00 hour. */
function backupTick() {
  if (settings.backupEnabled === false) return;
  const now = new Date();
  if (now.getHours() !== 3) return;

  const day = now.toISOString().slice(0, 10);
  if (backupAttemptedDay === day) return;

  const last = readJsonFile(BACKUP_STATUS_FILE);
  if (last && last.ok && last.at && Date.parse(last.at) > Date.now() - 20 * 3600 * 1000) return;

  backupAttemptedDay = day;
  try {
    writeServiceCommand({ action: 'backup' });
    console.log('[pocket-server] nightly backup requested');
  } catch (error) {
    console.warn(`[pocket-server] nightly backup not requested: ${error.message}`);
  }
}

setInterval(() => {
  watchdogTick().catch(() => {});
}, 60 * 1000);
setInterval(backupTick, 10 * 60 * 1000);

app.get('/api/files', async (req, res) => {
  const dir = requestSiteDir(req);
  res.json({ files: await listFiles(dir), directory: dir });
});

app.post('/api/upload', upload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
  const uploaded = Array.isArray(req.files)
    ? req.files.map((file) => ({ name: file.filename, size: file.size }))
    : [];
  // Checksums let the panel prove later that a file was not silently corrupted.
  const dir = requestSiteDir(req);
  await recordIntegrity(uploaded.map((file) => file.name), dir);
  res.json({ uploaded, files: await listFiles(dir), directory: dir });
});

app.get('/api/files/:name/download', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) {
    res.status(400).json({ error: 'Invalid file name.' });
    return;
  }

  const target = path.join(requestSiteDir(req), name);
  if (!fs.existsSync(target)) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }
  res.download(target, name);
});

app.delete('/api/files/:name', async (req, res) => {
  const name = safeName(req.params.name);
  if (!name) {
    res.status(400).json({ error: 'Invalid file name.' });
    return;
  }

  try {
    await fsp.unlink(path.join(requestSiteDir(req), name));
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found.' });
      return;
    }
    res.status(500).json({ error: `Could not delete the file: ${error.message}` });
    return;
  }

  if (requestSiteDir(req) === SITE_DIR) forgetIntegrity([name]);
  res.json({ deleted: name, files: await listFiles(requestSiteDir(req)) });
});

app.post('/api/files/:name/rename', async (req, res) => {
  const from = safeName(req.params.name);
  const to = safeName(typeof req.body?.name === 'string' ? req.body.name : '');
  if (!from || !to) {
    res.status(400).json({ error: 'Invalid file name.' });
    return;
  }
  const dir = requestSiteDir(req);
  if (from === to) {
    res.json({ renamed: { from, to }, files: await listFiles(dir) });
    return;
  }

  const target = path.join(dir, to);
  if (fs.existsSync(target)) {
    res.status(409).json({ error: 'A file with that name already exists.' });
    return;
  }

  try {
    await fsp.rename(path.join(dir, from), target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found.' });
      return;
    }
    res.status(500).json({ error: `Could not rename the file: ${error.message}` });
    return;
  }

  if (dir === SITE_DIR) forgetIntegrity([from]);
  await recordIntegrity([to], dir);
  res.json({ renamed: { from, to }, files: await listFiles(dir) });
});

// The dashboard itself is public; every piece of data above is not.
if (!fs.existsSync(path.join(WWW_DIR, 'index.html'))) {
  console.warn(`[pocket-server] ${WWW_DIR}/index.html is missing — run "npm run sync:ui".`);
}
app.use(
  express.static(WWW_DIR, {
    index: 'index.html',
    dotfiles: 'deny',
    maxAge: 0,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Unknown API route.' });
    return;
  }
  res.status(404).type('text/plain').send('Not found');
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `Each file must be smaller than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`
        : error.code === 'LIMIT_FILE_COUNT'
          ? `Upload at most ${MAX_FILES_PER_REQUEST} files at a time.`
          : error.message;
    res.status(400).json({ error: message });
    return;
  }
  console.error('[pocket-server]', error);
  res.status(500).json({ error: error.message || 'Internal server error.' });
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

// The dashboard reads this from PocketBase's public folder to learn which port the panel
// actually got, because it cannot assume 8080 is ours any more.
function publishActivePort(port) {
  const payload = `${port}\n`;
  for (const dir of [SITE_DIR, LOG_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '__panel-port.txt'), payload, 'utf8');
    } catch (error) {
      diag.bootError(error, `publish port in ${dir}`);
    }
  }
}

let server = null;
let candidateIndex = 0;

function listenOnCandidate() {
  const port = PORT_CANDIDATES[candidateIndex];
  const instance = http.createServer(app);

  instance.on('error', (error) => {
    const busy = error.code === 'EADDRINUSE' || error.code === 'EACCES';
    const next = PORT_CANDIDATES[candidateIndex + 1];

    if (busy && next !== undefined) {
      diag.bootInfo(`port ${port} unavailable (${error.code}) — trying ${next}`);
      console.warn(`[pocket-server] port ${port} unavailable (${error.code}), trying ${next}`);
      candidateIndex += 1;
      listenOnCandidate();
      return;
    }

    console.error(`[pocket-server] failed to listen on ${HOST}:${port}: ${error.message}`);
    diag.bootError(error, `listen ${HOST}:${port}`);
  });

  instance.listen(port, HOST, () => {
    server = instance;
    activePort = port;
    publishActivePort(port);

    const urls = [`http://localhost:${port}`, ...lanAddresses().map((item) => `http://${item.address}:${port}`)];
    diag.bootInfo(`listening on ${HOST}:${port} — panel is up`);
    console.log(`[pocket-server] listening on ${HOST}:${port}`);
    console.log(`[pocket-server] data directory: ${SITE_DIR}`);
    console.log(`[pocket-server] open one of: ${urls.join('  ')}`);
    if (settings.pin === DEFAULT_PIN) {
      console.log('[pocket-server] the PIN is still the default (1234) — change it in the dashboard.');
    }
  });

  return instance;
}

server = listenOnCandidate();

module.exports = server;
