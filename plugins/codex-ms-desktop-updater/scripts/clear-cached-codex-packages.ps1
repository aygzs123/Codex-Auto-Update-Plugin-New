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

# 清空下载缓存：把里面现存的 Codex 安装包全部删掉。
#
# 输出契约（parse.cjs 的 parseClearedPackages 按行解析，格式改动必须同步改那一侧）：
#
#   Cache directory: <路径>
#   Cleared package count: <N>
#   Cleared bytes: <N>
#   Failed package count: <N>
#     <完整路径>
#
# 三条边界，都是「清空缓存」这个动作容易越界的地方：
#
#   1. 只删 Get-CachedCodexPackages 认得的文件 —— 文件名以 OpenAI.Codex_ 开头、且能从
#      文件名解析出版本与架构。下载中的临时文件、别的应用的包、用户自己放进目录里的
#      东西，一律不碰。这个动作不该等价于对整个目录 rm -rf。
#   2. 已安装的 Codex 不受影响：删掉的是安装包文件，不是应用本身。用户失去的是「回退到
#      上一版」和「拿缓存重装」这两条便利，需要时重新下载就能拿回来。
#   3. 删不掉的（被杀毒软件或安装进程占着）不中断整批：逐个记下来，最后如实报数量。
#      整体报错退出的话，界面只能显示一句「命令失败」，用户既不知道删掉了几个、也不知道
#      还剩几个。所以这里始终以 0 退出，把「有几个没删掉」写进输出交给界面去说。
#
# 路径单独成行放在最后：路径里万一有 `|` 也不会让别的字段错位（list-cached 那份是用 `|`
# 拼多字段的，这里只有一个字段，不必再拼分隔符）。

$cachedPackages = @(Get-CachedCodexPackages `
    -DownloadDirectory $DownloadDirectory `
    -PackageName $PackageName)

$clearedPaths = @()
$clearedBytes = 0
$failedPaths = @()

foreach ($package in $cachedPackages) {
    try {
        Remove-Item -LiteralPath $package.FullName -Force -ErrorAction Stop
        $clearedPaths += $package.FullName
        $clearedBytes += $package.SizeBytes
    }
    catch {
        $failedPaths += $package.FullName
    }
}

Write-Host ("Cache directory: {0}" -f $DownloadDirectory)
Write-Host ("Cleared package count: {0}" -f $clearedPaths.Count)
Write-Host ("Cleared bytes: {0}" -f $clearedBytes)
Write-Host ("Failed package count: {0}" -f $failedPaths.Count)
foreach ($failedPath in $failedPaths) {
    Write-Host ("  {0}" -f $failedPath)
}
