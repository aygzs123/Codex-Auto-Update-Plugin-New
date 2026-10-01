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
  `%USERPROFILE%\.codex\plugins\codex-ms-desktop-updater`
- `install\automation.toml` to
  `%USERPROFILE%\.codex\automations\daily-codex-desktop-update-check\automation.toml`

It intentionally skips the plugin `downloads` cache.

## Path patching

Keep `install\automation.toml` portable. It must use these placeholders instead
of machine-specific paths:

- `{{CODEX_PLUGIN_ROOT}}`
- `{{CODEX_MAINTENANCE_SCRIPT}}`

During install, `install\install.ps1` rewrites the installed automation's
`prompt` and `cwds` entries to the target machine's real `%USERPROFILE%\.codex`
paths. Do not commit drive-letter paths such as `D:\...` into
`install\automation.toml`.

## Automation behavior

The installed automation runs the maintenance script directly rather than showing a PowerShell command for the user to run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <installed-plugin>\scripts\run-automatic-maintenance.ps1 -NoProxy
```

The maintenance script first checks whether the installed plugin is older than
`plugins\codex-ms-desktop-updater\.codex-plugin\plugin.json` on the remote
`aygzs123/Codex-Auto-Update-Plugin-New` repository. If the remote version is
newer, it downloads the GitHub archive and updates the local plugin while
preserving the `downloads` cache. It then checks Codex Desktop. If no newer
Codex MSIX is available, the script skips download and installation.

If an update is available and the package does **not** need administrator
privileges, it starts the detached install-and-restart workflow: Codex closes,
the MSIX is installed, and Codex is restarted after installation.

Newer Codex packages declare a packaged Windows service
(`<desktop6:Extension Category="windows.service">` in `AppxManifest.xml`), which
makes `Add-AppxPackage` require an administrator context (`HRESULT:
0x80073D28`). The unattended run deliberately never requests elevation — a
background run must not block on a UAC prompt — so for such a package the
maintenance script prints `ADMIN_PRIVILEGES_REQUIRED`, leaves the downloaded
package in place, changes nothing, and does not start the install. Tell the user
once, plainly, to open the Codex Updater desktop app and click the update button
there (it shows a single UAC prompt). The desktop app passes `-AllowElevation`
unconditionally; `check-codex-update.ps1` accepts it only on the
`-InstallWithRestart` path, and `install-codex-msix-and-restart.ps1` accepts it
directly.

Restart Codex if the plugin or automation does not appear immediately after
installation.
