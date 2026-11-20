#!/usr/bin/env node
/**
 * Fetches the three binaries the Windows folder needs and unpacks them into
 * dist/PocketServer-windows-x64. Nothing is committed: the binaries are 80 MiB and
 * belong in a release asset, not in git.
 *
 *   node scripts/fetch-windows-deps.mjs [--out dist/PocketServer-windows-x64] [--node v22.20.0]
 *
 * NODE_VERSION is picked from nodejs.org's LTS list when not given.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(ROOT, argValue('--out', 'dist/PocketServer-windows-x64'));
const POCKETBASE_VERSION = argValue('--pocketbase', '0.40.6');
const CACHE = path.join(os.tmpdir(), 'pocket-server-deps');

function say(message) {
  console.log(`[deps] ${message}`);
}

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
    say(`cached ${path.basename(file)}`);
    return file;
  }
  say(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buffer);
  const digest = createHash('sha256').update(buffer).digest('hex');
  say(`  ${(buffer.length / 1048576).toFixed(1)} MiB, sha256 ${digest.slice(0, 16)}…`);
  return file;
}

/** Finds a file by name under a folder, a few levels deep. */
function findFile(dir, name, depth = 3) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFile(path.join(dir, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * Expands a .zip with whichever tool works, and believes it only when `expected` is
 * really on disk. `powershell` (5.1) exits 0 even when Expand-Archive gives up — it
 * does on the deep corepack paths of a current Node zip — so its exit code alone is
 * not evidence. `tar` (bsdtar, bundled with Windows and Linux) reads zips too.
 */
function extract(zipFile, destination, expected) {
  fs.mkdirSync(destination, { recursive: true });
  const expand = `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destination}' -Force`;
  const attempts =
    process.platform === 'win32'
      ? [
          ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', expand]],
          ['powershell', ['-NoProfile', '-Command', expand]],
          ['tar', ['-xf', zipFile, '-C', destination]],
        ]
      : [
          ['unzip', ['-o', zipFile, '-d', destination]],
          ['tar', ['-xf', zipFile, '-C', destination]],
          ['python3', ['-m', 'zipfile', '-e', zipFile, destination]],
        ];
  for (const [command, commandArgs] of attempts) {
    const result = spawnSync(command, commandArgs, { stdio: 'ignore' });
    if (result.status === 0 && (!expected || findFile(destination, expected))) return true;
  }
  if (expected && findFile(destination, expected)) return true;
  throw new Error(`could not unpack ${path.basename(zipFile)} — install unzip or python3, or unpack it by hand`);
}

async function latestNodeLts() {
  const pinned = argValue('--node', '');
  if (pinned) return pinned;
  const response = await fetch('https://nodejs.org/dist/index.json');
  if (!response.ok) throw new Error(`nodejs.org answered ${response.status}`);
  const releases = await response.json();
  const lts = releases.find((release) => release.lts && /^v(22|24)\./.test(release.version));
  if (!lts) throw new Error('no LTS release found on nodejs.org');
  return lts.version;
}

async function main() {
  say(`output folder ${OUT}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });

  const nodeVersion = await latestNodeLts();
  const nodeZipUrl = `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-win-x64.zip`;
  const nodeZip = await download(nodeZipUrl, path.join(CACHE, `node-${nodeVersion}-win-x64.zip`));
  const unpacked = path.join(CACHE, `node-${nodeVersion}-win-x64`);
  let nodeExe = findFile(unpacked, 'node.exe', 2);
  if (!nodeExe) {
    extract(nodeZip, CACHE, 'node.exe');
    nodeExe = findFile(unpacked, 'node.exe', 2) || findFile(CACHE, 'node.exe', 2);
  }
  if (!nodeExe) throw new Error('node.exe was not inside the archive');
  await fsp.copyFile(nodeExe, path.join(OUT, 'node.exe'));
  say(`node.exe ${nodeVersion}`);

  const pbZipUrl = `https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_windows_amd64.zip`;
  const pbZip = await download(pbZipUrl, path.join(CACHE, `pocketbase_${POCKETBASE_VERSION}_windows_amd64.zip`));
  const pbDir = path.join(CACHE, `pocketbase-${POCKETBASE_VERSION}`);
  let pbExe = findFile(pbDir, 'pocketbase.exe', 1);
  if (!pbExe) {
    extract(pbZip, pbDir, 'pocketbase.exe');
    pbExe = findFile(pbDir, 'pocketbase.exe', 1);
  }
  if (!pbExe) throw new Error('pocketbase.exe was not inside the archive');
  await fsp.copyFile(pbExe, path.join(OUT, 'pocketbase.exe'));
  say(`pocketbase.exe ${POCKETBASE_VERSION}`);
  const license = path.join(ROOT, 'third-party', 'pocketbase', 'LICENSE.md');
  if (fs.existsSync(license)) {
    await fsp.mkdir(path.join(OUT, 'third-party'), { recursive: true });
    await fsp.copyFile(license, path.join(OUT, 'third-party', 'pocketbase-LICENSE.md'));
  }

  const cfUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
  const cfFile = await download(cfUrl, path.join(CACHE, 'cloudflared-windows-amd64.exe'));
  await fsp.copyFile(cfFile, path.join(OUT, 'cloudflared.exe'));
  say('cloudflared.exe latest');

  const cfLicense = path.join(ROOT, 'third-party', 'cloudflared', 'LICENSE');
  if (fs.existsSync(cfLicense)) {
    await fsp.mkdir(path.join(OUT, 'third-party'), { recursive: true });
    await fsp.copyFile(cfLicense, path.join(OUT, 'third-party', 'cloudflared-LICENSE.txt'));
  }

  const sizes = ['node.exe', 'pocketbase.exe', 'cloudflared.exe'].map((name) => {
    const full = path.join(OUT, name);
    return `${name} ${(fs.statSync(full).size / 1048576).toFixed(1)} MiB`;
  });
  say(`ready: ${sizes.join(', ')}`);
}

main().catch((error) => {
  console.error(`[deps] ${error.message}`);
  process.exit(1);
});
