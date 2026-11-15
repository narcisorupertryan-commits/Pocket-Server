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

/* Another app on the phone can already own 8080 (that is an EADDRINUSE). Rather than
 * dying, walk up to the next free port and publish the one that worked, so the UI can
 * find the panel wherever it landed. 8090 belongs to PocketBase and is skipped. */
const PORT_CANDIDATES = (() => {
  const list = [];
  for (let offset = 0; offset < 6; offset += 1) {
    const candidate = PORT + offset;
    if (candidate !== POCKETBASE_PORT && candidate > 0 && candidate < 65536) list.push(candidate);
  }
  return list;
})();

let activePort = PORT_CANDIDATES[0];

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

function resolveDataDir() {
  if (bridge && bridge.app && typeof bridge.app.datadir === 'function') {
    try {
      return bridge.app.datadir();
    } catch (error) {
      console.error('[pocket-server] could not read app datadir:', error.message);
    }
  }
  // Desktop development: keep the data outside the folder that gets copied into
  // the APK, so a local run never ships its settings and uploads with the app.
  return path.join(APP_DIR, '..', '..', 'data');
}

const DATA_DIR = resolveDataDir();
// PocketBase serves this directory as the static website and the file manager
// writes here, so an upload is live at http://<phone>:8090/<name> immediately.
const SITE_DIR = path.join(DATA_DIR, 'pb_public');
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
const BACKUP_DIR = path.join(SITE_DIR, 'backups');
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

async function listFiles() {
  let entries;
  try {
    entries = await fsp.readdir(SITE_DIR, { withFileTypes: true });
  } catch (error) {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    try {
      const info = await fsp.stat(path.join(SITE_DIR, entry.name));
      files.push({ name: entry.name, size: info.size, modified: info.mtime.toISOString() });
    } catch (error) {
      // File vanished mid-listing; skip it.
    }
  }
  files.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return files;
}

async function fileTotals() {
  const files = await listFiles();
  return {
    count: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
  };
}

/* ------------------------------------------------------------------ *
 * Upload handling
 * ------------------------------------------------------------------ */

const storage = multer.diskStorage({
  destination: (req, file, done) => done(null, SITE_DIR),
  filename: (req, file, done) => {
    const name = safeName(decodeUploadName(file.originalname)) || `upload-${Date.now()}`;
    done(null, uniqueName(SITE_DIR, name));
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
  const totals = await fileTotals();

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
    sitePort: POCKETBASE_PORT,
    pocketbase: { port: POCKETBASE_PORT, siteDirectory: SITE_DIR },
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

// Built per request: the panel port is only known once the listener is up.
const tunnelTargets = () => ({ panel: activePort, site: POCKETBASE_PORT });

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
  // The tunnel can only be spawned by the Android service, so a browser on the PC
  // can see the state but should not offer to start it.
  res.json({
    status: status || { state: 'stopped' },
    targets: tunnelTargets(),
    available: Boolean(bridge),
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

  if (mode === 'named' && !hasNamedTunnelToken()) {
    res.status(400).json({ error: 'Add and save a Cloudflare tunnel token first.' });
    return;
  }

  const command = {
    id: crypto.randomBytes(8).toString('hex'),
    action,
    target,
    mode,
    port: tunnelTargets()[target],
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
  const file = path.join(LOG_DIR, `${source}.log`);

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
    res.json({ accepted: writeServiceCommand({ action }) });
  } catch (error) {
    res.status(500).json({ error: `Could not reach the service: ${error.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * PocketBase superuser
 * ------------------------------------------------------------------ */

// PocketBase 0.23+ has no "create the account at /_/" flow: it prints a 30-minute
// installer link at startup, which the service captures into installer.json.
app.get('/api/superuser', (req, res) => {
  const installer = readJsonFile(INSTALLER_FILE);
  const result = readJsonFile(SUPERUSER_RESULT_FILE);
  const expiresAt = installer && installer.expiresAt ? Date.parse(installer.expiresAt) : 0;
  const expired = expiresAt > 0 && expiresAt < Date.now();

  res.json({
    needsSetup: Boolean(installer) && !expired,
    installer: installer
      ? { url: installer.url, lanUrl: installer.lanUrl, expiresAt: installer.expiresAt, expired }
      : null,
    result: result || null,
    available: Boolean(bridge),
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
  if (!bridge) {
    res.status(501).json({ error: 'Only the app on the phone can create the superuser.' });
    return;
  }

  try {
    fs.unlinkSync(SUPERUSER_RESULT_FILE);
  } catch (error) {
    // No previous result to clear.
  }

  try {
    const accepted = writeServiceCommand({ action: 'create-superuser', email, password });
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

async function listBackups() {
  try {
    const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
      const info = await fsp.stat(path.join(BACKUP_DIR, entry.name));
      files.push({ name: entry.name, bytes: info.size, modified: info.mtime.toISOString() });
    }
    files.sort((a, b) => (a.modified < b.modified ? 1 : -1));
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
  res.json({ ...powerState(), available: Boolean(bridge) });
});

app.post('/api/power', (req, res) => {
  if (typeof req.body?.on !== 'boolean') {
    res.status(400).json({ error: 'on must be true or false.' });
    return;
  }
  if (!bridge) {
    res.status(501).json({ error: 'The switch only works in the app on the phone.' });
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
async function recordIntegrity(names) {
  if (!names.length) return;
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
  res.json({
    status: readJsonFile(BACKUP_STATUS_FILE),
    files: await listBackups(),
    enabled: settings.backupEnabled !== false,
  });
});

app.post('/api/backup', (req, res) => {
  if (!bridge) {
    res.status(501).json({ error: 'Backups run in the app on the phone.' });
    return;
  }
  try {
    res.json({ accepted: writeServiceCommand({ action: 'backup' }) });
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
  res.json({ files: await listFiles(), directory: SITE_DIR });
});

app.post('/api/upload', upload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
  const uploaded = Array.isArray(req.files)
    ? req.files.map((file) => ({ name: file.filename, size: file.size }))
    : [];
  // Checksums let the panel prove later that a file was not silently corrupted.
  await recordIntegrity(uploaded.map((file) => file.name));
  res.json({ uploaded, files: await listFiles(), directory: SITE_DIR });
});

app.get('/api/files/:name/download', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) {
    res.status(400).json({ error: 'Invalid file name.' });
    return;
  }

  const target = path.join(SITE_DIR, name);
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
    await fsp.unlink(path.join(SITE_DIR, name));
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found.' });
      return;
    }
    res.status(500).json({ error: `Could not delete the file: ${error.message}` });
    return;
  }

  forgetIntegrity([name]);
  res.json({ deleted: name, files: await listFiles() });
});

app.post('/api/files/:name/rename', async (req, res) => {
  const from = safeName(req.params.name);
  const to = safeName(typeof req.body?.name === 'string' ? req.body.name : '');
  if (!from || !to) {
    res.status(400).json({ error: 'Invalid file name.' });
    return;
  }
  if (from === to) {
    res.json({ renamed: { from, to }, files: await listFiles() });
    return;
  }

  const target = path.join(SITE_DIR, to);
  if (fs.existsSync(target)) {
    res.status(409).json({ error: 'A file with that name already exists.' });
    return;
  }

  try {
    await fsp.rename(path.join(SITE_DIR, from), target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found.' });
      return;
    }
    res.status(500).json({ error: `Could not rename the file: ${error.message}` });
    return;
  }

  forgetIntegrity([from]);
  await recordIntegrity([to]);
  res.json({ renamed: { from, to }, files: await listFiles() });
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
