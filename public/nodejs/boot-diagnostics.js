'use strict';

/**
 * Boot diagnostics for the on-device Node runtime.
 *
 * If the Express panel fails to start, the panel cannot tell anyone about it — so the
 * reason is written where PocketBase can still serve it:
 *
 *   <data>/pb_public/__boot-status.txt   "the runtime started, listening on :8080"
 *   <data>/pb_public/__boot-error.txt    stack trace of whatever killed it
 *
 * That means `http://<phone-ip>:8090/__boot-error.txt` answers from any browser on the
 * same Wi-Fi even when :8080 is dead. The same lines also go to <data>/logs/boot.log,
 * which the Logs tab reads once the panel does come up.
 *
 * This module must not depend on anything: it is required before express.
 */

const fs = require('fs');
const path = require('path');

function findDataDir() {
  try {
    const bridge = require('bridge');
    if (bridge && bridge.app && typeof bridge.app.datadir === 'function') {
      return bridge.app.datadir();
    }
  } catch (error) {
    // Not running inside the APK.
  }
  // Same fallback as server.js: <repo>/data when run from public/nodejs.
  return path.join(__dirname, '..', '..', 'data');
}

function stamp() {
  return new Date().toISOString();
}

function targets(base) {
  return [path.join(base, 'pb_public'), path.join(base, 'logs')];
}

function write(name, line) {
  let base;
  try {
    base = findDataDir();
  } catch (error) {
    return;
  }

  for (const dir of targets(base)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, name), `${line}\n`, 'utf8');
    } catch (error) {
      // Nothing left to do: both locations are unwritable.
    }
  }
}

function describe(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  return error.stack || `${error.name}: ${error.message}`;
}

/** Record a fatal startup problem. Never throws. */
function bootError(error, context) {
  const where = context ? ` (${context})` : '';
  try {
    write('__boot-error.txt', `[${stamp()}]${where}\n${describe(error)}`);
  } catch (ignored) {
    // Diagnostics must never be the reason the server dies.
  }
}

/** Record progress. Never throws. */
function bootInfo(message) {
  try {
    write('__boot-status.txt', `[${stamp()}] ${message}`);
  } catch (ignored) {
    // ignore
  }
}

/** Hook the last-resort handlers and write the first line of the timeline. */
function install() {
  try {
    write(
      '__boot-status.txt',
      `[${stamp()}] booting: node=${process.version} pid=${process.pid} cwd=${process.cwd()} dir=${findDataDir()}`,
    );
  } catch (ignored) {
    // ignore
  }

  process.on('uncaughtException', (error) => {
    bootError(error, 'uncaughtException');
    // Let the write flush, then die loudly instead of running in a broken state.
    setTimeout(() => process.exit(1), 50);
  });

  process.on('unhandledRejection', (reason) => {
    bootError(reason, 'unhandledRejection');
  });
}

module.exports = { install, bootError, bootInfo, findDataDir };
