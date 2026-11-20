'use strict';

/**
 * The site registry: which PocketBase instances this folder runs, on which ports, and
 * where each one keeps its data.
 *
 * `data/sites.json` is optional and is read once, at start-up:
 *
 *   {
 *     "version": 1,
 *     "sites": [
 *       { "id": "default", "name": "Primary", "port": 8090, "legacy": true },
 *       { "id": "second",  "name": "Second site", "port": 8091 }
 *     ]
 *   }
 *
 * Without the file the folder behaves exactly like the single-site build it replaced:
 * one site on 8090 using data/pb_data and data/pb_public. A site flagged `legacy`
 * (or named `default`) keeps those original paths; every other site gets
 * data/sites/<id>/pb_data, data/sites/<id>/pb_public and logs/site-<id>.log.
 *
 * Nothing here moves, copies or migrates an existing folder: a path is a path.
 * A broken entry is reported and skipped — it must never stop the run, because the
 * site that is already serving traffic is usually the one the user cares about.
 */

const fs = require('fs');
const path = require('path');

const LEGACY_ID = 'default';
const LEGACY_NAME = 'Primary site';
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PANEL_PORT_LOW = 8080;
const PANEL_PORT_HIGH = 8085;
const MIN_SITE_PORT = 1024;
const MAX_SITE_PORT = 65535;
const FIRST_EXTRA_PORT = 8091;

function registryPath(dataDir) {
  return path.join(dataDir, 'sites.json');
}

/** Written by the supervisor so the panel and the launcher can see the live list. */
function statusPath(dataDir) {
  return path.join(dataDir, 'sites.status.json');
}

/** Where one site's database, website, backups and log line live. */
function pathsFor(site, dataDir) {
  const root = site.legacy ? dataDir : path.join(dataDir, 'sites', site.id);
  return {
    root,
    pbData: path.join(root, 'pb_data'),
    publicDir: path.join(root, 'pb_public'),
    backups: path.join(root, 'pb_public', 'backups'),
    // The original site keeps `pocketbase.log`, the name the dashboard's Logs tab reads.
    logName: site.legacy ? 'pocketbase' : `site-${site.id}`,
  };
}

function legacySite(legacyPort) {
  return { id: LEGACY_ID, name: LEGACY_NAME, port: legacyPort, legacy: true };
}

function usablePort(port) {
  return Number.isInteger(port) && port >= MIN_SITE_PORT && port <= MAX_SITE_PORT &&
    !(port >= PANEL_PORT_LOW && port <= PANEL_PORT_HIGH);
}

function cleanId(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ID_PATTERN.test(id) ? id : '';
}

function cleanName(value, id) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return id;
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

function readRegistry(dataDir) {
  const file = registryPath(dataDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { file, missing: true };
  }
  if (!text.trim()) return { file, error: 'the file is empty' };
  try {
    return { file, value: JSON.parse(text) };
  } catch (error) {
    return { file, error: error.message };
  }
}

function nextFreePort(taken, legacyPort) {
  for (let port = FIRST_EXTRA_PORT; port <= MAX_SITE_PORT; port += 1) {
    if (port === legacyPort || taken.has(port) || (port >= PANEL_PORT_LOW && port <= PANEL_PORT_HIGH)) continue;
    return port;
  }
  return 0;
}

/**
 * @returns {{ sites: Array, problems: string[], file: string, source: string }}
 *   source is 'registry', 'defaults' (no file) or 'fallback' (file unusable).
 */
function loadSites(options) {
  const dataDir = options.dataDir;
  const legacyPort = Number(options.legacyPort) || 8090;
  const problems = [];
  const registry = readRegistry(dataDir);

  const single = () => ({ sites: [legacySite(legacyPort)], problems, file: registry.file });

  if (registry.missing) return { ...single(), source: 'defaults' };
  if (registry.error) {
    problems.push(`data/sites.json was ignored (${registry.error}) — running the single site only.`);
    return { ...single(), source: 'fallback' };
  }

  const raw = registry.value && Array.isArray(registry.value.sites) ? registry.value.sites : null;
  if (!raw) {
    problems.push('data/sites.json has no "sites" array — running the single site only.');
    return { ...single(), source: 'fallback' };
  }
  if (raw.length === 0) {
    problems.push('data/sites.json lists no sites — running the single site only.');
    return { ...single(), source: 'fallback' };
  }

  // The site that owns data/pb_data is decided first so it always keeps its port,
  // even if a later entry asks for the same one.
  const wantsLegacy = (entry) => Boolean(entry) && typeof entry === 'object' &&
    (entry.legacy === true || entry.id === LEGACY_ID);
  const ordered = raw.slice().sort((left, right) => Number(wantsLegacy(right)) - Number(wantsLegacy(left)));

  const sites = [];
  const seenIds = new Set();
  const takenPorts = new Set();
  let legacyTaken = false;

  for (const entry of ordered) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push('a site entry is not an object — skipped.');
      continue;
    }
    const id = cleanId(entry.id) || cleanId(entry.name);
    if (!id) {
      problems.push('a site entry has no usable id (use lowercase letters, digits, - and _) — skipped.');
      continue;
    }
    if (seenIds.has(id)) {
      problems.push(`site "${id}" appears more than once — the extra entry was skipped.`);
      continue;
    }

    const legacy = wantsLegacy(entry) && !legacyTaken;
    if (wantsLegacy(entry) && legacyTaken) {
      problems.push(`site "${id}" also asked for the original data folder — it runs from data/sites/${id} instead.`);
    }

    const requested = Number(entry.port);
    // An entry that keeps the original folders keeps the usual port when none is given.
    const port = Number.isInteger(requested) && requested > 0
      ? requested
      : legacy ? legacyPort : nextFreePort(takenPorts, legacyPort);
    if (!usablePort(port)) {
      problems.push(`site "${id}" has no usable port (${entry.port === undefined ? 'none given' : entry.port}) — skipped.`);
      continue;
    }
    if (takenPorts.has(port)) {
      problems.push(`site "${id}" asked for port ${port}, which another site already uses — skipped.`);
      continue;
    }

    seenIds.add(id);
    takenPorts.add(port);
    if (legacy) legacyTaken = true;
    sites.push({ id, name: cleanName(entry.name, id), port, legacy });
  }

  if (sites.length === 0) {
    problems.push('data/sites.json had no usable site — running the single site only.');
    return { ...single(), source: 'fallback' };
  }
  return { sites, problems, file: registry.file, source: 'registry' };
}

function reservedPorts(sites) {
  return new Set(sites.map((site) => site.port));
}

module.exports = {
  LEGACY_ID,
  loadSites,
  pathsFor,
  registryPath,
  reservedPorts,
  statusPath,
  legacySite,
};
