[CmdletBinding()]
param(
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

Write-Host ("Selected package: {0}" -f $selected.FileName)
Write-Host ("Available version: {0}" -f $selected.Version)

$packagePath = Save-CodexPackage -Package $selected -DownloadDirectory $DownloadDirectory
Write-Host ("Downloaded package: {0}" -f $packagePath)
