#!/usr/bin/env node
/**
 * Proves the two things that must hold before a multi-site build ships:
 *
 *  1. An existing single-site data folder is used in place and stays intact — same
 *     paths, same bytes, no `data/sites` directory, and an old `runtime.json` from the
 *     previous build is still understood.
 *  2. A second entry in `data/sites.json` gets its own PocketBase, folders and log on
 *     8091 while the original site keeps serving on 8090 — including after a hard
 *     close that leaves both children running.
 *
 * PocketBase and cloudflared are replaced by tiny Node stubs, so this runs on Linux
 * (and in CI) without Windows or the real binaries:
 *
 *   node scripts/verify-multisite.mjs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR = path.join(ROOT, 'windows', 'supervisor.js');
const LEGACY_PORT = 8090;
const SECOND_PORT = 8091;
const KEEP = process.env.KEEP === '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-multisite-'));
const dataDir = path.join(tmp, 'data');
const binDir = path.join(tmp, 'bin');

const failures = [];
let checks = 0;

function check(ok, label, detail) {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(label);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
};
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function manifest(dir) {
  const files = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files.set(path.relative(dir, full).split(path.sep).join('/'), sha256(full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files;
}

/** The user's data: everything the previous build stored, minus its status files. */
function legacyData(map) {
  return new Map(
    [...map].filter(([file]) => file.startsWith('pb_data/') || file.startsWith('pb_public/') || file === 'settings.json'),
  );
}

/** Changed or added files, as relative paths. */
function diffMaps(beforeMap, afterMap) {
  const changes = [];
  for (const [file, hash] of beforeMap) if (afterMap.get(file) !== hash) changes.push(file);
  for (const file of afterMap.keys()) if (!beforeMap.has(file)) changes.push(file);
  return changes;
}

function health(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitForHealth(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health(port)) return true;
    await sleep(200);
  }
  return false;
}

async function waitForJson(file, predicate, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readJson(file);
    if (value && predicate(value)) return value;
    await sleep(200);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The stubs: a PocketBase that serves /api/health and a cloudflared that idles.
 * ------------------------------------------------------------------ */

const STUB_POCKETBASE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const args = process.argv.slice(2);
const arg = (name) => {
  const hit = args.find((value) => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : '';
};
if (args.includes('--version')) {
  console.log('PocketBase v0.0.0-stub');
  process.exit(0);
}
if (args[0] === 'superuser') {
  console.log('stub: superuser saved');
  process.exit(0);
}
if (args[0] !== 'serve') {
  console.log('stub: nothing to do');
  process.exit(0);
}
const dir = arg('dir');
const publicDir = arg('publicDir');
const port = Number(arg('http').split(':').pop());
fs.mkdirSync(dir, { recursive: true });
if (publicDir) fs.mkdirSync(publicDir, { recursive: true });
const database = path.join(dir, 'data.db');
if (!fs.existsSync(database)) fs.writeFileSync(database, JSON.stringify({ stub: true, dir }));
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/api/health')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 200, message: 'API is healthy.', data: {} }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('stub site');
});
server.listen(port, '0.0.0.0', () => console.log('Server started at http://0.0.0.0:' + port + ' (' + dir + ')'));
`;

const STUB_CLOUDFLARED = `#!/usr/bin/env node
'use strict';
if (process.argv.includes('--version')) {
  console.log('cloudflared version 0.0.0-stub');
  process.exit(0);
}
setInterval(() => {}, 1 << 30);
`;

const RUNNER = `#!/usr/bin/env node
'use strict';
// Exactly what windows/launch.js does, minus the panel and the browser.
process.env.POCKET_SERVER_DATA = process.argv[3];
process.env.POCKETBASE_PORT = process.argv[4] || '8090';
const { Supervisor } = require(process.argv[2]);
const supervisor = new Supervisor().start();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    Promise.resolve(supervisor.stop()).finally(() => process.exit(0));
  });
}
`;

function writeStub(file, body) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

const STUB_PB = path.join(binDir, 'pocketbase-stub');
const STUB_CF = path.join(binDir, 'cloudflared-stub');
const RUNNER_FILE = path.join(tmp, 'run-supervisor.js');

function startSupervisor() {
  const child = spawn(process.execPath, [RUNNER_FILE, SUPERVISOR, dataDir, String(LEGACY_PORT)], {
    cwd: ROOT,
    env: { ...process.env, POCKETBASE_BIN: STUB_PB, CLOUDFLARED_BIN: STUB_CF },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  const collect = (chunk) => {
    if (output.length > 400) return;
    output.push(String(chunk));
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.output = () => output.join('');
  return child;
}

function stopSupervisor(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        /* gone */
      }
      resolve();
    }, 12000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/* ------------------------------------------------------------------ *
 * A data folder written by the current single-site build.
 * ------------------------------------------------------------------ */

function seedLegacyFolder() {
  fs.mkdirSync(path.join(dataDir, 'pb_data'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'pb_public', 'backups'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'pb_data', 'data.db'), 'legacy database bytes');
  fs.writeFileSync(path.join(dataDir, 'pb_public', 'index.html'), '<h1>already published</h1>');
  fs.writeFileSync(path.join(dataDir, 'pb_public', 'backups', 'pb-2026-11-01-1200.zip'), 'legacy backup bytes');
  writeJson(path.join(dataDir, 'settings.json'), { pin: '9876', tunnelToken: '' });
  writeJson(path.join(dataDir, 'power.status.json'), { servers: 'on', at: '2026-11-01T12:00:00.000Z' });
  writeJson(path.join(dataDir, 'tunnel.status.json'), { state: 'stopped', updatedAt: 1 });
  writeJson(path.join(dataDir, 'backup.status.json'), { ok: true, at: '2026-11-01T12:00:00.000Z' });
  writeJson(path.join(dataDir, 'installer.json'), { token: 'old', url: 'http://127.0.0.1:8090/_/#/pbinstall/old' });
  fs.writeFileSync(path.join(dataDir, 'logs', 'pocketbase.log'), '2026/11/01 12:00:00 Server started at http://0.0.0.0:8090\n');
  // The previous build's pid record: flat keys, no sites[] array, dead pids.
  writeJson(path.join(dataDir, 'runtime.json'), {
    launcherPid: 999999,
    panelPid: null,
    pocketbasePid: 999998,
    cloudflaredPid: null,
    updatedAt: '2026-11-01T12:00:00.000Z',
  });
}

async function main() {
  writeStub(STUB_PB, STUB_POCKETBASE);
  writeStub(STUB_CF, STUB_CLOUDFLARED);
  fs.writeFileSync(RUNNER_FILE, RUNNER);

  console.log(`\nPocket Server — multi-site and upgrade check\n  folder ${dataDir}\n`);
  seedLegacyFolder();
  const before = manifest(dataDir);

  /* ---------------- 1. the upgrade: no registry, old folder ---------------- */
  console.log('Upgrade: the existing single-site folder, no sites.json');
  let supervisor = startSupervisor();
  const up = await waitForHealth(LEGACY_PORT);
  if (!up) {
    console.log(supervisor.output());
    check(false, 'the existing site answers on 8090');
  } else {
    check(true, 'the existing site answers on 8090');
  }

  const firstStatus = readJson(path.join(dataDir, 'sites.status.json'));
  const firstSite = firstStatus && firstStatus.sites && firstStatus.sites[0];
  check(Boolean(firstStatus) && firstStatus.sites.length === 1, 'sites.status.json lists exactly one site');
  check(Boolean(firstSite) && firstSite.legacy === true, 'and it is marked as the original folder');
  check(Boolean(firstSite) && firstSite.port === LEGACY_PORT, 'on port 8090');
  check(Boolean(firstSite) && firstSite.pbData === path.join(dataDir, 'pb_data'), 'with data/pb_data as its database', firstSite && firstSite.pbData);
  check(!fs.existsSync(path.join(dataDir, 'sites')), 'nothing was moved into data/sites');

  const afterUpgrade = manifest(dataDir);
  // power/tunnel/backup status files are rewritten by any start, the old build
  // included; the database, the website and settings.json must not move a byte.
  const changedData = diffMaps(legacyData(before), legacyData(afterUpgrade));
  check(changedData.length === 0, 'the database, the website and settings.json are byte-identical', changedData.join(', '));
  check(
    afterUpgrade.get('pb_data/data.db') === before.get('pb_data/data.db'),
    'the database file is byte-identical',
  );
  check(
    afterUpgrade.get('pb_public/backups/pb-2026-11-01-1200.zip') === before.get('pb_public/backups/pb-2026-11-01-1200.zip'),
    'the backup written by the old build is byte-identical',
  );
  const added = [...afterUpgrade.keys()].filter((file) => !before.has(file));
  check(
    added.every((file) => file === 'sites.status.json'),
    'the only new file is sites.status.json',
    added.join(', '),
  );

  const runtime = readJson(path.join(dataDir, 'runtime.json'));
  check(Boolean(runtime) && Number(runtime.pocketbasePid) > 0, 'runtime.json still has the flat pocketbasePid key older builds read');
  check(
    Boolean(runtime) && Array.isArray(runtime.sites) && runtime.sites.length === 1 &&
      runtime.sites[0].pocketbasePid === runtime.pocketbasePid,
    'and lists the same pid under sites[]',
  );

  // A backup through the old command file, with no siteId: it must hit the original folder.
  writeJson(path.join(dataDir, 'service.command.json'), { id: 'probe-1', at: new Date().toISOString(), action: 'backup' });
  const backup = await waitForJson(path.join(dataDir, 'backup.status.json'), (value) => value.ok === true && typeof value.file === 'string');
  check(Boolean(backup), 'a backup command without a siteId still works');
  check(Boolean(backup) && backup.siteId === 'default', 'and reports the original site');
  check(
    Boolean(backup) && fs.existsSync(path.join(dataDir, 'backups', 'default', backup.file)),
    'writing into data/backups/default, outside the published website',
  );
  check(
    Boolean(backup) && !fs.existsSync(path.join(dataDir, 'pb_public', 'backups', backup.file)),
    'and nothing new lands in the folder PocketBase serves',
  );
  check(
    fs.existsSync(path.join(dataDir, 'pb_public', 'backups', 'pb-2026-11-01-1200.zip')),
    'the old public zip is left where the earlier build put it',
  );
  check(
    sha256(path.join(dataDir, 'pb_data', 'data.db')) === before.get('pb_data/data.db'),
    'the database is still byte-identical after pausing for the backup',
  );

  await stopSupervisor(supervisor);
  check(!fs.existsSync(path.join(dataDir, 'runtime.json')), 'a clean stop removes the pid file');

  /* ---------------- 2. a second site on 8091 ---------------- */
  console.log('\nSecond site: default on 8090, second on 8091');
  writeJson(path.join(dataDir, 'sites.json'), {
    version: 1,
    sites: [
      { id: 'default', name: 'Primary', port: LEGACY_PORT, legacy: true },
      { id: 'second', name: 'Second site', port: SECOND_PORT },
    ],
  });
  const beforeSecond = manifest(dataDir);

  supervisor = startSupervisor();
  const legacyUp = await waitForHealth(LEGACY_PORT);
  const secondUp = await waitForHealth(SECOND_PORT);
  if (!legacyUp || !secondUp) console.log(supervisor.output());
  check(legacyUp, 'the original site still answers on 8090');
  check(secondUp, 'the second site answers on 8091');

  const twoSites = readJson(path.join(dataDir, 'sites.status.json'));
  const ids = twoSites && twoSites.sites ? twoSites.sites.map((site) => `${site.id}:${site.port}`) : [];
  check(ids.length === 2 && ids.includes('default:8090') && ids.includes('second:8091'), 'both sites are published to the panel', ids.join(' '));
  check(
    fs.existsSync(path.join(dataDir, 'sites', 'second', 'pb_data', 'data.db')),
    'the second site has its own database in data/sites/second',
  );
  check(
    sha256(path.join(dataDir, 'pb_data', 'data.db')) === beforeSecond.get('pb_data/data.db'),
    'the original database is untouched by the second site',
  );
  const afterSecond = manifest(dataDir);
  const legacyTouched = diffMaps(legacyData(beforeSecond), legacyData(afterSecond));
  check(legacyTouched.length === 0, 'no file in the original folder changed', legacyTouched.join(', '));
  check(fs.existsSync(path.join(dataDir, 'logs', 'site-second.log')), 'the second site logs to logs/site-second.log');
  check(fs.existsSync(path.join(dataDir, 'logs', 'pocketbase.log')), 'the original site keeps logs/pocketbase.log');

  /* ---------------- 3. a hard close must not leak port 8090 ---------------- */
  console.log('\nRecovery: the window is closed without a shutdown handler');
  const leftBehind = readJson(path.join(dataDir, 'runtime.json'));
  const pids = (leftBehind && leftBehind.sites ? leftBehind.sites : []).map((site) => Number(site.pocketbasePid)).filter(Boolean);
  supervisor.kill('SIGKILL');
  await sleep(600);
  check(pids.length === 2 && pids.every((pid) => isAlive(pid)), 'the two PocketBase processes outlive the killed launcher');

  supervisor = startSupervisor();
  const recovered = (await waitForHealth(LEGACY_PORT)) && (await waitForHealth(SECOND_PORT));
  if (!recovered) console.log(supervisor.output());
  check(recovered, 'the next start clears them and both ports answer again');
  await sleep(400);
  check(pids.every((pid) => !isAlive(pid)), 'the leftovers from the killed run are gone');

  await stopSupervisor(supervisor);
  console.log(`\n${failures.length === 0 ? 'All checks passed' : `${failures.length} check(s) failed`} — ${checks} checks\n`);
  if (KEEP) console.log(`Kept ${tmp} (KEEP=1)\n`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('the check itself failed:', error);
  if (!KEEP) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (ignored) {
      /* nothing to clean up */
    }
  }
  process.exit(1);
});
