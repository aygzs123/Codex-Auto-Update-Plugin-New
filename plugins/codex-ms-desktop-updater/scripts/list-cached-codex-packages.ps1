[CmdletBinding()]
param(
    [string]$DownloadDirectory,

    [string]$PackageName = "OpenAI.Codex"
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Split-Path -Parent $scriptRoot
if ([string]::IsNullOrWhiteSpace($DownloadDirectory)) {
    $DownloadDirectory = Join-Path $pluginRoot "downloads"
}

Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1") -Force

# 只读：把下载缓存里现存的 Codex 安装包列出来，给界面上的「版本历史 / 回退」用。
#
# 输出契约（parse.cjs 的 parseCachedPackages 按行解析，格式改动必须同步改那一侧）：
#
#   Download directory: <路径>
#   Installed version: <版本号，未安装时是 "not installed"
#   Cached package count: <N>
#     <版本>|<架构>|<字节数>|<最后写入时间>|<installed|older|newer>|<完整路径>
#
# 形状刻意沿用 `Removed N ...` 那一套（计数行 + N 行两空格缩进），它是这个仓库里唯一
# 有先例的变长列表格式。路径放在最后一个字段：路径里万一有 `|`，解析侧按 6 段切分并
# 把第 6 段起并回去，不会让前面的字段错位。
#
# 版本比较（installed / older / newer）在 PowerShell 这一侧做，因为这里是全仓库唯一用
# [version] 比较版本号的地方。在 JS 里再写一份比较函数，两边迟早会对「26.9 和 26.10
# 谁大」给出不同答案。

$installed = Get-InstalledCodexPackageInfo -PackageName $PackageName
$installedVersion = if ($null -eq $installed) { $null } else { $installed.Version }

Write-Host ("Download directory: {0}" -f $DownloadDirectory)
Write-Host ("Installed version: {0}" -f $(if ($null -eq $installedVersion) { "not installed" } else { $installedVersion.ToString() }))

$cachedPackages = @(Get-CachedCodexPackages `
    -DownloadDirectory $DownloadDirectory `
    -PackageName $PackageName `
    -InstalledVersion $installedVersion)

Write-Host ("Cached package count: {0}" -f $cachedPackages.Count)
foreach ($package in $cachedPackages) {
    Write-Host ("  {0}|{1}|{2}|{3}|{4}|{5}" -f `
        $package.Version, `
        $package.Architecture, `
        $package.SizeBytes, `
        $package.LastWriteTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), `
        $package.Relation, `
        $package.FullName)
}
