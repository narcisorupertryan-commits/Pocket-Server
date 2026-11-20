#!/usr/bin/env node
/**
 * Proves the panel's ?site= handling without a phone or a Windows box: it boots
 * public/nodejs/server.js against a throwaway data folder that looks like a
 * two-site installation and checks every place the selection must reach.
 *
 *   node scripts/verify-panel-sites.mjs
 *
 * Covered: status, the file manager (list, download path, delete, upload), the backup
 * list and the backup command, the per-site PocketBase log, the superuser card's
 * installer/result scoping, and that a single-site folder ignores ?site= completely.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = path.join(ROOT, 'public', 'nodejs', 'server.js');
const TWO_SITE_PORT = Number(process.env.PANEL_TEST_PORT || 8731);
const SINGLE_SITE_PORT = TWO_SITE_PORT + 1;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-panel-'));
const failures = [];
let checks = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(ok, label, detail) {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(label);
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function seedTwoSites(dir) {
  fs.mkdirSync(path.join(dir, 'pb_public', 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pb_public', 'index.html'), '<h1>primary</h1>');
  fs.mkdirSync(path.join(dir, 'sites', 'second', 'pb_public', 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sites', 'second', 'pb_public', 'only-second.txt'), 'second only');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'pocketbase.log'), 'primary-log line\n');
  fs.writeFileSync(path.join(dir, 'logs', 'site-second.log'), 'second-log line\n');

  writeJson(path.join(dir, 'installer.json'), {
    siteId: 'second',
    token: 'second-token',
    url: 'http://127.0.0.1:8091/_/#/pbinstall/second-token',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  writeJson(path.join(dir, 'superuser-result.json'), {
    siteId: 'second',
    ok: true,
    message: 'second site account saved',
    at: new Date().toISOString(),
  });
  writeJson(path.join(dir, 'sites.status.json'), {
    at: new Date().toISOString(),
    sites: [
      {
        id: 'default',
        name: 'Primary',
        port: 8090,
        legacy: true,
        state: 'running',
        pbData: path.join(dir, 'pb_data'),
        publicDir: path.join(dir, 'pb_public'),
        logName: 'pocketbase',
      },
      {
        id: 'second',
        name: 'Second site',
        port: 8091,
        legacy: false,
        state: 'running',
        pbData: path.join(dir, 'sites', 'second', 'pb_data'),
        publicDir: path.join(dir, 'sites', 'second', 'pb_public'),
        logName: 'site-second',
      },
    ],
  });
}

function startPanel(dataDir, port) {
  const child = spawn(process.execPath, [PANEL], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), POCKET_SERVER_DATA: dataDir, POCKET_SERVER_SUPERVISOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  const collect = (chunk) => {
    if (output.length < 60) output.push(String(chunk));
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.output = () => output.join('');
  return child;
}

async function waitForPanel(port) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return true;
    } catch (error) {
      /* not listening yet */
    }
    await sleep(250);
  }
  return false;
}

async function login(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '1234' }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  return data.token || '';
}

function client(port, token) {
  const headers = { 'x-pocket-token': token };
  return {
    async get(route) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    async del(route) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    async post(route, body) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    async upload(route, name, text) {
      const form = new FormData();
      form.append('files', new Blob([text]), name);
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  };
}

const names = (body) => (body && Array.isArray(body.body?.files) ? body.body.files.map((file) => file.name) : []);
const join = (parts) => parts.join('|');

async function twoSites() {
  const dir = path.join(tmp, 'two');
  fs.mkdirSync(dir, { recursive: true });
  seedTwoSites(dir);

  console.log('\nTwo sites:');
  const panel = startPanel(dir, TWO_SITE_PORT);
  try {
    if (!(await waitForPanel(TWO_SITE_PORT))) {
      console.log(panel.output());
      check(false, 'the panel starts');
      return;
    }
    const token = await login(TWO_SITE_PORT);
    const api = client(TWO_SITE_PORT, token);

    const status = await api.get('/api/status');
    check(
      join([status.body?.siteId, status.body?.sitePort, status.body?.sites?.length]) === 'default|8090|2',
      'status without ?site answers for the primary site',
      JSON.stringify([status.body?.siteId, status.body?.sitePort, status.body?.sites?.length]),
    );
    const secondStatus = await api.get('/api/status?site=second');
    check(
      join([secondStatus.body?.siteId, secondStatus.body?.sitePort]) === 'second|8091',
      'status?site=second answers for the second site',
      JSON.stringify([secondStatus.body?.siteId, secondStatus.body?.sitePort]),
    );
    const bogus = await api.get('/api/status?site=nope');
    check(join([bogus.body?.siteId, bogus.body?.sitePort]) === 'default|8090', 'an unknown site falls back to the primary');

    const primaryFiles = names(await api.get('/api/files'));
    check(
      primaryFiles.includes('index.html') && !primaryFiles.includes('only-second.txt'),
      'the file manager lists the primary folder',
      primaryFiles.join(','),
    );
    const secondFiles = await api.get('/api/files?site=second');
    check(
      names(secondFiles).includes('only-second.txt') && !names(secondFiles).includes('index.html'),
      'the file manager lists the second site',
      names(secondFiles).join(','),
    );
    check(
      secondFiles.body?.directory === path.join(dir, 'sites', 'second', 'pb_public'),
      'and reports that site’s directory',
      secondFiles.body?.directory,
    );

    check((await api.del('/api/files/only-second.txt')).status === 404, 'a delete without ?site cannot reach the second site');
    check((await api.del('/api/files/only-second.txt?site=second')).status === 200, 'a delete with ?site=second works');
    check(!fs.existsSync(path.join(dir, 'sites', 'second', 'pb_public', 'only-second.txt')), 'and the file is gone');

    const upload = await api.upload('/api/upload?site=second', 'via-second.txt', 'upload probe');
    check(upload.status === 200 && upload.body?.uploaded?.length === 1, 'an upload to ?site=second is accepted');
    check(
      fs.existsSync(path.join(dir, 'sites', 'second', 'pb_public', 'via-second.txt')) &&
        !fs.existsSync(path.join(dir, 'pb_public', 'via-second.txt')),
      'the upload landed in the second site only',
    );

    const backups = await api.get('/api/backup?site=second');
    check(backups.body?.siteId === 'second', 'the backup list names the site', backups.body?.siteId);
    await api.post('/api/backup?site=second');
    let command = null;
    try {
      command = JSON.parse(fs.readFileSync(path.join(dir, 'service.command.json'), 'utf8'));
    } catch (error) {
      /* asserted below */
    }
    check(
      command && command.action === 'backup' && command.siteId === 'second',
      'the backup command carries the siteId',
      JSON.stringify(command),
    );

    const primaryLog = await api.get('/api/logs?source=pocketbase');
    check(
      primaryLog.body?.file === 'pocketbase.log' && (primaryLog.body?.lines || []).some((line) => line.includes('primary-log')),
      'the Logs tab shows the primary site’s PocketBase log',
      JSON.stringify([primaryLog.body?.file, primaryLog.body?.lines]),
    );
    const secondLog = await api.get('/api/logs?source=pocketbase&site=second');
    check(
      secondLog.body?.file === 'site-second.log' &&
        (secondLog.body?.lines || []).some((line) => line.includes('second-log')) &&
        !(secondLog.body?.lines || []).some((line) => line.includes('primary-log')),
      'and switches to the second site’s log',
      JSON.stringify([secondLog.body?.file, secondLog.body?.lines]),
    );
    const tunnelLog = await api.get('/api/logs?source=cloudflared&site=second');
    check(tunnelLog.body?.file === 'cloudflared.log', 'the tunnel log stays shared across sites', tunnelLog.body?.file);

    const secondSuperuser = await api.get('/api/superuser?site=second');
    check(
      secondSuperuser.body?.result?.message === 'second site account saved' && secondSuperuser.body?.needsSetup === true,
      'the superuser card shows the second site’s installer and result',
      JSON.stringify(secondSuperuser.body),
    );
    const primarySuperuser = await api.get('/api/superuser');
    check(
      primarySuperuser.body?.result === null && primarySuperuser.body?.installer === null,
      'and the primary site does not see the second site’s setup',
      JSON.stringify(primarySuperuser.body),
    );
  } finally {
    panel.kill('SIGKILL');
  }
}

async function singleSite() {
  const dir = path.join(tmp, 'single');
  fs.mkdirSync(path.join(dir, 'pb_public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pb_public', 'index.html'), '<h1>primary</h1>');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'pocketbase.log'), 'primary-log line\n');

  console.log('\nOne site (no registry):');
  const panel = startPanel(dir, SINGLE_SITE_PORT);
  try {
    if (!(await waitForPanel(SINGLE_SITE_PORT))) {
      console.log(panel.output());
      check(false, 'the single-site panel starts');
      return;
    }
    const api = client(SINGLE_SITE_PORT, await login(SINGLE_SITE_PORT));

    const status = await api.get('/api/status');
    check(
      join([JSON.stringify(status.body?.siteId), status.body?.sitePort, status.body?.sites?.length]) === '"' + '"|8090|0',
      'the panel reports no site list and port 8090',
      JSON.stringify([status.body?.siteId, status.body?.sitePort, status.body?.sites?.length]),
    );
    const withParam = await api.get('/api/status?site=second');
    check(
      join([JSON.stringify(withParam.body?.siteId), withParam.body?.sitePort]) === '"' + '"|8090',
      'and ignores ?site= entirely',
      JSON.stringify([withParam.body?.siteId, withParam.body?.sitePort]),
    );
    const logs = await api.get('/api/logs?source=pocketbase&site=second');
    check(logs.body?.file === 'pocketbase.log', 'the single site still reads logs/pocketbase.log', logs.body?.file);
  } finally {
    panel.kill('SIGKILL');
  }
}

async function main() {
  console.log(`\nPocket Server — panel ?site= check\n  folder ${tmp}`);
  try {
    await twoSites();
    await singleSite();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${failures.length === 0 ? 'All checks passed' : `${failures.length} check(s) failed`} — ${checks} checks\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('the check itself failed:', error);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (ignored) {
    /* nothing to clean up */
  }
  process.exit(1);
});
