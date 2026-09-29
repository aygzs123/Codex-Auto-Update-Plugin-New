[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,

    [string]$PackageName = "OpenAI.Codex",

    [string]$AppId = "App",

    [int]$StartDelaySeconds = 3,

    [string]$LogPath,

    [int]$ProbeSeconds = 30,

    [switch]$SkipLaunch,

    # 回退（装一个比当前更旧的版本）必须显式声明。不加这个开关时 Windows 会拒绝降级，
    # 所以「一键更新」这条路保持原样，只有界面上的回退入口会传它。
    [switch]$AllowDowngrade,

    # 安装包缓存目录 —— 装完之后在这个目录里剪枝（保留最近 2 个，见模块里的保留策略）。
    #
    # 必须由调用方告诉 worker，不能让 worker 从 $PackagePath 反推：桌面应用允许把缓存
    # 换到别的盘，而 -PackagePath 是调用方给什么就是什么（旧包、手工下的包都行）。
    # 反推出来的目录未必是缓存，剪错目录会把不相干的安装包删掉。
    # 不传时退回「安装包所在目录」：插件 CLI（check-codex-update.ps1 把包下到 downloads/
    # 之后调本脚本）走的就是这条，与既有行为一致。
    [string]$DownloadDirectory,

    [switch]$Worker
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Split-Path -Parent $scriptRoot
Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1") -Force

if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $pluginRoot "downloads\install-codex-msix-and-restart.log"
}

# 日志写成 UTF-8（无 BOM）。
#
# 读取方 desktop/electron/codex.cjs 用 readFileSync(...).toString("utf8") 解码，而
# Add-Content 在 Windows PowerShell 5.1 下按系统 ANSI 代码页写盘。异常消息在中文系统上
# 就是中文（「拒绝访问。」「找不到路径…」），两边对不上，失败时唯一能看的那几行恰好变成
# 乱码。所以这里显式指定编码。
#
# 不用 Add-Content -Encoding UTF8：它在 PowerShell 5.1 下会写 BOM，而 BOM 会让第一行变成
# "﻿[2026-09-28 ...]"，解析器那条 ^\[ 时间戳正则认不出来，首个事件凭空丢失。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-InstallLog {
    param([string]$Message)

    $logDirectory = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    [System.IO.File]::AppendAllText($LogPath, ("[{0}] {1}`r`n" -f $timestamp, $Message), $utf8NoBom)
}

# 未捕获的终止性错误必须落进日志。
#
# worker 是 Start-Process 拉起的隐藏进程：没有控制台，stderr 无处可去；父进程又不带
# -Wait（它只回答「有没有拉起来」，不回答结果）。于是任何未捕获的错误都表现为
# 「日志文件永远不出现 → 界面等满 12 分钟超时」，真实原因一个字都留不下 ——
# 降级被 Windows 拒绝这种最需要看清的失败正在其中。
#
# trap 是**解析期**注册的，覆盖整个脚本作用域的终止性错误。本文件里的 6 处 throw 全都
# 在 trap 之下（最早的一处也在第 89 行），一条 trap 就够，不必逐个包 try/catch。
#
# 覆盖不到的只有 trap 注册之前的两处，都是脚本体还没开始执行时的失败：
# Import-Module（模块缺失/损坏）与 Mandatory 参数绑定失败（没给 -PackagePath）。
# 这两种情况下日志文件一个字都不会有 —— 但它们自己会往 stderr 写错误，父进程那条路
# （codex.cjs 的 describeFailure 看 stderr + 退出码）仍拿得到原因，只是没有日志可 tail。
trap {
    $reason = "FATAL: {0}" -f $_.Exception.Message
    Write-InstallLog $reason
    # 同时写到 stderr。**父进程那条路不读日志文件** —— 桌面应用只看 stderr 和退出码
    # （codex.cjs 的 describeFailure），日志文件是它之后才去 tail 的，而且是 worker 写的
    # 那一个。trap 只往日志里写的话，父进程侧失败就退化成一句「PowerShell 退出码 1」，
    # 比修复前更难查。
    # 用 [Console]::Error.WriteLine 而不是 Write-Error：$ErrorActionPreference 是 Stop，
    # 在 trap 里再抛一次错误会递归回到这个 trap。
    [Console]::Error.WriteLine($reason)
    exit 1
}

$resolvedPackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if (-not (Test-Path -LiteralPath $resolvedPackagePath)) {
    throw "Package path does not exist: $PackagePath"
}

$packageMetadata = Get-CodexPackageMetadata -FileName (Split-Path -Leaf $resolvedPackagePath) -Uri $resolvedPackagePath
if ($null -eq $packageMetadata) {
    throw "Package filename does not include parseable Codex metadata: $resolvedPackagePath"
}
if ($packageMetadata.Name -ne $PackageName) {
    throw "Refusing to install package '$($packageMetadata.Name)' when '$PackageName' was expected."
}

# 给单个参数补引号。拼命令行时唯一的正确做法 —— 细节见下面调用处的注释。
#
# 不能只写 '"' + $Value + '"'：Windows 的命令行解析里 `\"` 是一个**转义引号**，
# 所以值以反斜杠结尾时，收尾引号会被吃掉、引号保持开启，后面所有参数都被吞进这个值。
function ConvertTo-QuotedArgument {
    param([string]$Value)

    if ($Value -notmatch '[\s"]') { return $Value }

    $escaped = $Value -replace '(\\*)"', '$1$1\"'   # 引号前已有的反斜杠加倍，再转义引号
    $escaped = $escaped -replace '(\\+)$', '$1$1'   # 结尾反斜杠加倍，保住收尾引号
    return '"' + $escaped + '"'
}

if (-not $Worker) {
    $powershellPath = Join-Path $PSHOME "powershell.exe"
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-Worker",
        "-PackagePath", $resolvedPackagePath,
        "-PackageName", $PackageName,
        "-AppId", $AppId,
        "-StartDelaySeconds", $StartDelaySeconds,
        "-ProbeSeconds", $ProbeSeconds,
        "-LogPath", $LogPath
    )

    if ($SkipLaunch) {
        $arguments += "-SkipLaunch"
    }

    # 开关必须自己传下去：worker 是另一个进程，父进程的参数不会自动继承。
    if ($AllowDowngrade) {
        $arguments += "-AllowDowngrade"
    }

    if (-not [string]::IsNullOrWhiteSpace($DownloadDirectory)) {
        $arguments += @("-DownloadDirectory", $DownloadDirectory)
    }

    # 每个参数补引号后，拼成**单个字符串**交给 Start-Process。
    #
    # Windows PowerShell 5.1 的 -ArgumentList 收到数组时，会把元素用单个空格拼成一条
    # 命令行，并且**不加引号**。路径里只要有一个空格，参数就在空格处被截断：
    #   -PackagePath C:\...\Codex Updater\downloads\x.msix
    #   → 子进程拿到 "C:\...\Codex"，后半截变成一个孤立的位置参数。
    # 而本应用的日志目录固定在 %APPDATA%\Codex Updater\logs（main.cjs 里的
    # app.setName("Codex Updater")），也就是说**这个空格每一个用户都有**，安装和回退
    # 因此从来没有真正跑起来过：worker 在 Resolve-Path 就抛错，父进程因为不带 -Wait
    # 反而报「已启动」。
    # （已实测：不加引号时 LogPath 被截成 "C:\Users\X\AppData\Local\Temp\quote"，
    #   补引号后 PackagePath / LogPath 两条都完整。）
    #
    # 补引号本身还有第二层坑，所以引号交给 ConvertTo-QuotedArgument 而不是就地拼：
    # 只写 '"' + $_ + '"' 时，**以反斜杠结尾的值会把收尾引号转义掉**，命令行从那里断开，
    # 后面的参数整段被吞进这个值。实测（值同时含空格和尾部反斜杠）：
    #   值 C:\Temp\my cache\ → 子进程 PackagePath=<C:\Temp\my cache" -LogPath C:\Temp\my>
    #                          LogPath=<cache">          ← 未绑定，worker 落回默认日志
    # 这条对本应用是可达的：-DownloadDirectory 就是用户手填的缓存目录，
    # codex.cjs 的 resolveDownloadDirectory 只做 trim()，用户在高级设置里填
    # "D:\My Cache\" 就会命中，后果是剪枝静默失效、缓存一直涨。
    $quotedArguments = $arguments | ForEach-Object { ConvertTo-QuotedArgument $_ }

    Start-Process -FilePath $powershellPath -ArgumentList ($quotedArguments -join " ") -WindowStyle Hidden
    Write-Host ("Started detached Codex install worker. Log: {0}" -f $LogPath)
    return
}

Write-InstallLog ("Worker started for package: {0}" -f $resolvedPackagePath)
Start-Sleep -Seconds $StartDelaySeconds

# 按包的真实安装位置匹配进程（进程名可能是 ChatGPT.exe / codex.exe 等，不能按名字认）。
# 这里还没解析出 $installedPackage，交给模块自己去 Get-AppxPackage 取安装位置 ——
# 写死 *\WindowsApps\<包名>_* 在把应用装到别处的机器上会一个进程都匹配不到。
$codexProcesses = @(Get-CodexPackageProcess -PackageName $PackageName)

foreach ($process in $codexProcesses) {
    if ($process.MainWindowHandle -ne 0) {
        [void]$process.CloseMainWindow()
    }
}

if ($codexProcesses.Count -gt 0) {
    Wait-Process -Id $codexProcesses.Id -Timeout 20 -ErrorAction SilentlyContinue
}

$remainingCodexProcesses = @(Get-CodexPackageProcess -PackageName $PackageName)
foreach ($process in $remainingCodexProcesses) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
Write-InstallLog ("Closed {0} Codex Desktop process(es)." -f ($codexProcesses.Count + $remainingCodexProcesses.Count))

if ($AllowDowngrade) {
    Write-InstallLog "Installing package with Add-AppxPackage (downgrade allowed)..."
    Add-AppxPackage -Path $resolvedPackagePath -ForceUpdateFromAnyVersion
}
else {
    Write-InstallLog "Installing package with Add-AppxPackage..."
    Add-AppxPackage -Path $resolvedPackagePath
}
Write-InstallLog "Install command completed."

$installedPackage = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
if ($null -eq $installedPackage) {
    throw "Installed package '$PackageName' was not found after install."
}

$installedVersion = [version]$installedPackage.Version
if ($AllowDowngrade) {
    # 降级必须判「相等」，不能沿用下面那条「不小于」。Windows 拒绝降级时，系统里仍然是
    # 那个更高的版本，`-lt` 恰好为假 —— 那条判断会把「什么都没发生」报成安装成功，
    # 用户看到一句「安装完成」，而实际跑的还是那个有问题的版本。
    if ($installedVersion -ne $packageMetadata.Version) {
        throw "Downgrade did not take effect: '$installedVersion' is still installed while '$($packageMetadata.Version)' was requested. Windows refused to install a lower package version. Package file kept: $resolvedPackagePath"
    }
    Write-InstallLog ("Downgrade verified. Installed version: {0}" -f $installedVersion)
}
elseif ($installedVersion -lt $packageMetadata.Version) {
    throw "Installed package version '$installedVersion' is older than downloaded package version '$($packageMetadata.Version)'. Keeping package file for inspection: $resolvedPackagePath"
}

# 保留策略：剪枝到上限，而不是把刚用的这个包删掉。
#
# 放在 worker 里，是因为它是唯一「装完就知道新版本号、且正站在缓存目录里」的地方。
# 界面那条路（下载 → 安装）不跑 check-codex-update.ps1 -Install，所以只有在这里剪枝，
# 缓存才能在装完的那一刻回到上限内；靠下一次「检查更新」去清，会让缓存先多背一个
# 800 MB 级的包。
try {
    # 优先用调用方给的缓存目录；没给才退回「安装包所在目录」（插件 CLI 那条路）。
    $cacheDirectory = if (-not [string]::IsNullOrWhiteSpace($DownloadDirectory)) {
        $DownloadDirectory
    }
    else {
        Split-Path -Parent $resolvedPackagePath
    }
    $removedPaths = @(Remove-SupersededCodexPackageFiles `
        -DownloadDirectory $cacheDirectory `
        -InstalledVersion $installedVersion `
        -PackageName $PackageName)

    if ($removedPaths.Count -eq 0) {
        Write-InstallLog "No superseded package file to remove; keeping cached installers for rollback."
    }
    else {
        foreach ($removedPath in $removedPaths) {
            Write-InstallLog ("Removed superseded package file: {0}" -f $removedPath)
        }
    }
}
catch {
    Write-InstallLog ("Package cache cleanup failed: {0}" -f $_.Exception.Message)
}

if ($SkipLaunch) {
    Write-InstallLog "Skip launch requested. Installation completed without starting Codex."
    return
}

# 从已安装包 manifest 动态解析真实 AppId（当前为 App，避免硬编码漂移）
$resolvedAppId = $AppId
try {
    $manifestPath = Join-Path $installedPackage.InstallLocation "AppxManifest.xml"
    if (Test-Path -LiteralPath $manifestPath) {
        [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
        # 不要用 @() 包住：PowerShell 5.1 下会变成单元素数组，绑到 [string] 参数上抛
        # "Cannot process argument transformation"，这里被 catch 吞掉后只会留下一行
        # 误导性的 "Failed to resolve AppId"，看起来像 manifest 有问题。
        $manifestAppId = $manifest.Package.Applications.Application | Select-Object -First 1 -ExpandProperty Id
        if (-not [string]::IsNullOrWhiteSpace($manifestAppId)) {
            $resolvedAppId = $manifestAppId
        }
    }
}
catch {
    Write-InstallLog ("Failed to resolve AppId from manifest, using '{0}': {1}" -f $resolvedAppId, $_.Exception.Message)
}
$appUserModelId = Get-CodexAppUserModelId -PackageFamilyName $installedPackage.PackageFamilyName -AppId $resolvedAppId
Write-InstallLog ("Restarting Codex with AppUserModelId: {0}" -f $appUserModelId)
Start-Process -FilePath "explorer.exe" -ArgumentList ("shell:AppsFolder\{0}" -f $appUserModelId)
Write-InstallLog ("Restart requested. Installed version: {0}" -f $installedPackage.Version)

# ---------- post-restart window probe ----------
# Detects the official "encrypted-resource relocation" bug where the app keeps
# running but its main window never appears after an update. If the window does
# not show up within $ProbeSeconds, log a prominent warning and a relocation
# health snapshot so the failure is visible in the install log.
Write-InstallLog ("Probing for a visible main window (up to {0} s)..." -f $ProbeSeconds)
$windowUp = Test-CodexDesktopWindowUp -PackageName $PackageName -Seconds $ProbeSeconds

if ($windowUp) {
    Write-InstallLog "Window probe OK: Codex main window is visible."
}
else {
    Write-InstallLog "WINDOW_PROBE=FAILED: Codex restarted but NO main window appeared within $ProbeSeconds s."
    Write-InstallLog "This is the signature of the official encrypted-resource relocation bug."

    try {
        $health = Get-CodexRelocationHealth -PackageName $PackageName
        if ($health.Installed) {
            Write-InstallLog "Relocation health snapshot:"
            foreach ($component in $health.Components) {
                Write-InstallLog ("  component {0,-10} state={1}" -f $component.Name, $component.State)
            }
            Write-InstallLog ("  bundled plugins materialized: {0}" -f $health.PluginsMaterialized)
        }
    }
    catch {
        Write-InstallLog ("Could not collect relocation health: {0}" -f $_.Exception.Message)
    }

    Write-InstallLog "Remedy: run docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1 (from the repo root) with pwsh, then relaunch Codex."
    exit 4
}
