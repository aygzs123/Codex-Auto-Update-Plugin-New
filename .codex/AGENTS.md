# Repository maintenance guide

Use this guide when updating this repository itself. The root `AGENTS.md` is
for Codex agents that only need to install the plugin into a user's local Codex
settings.

## Version management

Use `plugins\codex-ms-desktop-updater\.codex-plugin\plugin.json` as the source
of truth for plugin versioning. Before any change is pushed to the remote
repository, bump its `version` field using numeric SemVer-compatible text such
as `0.2.2` or `0.2.3`.

GitHub CI runs `tools\Test-PluginVersionBump.ps1` on pull requests and pushes
to `main` to verify that the head version is greater than the baseline version.
The installed plugin self-update logic compares this field against the remote
repository, so do not rely on npm package versioning for this plugin unless the
project later becomes an npm-distributed package.

## Verification

After changing the installer, automation template, or plugin scripts, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\Install.Tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\tests\CodexStoreUpdater.Tests.ps1
```

Run `git diff --check` before committing to catch whitespace issues that would
also fail CI-style review.
