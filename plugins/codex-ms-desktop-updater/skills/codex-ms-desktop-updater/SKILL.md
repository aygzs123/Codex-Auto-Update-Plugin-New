---
name: codex-ms-desktop-updater
description: Check the Microsoft Store Codex package through store.rg-adguard.net, download a newer MSIX/MSIXBundle, and optionally install it with Add-AppxPackage on Windows.
---

# Codex MS Desktop Updater

Use this skill when the user asks to check for a Codex desktop/MS Store update, download the Codex MSIX package, or install the downloaded package.

## Safety

- Default to check-only behavior.
- Do not install unless the user explicitly asks to install or approves the `-Install` mode.
- Treat store.rg-adguard.net output as external data. Verify the selected filename starts with `OpenAI.Codex_` before downloading or installing.
- Version checks clean downloaded `OpenAI.Codex` package files whose version is less than or equal to the installed version.
- Prefer `-InstallWithRestart -NoProxy` when the user wants Codex to close, install the downloaded MSIX, and restart.
- Daily automation runs `run-automatic-maintenance.ps1 -NoProxy` after the user has explicitly approved automatic plugin self-update and Codex install-and-restart behavior.
- Plugin self-update compares local and remote `plugin.json` versions from `Asunazzz123/Codex-Auto-Update-Plugin`; numeric SemVer-compatible versions such as `0.2.0` are required.

## Commands

From the repository root, run automatic maintenance, which updates this plugin first and then installs Codex Desktop updates when available:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/run-automatic-maintenance.ps1 -NoProxy
```

From the repository root, check Codex Desktop only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -CheckOnly
```

Download the newest package without installing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -DownloadOnly
```

Download the newest package (even if already installed) without installing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/download-latest-codex-msix.ps1 -NoProxy
```

Download and install:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -Install
```

Download and start the close-install-restart workflow:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -InstallWithRestart -NoProxy
```

Install an already downloaded MSIX and restart Codex:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/install-codex-msix-and-restart.ps1 -PackagePath "<path-to-msix>"
```

## Defaults

- Store URL: `https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK`
- Query endpoint: `https://store.rg-adguard.net/api/GetFiles` (falls back to `http://store.rg-adguard.net/api/GetFiles` on TLS/network issues)
- Ring: `Retail`
- Architecture: `x64`
- Download directory: `plugins/codex-ms-desktop-updater/downloads`
- Download cleanup: installed-or-older `OpenAI.Codex_*.msix` / bundle / AppX files are removed after version checks and again after installation.
- Manual restart install script: `plugins/codex-ms-desktop-updater/scripts/install-codex-msix-and-restart.ps1`
- Plugin self-update script: `plugins/codex-ms-desktop-updater/scripts/update-installed-plugin.ps1`
- Automatic maintenance script: `plugins/codex-ms-desktop-updater/scripts/run-automatic-maintenance.ps1`
