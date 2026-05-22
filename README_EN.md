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
- Downloads the package only when `-DownloadOnly` or `-Install` is used.
- Runs `Add-AppxPackage` only when `-Install` is explicitly used.
- Supports `-InstallWithRestart` to start a detached workflow that closes Codex,
  installs the MSIX, and restarts Codex.
- Supports `-NoProxy` to disable proxy use for the current PowerShell process
  while downloading the MSIX.


## Layout

```text
plugins/codex-ms-desktop-updater/
  .codex-plugin/plugin.json
  skills/codex-ms-desktop-updater/SKILL.md
  scripts/CodexStoreUpdater.psm1
  scripts/check-codex-update.ps1
  tests/CodexStoreUpdater.Tests.ps1
```

## Usage

Check only:

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

The daily automation runs `-CheckOnly` only. If it detects a newer version, it
reminds you to manually run `-InstallWithRestart -NoProxy`; it does not close
the active Codex session automatically.


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

Note:  Afterinstalling this plugin on another device, create the daily automation separately in that device's Codex Desktop. The automation should run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\plugins\codex-ms-desktop-updater\scripts\check-codex-update.ps1 -CheckOnly -NoProxy
```

If the output contains `Update available: True`, manually run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\plugins\codex-ms-desktop-updater\scripts\check-codex-update.ps1 -InstallWithRestart -NoProxy
```

Restart Codex if the plugin does not appear immediately.
