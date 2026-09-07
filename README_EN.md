# Codex MS Desktop Auto-Updater

[English](README_EN.md) | [中文](README.md)

A Windows tool for keeping Codex Desktop (Microsoft Store / MSIX build) updated.
It queries `store.rg-adguard.net` for the Codex Store package, compares versions,
downloads a newer MSIX/bundle, and runs `Add-AppxPackage` only when you explicitly
ask. It ships with a local web UI, health check / window probe, and a daily
automation template.

## Features

- **Update check**: queries `https://store.rg-adguard.net/api/GetFiles` for the
  Codex Store entry (`9plm9xgg6vks`) and parses `OpenAI.Codex_*.msix` / bundle links.
- **Download & install on demand**: downloads only with `-DownloadOnly` /
  `-Install` / `-InstallWithRestart`; runs `Add-AppxPackage` only with `-Install`
  / `-InstallWithRestart`.
- **Restart after install**: `-InstallWithRestart` starts a detached workflow that
  closes Codex, installs the MSIX, verifies the installed version is not older
  than the downloaded one, then restarts Codex.
- **Auto cleanup**: after a verified install it removes installed-or-older
  `OpenAI.Codex` package files to save storage.
- **Plugin self-update**: compares the local and remote `plugin.json` versions and
  updates this plugin from GitHub when the remote is newer.
- **Proxy control**: `-NoProxy` disables proxy for the current download process.
- **Web UI**: local, visual, button-driven operations (see "Web UI" below).
- **Health check + window probe**: detects the official "process running but no
  main window" encrypted-relocation bug (see below and `docs/`).

## Layout

```text
plugins/codex-ms-desktop-updater/   The Codex plugin itself
  .codex-plugin/plugin.json         plugin manifest (single source of truth for version)
  skills/codex-ms-desktop-updater/  plugin skill description
  scripts/                          core scripts (see "Commands")
  tests/                            PowerShell tests
webui/                              local web UI (extension)
docs/codex-desktop-encrypted-copy-fix/  write-up + repair script for the "no window" bug
install/                            one-shot local install + daily automation template
tools/Test-PluginVersionBump.ps1    CI version-bump guard
```

## Commands

Run all commands from the **repository root** with PowerShell.

### Automatic maintenance (plugin self-update + Codex update)

Updates this plugin first, then downloads / installs / restarts Codex when a newer
package is available:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\run-automatic-maintenance.ps1 -NoProxy
```

### Manual Codex update control

| Purpose | Command |
|---------|---------|
| Check only | `check-codex-update.ps1 -CheckOnly` |
| Download only | `check-codex-update.ps1 -DownloadOnly` |
| Download and install (no restart) | `check-codex-update.ps1 -Install` |
| Download → close → install → restart | `check-codex-update.ps1 -InstallWithRestart -NoProxy` |
| Force-download newest package (even if installed) | `download-latest-codex-msix.ps1 -NoProxy` |
| Install a downloaded MSIX and restart | `install-codex-msix-and-restart.ps1 -PackagePath "<path>"` |

`run-automatic-maintenance.ps1`, `update-installed-plugin.ps1`, and
`download-latest-codex-msix.ps1` all accept `-NoProxy`.

Downloaded files are saved under:

```text
plugins/codex-ms-desktop-updater/downloads/
```

> That directory is a runtime cache and is git-ignored.

## Install into local Codex

For the current Windows user (copies the plugin and writes the daily automation):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1
```

It:

- copies `plugins\codex-ms-desktop-updater` to
  `%USERPROFILE%\.codex\plugins\codex-ms-desktop-updater` (**skipping** the
  `downloads` cache);
- writes the daily automation from the portable `install\automation.toml`
  template, substituting real machine paths for the placeholders:
  `%USERPROFILE%\.codex\automations\daily-codex-desktop-update-check\automation.toml`;
- the template stays portable (no drive-letter paths; uses placeholders such as
  `{{CODEX_PLUGIN_ROOT}}`).

Restart Codex Desktop if the plugin does not appear immediately.

### Manual copy (without install.ps1)

Copy the plugin directory to
`%USERPROFILE%\.codex\plugins\codex-ms-desktop-updater`, then register it in
`%USERPROFILE%\.codex\.agents\plugins\marketplace.json`:

```json
{
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Developer Tools",
  "name": "codex-ms-desktop-updater",
  "source": { "path": "./plugins/codex-ms-desktop-updater", "source": "local" }
}
```

To recreate the daily automation on another device, create it in that device's
Codex Desktop to run `run-automatic-maintenance.ps1 -NoProxy` daily.

## Web UI (visual control · extension)

Prefer buttons over the command line? Launch the local web UI to check / download /
install / restart / health-check Codex:

```text
webui/
  server.py         local bridge service (Python stdlib only, zero third-party deps)
  index.html        single-file UI (no external CDN, works offline)
  start-webui.ps1   launcher script
  start-webui.bat   double-click entry
```

### Launch

Double-click `webui\start-webui.bat` (or run `start-webui.ps1`). It:

1. detects Python on this machine (`py` → `python` → `python3`);
2. starts `server.py` in the background, listening only on `127.0.0.1:8765`;
3. opens the UI in the browser (or just opens it if the service is already up).

### What the UI offers

Three status cards on top: installed Codex version, **running processes / main
window**, and local plugin version. Logs stream live via SSE.

| Button | Backing script |
|--------|----------------|
| 🔍 Check Codex update | `check-codex-update.ps1 -CheckOnly -NoProxy` |
| ⬇️ Download, install + restart | `check-codex-update.ps1 -InstallWithRestart -NoProxy` |
| 📦 Check plugin update | `update-installed-plugin.ps1 -CheckOnly -NoProxy` |
| 🔄 Update plugin | `update-installed-plugin.ps1 -NoProxy` |
| 🩺 Health check | `check-codex-desktop-health.ps1` |
| 🚀 Health check + launch probe | `check-codex-desktop-health.ps1 -Probe` |

> Security: the service binds `127.0.0.1` only. Buttons only run fixed project
> scripts with fixed arguments; no arbitrary command execution surface.

## Health check & window probe (extension)

Codex Desktop (Store build) has an official bug: **after an update the processes
run but the main window never appears**. The cause is the encrypted-resource
relocation: copying MSIX resources into the user cache with `fs.copyFileSync`
fails (`errno=-4094`). This repo offers a read-only health check plus an optional
launch probe:

```powershell
# Read-only check: do the relocated bundle dirs exist? any .staging-* leftovers?
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\check-codex-desktop-health.ps1

# Check, then launch the app and wait for a main window (reproduces the bug)
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\check-codex-desktop-health.ps1 -Probe -ProbeSeconds 25
```

Exit codes: `0` healthy / `1` degraded or missing component / `2` not installed /
`3` probe timed out with no main window.

- `-InstallWithRestart` also probes the window after install; if no main window
  appears, the install log records `WINDOW_PROBE=FAILED` plus a relocation health
  snapshot and a pointer to the repair script.
- If the bug is confirmed, run the repair script under `docs\` to recover.

## Repair docs: docs/codex-desktop-encrypted-copy-fix

`docs/codex-desktop-encrypted-copy-fix/` documents the full investigation and fix
for "Codex Desktop starts with no window":

- `README.md` — symptoms, root cause (encrypted MSIX resources + Node copyFile
  failure), blast radius, Bundle ID algorithm, manual & scripted fix, verification,
  rollback;
- `repair-codex-desktop-bundles.ps1` — a **reusable, idempotent** repair script. It
  computes the five bundle IDs for the currently installed version (win-cli /
  win-rg / wsl-cli / wsl-rg / cua_node) and materializes the missing ones with
  byte-stream copies that bypass the encrypted-copy failure, verifying every file
  with SHA-256.

To run the repair (exit Codex first):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\codex-desktop-encrypted-copy-fix\repair-codex-desktop-bundles.ps1
```

> Safety: the script only writes under `%LOCALAPPDATA%\OpenAI\Codex` and
> `%USERPROFILE%\.codex`; it **never** touches files / ACLs / ownership under
> `C:\Program Files\WindowsApps`. Re-runs print `SKIP` for already-healthy caches.
> If the issue recurs after a Store update, just re-run it (it computes IDs for the
> currently installed version, so it works across versions).

## Version management & CI

The single source of truth for the plugin version is the `version` field in
`plugins\codex-ms-desktop-updater\.codex-plugin\plugin.json`. Bump it (numeric
SemVer-style text such as `0.3.0`) before pushing repository changes. GitHub CI
runs `tools\Test-PluginVersionBump.ps1` on PRs and pushes to `main` and requires
the head version to be greater than the baseline.

## Tests

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\Install.Tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\tests\CodexStoreUpdater.Tests.ps1
```

## Maintenance notes

- Root `AGENTS.md`: for Codex agents whose only job is to install the plugin into a
  local Codex setup.
- `.codex/AGENTS.md`: for maintaining this repository itself (version management,
  verification flow).
