[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$NoProxy,
    [string]$RepositoryOwner = "Asunazzz123",
    [string]$RepositoryName = "Codex-Auto-Update-Plugin",
    [string]$Branch = "main",
    [string]$PluginName = "codex-ms-desktop-updater",
    [string]$PluginRoot,
    [string]$RemoteManifestUri,
    [string]$ArchiveUri
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($PluginRoot)) {
    $PluginRoot = Split-Path -Parent $scriptRoot
}

Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1") -Force

if ([string]::IsNullOrWhiteSpace($RemoteManifestUri)) {
    $RemoteManifestUri = "https://raw.githubusercontent.com/$RepositoryOwner/$RepositoryName/$Branch/plugins/$PluginName/.codex-plugin/plugin.json"
}
if ([string]::IsNullOrWhiteSpace($ArchiveUri)) {
    $ArchiveUri = "https://codeload.github.com/$RepositoryOwner/$RepositoryName/zip/refs/heads/$Branch"
}

if ($NoProxy) {
    $env:HTTP_PROXY = ""
    $env:HTTPS_PROXY = ""
    $env:ALL_PROXY = ""
    $env:NO_PROXY = "*"
    [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy
}

function Invoke-PluginTextRequest {
    param([Parameter(Mandatory = $true)][string]$Uri)

    try {
        return (Invoke-WebRequest -Uri $Uri -UseBasicParsing).Content
    }
    catch {
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($null -eq $curl) {
            throw
        }

        $curlArgs = @("-sS", "-L", "--fail")
        if ($NoProxy) {
            $curlArgs += @("--noproxy", "*")
        }
        $curlArgs += $Uri

        $content = & $curl.Source @curlArgs
        if ($LASTEXITCODE -ne 0) {
            throw "curl.exe exited with code $LASTEXITCODE while requesting $Uri"
        }
        return ($content -join [Environment]::NewLine)
    }
}

function Save-PluginArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Path
    )

    try {
        Invoke-WebRequest -Uri $Uri -OutFile $Path -UseBasicParsing
        return
    }
    catch {
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($null -eq $curl) {
            throw
        }

        $curlArgs = @("-sS", "-L", "--fail")
        if ($NoProxy) {
            $curlArgs += @("--noproxy", "*")
        }
        $curlArgs += @("-o", $Path, $Uri)

        & $curl.Source @curlArgs
        if ($LASTEXITCODE -ne 0) {
            throw "curl.exe exited with code $LASTEXITCODE while downloading $Uri"
        }
    }
}

function Copy-PluginWithoutDownloads {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $resolvedSource = (Resolve-Path -LiteralPath $Source).Path.TrimEnd("\", "/")
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null

    Get-ChildItem -LiteralPath $resolvedSource -Recurse -Force | ForEach-Object {
        $relativePath = $_.FullName.Substring($resolvedSource.Length).TrimStart("\", "/")
        if ($relativePath -eq "downloads" -or
            $relativePath.StartsWith("downloads\", [System.StringComparison]::OrdinalIgnoreCase) -or
            $relativePath.StartsWith("downloads/", [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }

        $targetPath = Join-Path $Destination $relativePath
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
            return
        }

        $targetDirectory = Split-Path -Parent $targetPath
        New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $targetPath -Force
    }
}

$localManifestPath = Join-Path $PluginRoot ".codex-plugin/plugin.json"
if (-not (Test-Path -LiteralPath $localManifestPath)) {
    throw "Local plugin manifest does not exist: $localManifestPath"
}

$localManifest = Get-Content -LiteralPath $localManifestPath -Raw | ConvertFrom-Json
$remoteManifest = Invoke-PluginTextRequest -Uri $RemoteManifestUri | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($localManifest.version)) {
    throw "Local plugin manifest has no version: $localManifestPath"
}
if ([string]::IsNullOrWhiteSpace($remoteManifest.version)) {
    throw "Remote plugin manifest has no version: $RemoteManifestUri"
}

$updateAvailable = Test-IsPluginUpdateAvailable `
    -InstalledVersion $localManifest.version `
    -AvailableVersion $remoteManifest.version

Write-Host ("Installed plugin version: {0}" -f $localManifest.version)
Write-Host ("Available plugin version: {0}" -f $remoteManifest.version)
Write-Host ("Plugin update available: {0}" -f $updateAvailable)

if ($CheckOnly) {
    return
}

if (-not $updateAvailable) {
    Write-Host "No newer plugin version was found. Skipping plugin update."
    return
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-plugin-update-" + [guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tempRoot "repo.zip"
$extractRoot = Join-Path $tempRoot "extract"

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
    Save-PluginArchive -Uri $ArchiveUri -Path $zipPath
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

    $sourcePluginRoot = $null
    foreach ($directory in Get-ChildItem -LiteralPath $extractRoot -Directory) {
        $candidate = Join-Path $directory.FullName "plugins/$PluginName"
        if (Test-Path -LiteralPath (Join-Path $candidate ".codex-plugin/plugin.json")) {
            $sourcePluginRoot = $candidate
            break
        }
    }

    if ($null -eq $sourcePluginRoot) {
        throw "Downloaded archive does not contain plugins/$PluginName/.codex-plugin/plugin.json"
    }

    Copy-PluginWithoutDownloads -Source $sourcePluginRoot -Destination $PluginRoot
    Write-Host ("Updated plugin to version {0}." -f $remoteManifest.version)
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
