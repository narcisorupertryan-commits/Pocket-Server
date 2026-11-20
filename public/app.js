'use strict';

/* Pocket Server dashboard.
 *
 * Runs in two places with the same code:
 *   - inside the APK's WebView (origin http://localhost) talking to the Node
 *     server on http://127.0.0.1:8080,
 *   - in any browser on the LAN, where the page is served by that same Node
 *     server, so relative URLs already point at the right place.
 */

const STORAGE_KEY = 'pocket-server-token';
const SITE_KEY = 'pocket-server-site';
const DEFAULT_PORT = '8080';
// The same panel runs on the phone and on a PC. Only the wording differs, and it is
// decided from the browser that opened the page rather than from the server, so the
// screen is right even before the first status poll answers.
const IS_PC = (() => {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
  return /Windows NT|Macintosh|X11; Linux/i.test(agent) && !/Android|iPhone|iPad|Mobile/i.test(agent);
})();
const DEVICE_LABEL = IS_PC ? 'PC' : 'phone';
// Replaced with the package version by scripts/sync-ui.mjs, so the screen that loads
// inside the APK can show which build's UI it is actually running.
const UI_VERSION = (typeof window !== 'undefined' && window.POCKET_UI_VERSION) || 'dev build';
const POLL_MS = 2500;

const state = {
  token: localStorage.getItem(STORAGE_KEY) || '',
  apiBase: '',
  apiBaseResolved: false,
  status: null,
  files: [],
  tab: 'dashboard',
  uploading: false,
  tunnel: 'stopped',
  logSource: 'pocketbase',
  bootFailures: 0,
  // Which site the dashboard is showing. Empty means the primary one, and a
  // single-site server never sets it, so those panels look exactly as before.
  siteId: localStorage.getItem(SITE_KEY) || '',
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

async function reachable(base) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${base}/api/health`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    // Inside the APK the page is served by Capacitor's own local server, which answers
    // unknown paths with index.html and a 200 — a bare response.ok() would bind every
    // API call to that server instead of Pocket Server. Only our health payload counts.
    const data = await response.json().catch(() => null);
    return Boolean(data && data.ok === true);
  } catch (error) {
    return false;
  }
}

// The panel may not be on 8080: anything else on the phone can hold that port, and the
// server then falls back to the next free one. It publishes the port it got into
// PocketBase's public folder, which is readable even while the panel is down.
async function discoverPanelPort() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${DIAG_BASE}/__panel-port.txt`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const port = Number((await response.text()).trim());
    return Number.isFinite(port) && port > 0 && port < 65536 ? port : null;
  } catch (error) {
    return null;
  }
}

async function resolveApiBase() {
  if (state.apiBaseResolved) return true;

  const candidates = [''];
  const published = await discoverPanelPort();
  if (published) candidates.push(`http://127.0.0.1:${published}`);
  for (const port of [8080, 8081, 8082, 8083]) {
    const base = `http://127.0.0.1:${port}`;
    if (!candidates.includes(base)) candidates.push(base);
  }

  // Probe together: six sequential 1.5s timeouts would take nine seconds.
  const results = await Promise.all(candidates.map((base) => reachable(base)));
  const hit = results.indexOf(true);
  if (hit === -1) return false;

  state.apiBase = candidates[hit];
  state.apiBaseResolved = true;
  return true;
}

function setServerState(kind, text) {
  const dot = $('server-state-dot');
  const label = $('server-state-text');
  label.textContent = text;
  dot.className = 'inline-block size-1.5 rounded-full ' + {
    online: 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60',
    offline: 'bg-rose-500',
    pending: 'bg-amber-400 animate-pulse',
    locked: 'bg-slate-500',
  }[kind];
}

async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (state.token) headers['X-Pocket-Token'] = state.token;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${state.apiBase}${path}`, {
    ...options,
    headers,
    cache: 'no-store',
  });

  if (response.status === 401) {
    lock();
    throw new Error('locked');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toast(message, kind = 'info') {
  const host = $('toast');
  const node = document.createElement('div');
  const tone =
    kind === 'error'
      ? 'border-rose-500/40 bg-rose-500/15 text-rose-200'
      : kind === 'success'
        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
        : 'border-slate-700 bg-slate-900 text-slate-200';
  node.className = `pointer-events-auto max-w-sm rounded-xl border px-3.5 py-2.5 text-xs font-medium shadow-xl backdrop-blur transition ${tone}`;
  node.textContent = message;
  host.replaceChildren(node);
  setTimeout(() => {
    if (host.contains(node)) host.replaceChildren();
  }, 3200);
}

/* ------------------------------------------------------------------ *
 * Gate
 * ------------------------------------------------------------------ */

function showGate(message) {
  const gate = $('gate');
  gate.classList.remove('hidden');
  gate.classList.add('flex');
  const error = $('gate-error');
  if (message) {
    error.textContent = message;
    error.classList.remove('hidden');
  } else {
    error.classList.add('hidden');
  }
  setTimeout(() => $('gate-pin').focus(), 60);
}

function hideGate() {
  const gate = $('gate');
  gate.classList.add('hidden');
  gate.classList.remove('flex');
  $('gate-pin').value = '';
  $('gate-error').classList.add('hidden');
}

function lock() {
  state.token = '';
  localStorage.removeItem(STORAGE_KEY);
  state.status = null;
  state.files = [];
  state.apiBaseResolved = false;
  setServerState('locked', 'locked');
  $('logout').classList.add('hidden');
  showGate();
}

async function unlock(pin) {
  const response = await fetch(`${state.apiBase}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || `Could not unlock (HTTP ${response.status}).`);
  if (!data || typeof data.token !== 'string' || !data.token) {
    throw new Error(
      'That address answered, but it is not Pocket Server — the PIN was never checked. Make sure the server is running, then try again.',
    );
  }
  state.token = data.token;
  localStorage.setItem(STORAGE_KEY, data.token);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function setTab(tab) {
  state.tab = tab;
  const active = 'bg-slate-100 text-slate-950 shadow';
  const idle = 'text-slate-400 hover:text-white';

  for (const name of ['dashboard', 'files', 'logs']) {
    const button = $(`tab-btn-${name}`);
    button.className = `rounded-lg px-2 py-2 text-sm font-medium transition ${tab === name ? active : idle}`;
    button.setAttribute('aria-selected', String(tab === name));
    $(`tab-${name}`).classList.toggle('hidden', tab !== name);
  }

  if (tab === 'files') refreshFiles().catch(() => {});
  if (tab === 'logs') refreshLogs().catch(() => {});
}

function asPort(value, fallback) {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : fallback;
}

// Every URL is built from these, never straight from the payload: a partial or
// older-shaped /api/status response must not turn into "http://host:undefined".
function panelPort(status) {
  return asPort(status && (status.panelPort || status.port), asPort(location.port, Number(DEFAULT_PORT)));
}

function sitePort(status) {
  return asPort(status && status.pocketbase && status.pocketbase.port, 8090);
}

function lanHost(status) {
  const list = status && status.addresses;
  if (Array.isArray(list) && list.length > 0 && list[0] && list[0].address) return list[0].address;
  return '<server-ip>';
}

function reachableHost(status) {
  const list = status && status.addresses;
  if (Array.isArray(list) && list.length > 0 && list[0] && list[0].address) return list[0].address;
  return location.hostname || '127.0.0.1';
}

function primaryAddress(status) {
  if (!status) return '';
  return `http://${lanHost(status)}:${panelPort(status)}`;
}

/* ------------------------------------------------------------------ *
 * PocketBase superuser and backups
 * ------------------------------------------------------------------ */

let extrasAt = 0;

// Both change rarely, so this is throttled and safe to call from renderStatus.
async function refreshExtras(force) {
  if (!force && Date.now() - extrasAt < 20000) return;
  extrasAt = Date.now();
  await Promise.all([loadSuperuser(), loadBackup(), loadPower()]);
}

/* ------------------------------------------------------------------ *
 * Theme: system / light / dark
 * ------------------------------------------------------------------ */

const THEME_KEY = 'pocket-theme';
const THEME_MODES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'system', light: 'light', dark: 'dark' };

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return THEME_MODES.includes(value) ? value : 'system';
  } catch (error) {
    return 'system';
  }
}

function systemPrefersDark() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(mode, persist) {
  const dark = mode === 'dark' || (mode === 'system' && systemPrefersDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', dark ? '#020617' : '#f2f6fa');

  for (const name of THEME_MODES) {
    const icon = $(`theme-icon-${name}`);
    if (icon) icon.classList.toggle('hidden', name !== mode);
  }

  const button = $('theme-toggle');
  if (button) {
    button.title = `Theme: ${THEME_LABELS[mode]}`;
    button.setAttribute('aria-label', `Theme: ${THEME_LABELS[mode]}`);
  }

  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch (error) {
      // Private mode or a full quota: the choice just does not survive a reload.
    }
  }
}

function cycleTheme() {
  const next = THEME_MODES[(THEME_MODES.indexOf(storedTheme()) + 1) % THEME_MODES.length];
  applyTheme(next, true);
}

function initTheme() {
  applyTheme(storedTheme(), false);

  if (window.matchMedia) {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (storedTheme() === 'system') applyTheme('system', false);
    };
    if (query.addEventListener) query.addEventListener('change', onChange);
    else if (query.addListener) query.addListener(onChange);
  }
}

async function loadPower() {
  const button = $('power-toggle');
  if (!button) return;

  let data;
  try {
    data = await api('/api/power');
  } catch (error) {
    return;
  }

  const on = data.on !== false;
  button.setAttribute('aria-checked', on ? 'true' : 'false');
  button.title = on ? 'Servers on — tap to stop' : 'Servers off — tap to start';
}

async function togglePower() {
  const button = $('power-toggle');
  const want = button.getAttribute('aria-checked') !== 'true';

  button.disabled = true;
  try {
    await api('/api/power', { method: 'POST', body: JSON.stringify({ on: want }) });
    toast(want ? 'Starting the servers…' : 'Stopping the servers…');
    // The service stops/starts PocketBase, which takes a moment.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const data = await api('/api/power').catch(() => null);
      if (data && data.on === want) break;
    }
    await refreshExtras(true);
    toast(want ? 'Servers are on' : 'Servers are off', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function verifyIntegrity() {
  const button = $('integrity-check');
  const result = $('integrity-result');
  button.disabled = true;
  result.textContent = 'Hashing hosted files…';

  try {
    const data = await api('/api/integrity');
    if (data.ok) {
      const extra = data.untracked.length ? ` · ${data.untracked.length} without a checksum` : '';
      result.textContent = `All ${data.checked} tracked file${data.checked === 1 ? '' : 's'} match${extra}`;
      result.className = 'min-w-0 flex-1 truncate text-[11px] text-emerald-300';
      toast('Files verified', 'success');
    } else {
      const parts = [];
      if (data.changed.length) parts.push(`${data.changed.length} changed`);
      if (data.missing.length) parts.push(`${data.missing.length} missing`);
      result.textContent = `Problem: ${parts.join(', ')}`;
      result.className = 'min-w-0 flex-1 truncate text-[11px] text-rose-300';
      toast(`Integrity problem: ${parts.join(', ')}`, 'error');
    }
  } catch (error) {
    result.textContent = error.message;
    result.className = 'min-w-0 flex-1 truncate text-[11px] text-rose-300';
  } finally {
    button.disabled = false;
  }
}

async function loadSuperuser() {
  if (!$('superuser-state')) return;

  let data;
  try {
    data = await api(withSite('/api/superuser'));
  } catch (error) {
    return;
  }

  const badge = $('superuser-badge');
  const save = $('superuser-save');

  if (data.needsSetup) {
    badge.textContent = 'not created';
    badge.className =
      'shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300';
    $('superuser-state').textContent =
      'No superuser yet. Create one below to unlock the admin UI, collections, user accounts and the REST API. It cannot be created by just opening Admin — PocketBase changed that in 0.23.';
    save.textContent = 'Create superuser';
  } else {
    badge.textContent = 'ready';
    badge.className =
      'shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300';
    $('superuser-state').textContent =
      'A superuser exists. Use the fields below to add another or to reset a forgotten password.';
    save.textContent = 'Save superuser';
  }

  const installer = data.installer;
  const box = $('superuser-installer');
  if (installer) {
    box.classList.remove('hidden');
    const link = installer.expired ? '' : installer.lanUrl || installer.url;
    const anchor = $('superuser-installer-link');
    anchor.textContent = link || 'Link expired — restart PocketBase for a new one';
    anchor.href = link || '#';
    anchor.dataset.url = link;
  } else {
    box.classList.add('hidden');
  }

  if (data.result && data.result.message) {
    $('superuser-hint').textContent = data.result.message;
    $('superuser-hint').className = data.result.ok
      ? 'mt-2 text-xs text-emerald-300'
      : 'mt-2 text-xs text-rose-300';
  }
}

async function saveSuperuser(event) {
  event.preventDefault();
  const email = $('superuser-email').value.trim();
  const password = $('superuser-password').value;
  const button = $('superuser-save');
  const label = button.textContent;

  if (!email) {
    toast('Enter an email address.', 'error');
    return;
  }
  if (password.length < 8) {
    toast('PocketBase needs a password of at least 8 characters.', 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await api(withSite('/api/superuser'), { method: 'POST', body: JSON.stringify({ email, password }) });
    $('superuser-password').value = '';
    toast('PocketBase is writing the account…');

    // The service stops the database, runs the CLI and starts it again: wait for the result.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const data = await api(withSite('/api/superuser')).catch(() => null);
      if (data && data.result && data.result.message) {
        toast(data.result.message, data.result.ok ? 'success' : 'error');
        break;
      }
    }
    await refreshExtras(true);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function loadBackup() {
  if (!$('backup-state')) return;

  let data;
  try {
    data = await api(withSite('/api/backup'));
  } catch (error) {
    return;
  }

  const status = data.status;
  if (status && status.ok) {
    $('backup-state').textContent = `Last backup ${formatDate(status.at)} · ${formatBytes(status.bytes || 0)} · the newest 7 are kept.`;
  } else if (status && status.error) {
    $('backup-state').textContent = `The last backup failed: ${status.error}`;
  } else {
    $('backup-state').textContent = 'No backup yet. One runs nightly at 03:00, or start one now.';
  }

  const list = $('backup-list');
  list.replaceChildren();
  for (const file of (data.files || []).slice(0, 5)) {
    const row = document.createElement('li');
    row.className = 'flex items-center justify-between gap-2 text-[11px] text-slate-400';

    const link = document.createElement('a');
    link.href = `http://${reachableHost(state.status)}:${sitePort(state.status)}/backups/${encodeURIComponent(file.name)}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.className = 'truncate font-mono text-sky-300 hover:underline';
    link.textContent = file.name;

    const size = document.createElement('span');
    size.textContent = formatBytes(file.bytes || 0);

    row.append(link, size);
    list.append(row);
  }
}

async function backupNow() {
  const button = $('backup-now');
  button.disabled = true;
  try {
    await api(withSite('/api/backup'), { method: 'POST' });
    toast('Backup started — PocketBase pauses for a moment.');
    setTimeout(() => refreshExtras(true).catch(() => {}), 5000);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setTimeout(() => {
      button.disabled = false;
    }, 5000);
  }
}

function siteList(status) {
  return status && Array.isArray(status.sites) ? status.sites : [];
}

function selectedSite(status) {
  const list = siteList(status);
  if (list.length === 0) return null;
  return list.find((site) => site.id === state.siteId) || list.find((site) => site.legacy) || list[0];
}

/** Adds ?site= so a multi-site panel answers for the site on screen. */
function withSite(path) {
  if (!state.siteId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}site=${encodeURIComponent(state.siteId)}`;
}

/** The picker only appears when there is more than one site. */
function renderSiteSwitcher(status) {
  const row = $('site-switcher-row');
  const select = $('site-switcher');
  if (!row || !select) return;

  const list = siteList(status);
  if (list.length <= 1) {
    row.classList.add('hidden');
    row.classList.remove('flex');
    select.replaceChildren();
    if (state.siteId) {
      state.siteId = '';
      localStorage.removeItem(SITE_KEY);
    }
    return;
  }

  const active = selectedSite(status);
  if (active && active.id !== state.siteId) {
    state.siteId = active.id;
    localStorage.setItem(SITE_KEY, state.siteId);
  }

  row.classList.remove('hidden');
  row.classList.add('flex');
  select.replaceChildren();
  for (const site of list) {
    const option = document.createElement('option');
    option.value = site.id;
    const port = site.port ? ` · :${site.port}` : '';
    const state = site.state && site.state !== 'running' ? ` (${site.state})` : '';
    option.textContent = `${site.name || site.id}${port}${state}`;
    select.append(option);
  }
  if (active) select.value = active.id;
}

function renderStatus(status) {
  state.status = status;
  renderSiteSwitcher(status);
  setServerState('online', 'online');
  if ($('offline-help')) $('offline-help').classList.add('hidden');

  const badge = $('status-badge');
  badge.textContent = 'online';
  badge.className =
    'rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300';
  $('status-headline').textContent = `Listening on port ${panelPort(status)}`;

  $('metric-memory').textContent = formatBytes((status.memory && status.memory.rss) || 0);
  $('metric-uptime').textContent = formatUptime(status.uptimeSeconds || 0);

  const load = status.loadAverage;
  $('metric-load').textContent =
    Array.isArray(load) && load.length >= 2 ? `${load[0].toFixed(2)} / ${load[1].toFixed(2)}` : 'n/a';

  $('metric-files').textContent = `${(status.files && status.files.count) || 0} · ${formatBytes((status.files && status.files.bytes) || 0)}`;

  $('runtime-node').textContent = status.node || 'unknown';
  $('runtime-platform').textContent = `${status.platform || 'unknown'} · ${status.arch || 'unknown'}`;
  $('runtime-port').textContent = `0.0.0.0:${panelPort(status)}`;
  if ($('tunnel-target-panel')) {
    $('tunnel-target-panel').textContent = `Control panel (${panelPort(status)})`;
  }
  if ($('runtime-ui')) {
    $('runtime-ui').textContent = UI_VERSION === '__POCKET_UI_VERSION__' ? 'dev copy' : UI_VERSION;
  }

  $('pin-warning').classList.toggle('hidden', !status.defaultPin);

  const pocketbasePort = sitePort(status);
  const host = reachableHost(status);
  const siteUrl = `http://${host}:${pocketbasePort}/`;
  const adminUrl = `http://${host}:${pocketbasePort}/_/`;
  $('site-url').textContent = siteUrl;
  $('admin-url').textContent = adminUrl;
  $('site-link').href = siteUrl;
  $('admin-link').href = adminUrl;

  const list = $('address-list');
  list.replaceChildren();
  const addresses = status.addresses && status.addresses.length > 0 ? status.addresses : [{ name: 'server', address: '<server-ip>' }];
  for (const entry of addresses) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'flex w-full items-center justify-between gap-3 rounded-xl bg-slate-950/70 px-3 py-2.5 text-left ring-1 ring-slate-800 transition hover:ring-emerald-500/50';
    const url = `http://${entry.address}:${panelPort(status)}`;

    const left = document.createElement('span');
    left.className = 'min-w-0';
    const address = document.createElement('span');
    address.className = 'block truncate font-mono text-sm text-emerald-300';
    address.textContent = url;
    const name = document.createElement('span');
    name.className = 'block text-[11px] text-slate-500';
    name.textContent = entry.name === 'server' ? "find this device's IP in its network settings" : entry.name;
    left.append(address, name);

    row.append(left);
    row.addEventListener('click', () => copy(url));
    list.append(row);
  }

  // Throttled internally: superuser state and backups change rarely.
  refreshExtras().catch(() => {});
}

function renderFiles(files) {
  state.files = files || [];
  const list = $('files-list');
  const empty = $('files-empty');
  list.replaceChildren();

  const totals = state.files.reduce((sum, file) => sum + (file.size || 0), 0);
  $('files-summary').textContent =
    state.files.length === 0 ? 'No files yet' : `${state.files.length} file${state.files.length === 1 ? '' : 's'} · ${formatBytes(totals)}`;

  empty.classList.toggle('hidden', state.files.length > 0);

  for (const file of state.files) {
    const item = document.createElement('li');
    item.className = 'flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5';

    const info = document.createElement('div');
    info.className = 'min-w-0 flex-1';
    const name = document.createElement('p');
    name.className = 'truncate text-sm font-medium text-white';
    name.textContent = file.name;
    name.title = file.name;
    const meta = document.createElement('p');
    meta.className = 'text-[11px] text-slate-500';
    meta.textContent = `${formatBytes(file.size)} · ${formatDate(file.modified)}`;
    info.append(name, meta);

    name.title = 'Tap to copy the public URL';
    name.classList.add('cursor-pointer');
    name.addEventListener('click', () => copy(publicUrl(file.name)));

    const action = (label, tone, handler) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `shrink-0 rounded-lg border border-slate-700 px-2 py-1.5 text-[11px] font-medium text-slate-300 transition ${tone}`;
      button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    };

    item.append(
      info,
      action('Get', 'hover:border-emerald-500/60 hover:text-emerald-300', () => downloadFile(file.name)),
      action('Rename', 'hover:border-sky-500/60 hover:text-sky-300', () => renameFile(file.name)),
      action('Delete', 'hover:border-rose-500/60 hover:text-rose-300', () => deleteFile(file.name)),
    );
    list.append(item);
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    $('copy-hint').classList.remove('hidden');
    setTimeout(() => $('copy-hint').classList.add('hidden'), 2000);
  } catch (error) {
    toast(text, 'info');
  }
}

async function refreshStatus() {
  const data = await api(withSite('/api/status'));
  // Tolerate both shapes: the flat payload, or one that nests the server object
  // under "status" (which would otherwise render as the string "online").
  const status = data && typeof data.status === 'object' && data.status !== null ? data.status : data;
  renderStatus(status);
  refreshTunnel().catch(() => {});
}

async function refreshFiles() {
  const data = await api(withSite('/api/files'));
  renderFiles(data.files);
}

async function refreshTunnel() {
  const data = await api('/api/tunnel');
  renderTunnel(data.status || { state: 'stopped' }, data.available !== false, Boolean(data.named && data.named.configured));
}

async function refreshLogs() {
  const data = await api(`/api/logs?source=${state.logSource}&lines=300`);
  const output = $('logs-output');
  output.textContent = data.empty
    ? 'No output yet. This view shows the log files the Android service writes for each process — restart one below if you expect output.'
    : data.lines.join('\n');
  output.scrollTop = output.scrollHeight;
  $('logs-meta').textContent = data.updatedAt
    ? `${state.logSource} · updated ${new Date(data.updatedAt).toLocaleTimeString()}`
    : `${state.logSource} · no log file yet`;

  for (const name of ['pocketbase', 'cloudflared']) {
    const button = $(`log-src-${name}`);
    const isActive = name === state.logSource;
    button.className = `rounded-lg px-3 py-1.5 text-xs font-medium transition ${
      isActive ? 'bg-slate-100 text-slate-950' : 'text-slate-400 hover:text-white'
    }`;
  }
}

async function restartSelectedService() {
  const action = state.logSource === 'pocketbase' ? 'restart-pocketbase' : 'restart-tunnel';
  try {
    await api(withSite('/api/service'), { method: 'POST', body: JSON.stringify({ action }) });
    toast(`Restart requested for ${state.logSource}`, 'success');
    setTimeout(() => refreshLogs().catch(() => {}), 2000);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function updateTunnelModeUi() {
  const named = $('tunnel-mode').value === 'named';
  $('tunnel-token').classList.toggle('hidden', !named);
  $('tunnel-token-save').classList.toggle('hidden', !named);
  $('tunnel-token-note').classList.toggle('hidden', !named);
  $('tunnel-target').disabled = named;
}

async function saveTunnelToken() {
  const token = $('tunnel-token').value.trim();
  try {
    const data = await api('/api/tunnel/token', { method: 'POST', body: JSON.stringify({ token }) });
    $('tunnel-token').value = '';
    toast(data.configured ? 'Tunnel token saved' : 'Tunnel token cleared', 'success');
    refreshTunnel().catch(() => {});
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderTunnel(status, available, namedConfigured) {
  const current = status.state || 'stopped';
  state.tunnel = current;

  // While a tunnel is up, mirror what is actually running into the pickers.
  if (current === 'running' || current === 'starting') {
    $('tunnel-mode').value = status.mode === 'named' ? 'named' : 'quick';
    updateTunnelModeUi();
  }

  if ($('tunnel-mode').value === 'named') {
    $('tunnel-token-note').textContent = namedConfigured
      ? 'Token saved on this device. The public hostname is whatever you point at this server in the Cloudflare dashboard.'
      : 'No token saved yet — create a tunnel in the Cloudflare dashboard and paste its token here.';
  }

  const tones = {
    stopped: 'border-slate-700 text-slate-300',
    starting: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    running: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    error: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  };

  const badge = $('tunnel-badge');
  badge.textContent = current;
  badge.className = `rounded-full border px-2.5 py-1 text-[11px] font-medium ${tones[current] || tones.stopped}`;

  const busy = current === 'running' || current === 'starting';
  const toggle = $('tunnel-toggle');
  toggle.textContent = busy ? 'Stop' : 'Start';
  toggle.disabled = !available;
  toggle.classList.toggle('opacity-40', !available);

  const row = $('tunnel-url-row');
  if (current === 'running' && status.url) {
    row.classList.remove('hidden');
    row.classList.add('flex');
    $('tunnel-url').textContent = status.url;
    $('tunnel-url').href = status.url;
  } else {
    row.classList.add('hidden');
    row.classList.remove('flex');
  }

  const message = $('tunnel-message');
  if (current === 'error') {
    message.textContent = status.message || 'cloudflared could not start.';
    message.className = 'mt-2 text-xs text-rose-400';
  } else if (current === 'starting') {
    message.textContent = 'Asking Cloudflare for a public address…';
    message.className = 'mt-2 text-xs text-amber-300';
  } else if (current === 'running') {
    message.textContent = 'This address is public. Anyone with the link reaches the server behind the PIN.';
    message.className = 'mt-2 text-xs text-slate-500';
  } else {
    message.textContent = 'Anyone with the address can reach this server. Keep the PIN strong.';
    message.className = 'mt-2 text-xs text-slate-500';
  }

  if (!available) {
    message.textContent = 'The tunnel is unavailable in this build — it needs a build that bundles cloudflared.';
    message.className = 'mt-2 text-xs text-slate-500';
  }
}

async function toggleTunnel() {
  if ($('tunnel-toggle').disabled) return;
  const running = state.tunnel === 'running' || state.tunnel === 'starting';
  const action = running ? 'stop' : 'start';

  try {
    await api('/api/tunnel', {
      method: 'POST',
      body: JSON.stringify({ action, target: $('tunnel-target').value, mode: $('tunnel-mode').value }),
    });
    $('tunnel-badge').textContent = action === 'start' ? 'starting' : 'stopping';
    setTimeout(() => refreshTunnel().catch(() => {}), 1500);
    setTimeout(() => refreshTunnel().catch(() => {}), 4000);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function downloadFile(name) {
  try {
    const response = await fetch(`${state.apiBase}${withSite(`/api/files/${encodeURIComponent(name)}/download`)}`, {
      headers: state.token ? { 'X-Pocket-Token': state.token } : {},
    });
    if (response.status === 401) {
      lock();
      return;
    }
    if (!response.ok) throw new Error(`Download failed (${response.status})`);

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteFile(name) {
  if (!window.confirm(`Delete "${name}" from the server?`)) return;
  try {
    const data = await api(withSite(`/api/files/${encodeURIComponent(name)}`), { method: 'DELETE' });
    renderFiles(data.files);
    toast(`Deleted ${name}`, 'success');
    refreshStatus().catch(() => {});
  } catch (error) {
    toast(error.message, 'error');
  }
}

function publicUrl(fileName) {
  return `http://${reachableHost(state.status)}:${sitePort(state.status)}/${encodeURIComponent(fileName)}`;
}

async function renameFile(name) {
  const next = window.prompt(`New name for "${name}"`, name);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === name) return;

  try {
    const data = await api(withSite(`/api/files/${encodeURIComponent(name)}/rename`), {
      method: 'POST',
      body: JSON.stringify({ name: trimmed }),
    });
    renderFiles(data.files);
    toast(`Renamed to ${trimmed}`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0 || state.uploading) return;

  state.uploading = true;
  const wrap = $('upload-progress');
  const bar = $('upload-bar');
  const percent = $('upload-percent');
  const label = $('upload-label');
  wrap.classList.remove('hidden');
  bar.style.width = '0%';
  percent.textContent = '0%';
  label.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`;

  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);

  const request = new XMLHttpRequest();
  request.open('POST', `${state.apiBase}${withSite('/api/upload')}`);
  if (state.token) request.setRequestHeader('X-Pocket-Token', state.token);

  request.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const value = Math.round((event.loaded / event.total) * 100);
    bar.style.width = `${value}%`;
    percent.textContent = `${value}%`;
  });

  request.addEventListener('load', () => {
    state.uploading = false;
    wrap.classList.add('hidden');
    if (request.status === 401) {
      lock();
      return;
    }
    if (request.status >= 200 && request.status < 300) {
      try {
        const data = JSON.parse(request.responseText || '{}');
        renderFiles(data.files);
        toast(`Uploaded ${data.uploaded.length} file${data.uploaded.length === 1 ? '' : 's'}`, 'success');
        refreshStatus().catch(() => {});
      } catch (error) {
        toast('Upload finished but the reply could not be read.', 'error');
      }
    } else {
      let message = `Upload failed (${request.status})`;
      try {
        message = JSON.parse(request.responseText).error || message;
      } catch (error) {
        /* keep the fallback message */
      }
      toast(message, 'error');
    }
  });

  request.addEventListener('error', () => {
    state.uploading = false;
    wrap.classList.add('hidden');
    toast('Upload failed — is the server still running?', 'error');
  });

  request.send(form);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function wireEvents() {
  $('tab-btn-dashboard').addEventListener('click', () => setTab('dashboard'));
  $('tab-btn-files').addEventListener('click', () => setTab('files'));
  $('tab-btn-logs').addEventListener('click', () => setTab('logs'));

  $('copy-address').addEventListener('click', () => copy(primaryAddress(state.status)));
  $('site-copy').addEventListener('click', () => copy($('site-url').textContent));
  if ($('site-switcher')) {
    $('site-switcher').addEventListener('change', (event) => {
      state.siteId = event.target.value;
      localStorage.setItem(SITE_KEY, state.siteId);
      // Files, backups and the superuser card all belong to the site being shown.
      refreshStatus().catch(() => {});
      refreshFiles().catch(() => {});
      refreshExtras(true).catch(() => {});
    });
  }
  $('admin-copy').addEventListener('click', () => copy($('admin-url').textContent));
  if ($('superuser-form')) $('superuser-form').addEventListener('submit', saveSuperuser);
  if ($('superuser-installer-copy')) {
    $('superuser-installer-copy').addEventListener('click', () => {
      const url = $('superuser-installer-link').dataset.url;
      if (url) copy(url);
    });
  }
  if ($('backup-now')) $('backup-now').addEventListener('click', backupNow);
  if ($('power-toggle')) $('power-toggle').addEventListener('click', togglePower);
  if ($('theme-toggle')) $('theme-toggle').addEventListener('click', cycleTheme);
  initTheme();
  if ($('integrity-check')) $('integrity-check').addEventListener('click', verifyIntegrity);
  $('tunnel-toggle').addEventListener('click', toggleTunnel);
  $('tunnel-copy').addEventListener('click', () => copy($('tunnel-url').textContent));
  $('offline-retry').addEventListener('click', () => {
    state.apiBaseResolved = false;
    state.bootFailures = 0;
    boot();
    probeDiagnostics().catch(() => {});
  });

  $('tunnel-mode').addEventListener('change', updateTunnelModeUi);
  $('tunnel-token-save').addEventListener('click', saveTunnelToken);

  for (const name of ['pocketbase', 'cloudflared']) {
    $(`log-src-${name}`).addEventListener('click', () => {
      state.logSource = name;
      refreshLogs().catch((error) => toast(error.message, 'error'));
    });
  }
  $('logs-refresh').addEventListener('click', () => {
    refreshLogs()
      .then(() => toast('Logs refreshed'))
      .catch((error) => toast(error.message, 'error'));
  });
  $('logs-restart').addEventListener('click', restartSelectedService);

  $('logout').addEventListener('click', lock);

  $('pin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPin = $('pin-current').value.trim();
    const newPin = $('pin-next').value.trim();
    try {
      const data = await api('/api/pin', {
        method: 'POST',
        body: JSON.stringify({ currentPin, newPin }),
      });
      state.token = data.token;
      localStorage.setItem(STORAGE_KEY, data.token);
      $('pin-current').value = '';
      $('pin-next').value = '';
      toast('PIN updated', 'success');
      refreshStatus().catch(() => {});
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  const dropzone = $('dropzone');
  const input = $('file-input');

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    uploadFiles(input.files);
    input.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('border-emerald-500', 'bg-emerald-500/5');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    dropzone.addEventListener(type, () => {
      dropzone.classList.remove('border-emerald-500', 'bg-emerald-500/5');
    });
  }
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('border-emerald-500', 'bg-emerald-500/5');
    uploadFiles(event.dataTransfer.files);
  });
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => event.preventDefault());
  }

  $('files-refresh').addEventListener('click', () => {
    refreshFiles()
      .then(() => toast('File list refreshed'))
      .catch((error) => toast(error.message, 'error'));
  });

  $('gate-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const pin = $('gate-pin').value.trim();
    if (!pin) return;
    try {
      const ready = await resolveApiBase();
      if (!ready) {
        showGate('The server is still starting. Give it a second and try again.');
        return;
      }
      await unlock(pin);
      hideGate();
      await boot();
    } catch (error) {
      showGate(error.message);
    }
  });
}

let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.hidden || !state.token) return;
    const job =
      state.tab === 'files' ? refreshFiles() : state.tab === 'logs' ? refreshLogs() : refreshStatus();
    job.catch(() => {});
  }, POLL_MS);
}

// PocketBase is a separate native process on :8090, so it can answer while the panel is
// dead. That difference is the whole diagnosis, and both diagnostics files are served
// from its public folder, so this works with no PC and no working panel.
const DIAG_BASE = 'http://127.0.0.1:8090';

async function readDiagnostic(name) {
  try {
    const response = await fetch(`${DIAG_BASE}/${name}`, { cache: 'no-store' });
    if (!response.ok) return `(no ${name} — HTTP ${response.status})`;
    const text = (await response.text()).trim();
    return text || `(${name} exists but is empty)`;
  } catch (error) {
    return `(cannot read ${name}: ${error.message})`;
  }
}

async function probeDiagnostics() {
  const card = $('offline-help');
  if (!card) return;
  card.classList.remove('hidden');

  $('offline-summary').textContent = 'Checking the server…';
  $('offline-pocketbase').textContent = 'checking…';
  $('offline-boot').textContent = 'checking…';
  $('offline-error').textContent = 'checking…';

  let pocketbaseUp = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(`${DIAG_BASE}/api/health`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    pocketbaseUp = response.ok;
    $('offline-pocketbase').textContent = response.ok
      ? 'reachable — the background service is running'
      : `answered HTTP ${response.status}`;
  } catch (error) {
    $('offline-pocketbase').textContent = 'not reachable — the background service may be stopped';
  }

  $('offline-summary').textContent = pocketbaseUp
    ? 'PocketBase is running, so the embedded Node panel is what failed. The lines below say why.'
    : 'Neither server answers. Reopen the app, allow notifications, and exempt it from battery optimisation.';

  $('offline-boot').textContent = await readDiagnostic('__boot-status.txt');
  $('offline-error').textContent = await readDiagnostic('__boot-error.txt');
}

async function boot() {
  // Windows and Android share this file; name the machine that is actually serving it.
  if ($('footer-note')) {
    $('footer-note').textContent = `Runs entirely on this ${DEVICE_LABEL} · no internet needed`;
  }
  if ($('gate-note')) {
    $('gate-note').textContent = IS_PC
      ? 'The PIN is stored in data\\settings.json inside the server folder.'
      : 'The PIN is shown in the app settings on the phone.';
  }

  const ready = await resolveApiBase();
  if (!ready) {
    setServerState('pending', 'starting the server…');
    state.bootFailures += 1;
    // After ~8s of silence, stop pretending and say what to check. The admin page runs on
    // the native side, so it can still answer when the Node panel is dead — that is the
    // quickest way to tell "panel failed" apart from "background service stopped".
    if (state.bootFailures === 4) probeDiagnostics().catch(() => {});
    if (state.bootFailures === 6 && !$('gate').classList.contains('hidden')) {
      showGate(
        'The panel on port 8080 is not answering. First launch can take up to a minute while the runtime unpacks. ' +
          'Quick check: open http://127.0.0.1:8090/_/ on this device. If that page loads, only the panel failed and ' +
          'http://127.0.0.1:8090/__boot-error.txt says why. If it does not load either, the background service is stopped — ' +
          'check the notification, then reopen the app.',
      );
    }
    setTimeout(boot, 1500);
    return;
  }
  state.bootFailures = 0;

  if (!state.token) {
    setServerState('locked', 'locked');
    showGate();
    return;
  }

  try {
    await refreshStatus();
    await refreshFiles();
    $('logout').classList.remove('hidden');
    hideGate();
    startPolling();
  } catch (error) {
    if (error.message === 'locked') return;
    setServerState('offline', 'server not responding');
    setTimeout(boot, 2000);
  }
}

wireEvents();
updateTunnelModeUi();
setTab('dashboard');
boot();
