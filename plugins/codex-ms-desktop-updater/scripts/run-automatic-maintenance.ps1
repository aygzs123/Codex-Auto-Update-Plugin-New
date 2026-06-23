[CmdletBinding()]
param(
    [switch]$NoProxy
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$updatePluginScript = Join-Path $scriptRoot "update-installed-plugin.ps1"
$checkCodexScript = Join-Path $scriptRoot "check-codex-update.ps1"

$commonArgs = @()
if ($NoProxy) {
    $commonArgs += "-NoProxy"
}

Write-Host "Checking for plugin updates..."
& $updatePluginScript @commonArgs

Write-Host "Checking for Codex Desktop updates..."
& $checkCodexScript -InstallWithRestart @commonArgs
