# Pocket Server for Windows

The same control panel and the same PocketBase database as the phone build, in a
portable folder. No installer, no service to register, no Node.js to install —
`node.exe` travels with the folder.

```
PocketServer-windows-x64/
├─ Pocket Server.bat      ← double-click this
├─ node.exe
├─ pocketbase.exe
├─ cloudflared.exe
├─ windows/               ← launcher, supervisor, self check
├─ public/                ← the control panel (identical to the APK)
├─ docs/windows.md
└─ data/                  ← created on first run
```

## First run

1. Unpack the zip anywhere writable — `C:\PocketServer`, a USB stick, `D:\`.
   If Windows shows "Windows protected your PC", choose **More info → Run anyway**;
   the folder is not code-signed.
2. Double-click **`Pocket Server.bat`**.
3. The panel opens at <http://127.0.0.1:8080>. The PIN is `1234` — change it in
   **Security** before you use the server on a shared network.
4. Your site is served from `data\pb_public` at <http://127.0.0.1:8090>.
   Drop files in the **Files** tab and they are live immediately.

Closing the window (or Ctrl+C) stops the panel, PocketBase and the tunnel together.
There is no tray icon and no background service: if the window is closed, nothing runs.

## Reaching it from other devices

Windows Firewall asks the first time PocketBase listens. Allow it on **Private**
networks. Then open `http://<your-pc-ip>:8080` from a phone or tablet on the same
Wi-Fi. The dashboard shows the address it is reachable on.

To allow it from the command line instead:

```bat
netsh advfirewall firewall add rule name="Pocket Server panel" dir=in action=allow protocol=TCP localport=8080
netsh advfirewall firewall add rule name="Pocket Server site"  dir=in action=allow protocol=TCP localport=8090
```

Set the network to **Private** in Windows settings; on a **Public** network Windows
blocks the ports regardless of these rules.

## Start it when you log in

There is no service on purpose — a service would keep running after you log out and
would be harder to stop. If you want it at login:

1. Press `Win+R`, run `shell:startup`.
2. Right-click → **New → Shortcut**, point it at `Pocket Server.bat`.
3. In the shortcut's properties set **Run: Minimized**.

## Public HTTPS link

The **Public tunnel** card starts a `cloudflared` quick tunnel and shows the
`https://….trycloudflare.com` address. For a stable hostname, put a named tunnel
token in the same card; the token stays in `data\settings.json` on your PC and is
never sent to the browser.

## Where your data lives

| Path | Contents |
| --- | --- |
| `data\pb_data` | SQLite database, uploaded collections, PocketBase settings |
| `data\pb_public` | the hosted website — every file here is public on port 8090 |
| `data\pb_public\backups` | nightly zips of `pb_data`, seven kept |
| `data\logs` | `pocketbase.log`, `cloudflared.log`, `panel.log` |
| `data\settings.json` | panel PIN, session secret, tunnel token — **back this up, keep it private** |

Copying the whole folder to another PC keeps everything. `data\` is created next to
`node.exe`, so a fresh folder always starts clean.

## More than one site

By default the folder runs one site on 8090, exactly as before. To run a second one,
create `data\sites.json` and start the launcher again:

```json
{
  "version": 1,
  "sites": [
    { "id": "default", "name": "Primary", "port": 8090, "legacy": true },
    { "id": "second", "name": "Second site", "port": 8091 }
  ]
}
```

Each site is its own PocketBase — its own database, admin login, files and backups:

| Site | Port | Data | Log |
| --- | --- | --- | --- |
| the entry marked `"legacy": true` (or with the id `default`) | its `port` | `data\pb_data`, `data\pb_public` | `data\logs\pocketbase.log` |
| every other id | its `port` | `data\sites\<id>\pb_data`, `…\pb_public` | `data\logs\site-<id>.log` |

- **Upgrading changes nothing.** With no `sites.json` the build behaves exactly like the
  single-site one: same port, same folders, no migration step. A folder from an older
  version is used in place, including its existing `runtime.json`.
- The `legacy` entry is the one that keeps the original folders. Point it at a
  different `port` if 8090 is taken; the data stays where it is.
- Ports 8080–8085 belong to the dashboard and are refused. Leave `port` out and the
  next free port from 8091 is used.
- A broken entry is logged and skipped — the remaining sites still start.
- Adding or removing a site needs a launcher restart for now, and the dashboard still
  shows the primary site. The Android build has no registry yet.
- Firewall: allow each site's port, e.g.
  `netsh advfirewall firewall add rule name="Pocket Server site 2" dir=in action=allow protocol=TCP localport=8091`.

## How it works

On Android, `ServerService.java` owns the child processes and talks to the panel
through command files. On Windows, `windows/supervisor.js` does exactly the same job:

- spawns one `pocketbase.exe serve --http=0.0.0.0:<port> --dir=… --publicDir=…` per site
  listed in `data\sites.json` (just one, on 8090, when there is no such file);
- publishes the live list to `data\sites.status.json` and the pids to `data\runtime.json`;
- watches `data\service.command.json` and `data\tunnel.command.json`, deleting each
  one after it runs (restart, backup, superuser, power off/on, tunnel start/stop);
- writes `power.status.json`, `tunnel.status.json`, `installer.json`,
  `backup.status.json`, `superuser-result.json` and the two log files.

The panel itself is unchanged, so both builds behave identically and a bug fixed on
one is fixed on the other.

Backups pause PocketBase, zip `pb_data` (deflate under 64 MiB per file, stored above
that), prune to seven, then let the supervisor start it again — same order as the
phone build, so SQLite is never copied mid-write.

## Checking a machine

```bat
node windows\selfcheck.js
```

Prints the platform, the binaries and their versions, which ports are busy, whether
the panel and PocketBase answer, and the newest status files. Paste its output when
reporting a problem.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Node.js was not found" | `node.exe` is missing next to the `.bat` — download the zip again |
| Panel opens, PocketBase card says offline | `data\logs\pocketbase.log`; usually the port is taken or the binary was blocked by antivirus |
| Nothing answers from the phone | Windows Firewall, or the network is set to Public |
| Backup says `ok: false` | PocketBase could not be paused — check for a second `pocketbase.exe` in Task Manager |
| Tunnel says "unavailable" | `cloudflared.exe` is missing from the folder (the lite equivalent) |

## Building it yourself

```bash
npm install
npm run windows:fetch     # downloads node.exe, pocketbase.exe, cloudflared.exe
npm run windows:pack      # builds dist/PocketServer-windows-x64(.zip)
```

`npm run windows:check` runs the self check, and `node windows/launch.js --no-open`
starts the stack without opening a browser — the useful form when working from a
terminal or from WSL.
