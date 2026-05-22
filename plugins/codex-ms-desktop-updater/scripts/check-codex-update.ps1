[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$DownloadOnly,
    [switch]$Install,
    [switch]$InstallWithRestart,
    [switch]$NoProxy,
    [string]$StoreUrl = "https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK",
    [string]$Ring = "Retail",
    [string]$Architecture = "x64",
    [string]$PackageName = "OpenAI.Codex",
    [string]$DownloadDirectory
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Split-Path -Parent $scriptRoot
if ([string]::IsNullOrWhiteSpace($DownloadDirectory)) {
    $DownloadDirectory = Join-Path $pluginRoot "downloads"
}

Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1") -Force

$writeModes = @($CheckOnly, $DownloadOnly, $Install, $InstallWithRestart) | Where-Object { $_ }
if ($writeModes.Count -gt 1) {
    throw "Use only one of -CheckOnly, -DownloadOnly, -Install, or -InstallWithRestart."
}

if ($NoProxy) {
    $env:HTTP_PROXY = ""
    $env:HTTPS_PROXY = ""
    $env:ALL_PROXY = ""
    $env:NO_PROXY = "*"
    [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy
}

Write-Host "Querying Codex package links from store.rg-adguard.net..."
$html = Invoke-RgAdguardQuery -StoreUrl $StoreUrl -Ring $Ring
$packages = ConvertFrom-RgAdguardHtml -Html $html -PackageName $PackageName
if ($packages.Count -eq 0) {
    throw "No '$PackageName' MSIX/AppX links were found in the rg-adguard response."
}

$selected = Select-BestCodexPackage -Packages $packages -Architecture $Architecture
if ($null -eq $selected) {
    throw "Could not select a package from rg-adguard response."
}

$installed = Get-InstalledCodexPackageInfo -PackageName $PackageName
$installedVersion = if ($null -eq $installed) { $null } else { $installed.Version }
$updateAvailable = Test-IsUpdateAvailable -InstalledVersion $installedVersion -AvailableVersion $selected.Version

Write-Host ("Installed version: {0}" -f $(if ($null -eq $installedVersion) { "not installed or not visible to Get-AppxPackage" } else { $installedVersion.ToString() }))
Write-Host ("Available version: {0}" -f $selected.Version)
Write-Host ("Selected package: {0}" -f $selected.FileName)
Write-Host ("Update available: {0}" -f $updateAvailable)

$removedPackagePaths = Remove-InstalledCodexPackageFiles `
    -DownloadDirectory $DownloadDirectory `
    -InstalledVersion $installedVersion `
    -PackageName $PackageName
if ($removedPackagePaths.Count -gt 0) {
    Write-Host ("Removed {0} installed-or-older package file(s) from download cache:" -f $removedPackagePaths.Count)
    foreach ($removedPackagePath in $removedPackagePaths) {
        Write-Host ("  {0}" -f $removedPackagePath)
    }
}

if ($CheckOnly -or (-not $DownloadOnly -and -not $Install -and -not $InstallWithRestart)) {
    return
}

if (-not $updateAvailable) {
    Write-Host "No newer package was found. Skipping download."
    return
}

$packagePath = Save-CodexPackage -Package $selected -DownloadDirectory $DownloadDirectory
Write-Host ("Downloaded package: {0}" -f $packagePath)

if ($Install) {
    Write-Host "Installing package with Add-AppxPackage..."
    Install-CodexPackage -Path $packagePath
    Write-Host "Install command completed."

    $installedAfterInstall = Get-InstalledCodexPackageInfo -PackageName $PackageName
    $installedVersionAfterInstall = if ($null -eq $installedAfterInstall) { $null } else { $installedAfterInstall.Version }
    $removedAfterInstall = Remove-InstalledCodexPackageFiles `
        -DownloadDirectory $DownloadDirectory `
        -InstalledVersion $installedVersionAfterInstall `
        -PackageName $PackageName
    if ($removedAfterInstall.Count -gt 0) {
        Write-Host ("Removed {0} installed-or-older package file(s) after install:" -f $removedAfterInstall.Count)
        foreach ($removedPackagePath in $removedAfterInstall) {
            Write-Host ("  {0}" -f $removedPackagePath)
        }
    }
}

if ($InstallWithRestart) {
    $installRestartScript = Join-Path $scriptRoot "install-codex-msix-and-restart.ps1"
    Write-Host "Starting detached install-and-restart workflow..."
    & $installRestartScript -PackagePath $packagePath -PackageName $PackageName
}
