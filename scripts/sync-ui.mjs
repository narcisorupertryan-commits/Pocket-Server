// Copies the dashboard into the Node project.
//
// The phone's WebView loads public/index.html straight from the APK assets, while
// the Express server has to serve the same page to a PC on the LAN. Express runs
// from `filesDir/capawesome_nodejs/nodejs-project/`, so the UI has to live inside
// public/nodejs/. Keeping one source of truth (public/) and copying it avoids
// two drifting copies of the same screen.

import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public');
const target = path.join(source, 'nodejs', 'www');

const files = [
  'index.html',
  'app.js',
  'app.css',
  'theme-init.js',
  'logo.png',
  'favicon.png',
  'icon-192.png',
];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const file of files) {
  const from = path.join(source, file);
  try {
    await stat(from);
  } catch {
    if (file === 'app.css') {
      console.error('public/app.css is missing — run `npm run build:css` first.');
    } else {
      console.error(`Missing ${path.relative(root, from)}.`);
    }
    process.exit(1);
  }
  await copyFile(from, path.join(target, file));
  console.log(`synced public/${file} → public/nodejs/www/${file}`);
}

// Generate version.js next to both copies of the UI. The WebView inside the APK loads
// public/ (Capacitor's webDir) while Express serves public/nodejs/www, so the same file
// has to exist in both — that is how the dashboard can show which build it came from.
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const versionSource = `window.POCKET_UI_VERSION = '${pkg.version}'\n`;
await writeFile(path.join(source, 'version.js'), versionSource, 'utf8');
await writeFile(path.join(target, 'version.js'), versionSource, 'utf8');

console.log(`UI synced to ${path.relative(root, target)} (version ${pkg.version})`);
