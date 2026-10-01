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
- **Elevation when required**: newer Codex packages declare a packaged Windows
  service running as `localSystem` (`Category="windows.service"`), so Windows
  requires an administrator context for `Add-AppxPackage` and otherwise fails with
  `0x80073D28`. The scripts read the package manifest first
  (`Test-CodexPackageRequiresElevation`) and, when needed, spawn a short-lived
  elevated child (`-Verb RunAs`) that only closes Codex and installs — one UAC
  prompt. Elevation is **off by default**: without `-AllowElevation` the run
  refuses honestly (nothing installed, nothing changed, no prompt), which is why
  automatic maintenance can no longer finish an elevation-requiring version — open
  the desktop app and click update instead (see "Automatic maintenance").
- **Cache retention + rollback**: keeps the two most recent `OpenAI.Codex`
  installers in the download cache (about 1.67 GB) and prunes older ones, so a
  problematic update can be rolled back to the previous version (see "Version
  rollback" below).
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

**Automatic maintenance never requests administrator privileges.** An unattended
run must not block on a UAC prompt, so when a package needs elevation (see
"Features") it prints `ADMIN_PRIVILEGES_REQUIRED`, states that the package has
already been downloaded and that nothing was changed, and does **not** start the
install. That check deliberately runs *before* the detached worker is spawned: the
worker is a separate process and the call site only sees whether it started, so
letting it fail asynchronously would make the automation report success.

For an elevation-requiring version use the manual (or desktop app) path, which
shows a single UAC prompt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\check-codex-update.ps1 -InstallWithRestart -NoProxy -AllowElevation
```

### Manual Codex update control

| Purpose | Command |
|---------|---------|
| Check only | `check-codex-update.ps1 -CheckOnly` |
| Download only | `check-codex-update.ps1 -DownloadOnly` |
| Download and install (no restart) | `check-codex-update.ps1 -Install` |
| Download → close → install → restart | `check-codex-update.ps1 -InstallWithRestart -NoProxy` |
| Same, allowing one UAC prompt | `check-codex-update.ps1 -InstallWithRestart -NoProxy -AllowElevation` |
| Force-download newest package (even if installed) | `download-latest-codex-msix.ps1 -NoProxy` |
| Install a downloaded MSIX and restart | `install-codex-msix-and-restart.ps1 -PackagePath "<path>"` |
| Roll back to the previous version (must still be cached) | `install-codex-msix-and-restart.ps1 -PackagePath "<path>" -AllowDowngrade -AllowElevation` |

`-AllowElevation` exists only on `check-codex-update.ps1`'s `-InstallWithRestart`
path (not on `-CheckOnly` / `-DownloadOnly` / `-Install`);
`install-codex-msix-and-restart.ps1` accepts it directly. Without it a package that
needs elevation does not fail on `0x80073D28` — it is refused with
`ADMIN_PRIVILEGES_REQUIRED` before anything touches Codex.

`run-automatic-maintenance.ps1`, `update-installed-plugin.ps1`, and
`download-latest-codex-msix.ps1` all accept `-NoProxy`.

Downloaded files are saved under:

```text
plugins/codex-ms-desktop-updater/downloads/
```

> That directory is a runtime cache and is git-ignored. It deliberately keeps the
> two most recent installers (~1.67 GB) as rollback targets; see "Version
> rollback" below.

| Rollback / cache inspection | Command |
|---------|---------|
| List cached installers (read-only) | `list-cached-codex-packages.ps1 -DownloadDirectory "<dir>"` |
| Install a specific package, downgrade allowed | `install-codex-msix-and-restart.ps1 -PackagePath "<path>" -AllowDowngrade` |

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

## Version rollback (extension)

Rolling back after a bad update used to be impossible — not "unimplemented", but
actively prevented by three things working together:

1. the version check deleted every package whose version was **≤ the installed
   version**, i.e. exactly the one the user was running and knew to be good;
2. the install workflow deleted the package it had just used;
3. both install paths called a bare `Add-AppxPackage`, without
   `-ForceUpdateFromAnyVersion`, so **even if the package survived, Windows
   refuses to install a lower version**.

The distribution source only serves the newest version (verified here: `Retail`,
`Slow` and `Fast` all return the same build), so a deleted installer **cannot be
downloaded again**.

### Retention policy

> Among cached packages whose version is **≤ the installed version**, keep the two
> newest by version and delete the rest.

- The floor is 2, not 1: the package just installed is the **next** update's
  rollback target. Keeping only 1 leaves nothing to go back to after the next
  update, so the feature would not exist.
- Packages **newer** than the installed version (downloaded, not yet installed)
  are left alone, as are other apps' packages and `.partial` downloads.
- At two ~800 MB packages, the cache holds roughly **1.67 GB** at rest.

Pruning happens inside the install worker (the only place that both knows the new
version and sits in the cache directory), so the cache returns to 2 packages as
soon as an install finishes, instead of briefly holding 3 (2.5 GB).

### How to use it

- **Desktop app**: the "Version History" card lists the cached installers with a
  `current / rollback available / newer than current` badge; the rollback-able
  row has a "Roll back to this version" button, and the same button appears in the
  failure warning cards when an update goes wrong. Rolling back closes the running
  Codex, installs, and restarts it.
- **Plugin side**: see the rollback table in "Manual Codex update control".

### Three implementation points

1. **Downgrade is allowed only on the rollback path.** Only `-AllowDowngrade`
   adds `-ForceUpdateFromAnyVersion`; one-click update behaves exactly as before,
   and the log shows which mode a run used.
2. **The post-downgrade version check uses equality.** When Windows refuses a
   downgrade the higher version is still installed, which makes the upgrade path's
   `-lt` check false — reporting a downgrade that never happened as a success. The
   equality check turns it into a visible error (`Downgrade did not take effect`).
3. **Rollback verifies the signature first.** An old installer may have been
   sitting on disk for weeks; the gate is no weaker than for a fresh download.

### One limitation you should know about

Rollback depends on an installer **this tool itself retained**, which means it only
works for versions downloaded **after the new retention policy took effect**.
Rolling back to the version you had before installing this feature is not possible:
that installer was already deleted under the old rule.

Measured on this machine, the packages currently in the three cache directories
(`26.924.2738.0`, `26.917.6896.0`) are both **newer** than the installed
`26.901.6511.0`, so neither is a rollback target, and the `26.901.6511.0`
installer cannot be recovered. The feature first becomes usable after the **next**
update, when `26.901` is retained. The empty state in the UI says exactly this
rather than showing an empty box.

### Verifying a real rollback by hand

Whether `-ForceUpdateFromAnyVersion` is accepted for a Store-signed package can
only be confirmed by actually downgrading once (this machine has no older package,
so this step has not been done). Reproducible steps:

1. Update normally once, so the cache holds two packages (the new one and the
   previous one);
2. confirm with `list-cached-codex-packages.ps1` that the previous one's relation
   is `older`;
3. click "Roll back to this version" (or run the `-AllowDowngrade` command above);
4. check whether the version reported by `Get-AppxPackage` in the install log
   really went back down after `Add-AppxPackage`.

A refused downgrade does not silently succeed — it surfaces as "the downgrade did
not take effect, still on X".

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
