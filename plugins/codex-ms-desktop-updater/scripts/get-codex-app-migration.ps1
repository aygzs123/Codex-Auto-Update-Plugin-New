<#
================================================================================
get-codex-app-migration.ps1
================================================================================
Purpose
    Read-only capability check for moving the installed Codex MSIX to another
    Windows AppxVolume. Reports the package identity, its current volume, the
    volumes Windows knows about, and why a move would or would not be enabled.

    This script never moves anything. "movable" here means the local checks
    passed; the deployment service still decides at execution time, and the
    caller must re-read InstallLocation afterwards.

Usage
    powershell -NoProfile -ExecutionPolicy Bypass -File get-codex-app-migration.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File get-codex-app-migration.ps1 -Name OpenAI.Codex

Output
    A single JSON object on stdout. Exit code is 0 whenever JSON was produced;
    read the fields, not the exit code.
================================================================================
#>

[CmdletBinding()]
param(
    [string]$Name = "OpenAI.Codex"
)

$ErrorActionPreference = "Stop"
$WarningPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function New-Result {
    param(
        [bool]$Installed,
        $Version,
        $InstallLocation,
        $PackageVolume,
        [bool]$Movable,
        [string]$Reason,
        [object[]]$Volumes
    )

    return [ordered]@{
        installed       = $Installed
        version         = $Version
        installLocation = $InstallLocation
        packageVolume   = $PackageVolume
        movable         = $Movable
        reason          = $Reason
        volumes         = @($Volumes)
    }
}

function Get-AppxVolumeList {
    # Get-AppxVolume is missing on some older builds; treat that as "no known
    # secondary volumes" instead of failing the whole check.
    try {
        return @(Get-AppxVolume -ErrorAction Stop)
    }
    catch {
        return @()
    }
}

try {
    $volumes = Get-AppxVolumeList
    $volumeInfo = @(
        foreach ($volume in $volumes) {
            $storePath = [string]$volume.PackageStorePath
            if ([string]::IsNullOrWhiteSpace($storePath)) { continue }
            [ordered]@{
                path           = $storePath
                isSystemVolume = [bool]$volume.IsSystemVolume
            }
        }
    )

    $package = Get-AppxPackage -Name $Name -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if (-not $package) {
        New-Result -Installed $false -Version $null -InstallLocation $null `
            -PackageVolume $null -Movable $false `
            -Reason "没有检测到已安装的 Codex。" -Volumes $volumeInfo |
            ConvertTo-Json -Depth 6 -Compress
        exit 0
    }

    $installLocation = [string]$package.InstallLocation
    $packageVolume = $null
    foreach ($volume in $volumes) {
        $storePath = [string]$volume.PackageStorePath
        if ([string]::IsNullOrWhiteSpace($storePath)) { continue }
        if ($installLocation.StartsWith($storePath, [System.StringComparison]::OrdinalIgnoreCase)) {
            # Prefer the longest matching store path (nested volume layouts).
            if (-not $packageVolume -or $storePath.Length -gt $packageVolume.Length) {
                $packageVolume = $storePath
            }
        }
    }

    $reasons = @()
    $movable = $true

    if (-not (Get-Command -Name "Move-AppxPackage" -ErrorAction SilentlyContinue)) {
        $movable = $false
        $reasons += "当前 Windows 没有提供 Move-AppxPackage。"
    }

    if ([string]::IsNullOrWhiteSpace($packageVolume)) {
        $movable = $false
        $reasons += "无法确定 Codex 当前所在的 AppxVolume。"
    }

    if ($package.Status -and [string]$package.Status -ne "Ok") {
        $movable = $false
        $reasons += ("包状态为 {0}，需要先修复。" -f $package.Status)
    }

    # NonRemovable is present on Windows 11; absent on older builds, in which
    # case it must not be treated as "removable" evidence either way. The
    # deployment service remains the final authority.
    $nonRemovable = $package.PSObject.Properties.Name -contains "NonRemovable" -and [bool]$package.NonRemovable
    if ($nonRemovable) {
        $movable = $false
        $reasons += "Windows 将该包标记为不可移动（NonRemovable）。"
    }

    if ($package.IsFramework) {
        $movable = $false
        $reasons += "框架包不能移动。"
    }

    if ($package.PSObject.Properties.Name -contains "IsDevelopmentMode" -and [bool]$package.IsDevelopmentMode) {
        $movable = $false
        $reasons += "开发模式加载的包不能移动，请先正式安装。"
    }

    $targets = @(
        foreach ($volume in $volumeInfo) {
            if ([string]::IsNullOrWhiteSpace($packageVolume)) { $volume; continue }
            if ($volume.path -ine $packageVolume) { $volume }
        }
    )
    if ($targets.Count -eq 0) {
        $movable = $false
        $reasons += "Windows 没有报告第二个可用的 AppxVolume。请先在「存储 → 高级存储设置」里添加或挂载应用卷。"
    }

    if ($movable) {
        $reason = "包状态正常，Windows 报告存在其他可用应用卷。迁移需要管理员权限，最终结果以部署服务执行后的真实安装位置为准。"
    }
    else {
        $reason = ($reasons -join " ")
    }

    New-Result -Installed $true -Version ([string]$package.Version) `
        -InstallLocation $installLocation -PackageVolume $packageVolume `
        -Movable $movable -Reason $reason -Volumes $volumeInfo |
        ConvertTo-Json -Depth 6 -Compress
    exit 0
}
catch {
    New-Result -Installed $false -Version $null -InstallLocation $null `
        -PackageVolume $null -Movable $false `
        -Reason ("迁移条件检测失败：{0}" -f $_.Exception.Message) -Volumes @() |
        ConvertTo-Json -Depth 6 -Compress
    exit 0
}
