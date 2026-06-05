# Install workflow

This repository contains the `codex-ms-desktop-updater` Codex plugin and its
automation template. Use these steps when migrating a freshly cloned repository
into a user's local Codex settings.

## Install from a cloned repo

From the repository root, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1
```

The installer copies:

- `plugins\codex-ms-desktop-updater` to
  `%USERPROFILE%\.codex\plugin\codex-ms-desktop-updater`
- `install\automation.toml` to
  `%USERPROFILE%\.codex\automations\daily-codex-desktop-update-check\automation.toml`

It intentionally skips the plugin `downloads` cache.

## Path patching

Keep `install\automation.toml` portable. It must use these placeholders instead
of machine-specific paths:

- `{{CODEX_PLUGIN_ROOT}}`
- `{{CODEX_CHECK_SCRIPT}}`

During install, `install\install.ps1` rewrites the installed automation's
`prompt` and `cwds` entries to the target machine's real `%USERPROFILE%\.codex`
paths. Do not commit drive-letter paths such as `D:\...` into
`install\automation.toml`.

## Automation behavior

The installed automation runs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <installed-plugin>\scripts\check-codex-update.ps1 -InstallWithRestart -NoProxy
```

If no newer Codex MSIX is available, the script skips download and installation.
If an update is available, it starts the detached install-and-restart workflow:
Codex closes, the MSIX is installed, and Codex is restarted after installation.

## Verification

After changing the installer or automation template, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\Install.Tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\tests\CodexStoreUpdater.Tests.ps1
```

Restart Codex if the plugin or automation does not appear immediately after
installation.
