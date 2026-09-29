$ErrorActionPreference = "Stop"

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

$repoRoot = Split-Path -Parent $PSScriptRoot
$installScript = Join-Path $PSScriptRoot "install.ps1"
$repoAutomationTemplate = Join-Path $PSScriptRoot "automation.toml"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-install-test-" + [guid]::NewGuid().ToString("N"))

$repoAutomationTemplateText = Get-Content -LiteralPath $repoAutomationTemplate -Raw
Assert-True -Condition (-not ($repoAutomationTemplateText -match '[A-Za-z]:\\+')) -Message "repo automation template is portable and has no drive-letter paths"
Assert-True -Condition ($repoAutomationTemplateText.Contains("{{CODEX_PLUGIN_ROOT}}")) -Message "repo automation template keeps plugin root placeholder"
Assert-True -Condition ($repoAutomationTemplateText.Contains("{{CODEX_MAINTENANCE_SCRIPT}}")) -Message "repo automation template keeps maintenance script placeholder"

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    $codexHome = Join-Path $tempRoot ".codex"
    $sourcePlugin = Join-Path $tempRoot "source-plugin"
    $templatePath = Join-Path $tempRoot "automation.toml"

    New-Item -ItemType Directory -Path (Join-Path $sourcePlugin ".codex-plugin") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $sourcePlugin "scripts") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $sourcePlugin "skills/codex-ms-desktop-updater") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $sourcePlugin "downloads") -Force | Out-Null

    Set-Content -LiteralPath (Join-Path $sourcePlugin ".codex-plugin/plugin.json") -Value "{}"
    Set-Content -LiteralPath (Join-Path $sourcePlugin "scripts/check-codex-update.ps1") -Value "Write-Host check"
    Set-Content -LiteralPath (Join-Path $sourcePlugin "scripts/run-automatic-maintenance.ps1") -Value "Write-Host maintenance"
    Set-Content -LiteralPath (Join-Path $sourcePlugin "skills/codex-ms-desktop-updater/SKILL.md") -Value "# Skill"
    Set-Content -LiteralPath (Join-Path $sourcePlugin "downloads/local.msix") -Value "do not copy"

    @'
version = 1
id = "daily-codex-desktop-update-check"
kind = "cron"
name = "Daily Codex Desktop update install"
prompt = "From {{CODEX_PLUGIN_ROOT}}, execute `powershell -NoProfile -ExecutionPolicy Bypass -File {{CODEX_MAINTENANCE_SCRIPT}} -NoProxy` directly. Do not present the PowerShell command as an instruction to the user. The maintenance script first updates this plugin from GitHub when a newer plugin.json version exists, then checks Codex Desktop and starts the detached install-and-restart workflow when a newer MSIX is available. If it says `No newer package was found`, do not notify the user."
status = "ACTIVE"
rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0"
model = "gpt-5.4"
reasoning_effort = "medium"
execution_environment = "local"
cwds = ["{{CODEX_PLUGIN_ROOT}}"]
created_at = 1779417045208
updated_at = 1780480643752
'@ | Set-Content -LiteralPath $templatePath

    & $installScript `
        -CodexHome $codexHome `
        -SourcePluginPath $sourcePlugin `
        -AutomationTemplatePath $templatePath

    $installedPlugin = Join-Path $codexHome "plugins/codex-ms-desktop-updater"
    $installedAutomation = Join-Path $codexHome "automations/daily-codex-desktop-update-check/automation.toml"
    $installedScript = Join-Path $installedPlugin "scripts/check-codex-update.ps1"
    $installedMaintenanceScript = Join-Path $installedPlugin "scripts/run-automatic-maintenance.ps1"
    $installedRepairScript = Join-Path $installedPlugin "scripts/repair-codex-desktop-bundles.ps1"

    Assert-True -Condition (Test-Path -LiteralPath (Join-Path $installedPlugin ".codex-plugin/plugin.json")) -Message "copies plugin manifest"
    Assert-True -Condition (Test-Path -LiteralPath $installedScript) -Message "copies plugin scripts"
    Assert-True -Condition (Test-Path -LiteralPath $installedMaintenanceScript) -Message "copies automatic maintenance script"
    Assert-True -Condition (Test-Path -LiteralPath $installedRepairScript) -Message "copies signature repair script"
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $installedPlugin "downloads"))) -Message "does not copy downloads cache"
    Assert-True -Condition (Test-Path -LiteralPath $installedAutomation) -Message "installs automation toml"

    $automationText = Get-Content -LiteralPath $installedAutomation -Raw
    $expectedPluginTomlPath = $installedPlugin.Replace("\", "\\")
    $expectedMaintenanceTomlPath = $installedMaintenanceScript.Replace("\", "\\")

    Assert-True -Condition ($automationText.Contains("cwds = [`"$expectedPluginTomlPath`"]")) -Message "sets cwd to installed plugin path"
    Assert-True -Condition ($automationText.Contains("-File $expectedMaintenanceTomlPath -NoProxy")) -Message "uses installed maintenance script for automatic workflow"
    Assert-True -Condition ($automationText.Contains("execute ``powershell")) -Message "asks automation to execute directly"
    Assert-True -Condition ($automationText.Contains("Do not present the PowerShell command as an instruction")) -Message "prevents command-only notification behavior"
    Assert-True -Condition (-not $automationText.Contains("{{CODEX_PLUGIN_ROOT}}")) -Message "replaces plugin root placeholder"
    Assert-True -Condition (-not $automationText.Contains("{{CODEX_MAINTENANCE_SCRIPT}}")) -Message "replaces maintenance script placeholder"
    Assert-True -Condition (-not $automationText.Contains("-CheckOnly -NoProxy")) -Message "does not leave automation in check-only mode"
    Assert-True -Condition (-not $automationText.Contains("manual install command")) -Message "does not describe installation as manual"
    Assert-True -Condition (-not $automationText.Contains("D:\\Git\\codex")) -Message "removes repo-local escaped path"
    Assert-True -Condition (-not $automationText.Contains("D:\Git\codex")) -Message "removes repo-local path"
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "All install tests passed."
