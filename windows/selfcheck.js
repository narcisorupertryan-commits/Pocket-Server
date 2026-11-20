'use strict';

/**
 * Support tool: prints what the portable folder can and cannot find, so a user on
 * Windows can paste one screen instead of describing a symptom.
 *
 *   node windows/selfcheck.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { loadSites, pathsFor } = require('./sites');

const ROOT = path.resolve(process.env.POCKET_SERVER_ROOT || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.POCKET_SERVER_DATA || path.join(ROOT, 'data'));
const POCKETBASE_PORT = Number(process.env.POCKETBASE_PORT) || 8090;
const PANEL_PORT = Number(process.env.PORT) || 8080;
const registry = loadSites({ dataDir: DATA_DIR, legacyPort: POCKETBASE_PORT });

const problems = [];

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(700);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

function get(port, route) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: route, timeout: 1500 }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ status: 0, body: '' });
    });
    request.on('error', () => resolve({ status: 0, body: '' }));
  });
}

function version(binary) {
  try {
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n')[0];
    return text || (result.error ? `error: ${result.error.message}` : 'no output');
  } catch (error) {
    return `error: ${error.message}`;
  }
}

async function main() {
  console.log('\nPocket Server — Windows self check\n');

  console.log('Environment');
  line('platform', `${process.platform} ${os.release()}`);
  line('node', process.execPath);
  line('node version', process.version);
  line('folder', ROOT);
  line('data folder', fs.existsSync(DATA_DIR) ? DATA_DIR : `${DATA_DIR} (missing)`);

  console.log('\nBinaries');
  const expected = [
    { label: 'pocketbase', override: process.env.POCKETBASE_BIN, file: process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase' },
    { label: 'cloudflared', override: process.env.CLOUDFLARED_BIN, file: process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared' },
  ];
  for (const entry of expected) {
    const candidates = [entry.override, path.join(ROOT, entry.file), path.join(ROOT, 'bin', entry.file)]
      .filter(Boolean)
      .map((candidate) => path.resolve(candidate));
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) {
      const size = `${(fs.statSync(found).size / 1048576).toFixed(1)} MiB`;
      line(entry.file, `${found} (${size}) — ${version(found)}`);
    } else {
      line(entry.file, 'not found next to the launcher');
      if (entry.label === 'pocketbase') {
        problems.push(`${entry.file} is missing: the database and the website will not run.`);
      }
    }
  }
  const panelEntry = path.join(ROOT, 'public', 'nodejs', 'server.js');
  line('panel', fs.existsSync(panelEntry) ? panelEntry : 'public/nodejs/server.js is missing');

  console.log('\nSites');
  line('registry', `${registry.file} (${registry.source})`);
  for (const problem of registry.problems) line('problem', problem);
  for (const site of registry.sites) {
    const paths = pathsFor(site, DATA_DIR);
    line(`${site.id} :${site.port}`, `${paths.pbData}${site.legacy ? ' (original folder)' : ''}`);
  }

  console.log('\nPorts');
  for (const port of [PANEL_PORT, PANEL_PORT + 1, ...registry.sites.map((site) => site.port)]) {
    line(String(port), (await probePort(port)) ? 'something is listening' : 'free');
  }

  console.log('\nAnswers');
  const health = await get(PANEL_PORT, '/api/health');
  line('panel /api/health', health.status ? `${health.status} ${health.body.slice(0, 80)}` : 'no answer');
  for (const site of registry.sites) {
    const answer = await get(site.port, '/api/health');
    line(`${site.id} /api/health`, answer.status ? `${answer.status} ${answer.body.slice(0, 80)}` : 'no answer');
    if (!answer.status) {
      problems.push(`site "${site.id}" is not answering on ${site.port} — check data/logs/${pathsFor(site, DATA_DIR).logName}.log.`);
    }
  }

  console.log('\nData');
  for (const file of ['sites.json', 'sites.status.json', 'settings.json', 'power.status.json', 'tunnel.status.json', 'backup.status.json', 'installer.json']) {
    const full = path.join(DATA_DIR, file);
    if (!fs.existsSync(full)) {
      line(file, 'absent');
      continue;
    }
    const text = fs.readFileSync(full, 'utf8');
    line(file, text.length > 110 ? `${text.slice(0, 110)}…` : text);
  }
  const logDir = path.join(DATA_DIR, 'logs');
  line('logs', fs.existsSync(logDir) ? fs.readdirSync(logDir).join(', ') || 'empty' : 'missing');

  console.log(`\n${problems.length ? 'Problems:' : 'No blocking problems found.'}`);
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log('');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('self check failed:', error.message);
  process.exit(1);
});
