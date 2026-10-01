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
- Version checks keep the two most recent downloaded `OpenAI.Codex` package files whose version is less than or equal to the installed version, and remove older ones. Packages newer than the installed version are never removed.
- Detached install validates the package filename metadata and installed version before pruning the cache; it never deletes the package file it just installed, because that file is the next update's rollback target.
- Rolling back to a previous version requires `-AllowDowngrade`, and is only possible for a version whose installer is still in the download cache.
- Newer Codex packages declare a packaged Windows service (`<desktop6:Extension Category="windows.service">` in `AppxManifest.xml`), so Windows requires an administrator context to `Add-AppxPackage` and otherwise fails with `HRESULT: 0x80073D28`. `Test-CodexPackageRequiresElevation -Path <package>` reads the package manifest and reports whether this applies. Elevation is **off by default**: without `-AllowElevation` the downloaded package is left in place, nothing is installed, no UAC prompt is raised, and the run says so plainly (see `ADMIN_PRIVILEGES_REQUIRED`). Never start an install that needs elevation unless the user explicitly approved a UAC prompt.
- Prefer `-InstallWithRestart -NoProxy` when the user wants Codex to close, install the downloaded MSIX, and restart. Add `-AllowElevation` only when the user has agreed to a single UAC prompt.
- Daily automation runs `run-automatic-maintenance.ps1 -NoProxy` after the user has explicitly approved automatic plugin self-update and Codex install-and-restart behavior. It deliberately never requests elevation: an unattended run must not block on a UAC prompt, so when a package needs administrator rights the automation reports `ADMIN_PRIVILEGES_REQUIRED` and leaves the installation to the Codex Updater desktop app.
- Plugin self-update compares local and remote `plugin.json` versions from `aygzs123/Codex-Auto-Update-Plugin-New`; numeric SemVer-compatible versions such as `0.2.0` are required.

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

The same, allowing one UAC prompt — needed for Codex versions that declare a packaged Windows service. `-AllowElevation` exists on `check-codex-update.ps1`'s `-InstallWithRestart` path (not on `-CheckOnly` / `-DownloadOnly` / `-Install`) and on `install-codex-msix-and-restart.ps1`. When the package needs administrator rights and the switch is missing, the check script stops before starting the worker and prints `ADMIN_PRIVILEGES_REQUIRED`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -InstallWithRestart -NoProxy -AllowElevation
```

Install an already downloaded MSIX and restart Codex (`-AllowElevation` when the manifest declares `windows.service`; `-AllowDowngrade` to roll back):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/install-codex-msix-and-restart.ps1 -PackagePath "<path-to-msix>"
```

## Defaults

- Store URL: `https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK`
- Query endpoint: `https://store.rg-adguard.net/api/GetFiles` (falls back to `http://store.rg-adguard.net/api/GetFiles` on TLS/network issues)
- Ring: `Retail`
- Architecture: `x64`
- Download directory: `plugins/codex-ms-desktop-updater/downloads`
- Download cleanup: among `OpenAI.Codex_*.msix` / bundle / AppX files whose version is not higher than the installed one, the two newest are kept and the rest are removed after version checks and again after installation. Packages newer than the installed version, other apps' packages, and `.partial` downloads are left alone. Detached install prunes the cache only after validating the installed version, and keeps the file it used.
- Cache retention / rollback: keeping 2 packages costs about 1.67 GB. Rolling back needs an installer that this tool itself retained, so it only works for versions downloaded since the retention policy took effect — an installer already deleted under the old "delete everything up to the installed version" rule cannot be recovered, because the distribution source only serves the newest version.
- Rollback install script: `plugins/codex-ms-desktop-updater/scripts/install-codex-msix-and-restart.ps1 -PackagePath "<path>" -AllowDowngrade -AllowElevation` (the retained Codex packages declare a packaged service, so rolling back needs the UAC prompt too)
- Cached package listing (read-only): `plugins/codex-ms-desktop-updater/scripts/list-cached-codex-packages.ps1`
- Manual restart install script: `plugins/codex-ms-desktop-updater/scripts/install-codex-msix-and-restart.ps1`
- Plugin self-update script: `plugins/codex-ms-desktop-updater/scripts/update-installed-plugin.ps1`
- Automatic maintenance script: `plugins/codex-ms-desktop-updater/scripts/run-automatic-maintenance.ps1`
