<#
================================================================================
check-codex-desktop-health.ps1
================================================================================
Purpose
    Health check for Codex Desktop (Microsoft Store / MSIX). Reports the state
    of the relocated bundle directories. Every check is read-only, and the
    component states are reported as facts — they are never used to infer why a
    main window did or did not appear.

    It inspects the five relocated bundle directories under
      %LOCALAPPDATA%\OpenAI\Codex   (bin, runtimes\cua_node)
      %USERPROFILE%\.codex\bin\wsl  (bin\wsl)
    plus leftover .staging-* / .repair-* dirs and the bundled-plugins
    materialization key.

    With -Probe it additionally launches the app (via its AppUserModelId) and
    waits up to -ProbeSeconds for a visible main window. If no window appears it
    reports that as a fact and adds the evidence it managed to collect
    (STARTUP_DIAGNOSIS= plus a window inventory); it reaches for the official
    encrypted-resource relocation bug only when the evidence actually says so.

Usage
    pwsh -NoProfile -File check-codex-desktop-health.ps1
    pwsh -NoProfile -File check-codex-desktop-health.ps1 -Probe -ProbeSeconds 25

Exit codes
    0  healthy (every component ok; probe, if requested, found a window)
    1  degraded (some bundle missing / partial / plugin key absent)
    2  package not installed
    3  probe ran but no main window appeared within the timeout. The cause, if
       one could be evidenced, is in the STARTUP_DIAGNOSIS= line; if it could
       not be, the line says so rather than guessing.
================================================================================
#>

[CmdletBinding()]
param(
    [string]$PackageName = "OpenAI.Codex",
    [switch]$Probe,
    [int]$ProbeSeconds = 20,

    # 探针失败后，如果诊断说「还在把运行时落到本地缓存」，再等这么久（0 = 不延长）。
    # 首次启动要落几百 MB（2026-10-01 实测约 132 秒），20 秒的默认探针必然误判。
    [int]$ProbeExtensionSeconds = 150
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

$probeBudgetSeconds = $ProbeSeconds
$windowUp = Test-CodexDesktopWindowUp `
    -PackageName $PackageName `
    -AppUserModelId $appUserModelId `
    -Seconds $ProbeSeconds `
    -Launch

$diagnosis = $null

if (-not $windowUp -and $ProbeExtensionSeconds -gt 0) {
    # 复用上面那份 $health（一个 SHA 都不重算）：判定只读 Installed / Id / Path 与
    # 目录 mtime，这些要么由版本决定、要么现取，跟 snapshot 的新旧无关。
    $diagnosis = Get-CodexStartupDiagnosis -PackageName $PackageName -Health $health
    if ($diagnosis.Verdict -eq 'still-preparing') {
        Write-Host ("Codex is still materializing its runtime into the local cache ({0}). Extending the window probe by {1} s." -f ($diagnosis.Evidence -join '; '), $ProbeExtensionSeconds)
        $probeBudgetSeconds = $ProbeSeconds + $ProbeExtensionSeconds
        # 不再传 -Launch：激活请求上面已经发过一次了。
        $windowUp = Test-CodexDesktopWindowUp `
            -PackageName $PackageName `
            -AppUserModelId $appUserModelId `
            -Seconds $ProbeExtensionSeconds
    }
}

if ($windowUp) {
    Write-Host "RESULT=window-visible"
    Write-Host "The Codex Desktop main window appeared. The app is launchable."
    exit 0
}

# 先把证据采集完，再写第一行日志：Get-CodexWindowInventory 首次要 Add-Type 编译 C#，
# 耗时数秒；调用方（桌面端）是按「最后一行输出之后一小段静默」判定结果已经落完的，
# 中间插一段静默编译会把整段窗口清单丢掉。
if ($null -eq $diagnosis) {
    $diagnosis = Get-CodexStartupDiagnosis -PackageName $PackageName -Health $health
}
$windows = Get-CodexWindowInventory -PackageName $PackageName -InstallLocation $health.InstallLocation

Write-Host "RESULT=window-not-visible"
Write-Host "WARNING: Codex Desktop processes are up but NO main window appeared within $probeBudgetSeconds s."
Write-Host ("STARTUP_DIAGNOSIS={0}" -f $diagnosis.Verdict)

$evidenceText = if ($diagnosis.Evidence.Count -gt 0) { $diagnosis.Evidence -join '; ' } else { 'none' }
switch ($diagnosis.Verdict) {
    'still-preparing' {
        Write-Host ("This is NOT the encrypted-resource relocation bug. Codex is still materializing its runtime into the local cache. Recent write activity: {0}." -f $evidenceText)
        Write-Host "Wait a minute or two and launch it again."
    }
    'relocation-bug' {
        Write-Host "This is the signature of the official encrypted-resource relocation bug."
        Write-Host ("Evidence: {0}" -f $evidenceText)
    }
    default {
        Write-Host ("No cause could be determined from the relocation-health evidence. This is not, by itself, evidence of the encrypted-resource relocation bug. Evidence: {0}." -f $evidenceText)
        Write-Host "Next: check the app's own logs under %LOCALAPPDATA%\OpenAI\Codex, and whether a Codex dialog or a crash is blocking the main window."
    }
}

if ($null -eq $windows) {
    Write-Host "Window inventory unavailable."
}
else {
    Write-Host "Codex top-level windows:"
    if ($windows.Count -eq 0) {
        Write-Host "  (none visible)"
    }
    else {
        foreach ($window in $windows) {
            Write-Host ("  pid={0} owned={1} class={2} title={3}" -f $window.ProcessId, $window.Owned, $window.Class, ('"{0}"' -f $window.Title))
        }
    }
}

if ($diagnosis.Verdict -eq 'relocation-bug') {
    Write-Host "Run the repair script from docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1, then launch again."
}
exit 3
