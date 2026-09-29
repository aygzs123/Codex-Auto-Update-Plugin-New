[CmdletBinding()]
param(
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$SourcePluginPath,
    [string]$AutomationTemplatePath
)

$ErrorActionPreference = "Stop"

$pluginName = "codex-ms-desktop-updater"
$automationId = "daily-codex-desktop-update-check"

function Resolve-InstallPath {
    param([string]$Path)

    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function ConvertTo-TomlStringLiteral {
    param([string]$Value)

    return ($Value -replace "\\", "\\" -replace '"', '\"')
}

function Set-TomlLine {
    param(
        [string[]]$Lines,
        [string]$Key,
        [string]$Value
    )

    $pattern = "^\s*$([regex]::Escape($Key))\s*="
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index] -match $pattern) {
            $Lines[$index] = "$Key = $Value"
            return $Lines
        }
    }

    return @($Lines + "$Key = $Value")
}

function Copy-PluginWithoutDownloads {
    param(
        [string]$Source,
        [string]$Destination
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

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourcePluginPath) {
    $SourcePluginPath = Join-Path $repoRoot "plugins/$pluginName"
}
if (-not $AutomationTemplatePath) {
    $AutomationTemplatePath = Join-Path $PSScriptRoot "automation.toml"
}

$codexHomePath = Resolve-InstallPath $CodexHome
$sourcePluginRoot = Resolve-InstallPath $SourcePluginPath
$automationTemplate = Resolve-InstallPath $AutomationTemplatePath

if (-not (Test-Path -LiteralPath $sourcePluginRoot)) {
    throw "Plugin source path does not exist: $sourcePluginRoot"
}
if (-not (Test-Path -LiteralPath $automationTemplate)) {
    throw "Automation template does not exist: $automationTemplate"
}

$installedPluginRoot = Join-Path (Join-Path $codexHomePath "plugins") $pluginName
$automationDirectory = Join-Path (Join-Path $codexHomePath "automations") $automationId
$installedAutomationPath = Join-Path $automationDirectory "automation.toml"
$installedMaintenanceScript = Join-Path $installedPluginRoot "scripts/run-automatic-maintenance.ps1"
$repairScriptSource = Join-Path $repoRoot "docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1"
$repairScriptDestination = Join-Path $installedPluginRoot "scripts/repair-codex-desktop-bundles.ps1"

Copy-PluginWithoutDownloads -Source $sourcePluginRoot -Destination $installedPluginRoot

# The desktop control center invokes this repair through the installed plugin
# root, so keep the reviewed script available after installation as well.
if (Test-Path -LiteralPath $repairScriptSource) {
    Copy-Item -LiteralPath $repairScriptSource -Destination $repairScriptDestination -Force
}

New-Item -ItemType Directory -Path $automationDirectory -Force | Out-Null

$installCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File $installedMaintenanceScript -NoProxy"
$prompt = "From $installedPluginRoot, execute ``$installCommand`` directly. Do not present the PowerShell command as an instruction to the user. The maintenance script first updates this plugin from GitHub when a newer plugin.json version exists, then checks Codex Desktop and starts the detached install-and-restart workflow when a newer MSIX is available. If it says ``No newer package was found``, do not notify the user."

$automationLines = (Get-Content -LiteralPath $automationTemplate -Raw) -split "\r?\n"
$automationLines = Set-TomlLine -Lines $automationLines -Key "prompt" -Value "`"$(ConvertTo-TomlStringLiteral $prompt)`""
$automationLines = Set-TomlLine -Lines $automationLines -Key "cwds" -Value "[`"$(ConvertTo-TomlStringLiteral $installedPluginRoot)`"]"

Set-Content -LiteralPath $installedAutomationPath -Value ($automationLines -join [Environment]::NewLine)

Write-Host "Installed plugin: $installedPluginRoot"
Write-Host "Installed automation: $installedAutomationPath"
Write-Host "Skipped plugin downloads cache."
