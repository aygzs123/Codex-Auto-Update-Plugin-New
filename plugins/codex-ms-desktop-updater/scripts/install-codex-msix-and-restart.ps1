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

$appUserModelId = Get-CodexAppUserModelId -PackageFamilyName $installedPackage.PackageFamilyName -AppId $AppId
Write-InstallLog ("Restarting Codex with AppUserModelId: {0}" -f $appUserModelId)
Start-Process -FilePath "explorer.exe" -ArgumentList ("shell:AppsFolder\{0}" -f $appUserModelId)
Write-InstallLog ("Restart requested. Installed version: {0}" -f $installedPackage.Version)
