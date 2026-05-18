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

$selected = Select-BestCodexPackage -Packages $packages -Architecture "x64"
Assert-Equal "OpenAI.Codex_26.512.10.0_x64.msix" $selected.FileName "selects newest matching architecture package"

$installed = ConvertFrom-AppxPackageText -Text "Name : OpenAI.Codex`nVersion : 26.506.3741.0`nArchitecture : X64"
Assert-Equal "26.506.3741.0" $installed.Version.ToString() "parses installed package version"

Assert-True -Condition (Test-IsUpdateAvailable -InstalledVersion ([version]"26.506.3741.0") -AvailableVersion ([version]"26.512.10.0")) -Message "detects newer available version"
Assert-True -Condition (-not (Test-IsUpdateAvailable -InstalledVersion ([version]"26.512.10.0") -AvailableVersion ([version]"26.512.10.0"))) -Message "does not update equal versions"

Write-Host "All CodexStoreUpdater tests passed."
