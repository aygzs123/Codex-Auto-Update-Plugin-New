$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $pluginRoot "scripts/CodexStoreUpdater.psm1"
Import-Module $modulePath -Force

function Assert-Equal {
    param(
        [object]$Expected,
        [object]$Actual,
        [string]$Message
    )

    if ($Expected -ne $Actual) {
        throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'."
    }
}

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw "Assertion failed: $Message."
    }
}

$sampleHtml = @"
<html>
  <body>
    <table>
      <tr>
        <td><a href="https://example.invalid/OpenAI.Codex_26.506.3741.0_x64.msix">OpenAI.Codex_26.506.3741.0_x64.msix</a></td>
        <td>418 MB</td>
      </tr>
      <tr>
        <td><a href="https://example.invalid/OpenAI.Codex_26.512.10.0_x64.msix">OpenAI.Codex_26.512.10.0_x64.msix</a></td>
        <td>419 MB</td>
      </tr>
      <tr>
        <td><a href="https://example.invalid/OpenAI.Codex_26.512.10.0_arm64.msix">OpenAI.Codex_26.512.10.0_arm64.msix</a></td>
        <td>400 MB</td>
      </tr>
      <tr>
        <td><a href="https://example.invalid/Other.App_1.0.0.0_x64.msix">Other.App_1.0.0.0_x64.msix</a></td>
        <td>1 MB</td>
      </tr>
    </table>
  </body>
</html>
"@

$packages = ConvertFrom-RgAdguardHtml -Html $sampleHtml -PackageName "OpenAI.Codex"
Assert-Equal 3 $packages.Count "extracts only Codex package links"
Assert-Equal "26.506.3741.0" $packages[0].Version.ToString() "extracts version from package filename"
Assert-Equal "x64" $packages[0].Architecture "extracts architecture from package filename"

$metadata = Get-CodexPackageMetadata -FileName "OpenAI.Codex_26.512.10.0_x64.msix" -Uri "C:\Downloads\OpenAI.Codex_26.512.10.0_x64.msix"
Assert-Equal "OpenAI.Codex" $metadata.Name "parses package metadata name for install validation"
Assert-Equal "26.512.10.0" $metadata.Version.ToString() "parses package metadata version for cleanup validation"

$selected = Select-BestCodexPackage -Packages $packages -Architecture "x64"
Assert-Equal "OpenAI.Codex_26.512.10.0_x64.msix" $selected.FileName "selects newest matching architecture package"

$installed = ConvertFrom-AppxPackageText -Text "Name : OpenAI.Codex`nVersion : 26.506.3741.0`nArchitecture : X64"
Assert-Equal "26.506.3741.0" $installed.Version.ToString() "parses installed package version"

Assert-True -Condition (Test-IsUpdateAvailable -InstalledVersion ([version]"26.506.3741.0") -AvailableVersion ([version]"26.512.10.0")) -Message "detects newer available version"
Assert-True -Condition (-not (Test-IsUpdateAvailable -InstalledVersion ([version]"26.512.10.0") -AvailableVersion ([version]"26.512.10.0"))) -Message "does not update equal versions"

$tempDownloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-store-updater-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDownloadDirectory -Force | Out-Null
try {
    $oldPackage = Join-Path $tempDownloadDirectory "OpenAI.Codex_26.506.3741.0_x64.msix"
    $currentPackage = Join-Path $tempDownloadDirectory "OpenAI.Codex_26.512.10.0_x64.msix"
    $newerPackage = Join-Path $tempDownloadDirectory "OpenAI.Codex_26.513.1.0_x64.msix"
    $otherPackage = Join-Path $tempDownloadDirectory "Other.App_1.0.0.0_x64.msix"
    $partialPackage = Join-Path $tempDownloadDirectory "OpenAI.Codex_26.512.10.0_x64.msix.partial"

    foreach ($path in @($oldPackage, $currentPackage, $newerPackage, $otherPackage, $partialPackage)) {
        Set-Content -LiteralPath $path -Value "test"
    }

    $removedPackages = Remove-InstalledCodexPackageFiles `
        -DownloadDirectory $tempDownloadDirectory `
        -InstalledVersion ([version]"26.512.10.0") `
        -PackageName "OpenAI.Codex"

    Assert-Equal 2 $removedPackages.Count "removes only installed-or-older Codex packages"
    Assert-True -Condition (-not (Test-Path -LiteralPath $oldPackage)) -Message "removes older package"
    Assert-True -Condition (-not (Test-Path -LiteralPath $currentPackage)) -Message "removes current installed package"
    Assert-True -Condition (Test-Path -LiteralPath $newerPackage) -Message "keeps newer package"
    Assert-True -Condition (Test-Path -LiteralPath $otherPackage) -Message "keeps other app package"
    Assert-True -Condition (Test-Path -LiteralPath $partialPackage) -Message "keeps partial file"
}
finally {
    Remove-Item -LiteralPath $tempDownloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

Assert-True -Condition (Test-IsPluginUpdateAvailable -InstalledVersion "0.1.1" -AvailableVersion "0.2.0") -Message "detects newer plugin version"
Assert-True -Condition (-not (Test-IsPluginUpdateAvailable -InstalledVersion "0.2.0" -AvailableVersion "0.2.0")) -Message "does not update equal plugin version"

$invalidPluginVersionThrew = $false
try {
    ConvertTo-CodexPluginVersion -VersionText "0.2.0-beta" | Out-Null
}
catch {
    $invalidPluginVersionThrew = $true
}
Assert-True -Condition $invalidPluginVersionThrew -Message "requires numeric plugin versions"
$appUserModelId = Get-CodexAppUserModelId -PackageFamilyName "OpenAI.Codex_2p2nqsd0c76g0" -AppId "Codex"
Assert-Equal "OpenAI.Codex_2p2nqsd0c76g0!Codex" $appUserModelId "builds Codex AppUserModelId"

$installRestartScript = Join-Path $pluginRoot "scripts/install-codex-msix-and-restart.ps1"
Assert-True -Condition (Test-Path -LiteralPath $installRestartScript) -Message "provides install-and-restart script"
$installRestartScriptText = Get-Content -LiteralPath $installRestartScript -Raw
Assert-True -Condition ($installRestartScriptText -match '\[switch\]\$Worker') -Message "install-and-restart script has detached worker mode"
Assert-True -Condition ($installRestartScriptText -match 'Add-AppxPackage') -Message "install-and-restart script installs MSIX package"
Assert-True -Condition ($installRestartScriptText -match 'Get-CodexPackageMetadata') -Message "install-and-restart script validates package metadata"
Assert-True -Condition ($installRestartScriptText -match 'installedVersion -lt') -Message "install-and-restart script verifies installed version before cleanup"
Assert-True -Condition ($installRestartScriptText -match 'Remove-Item -LiteralPath \$resolvedPackagePath') -Message "install-and-restart script removes installed package file"

$checkScript = Join-Path $pluginRoot "scripts/check-codex-update.ps1"
$checkScriptText = Get-Content -LiteralPath $checkScript -Raw
Assert-True -Condition ($checkScriptText -match '\[switch\]\$InstallWithRestart') -Message "check script exposes install-with-restart mode"
Assert-True -Condition ($checkScriptText -match 'install-codex-msix-and-restart\.ps1') -Message "check script invokes install-and-restart script"

$pluginUpdateScript = Join-Path $pluginRoot "scripts/update-installed-plugin.ps1"
Assert-True -Condition (Test-Path -LiteralPath $pluginUpdateScript) -Message "provides plugin self-update script"
$pluginUpdateScriptText = Get-Content -LiteralPath $pluginUpdateScript -Raw
Assert-True -Condition ($pluginUpdateScriptText -match 'aygzs123') -Message "plugin update script defaults to repository owner"
Assert-True -Condition ($pluginUpdateScriptText -match 'Codex-Auto-Update-Plugin-New') -Message "plugin update script defaults to remote repository"
Assert-True -Condition ($pluginUpdateScriptText -match 'raw\.githubusercontent\.com') -Message "plugin update script reads remote manifest"
Assert-True -Condition ($pluginUpdateScriptText -match 'codeload\.github\.com') -Message "plugin update script downloads repository archive"
Assert-True -Condition ($pluginUpdateScriptText -match 'Copy-PluginWithoutDownloads') -Message "plugin update script skips downloads cache"

$maintenanceScript = Join-Path $pluginRoot "scripts/run-automatic-maintenance.ps1"
Assert-True -Condition (Test-Path -LiteralPath $maintenanceScript) -Message "provides automatic maintenance script"
$maintenanceScriptText = Get-Content -LiteralPath $maintenanceScript -Raw
Assert-True -Condition ($maintenanceScriptText -match 'update-installed-plugin\.ps1') -Message "maintenance script updates plugin first"
Assert-True -Condition ($maintenanceScriptText -match 'check-codex-update\.ps1') -Message "maintenance script checks Codex package"
Assert-True -Condition ($maintenanceScriptText -match 'InstallWithRestart') -Message "maintenance script installs Codex update with restart"

Write-Host "All CodexStoreUpdater tests passed."
