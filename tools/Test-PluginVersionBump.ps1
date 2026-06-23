[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BaseRef,

    [string]$HeadRef = "HEAD",

    [string]$PluginManifestPath = "plugins/codex-ms-desktop-updater/.codex-plugin/plugin.json"
)

$ErrorActionPreference = "Stop"

function Test-IsZeroSha {
    param([string]$Value)

    return ($Value -match '^0+$')
}

function Invoke-GitText {
    param([string[]]$Arguments)

    $output = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed: $output"
    }

    return ($output -join [Environment]::NewLine)
}

function Get-ManifestVersionAtRef {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Ref,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $jsonText = Invoke-GitText -Arguments @("show", "${Ref}:${Path}")
    $manifest = $jsonText | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($manifest.version)) {
        throw "Manifest at ${Ref}:${Path} has no version."
    }
    if ($manifest.version -notmatch '^\d+(?:\.\d+){1,3}$') {
        throw "Manifest at ${Ref}:${Path} has non-numeric version '$($manifest.version)'."
    }

    return [version]$manifest.version
}

if ([string]::IsNullOrWhiteSpace($BaseRef) -or (Test-IsZeroSha -Value $BaseRef)) {
    Write-Host "No usable base ref was provided; skipping plugin version bump check."
    return
}

Invoke-GitText -Arguments @("rev-parse", "--verify", "$BaseRef^{commit}") | Out-Null
Invoke-GitText -Arguments @("rev-parse", "--verify", "$HeadRef^{commit}") | Out-Null

$changedFilesText = Invoke-GitText -Arguments @("diff", "--name-only", $BaseRef, $HeadRef)
$changedFiles = @($changedFilesText -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($changedFiles.Count -eq 0) {
    Write-Host "No changed files; skipping plugin version bump check."
    return
}

$baseVersion = Get-ManifestVersionAtRef -Ref $BaseRef -Path $PluginManifestPath
$headVersion = Get-ManifestVersionAtRef -Ref $HeadRef -Path $PluginManifestPath

Write-Host ("Base plugin version: {0}" -f $baseVersion)
Write-Host ("Head plugin version: {0}" -f $headVersion)

if ($headVersion -le $baseVersion) {
    throw "Plugin version must be bumped in $PluginManifestPath for repository changes. Current head version '$headVersion' is not greater than base version '$baseVersion'."
}

Write-Host "Plugin version bump check passed."
