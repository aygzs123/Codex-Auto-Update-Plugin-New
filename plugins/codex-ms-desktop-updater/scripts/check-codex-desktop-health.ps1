<#
================================================================================
check-codex-desktop-health.ps1
================================================================================
Purpose
    Health check for Codex Desktop (Microsoft Store / MSIX). Detects the
    "app is running but the main window never appears" state caused by the
    encrypted-resource relocation failure, without launching the app.

    It inspects the five relocated bundle directories under
      %LOCALAPPDATA%\OpenAI\Codex   (bin, runtimes\cua_node)
      %USERPROFILE%\.codex\bin\wsl  (bin\wsl)
    plus leftover .staging-* / .repair-* dirs and the bundled-plugins
    materialization key. Every check is read-only.

    With -Probe it additionally launches the app (via its AppUserModelId) and
    waits up to -ProbeSeconds for a visible main window, which reproduces the
    reported bug directly.

Usage
    pwsh -NoProfile -File check-codex-desktop-health.ps1
    pwsh -NoProfile -File check-codex-desktop-health.ps1 -Probe -ProbeSeconds 25

Exit codes
    0  healthy (every component ok; probe, if requested, found a window)
    1  degraded (some bundle missing / partial / plugin key absent)
    2  package not installed
    3  probe ran but no main window appeared within the timeout
================================================================================
#>

[CmdletBinding()]
param(
    [string]$PackageName = "OpenAI.Codex",
    [switch]$Probe,
    [int]$ProbeSeconds = 20
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1") -Force

$health = Get-CodexRelocationHealth -PackageName $PackageName

if (-not $health.Installed) {
    Write-Host ("Codex Desktop package '{0}' is not installed (or not visible to Get-AppxPackage)." -f $PackageName)
    Write-Host "OVERALL=not-installed"
    exit 2
}

Write-Host ("Package  : {0}" -f $health.PackageFullName)
Write-Host ("Version  : {0}" -f $health.Version)
# 安装位置现取现报，不猜也不写死。MSIX 可以装在别的盘（用户把「新的应用将保存到」
# 设成 D: 时就在 D:\WindowsApps），这里打印的是包自己报的路径 —— 界面拿它给用户看，
# 免得「到底装哪儿了、C 盘是不是被占了」只能靠猜。
Write-Host ("Location : {0}" -f $health.InstallLocation)

$overall = "ok"
foreach ($c in $health.Components) {
    $symbol = switch ($c.State) {
        "ok"      { "OK   " }
        "missing" { "MISS " }
        "partial" { "PART " }
        "error"   { "ERR  " }
        default   { "?    " }
    }
    $extra = ""
    if ($c.State -ne "ok") { $extra = "  <- staging/repair leftovers: {0}" -f $c.StagingCount }
    Write-Host ("[{0}] {1,-12} {2}{3}" -f $symbol, $c.Name, $c.Path, $extra)
    if ($c.State -ne "ok") { $overall = "degraded" }
}

Write-Host ("Plugins  : {0}" -f $(if ($health.PluginsMaterialized) { "materialized" } else { "NOT materialized (bundled plugins stale)" }))
Write-Host ("OVERALL={0}" -f $overall)

if (-not $Probe) {
    exit $(if ($overall -eq "ok") { 0 } else { 1 })
}

Write-Host ""
Write-Host "Probing for a visible main window..."

# Resolve the app id from the package manifest when possible.
$appId = "App"
try {
    $manifestPath = Join-Path $health.InstallLocation "AppxManifest.xml"
    if (Test-Path -LiteralPath $manifestPath) {
        [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
        # Do NOT wrap this in @(): that yields a single-element array, and binding an
        # array to a [string] parameter fails on Windows PowerShell 5.1 with
        # "Cannot process argument transformation on parameter 'AppId'". The throw
        # aborted this script below, so the probe never reported a result at all.
        $fromManifest = $manifest.Package.Applications.Application | Select-Object -First 1 -ExpandProperty Id
        if (-not [string]::IsNullOrWhiteSpace($fromManifest)) {
            $appId = $fromManifest
        }
    }
}
catch {
    # fall back to the default app id
}

$appUserModelId = Get-CodexAppUserModelId -PackageFamilyName $health.PackageFamilyName -AppId $appId
Write-Host ("AppUserModelId: {0}" -f $appUserModelId)

$windowUp = Test-CodexDesktopWindowUp `
    -PackageName $PackageName `
    -AppUserModelId $appUserModelId `
    -Seconds $ProbeSeconds `
    -Launch

if ($windowUp) {
    Write-Host "RESULT=window-visible"
    Write-Host "The Codex Desktop main window appeared. The app is launchable."
    exit 0
}

Write-Host "RESULT=window-not-visible"
Write-Host "WARNING: Codex Desktop processes are up but NO main window appeared within $ProbeSeconds s."
Write-Host "This is the signature of the official encrypted-resource relocation bug."
Write-Host "Run the repair script from docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1, then launch again."
exit 3
