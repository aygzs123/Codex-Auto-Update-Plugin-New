# Codex MS Desktop Updater

[English](README_EN.md) | [中文](README.md)

Repo-local Codex Desktop plugin for checking the Microsoft Store Codex package through
store.rg-adguard.net, downloading a newer MSIX package, and installing it only
when explicitly requested.

## What It Does

- Queries `https://store.rg-adguard.net/api/GetFiles` for the Codex Microsoft
  Store listing.
- Uses the Codex Store URL:
  `https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK`.
- Parses `OpenAI.Codex_*.msix` / bundle links from the response.
- Compares the latest available version with the installed `OpenAI.Codex`
  AppX package.
- After version checks, automatically removes downloaded `OpenAI.Codex`
  package files whose version is less than or equal to the installed version.
- Downloads the package only when `-DownloadOnly`, `-Install`, or
  `-InstallWithRestart` is used.
- Runs `Add-AppxPackage` only when `-Install` or `-InstallWithRestart` is
  explicitly used.
- Supports `-InstallWithRestart` to start a detached workflow that closes Codex,
  installs the MSIX, and restarts Codex.
- After install, verifies the installed version is not older than the downloaded
  package and removes the installed MSIX/AppX package file to save storage.
- Supports `-NoProxy` to disable proxy use for the current PowerShell process
  while downloading the MSIX.


## Layout

```text
plugins/codex-ms-desktop-updater/
  .codex-plugin/plugin.json
  skills/codex-ms-desktop-updater/SKILL.md
  scripts/CodexStoreUpdater.psm1
  scripts/check-codex-update.ps1
  scripts/update-installed-plugin.ps1
  scripts/run-automatic-maintenance.ps1
  tests/CodexStoreUpdater.Tests.ps1
```

## Usage

Automatic maintenance: update this plugin first, then install Codex Desktop updates when available.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/run-automatic-maintenance.ps1 -NoProxy
```

Check Codex Desktop only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -CheckOnly
```

Download only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -DownloadOnly
```

Download and install:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -Install
```

Download and start the close-install-restart workflow:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -InstallWithRestart -NoProxy
```

Install a downloaded MSIX and restart Codex:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/install-codex-msix-and-restart.ps1 -PackagePath "<path-to-msix>"
```

Downloaded files are saved under:

```text
plugins/codex-ms-desktop-updater/downloads/
```

After the script detects the installed local version, it cleans installed-or-older
`OpenAI.Codex_*.msix` / bundle / AppX packages from that directory. After a
successful install, it reads the installed version again and repeats the cleanup.
The `-InstallWithRestart` detached workflow also removes the package file used for that install after version verification passes.

The daily automation runs `run-automatic-maintenance.ps1 -NoProxy`. It first compares the local plugin version with `plugin.json` in the remote `Asunazzz123/Codex-Auto-Update-Plugin` repository. If the remote version is newer, it downloads the GitHub archive and updates the local plugin while preserving the `downloads` cache. It then checks Codex Desktop. If a newer package is available, it starts the detached workflow that closes Codex, installs the MSIX, and restarts Codex after installation. If no newer package is available, it does not notify you.



## Version Management And CI

Plugin versioning uses the `version` field in
`plugins/codex-ms-desktop-updater/.codex-plugin/plugin.json` as the source of
truth. Bump that version before pushing repository changes. GitHub CI runs
`tools/Test-PluginVersionBump.ps1` on pull requests and pushes to `main`, and
requires the head version to be greater than the baseline version.

## Local Codex Plugin Install

For a Windows user profile, install by copying:

```text
<repo>\plugins\codex-ms-desktop-updater
```

to:

```text
%USERPROFILE%\.codex\plugins\codex-ms-desktop-updater
```

Then add this entry to:

```text
%USERPROFILE%\.codex\.agents\plugins\marketplace.json
```

```json
{
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Developer Tools",
  "name": "codex-ms-desktop-updater",
  "source": {
    "path": "./plugins/codex-ms-desktop-updater",
    "source": "local"
  }
}
```

Note: After installing this plugin on another device, create the daily automation separately in that device's Codex Desktop. The automation should run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\plugins\codex-ms-desktop-updater\scripts\run-automatic-maintenance.ps1 -NoProxy
```

If no newer package is available, the script skips download and installation. If
a newer package is available, it closes Codex, installs the MSIX, and restarts
Codex after installation.

`install/automation.toml` is a portable template. It uses the
`{{CODEX_PLUGIN_ROOT}}` and `{{CODEX_MAINTENANCE_SCRIPT}}` placeholders instead of
machine-specific drive-letter paths. When `install/install.ps1` installs it into
the local `~/.codex` directory, it writes the actual installed plugin and script
paths for that machine.

You can still run the install workflow manually:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\plugins\codex-ms-desktop-updater\scripts\run-automatic-maintenance.ps1 -NoProxy
```

Restart Codex if the plugin does not appear immediately.
