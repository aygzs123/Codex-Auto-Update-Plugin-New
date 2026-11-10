<#
================================================================================
move-codex-app.ps1
================================================================================
Purpose
    Move the installed Codex MSIX to another Windows AppxVolume with the
    deployment service (Move-AppxPackage). This never copies WindowsApps, never
    takes ownership of it and never creates a directory junction.

    Move-AppxPackage requires administrator rights. When the script is not
    elevated it re-launches itself with -Verb RunAs and waits; the elevated
    child writes the result JSON to -ResultPath so the parent can report the
    real outcome. Declining the UAC prompt is a normal result, not a crash.

Usage
    powershell -NoProfile -ExecutionPolicy Bypass -File move-codex-app.ps1 -Volume "<目标卷枚举出的 WindowsApps 路径>"
    powershell -NoProfile -ExecutionPolicy Bypass -File move-codex-app.ps1 -Volume "<目标卷枚举出的 WindowsApps 路径>" -ResultPath "<临时结果文件>"

Result
    {"ok":bool,"installLocation":string|null,"version":string|null,"message":string}
    Printed to stdout and, when -ResultPath is given, written to that file.
================================================================================
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Volume,

    [string]$ResultPath = "",

    [switch]$ElevatedWorker
)

$ErrorActionPreference = "Stop"
$WarningPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$PackageName = "OpenAI.Codex"

# Single-quote every argument that needs it. Windows PowerShell 5.1 joins
# -ArgumentList with plain spaces, so a path containing a space truncates the
# command line; a value ending in a backslash also eats the closing quote.
function ConvertTo-QuotedArgument {
    param([string]$Value)

    if ($Value -notmatch '[\s"]') { return $Value }

    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Get-CurrentPowerShellPath {
    try {
        $path = (Get-Process -Id $PID).Path
        if (-not [string]::IsNullOrWhiteSpace($path)) { return $path }
    }
    catch { }

    return (Join-Path $PSHOME "powershell.exe")
}

function Test-Elevated {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Write-Result {
    param(
        [bool]$Ok,
        $InstallLocation,
        $Version,
        [string]$Message,
        [bool]$Cancelled = $false
    )

    $json = ([ordered]@{
            ok              = $Ok
            cancelled       = $Cancelled
            installLocation = $InstallLocation
            version         = $Version
            message         = $Message
        } | ConvertTo-Json -Depth 4 -Compress)

    if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
        try {
            $directory = Split-Path -Parent $ResultPath
            if ($directory -and -not (Test-Path -LiteralPath $directory)) {
                New-Item -ItemType Directory -Path $directory -Force | Out-Null
            }
            [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        }
        catch { }
    }

    Write-Output $json
}

# Resolve the target volume against what Windows actually reports. A path
# chosen in the UI is still just a string until it matches an AppxVolume.
try {
    $volumes = @(Get-AppxVolume -ErrorAction SilentlyContinue)
}
catch {
    $volumes = @()
}

$targetVolume = $volumes |
    Where-Object { [string]$_.PackageStorePath -ieq $Volume -and -not $_.IsOffline } |
    Select-Object -First 1

if (-not $targetVolume) {
    Write-Result -Ok $false -InstallLocation $null -Version $null `
        -Message ("目标不是 Windows 已识别的应用卷：{0}。请先在「存储 → 高级存储设置」里添加应用卷。" -f $Volume)
    exit 2
}

$package = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1

if (-not $package) {
    Write-Result -Ok $false -InstallLocation $null -Version $null `
        -Message "没有检测到已安装的 Codex，无法迁移。"
    exit 2
}

$storePath = ([string]$targetVolume.PackageStorePath).TrimEnd('\')
if ($package.InstallLocation -and $package.InstallLocation.StartsWith($storePath + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Result -Ok $true -InstallLocation $package.InstallLocation -Version ([string]$package.Version) `
        -Message "Codex 已经位于所选应用卷，没有执行迁移。"
    exit 0
}

# Elevated child: perform the move and report through -ResultPath.
if (-not (Test-Elevated) -and -not $ElevatedWorker) {
    if ([string]::IsNullOrWhiteSpace($ResultPath)) {
        $ResultPath = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-app-move-{0}.json" -f [guid]::NewGuid().ToString("N"))
    }
    # A stale result from a previous run must not be mistaken for this one.
    Remove-Item -LiteralPath $ResultPath -Force -ErrorAction SilentlyContinue

    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-ElevatedWorker",
        "-Volume", $Volume,
        "-ResultPath", $ResultPath
    ) | ForEach-Object { ConvertTo-QuotedArgument $_ }

    try {
        $child = Start-Process -FilePath (Get-CurrentPowerShellPath) `
            -Verb RunAs `
            -WindowStyle Hidden `
            -Wait `
            -PassThru `
            -ArgumentList ($arguments -join " ")
        try { $null = $child.ExitCode } catch { }
    }
    catch {
        # 只有 Win32 ERROR_CANCELLED 才属于用户取消，其他提权错误仍应显示为失败。
        $cause = $_.Exception
        $cancelled = $false
        while ($null -ne $cause) {
            if ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) {
                $cancelled = $true
                break
            }
            $cause = $cause.InnerException
        }
        Write-Result -Ok $false -InstallLocation $package.InstallLocation -Version ([string]$package.Version) `
            -Cancelled $cancelled -Message $(if ($cancelled) { "已取消管理员授权，Codex 没有被迁移。" } else { "无法请求管理员权限，Codex 没有被迁移。" })
        exit 3
    }

    if (Test-Path -LiteralPath $ResultPath) {
        $json = Get-Content -LiteralPath $ResultPath -Raw -Encoding UTF8
        Write-Output $json
        exit 0
    }

    Write-Result -Ok $false -InstallLocation $package.InstallLocation -Version ([string]$package.Version) `
        -Message "管理员进程没有返回结果，无法确认 Codex 是否已迁移。请重新检测安装位置。"
    exit 2
}

try {
    Import-Module (Join-Path $PSScriptRoot "CodexStoreUpdater.psm1") -Force

    # Move-AppxPackage refuses to move a running package. Close it the same way
    # the installer does, matching processes by install location instead of a
    # hard-coded process name.
    $processes = @(Get-CodexPackageProcess -PackageName $PackageName -InstallLocation $package.InstallLocation)
    foreach ($process in $processes) {
        if ($process.MainWindowHandle -ne 0) {
            [void]$process.CloseMainWindow()
        }
    }
    if ($processes.Count -gt 0) {
        Wait-Process -Id $processes.Id -Timeout 20 -ErrorAction SilentlyContinue
    }
    foreach ($process in @(Get-CodexPackageProcess -PackageName $PackageName -InstallLocation $package.InstallLocation)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }

    Move-AppxPackage -Package $package.PackageFullName -Volume $targetVolume

    $moved = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if (-not $moved) {
        Write-Result -Ok $false -InstallLocation $null -Version $null `
            -Message "Move-AppxPackage 已返回，但无法重新读取 Codex 包。请重开更新器检测安装位置。"
        exit 2
    }

    $newLocation = [string]$moved.InstallLocation
    if (-not $newLocation.StartsWith($storePath + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Result -Ok $false -InstallLocation $newLocation -Version ([string]$moved.Version) `
            -Message ("迁移命令已返回，但 Codex 仍位于 {0}，不是所选应用卷。请重新检测后再试。" -f $newLocation)
        exit 2
    }

    Write-Result -Ok $true -InstallLocation $newLocation -Version ([string]$moved.Version) `
        -Message ("Codex 已迁移到 {0}。项目与包管理范围外的用户数据需单独管理。" -f $newLocation)
    exit 0
}
catch {
    $currentLocation = $null
    $currentVersion = $null
    try {
        $current = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue |
            Sort-Object Version -Descending |
            Select-Object -First 1
        if ($current) {
            $currentLocation = [string]$current.InstallLocation
            $currentVersion = [string]$current.Version
        }
    }
    catch { }

    Write-Result -Ok $false -InstallLocation $currentLocation -Version $currentVersion `
        -Message ("应用迁移失败：{0}" -f $_.Exception.Message)
    exit 2
}
