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

## Commands

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -CheckOnly
```

Download the newest package without installing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -DownloadOnly
```

Download and install:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -Install
```

## Defaults

- Store URL: `https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK`
- Query endpoint: `https://store.rg-adguard.net/api/GetFiles`
- Ring: `Retail`
- Architecture: `x64`
- Download directory: `plugins/codex-ms-desktop-updater/downloads`
- Download cleanup: installed-or-older `OpenAI.Codex_*.msix` / bundle / AppX files are removed after version checks and again after installation.
