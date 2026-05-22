[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,

    [string]$PackageName = "OpenAI.Codex",

    [string]$AppId = "Codex",

    [int]$StartDelaySeconds = 3,

    [string]$LogPath,

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
            ($_.ProcessName -eq "Codex" -or $_.ProcessName -eq "codex") -and
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
            ($_.ProcessName -eq "Codex" -or $_.ProcessName -eq "codex") -and
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

$appUserModelId = Get-CodexAppUserModelId -PackageFamilyName $installedPackage.PackageFamilyName -AppId $AppId
Write-InstallLog ("Restarting Codex with AppUserModelId: {0}" -f $appUserModelId)
Start-Process -FilePath "explorer.exe" -ArgumentList ("shell:AppsFolder\{0}" -f $appUserModelId)
Write-InstallLog ("Restart requested. Installed version: {0}" -f $installedPackage.Version)
