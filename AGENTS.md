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
`Asunazzz123/Codex-Auto-Update-Plugin` repository. If the remote version is
newer, it downloads the GitHub archive and updates the local plugin while
preserving the `downloads` cache. It then checks Codex Desktop. If no newer
Codex MSIX is available, the script skips download and installation. If an
update is available, it starts the detached install-and-restart workflow: Codex
closes, the MSIX is installed, and Codex is restarted after installation.


## Version management

Use `plugins\codex-ms-desktop-updater\.codex-plugin\plugin.json` as the source
of truth for plugin versioning. Before any change is pushed to the remote
repository, bump its `version` field using numeric SemVer-compatible text such
as `0.2.2` or `0.2.3`. GitHub CI runs
`tools\Test-PluginVersionBump.ps1` on pull requests and pushes to `main` to
verify that the head version is greater than the baseline version. The installed
plugin self-update logic compares this field against the remote repository, so
do not rely on npm package versioning for this plugin unless the project later
becomes an npm-distributed package.

## Verification

After changing the installer or automation template, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\Install.Tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\tests\CodexStoreUpdater.Tests.ps1
```

Restart Codex if the plugin or automation does not appear immediately after
installation.
