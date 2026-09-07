[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,

    [string]$PackageName = "OpenAI.Codex",

    [string]$AppId = "App",

    [int]$StartDelaySeconds = 3,

    [string]$LogPath,

    [int]$ProbeSeconds = 30,

    [switch]$Worker
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Split-Path -Parent $scriptRoot
Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1") -Force

if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $pluginRoot "downloads\install-codex-msix-and-restart.log"
}

function Write-InstallLog {
    param([string]$Message)

    $logDirectory = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $LogPath -Value ("[{0}] {1}" -f $timestamp, $Message)
}

$resolvedPackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if (-not (Test-Path -LiteralPath $resolvedPackagePath)) {
    throw "Package path does not exist: $PackagePath"
}

$packageMetadata = Get-CodexPackageMetadata -FileName (Split-Path -Leaf $resolvedPackagePath) -Uri $resolvedPackagePath
if ($null -eq $packageMetadata) {
    throw "Package filename does not include parseable Codex metadata: $resolvedPackagePath"
}
if ($packageMetadata.Name -ne $PackageName) {
    throw "Refusing to install package '$($packageMetadata.Name)' when '$PackageName' was expected."
}

if (-not $Worker) {
    $powershellPath = Join-Path $PSHOME "powershell.exe"
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-Worker",
        "-PackagePath", $resolvedPackagePath,
        "-PackageName", $PackageName,
        "-AppId", $AppId,
        "-StartDelaySeconds", $StartDelaySeconds,
        "-ProbeSeconds", $ProbeSeconds,
        "-LogPath", $LogPath
    )

    Start-Process -FilePath $powershellPath -ArgumentList $arguments -WindowStyle Hidden
    Write-Host ("Started detached Codex install worker. Log: {0}" -f $LogPath)
    return
}

Write-InstallLog ("Worker started for package: {0}" -f $resolvedPackagePath)
Start-Sleep -Seconds $StartDelaySeconds

$codexProcesses = @(
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            # 进程名可能是 ChatGPT.exe / codex.exe 等，统一按包路径匹配
            $_.Path -like "*\WindowsApps\$PackageName`_*"
        }
)

foreach ($process in $codexProcesses) {
    if ($process.MainWindowHandle -ne 0) {
        [void]$process.CloseMainWindow()
    }
}

if ($codexProcesses.Count -gt 0) {
    Wait-Process -Id $codexProcesses.Id -Timeout 20 -ErrorAction SilentlyContinue
}

$remainingCodexProcesses = @(
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            # 进程名可能是 ChatGPT.exe / codex.exe 等，统一按包路径匹配
            $_.Path -like "*\WindowsApps\$PackageName`_*"
        }
)
foreach ($process in $remainingCodexProcesses) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
Write-InstallLog ("Closed {0} Codex Desktop process(es)." -f ($codexProcesses.Count + $remainingCodexProcesses.Count))

Write-InstallLog "Installing package with Add-AppxPackage..."
Add-AppxPackage -Path $resolvedPackagePath
Write-InstallLog "Install command completed."

$installedPackage = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
if ($null -eq $installedPackage) {
    throw "Installed package '$PackageName' was not found after install."
}

$installedVersion = [version]$installedPackage.Version
if ($installedVersion -lt $packageMetadata.Version) {
    throw "Installed package version '$installedVersion' is older than downloaded package version '$($packageMetadata.Version)'. Keeping package file for inspection: $resolvedPackagePath"
}

try {
    Remove-Item -LiteralPath $resolvedPackagePath -Force
    if (Test-Path -LiteralPath $resolvedPackagePath) {
        Write-InstallLog ("Package cleanup verification failed; file still exists: {0}" -f $resolvedPackagePath)
    }
    else {
        Write-InstallLog ("Removed installed package file: {0}" -f $resolvedPackagePath)
    }
}
catch {
    Write-InstallLog ("Package cleanup failed for {0}: {1}" -f $resolvedPackagePath, $_.Exception.Message)
}

# 从已安装包 manifest 动态解析真实 AppId（当前为 App，避免硬编码漂移）
$resolvedAppId = $AppId
try {
    $manifestPath = Join-Path $installedPackage.InstallLocation "AppxManifest.xml"
    if (Test-Path -LiteralPath $manifestPath) {
        [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
        $manifestAppId = @($manifest.Package.Applications.Application | Select-Object -First 1 -ExpandProperty Id)
        if (-not [string]::IsNullOrWhiteSpace($manifestAppId)) {
            $resolvedAppId = $manifestAppId
        }
    }
}
catch {
    Write-InstallLog ("Failed to resolve AppId from manifest, using '{0}': {1}" -f $resolvedAppId, $_.Exception.Message)
}
$appUserModelId = Get-CodexAppUserModelId -PackageFamilyName $installedPackage.PackageFamilyName -AppId $resolvedAppId
Write-InstallLog ("Restarting Codex with AppUserModelId: {0}" -f $appUserModelId)
Start-Process -FilePath "explorer.exe" -ArgumentList ("shell:AppsFolder\{0}" -f $appUserModelId)
Write-InstallLog ("Restart requested. Installed version: {0}" -f $installedPackage.Version)

# ---------- post-restart window probe ----------
# Detects the official "encrypted-resource relocation" bug where the app keeps
# running but its main window never appears after an update. If the window does
# not show up within $ProbeSeconds, log a prominent warning and a relocation
# health snapshot so the failure is visible in the install log.
Write-InstallLog ("Probing for a visible main window (up to {0} s)..." -f $ProbeSeconds)
$windowUp = Test-CodexDesktopWindowUp -PackageName $PackageName -Seconds $ProbeSeconds

if ($windowUp) {
    Write-InstallLog "Window probe OK: Codex main window is visible."
}
else {
    Write-InstallLog "WINDOW_PROBE=FAILED: Codex restarted but NO main window appeared within $ProbeSeconds s."
    Write-InstallLog "This is the signature of the official encrypted-resource relocation bug."

    try {
        $health = Get-CodexRelocationHealth -PackageName $PackageName
        if ($health.Installed) {
            Write-InstallLog "Relocation health snapshot:"
            foreach ($component in $health.Components) {
                Write-InstallLog ("  component {0,-10} state={1}" -f $component.Name, $component.State)
            }
            Write-InstallLog ("  bundled plugins materialized: {0}" -f $health.PluginsMaterialized)
        }
    }
    catch {
        Write-InstallLog ("Could not collect relocation health: {0}" -f $_.Exception.Message)
    }

    Write-InstallLog "Remedy: run docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1 (from the repo root) with pwsh, then relaunch Codex."
    exit 4
}
