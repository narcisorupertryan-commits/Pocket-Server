'use strict';

/**
 * One entry point for the portable folder: start the supervisor, start the control
 * panel, wait until it answers, open the browser, and stop both on Ctrl+C or when
 * the window is closed. Nothing is left running in the background afterwards.
 *
 *   node windows/launch.js [--no-open] [--fast]
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const supervisorModule = require('./supervisor');

const ROOT = path.resolve(__dirname, '..');
const PANEL_PORT = Number(process.env.PORT) || 8080;
const POCKETBASE_PORT = Number(process.env.POCKETBASE_PORT) || 8090;
const args = process.argv.slice(2);
const noOpen = args.includes('--no-open') || process.env.POCKET_SERVER_NO_OPEN === '1';

const serverEntry = path.join(ROOT, 'public', 'nodejs', 'server.js');
const panelLog = path.join(ROOT, 'data', 'logs', 'panel.log');

let panel = null;
let supervisor = null;
let shuttingDown = false;

function say(message) {
  console.log(`[launcher] ${message}`);
}

function tailLog(file, onLine) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter(Boolean).slice(-12);
  for (const line of lines) onLine(line);
}

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(600);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

function healthy(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1200 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitForPanel() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    for (let offset = 0; offset < 6; offset += 1) {
      const port = PANEL_PORT + offset;
      if (port === POCKETBASE_PORT) continue;
      if (!(await probe(port))) continue;
      if (await healthy(port)) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

function openBrowser(url) {
  if (noOpen) {
    say(`open ${url} in your browser`);
    return;
  }
  const command =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
  try {
    spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (error) {
    say(`could not open a browser (${error.message}) — go to ${url}`);
  }
}

function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  say(`shutting down (${reason})`);
  try {
    if (panel) panel.kill();
  } catch (error) {
    /* already gone */
  }
  const finish = () => {
    say('stopped');
    process.exit(code);
  };
  if (supervisor) supervisor.stop().then(finish).catch(finish);
  else finish();
}

async function main() {
  if (!fs.existsSync(serverEntry)) {
    console.error(`Cannot find the panel at ${serverEntry}`);
    process.exit(1);
  }

  fs.mkdirSync(path.join(ROOT, 'data', 'logs'), { recursive: true });

  supervisor = supervisorModule.start();

  const logHandle = fs.openSync(panelLog, 'a');
  panel = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PANEL_PORT), POCKETBASE_PORT: String(POCKETBASE_PORT), POCKET_SERVER_SUPERVISOR: '1' },
    stdio: ['ignore', logHandle, logHandle],
    windowsHide: true,
  });

  panel.once('exit', (code) => {
    if (shuttingDown) return;
    say(`the panel exited (${code})`);
    tailLog(panelLog, (line) => say(`panel: ${line}`));
    shutdown('panel exited', code === 0 ? 0 : 1);
  });

  const port = await waitForPanel();
  if (!port) {
    say('the panel did not answer — last lines of data/logs/panel.log:');
    tailLog(panelLog, (line) => say(`panel: ${line}`));
    shutdown('panel not reachable', 1);
    return;
  }

  const url = `http://127.0.0.1:${port}`;
  say(`panel ${url}`);
  say(`site  http://127.0.0.1:${POCKETBASE_PORT}`);
  say('close this window or press Ctrl+C to stop everything');
  openBrowser(url);
}

process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('terminated'));
process.on('SIGHUP', () => shutdown('window closed'));
process.on('uncaughtException', (error) => {
  console.error('[launcher] unexpected error:', error.message);
  shutdown('error', 1);
});

main().catch((error) => {
  console.error('[launcher] could not start:', error.message);
  shutdown('start failure', 1);
});
