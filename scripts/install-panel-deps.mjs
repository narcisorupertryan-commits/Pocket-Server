#!/usr/bin/env node
/**
 * Installs the control panel's two runtime dependencies (express + multer) into
 * public/nodejs. The panel is packaged as its own tiny npm project, so this is what
 * makes `public/nodejs/node_modules` exist for the APK and for the Windows zip.
 *
 * It calls npm through node + npm-cli.js instead of spawning `npm` by name: on a
 * Windows runner the `npm` shim is not on the PATH that npm gives to lifecycle
 * scripts, which made the old inline `npm --prefix …` postinstall recurse and fail
 * with "'npm' is not recognized". `--ignore-scripts` keeps that from ever happening
 * again, whatever is added to the panel's package.json later.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const panel = path.join(root, 'public', 'nodejs');
const args = ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'];

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const nodeModules = path.join(panel, 'node_modules');

if (!fs.existsSync(path.join(panel, 'package.json'))) {
  console.error(`[panel-deps] ${panel}/package.json is missing`);
  process.exit(1);
}

// Fresh clones only; a warm install is left alone so `npm ci` stays cheap.
if (fs.existsSync(path.join(nodeModules, 'express', 'package.json'))) {
  console.log('[panel-deps] express is already installed');
  process.exit(0);
}

const useCli = fs.existsSync(npmCli);
const command = useCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const argv = useCli ? [npmCli, ...args] : args;

console.log(`[panel-deps] ${path.relative(root, panel)}: npm ${args.join(' ')}`);
const result = spawnSync(command, argv, { cwd: panel, stdio: 'inherit' });

if (result.error) {
  console.error(`[panel-deps] could not run npm: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[panel-deps] npm exited with ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log('[panel-deps] panel dependencies installed');
