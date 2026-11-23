#!/usr/bin/env node
/**
 * Proves the panel's ?site= handling without a phone or a Windows box: it boots
 * public/nodejs/server.js against a throwaway data folder that looks like a
 * two-site installation and checks every place the selection must reach.
 *
 *   node scripts/verify-panel-sites.mjs
 *
 * Covered: status, the file manager (list, download path, delete, upload), the backup
 * list, the private backup folder and its token-protected download, the backup command,
 * the per-site PocketBase log, the superuser card's installer/result scoping, the
 * per-site tunnel target and its command, per-site own addresses, the QR encoder behind
 * the public address, and that a single-site folder ignores ?site= completely.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
  // A zip an older build wrote into the published folder: still listed, flagged public.
  fs.writeFileSync(path.join(dir, 'pb_public', 'backups', 'pb-2026-11-01-1200.zip'), 'old public zip');
  // What the supervisor writes now: outside the web root, one folder per site.
  fs.mkdirSync(path.join(dir, 'backups', 'default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backups', 'default', 'pb-2026-11-20-0300.zip'), 'primary private zip');
  fs.mkdirSync(path.join(dir, 'backups', 'second'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backups', 'second', 'pb-2026-11-21-0300.zip'), 'second private zip');
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
  // What the supervisor writes while a quick tunnel serves the second site.
  writeJson(path.join(dir, 'tunnel.status.json'), {
    state: 'running',
    mode: 'quick',
    url: 'https://second-site.trycloudflare.com',
    port: 8091,
    siteId: 'second',
    message: 'Quick tunnel is live.',
    updatedAt: Date.now(),
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
    async raw(route, withToken = true) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        headers: withToken ? headers : {},
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, text: await response.text() };
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

    const secondList = (backups.body?.files || []).map((file) => `${file.name}:${file.public}`);
    check(
      secondList.includes('pb-2026-11-21-0300.zip:false'),
      'the second site’s new backup is listed as private',
      secondList.join(','),
    );
    check(
      backups.body?.directory === path.join(dir, 'backups', 'second') &&
        backups.body?.publicCount === 0,
      'the second site backs up outside its website folder',
      JSON.stringify([backups.body?.directory, backups.body?.publicCount]),
    );

    const primaryBackups = await api.get('/api/backup');
    const primaryList = (primaryBackups.body?.files || []).map((file) => `${file.name}:${file.public}`);
    check(
      primaryList.includes('pb-2026-11-20-0300.zip:false') &&
        primaryList.includes('pb-2026-11-01-1200.zip:true'),
      'the primary site keeps the old public zip listed, flagged public',
      primaryList.join(','),
    );
    check(primaryBackups.body?.publicCount === 1, 'and counts it as exposed', primaryBackups.body?.publicCount);

    const privateZip = await api.raw('/api/backup/pb-2026-11-21-0300.zip/download?site=second');
    check(
      privateZip.status === 200 && privateZip.text === 'second private zip',
      'a private backup downloads through the panel',
      `${privateZip.status}: ${privateZip.text?.slice(0, 24)}`,
    );
    const lockedZip = await api.raw('/api/backup/pb-2026-11-21-0300.zip/download?site=second', false);
    check(lockedZip.status === 401, 'and only with the panel token', lockedZip.status);
    const otherSiteZip = await api.raw('/api/backup/pb-2026-11-20-0300.zip/download?site=second');
    check(otherSiteZip.status === 404, 'another site’s private backup is not reachable', otherSiteZip.status);
    const traversal = await api.raw('/api/backup/..%2F..%2Fsettings.json/download?site=second');
    check(traversal.status === 400, 'a traversal in the backup name is refused', traversal.status);
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

    const tunnel = await api.get('/api/tunnel?site=second');
    check(
      join([tunnel.body?.targets?.panel, tunnel.body?.targets?.site, tunnel.body?.site?.id]) === `${TWO_SITE_PORT}|8091|second`,
      'the tunnel card targets the selected site’s port',
      JSON.stringify([tunnel.body?.targets, tunnel.body?.site]),
    );
    check(
      join([tunnel.body?.status?.siteId, tunnel.body?.status?.port]) === 'second|8091',
      'and reports which site the running address serves',
      JSON.stringify(tunnel.body?.status),
    );

    const primaryTunnel = await api.get('/api/tunnel');
    check(
      join([primaryTunnel.body?.targets?.site, primaryTunnel.body?.site?.id]) === '8090|default',
      'without ?site the tunnel card targets the primary site',
      JSON.stringify([primaryTunnel.body?.targets, primaryTunnel.body?.site]),
    );

    await api.post('/api/tunnel?site=second', { action: 'start', target: 'site', mode: 'quick' });
    let tunnelCommand = null;
    try {
      tunnelCommand = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.command.json'), 'utf8'));
    } catch (error) {
      /* asserted below */
    }
    check(
      tunnelCommand &&
        tunnelCommand.action === 'start' &&
        tunnelCommand.port === 8091 &&
        tunnelCommand.siteId === 'second',
      'the tunnel command carries the site id and its port',
      JSON.stringify(tunnelCommand),
    );

    await api.post('/api/tunnel', { action: 'start', target: 'panel', mode: 'quick', siteId: 'second' });
    try {
      tunnelCommand = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.command.json'), 'utf8'));
    } catch (error) {
      tunnelCommand = null;
    }
    check(
      tunnelCommand && tunnelCommand.port === TWO_SITE_PORT && tunnelCommand.siteId === '',
      'publishing the control panel ignores the site port',
      JSON.stringify(tunnelCommand),
    );

    const unknownSite = await api.post('/api/tunnel', {
      action: 'start',
      target: 'site',
      mode: 'quick',
      siteId: 'nope',
    });
    check(
      unknownSite.status === 400,
      'an unknown site is refused instead of silently publishing the primary site',
      unknownSite.status,
    );

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

    const domains = await api.get('/api/domains');
    check(
      join((domains.body?.sites || []).map((site) => `${site.id}:${site.hostname}`)) === 'default:|second:',
      'the own-address list starts empty for both sites',
      JSON.stringify(domains.body?.sites),
    );

    const saved = await api.post('/api/domains?site=second', { hostname: 'Shop.Example.com' });
    check(
      saved.status === 200 &&
        (saved.body?.sites || []).find((site) => site.id === 'second')?.hostname === 'shop.example.com',
      'a hostname is saved for that site, lowercased',
      JSON.stringify(saved.body?.sites),
    );
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    check(stored.domains?.second === 'shop.example.com', 'and lands in settings.json', JSON.stringify(stored.domains));

    const duplicate = await api.post('/api/domains', { hostname: 'shop.example.com' });
    check(duplicate.status === 409, 'the same address cannot belong to two sites', duplicate.status);
    const badHost = await api.post('/api/domains?site=second', { hostname: 'not a host' });
    check(badHost.status === 400, 'a hostname that is not one is refused', badHost.status);
    const noAddress = await api.post('/api/domains/check?site=default');
    check(noAddress.status === 400, 'checking needs a saved address first', noAddress.status);

    const cleared = await api.post('/api/domains?site=second', { hostname: '' });
    check(
      (cleared.body?.sites || []).find((site) => site.id === 'second')?.hostname === '',
      'an empty address clears it',
      JSON.stringify(cleared.body?.sites),
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

    const tunnel = await api.get('/api/tunnel?site=second');
    check(
      join([tunnel.body?.targets?.site, tunnel.body?.targets?.panel]) === `8090|${SINGLE_SITE_PORT}`,
      'the single-site tunnel still publishes 8090 and ignores ?site',
      JSON.stringify(tunnel.body?.targets),
    );

    const domains = await api.get('/api/domains');
    check(
      (domains.body?.sites || []).length === 1 &&
        domains.body.sites[0].id === 'default' &&
        domains.body.sites[0].port === 8090,
      'a single site can still be given an own address',
      JSON.stringify(domains.body?.sites),
    );
  } finally {
    panel.kill('SIGKILL');
  }
}

function qrCode() {
  console.log('\nTunnel QR code:');
  const require = createRequire(import.meta.url);
  const qr = require(path.join(ROOT, 'public', 'qr.js'));

  const url = 'https://second-site.trycloudflare.com';
  const code = qr.matrix(url);
  check(
    code.size === 17 + code.version * 4 && code.modules.length === code.size,
    'the QR matrix size matches its version',
    `${code.size}px / v${code.version}`,
  );

  // Each finder is a dark ring, a light inner ring and a dark 3x3 core.
  const finder = (row, column) =>
    code.modules[row][column] === 1 &&
    code.modules[row][column + 6] === 1 &&
    code.modules[row + 1][column + 1] === 0 &&
    code.modules[row + 2][column + 2] === 1 &&
    code.modules[row + 6][column + 6] === 1;
  check(
    finder(0, 0) && finder(0, code.size - 7) && finder(code.size - 7, 0),
    'all three finder patterns are in place',
  );

  const svg = qr.svg(url, { margin: 2 });
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  check(
    svg.startsWith('<svg') && viewBox !== null && Number(viewBox[1]) === code.size + 4,
    'the renderer surrounds the matrix with its quiet zone',
    viewBox && viewBox[1],
  );

  let refused = false;
  try {
    qr.matrix('x'.repeat(400));
  } catch (error) {
    refused = true;
  }
  check(refused, 'an address too long to encode is refused, not rendered broken');

  // The page needs the encoder before app.js runs, and the LAN/Windows copy needs it too.
  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check(
    page.indexOf('src="qr.js"') !== -1 && page.indexOf('src="qr.js"') < page.indexOf('src="app.js"'),
    'index.html loads qr.js before app.js',
  );
  const sync = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-ui.mjs'), 'utf8');
  check(sync.includes("'qr.js'"), 'sync-ui.mjs copies qr.js into the served dashboard');
}

async function main() {
  console.log(`\nPocket Server — panel ?site= check\n  folder ${tmp}`);
  try {
    await twoSites();
    await singleSite();
    qrCode();
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
