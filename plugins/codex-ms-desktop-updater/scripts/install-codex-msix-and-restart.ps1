[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,

    [string]$PackageName = "OpenAI.Codex",

    [string]$AppId = "App",

    [int]$StartDelaySeconds = 3,

    [string]$LogPath,

    [int]$ProbeSeconds = 30,

    # 探针失败后，如果诊断说「还在把运行时落到本地缓存」，再等这么久。
    #
    # 首次启动要落几百 MB（2026-10-01 实测约 132 秒），30 秒的探针必然误判。这个延长是
    # 有条件的：只有拿到「最近还有写入」的证据才延长，拿不到就立刻如实报告。
    # 0 表示不延长。
    [int]$ProbeExtensionSeconds = 150,

    [switch]$SkipLaunch,

    # 回退（装一个比当前更旧的版本）必须显式声明。不加这个开关时 Windows 会拒绝降级，
    # 所以「一键更新」这条路保持原样，只有界面上的回退入口会传它。
    [switch]$AllowDowngrade,

    # 需要时允许弹一次 UAC 提权。
    #
    # 新版 Codex 的清单里声明了一个以 localSystem 运行的打包服务，Add-AppxPackage 于是
    # 必须由管理员上下文执行（否则回 0x80073D28）。装不上的时候是弹一次 UAC、还是如实
    # 拒绝，取决于调用方：桌面应用的「一键更新」带上它（仍然是一键，只是不再静默），
    # 每日自动化不带（后台不许弹窗，改为如实报告并让用户去点桌面应用）。
    # 默认关 —— 提权是调用方显式同意的结果，脚本自己不该在没人看着的时候弹窗。
    [switch]$AllowElevation,

    # 安装包缓存目录 —— 装完之后在这个目录里剪枝（保留最近 2 个，见模块里的保留策略）。
    #
    # 必须由调用方告诉 worker，不能让 worker 从 $PackagePath 反推：桌面应用允许把缓存
    # 换到别的盘，而 -PackagePath 是调用方给什么就是什么（旧包、手工下的包都行）。
    # 反推出来的目录未必是缓存，剪错目录会把不相干的安装包删掉。
    # 不传时退回「安装包所在目录」：插件 CLI（check-codex-update.ps1 把包下到 downloads/
    # 之后调本脚本）走的就是这条，与既有行为一致。
    [string]$DownloadDirectory,

    [switch]$Worker,

    # 提权子进程模式：由 worker 用 -Verb RunAs 拉起的短命进程，只做「关 Codex + 装包」
    # 两件事就返回。
    #
    # 刻意不复用 -Worker。worker 后面还要做版本校验、剪枝、重启和窗口探测，而重启用的是
    # explorer.exe shell:AppsFolder 激活请求 —— 从一个**提权**进程发出去行为不确定
    # （可能起不来，也可能把 Codex 拉成管理员进程）。所以提权进程只负责装包这一段，
    # 其余（含重启与探针）照旧留在非提权的 worker 里跑。
    [switch]$ElevatedWorker
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

# 拉起提权子进程用的解释器路径。
#
# 不能照抄 launcher 那句 Join-Path $PSHOME "powershell.exe"：在 pwsh 7 下 $PSHOME 指向
# pwsh 自己的目录，那里**没有** powershell.exe，拼出来的路径根本不存在，Start-Process 会抛
# 「找不到文件」—— 而它会被提权那段的 catch 当成「用户拒绝了 UAC」，报一句和真实原因
# 无关的话。直接问当前进程自己是谁，两个宿主下都对。
function Get-CurrentPowerShellPath {
    try {
        $path = (Get-Process -Id $PID).Path
        if (-not [string]::IsNullOrWhiteSpace($path)) { return $path }
    }
    catch { }

    return (Join-Path $PSHOME "powershell.exe")
}

# 「关掉正在运行的 Codex，然后装包」—— worker 与提权子进程共用的那一段。
#
# 抽出来是因为提权那条路必须**只**做这两件事（原因见 -ElevatedWorker 的注释）。
#
# 参数收包路径，而不是就地读脚本级的 $resolvedPackagePath：PowerShell 的函数会动态读
# 父作用域的变量，写成脚本级变量照样能跑通 —— 但那样这个函数的参数契约就是假的，
# 「提权子进程拿到的是完整路径」这件事也就没有东西在守着了。
function Invoke-CodexInstallSteps {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageName,

        [Parameter(Mandatory = $true)]
        [string]$PackagePath,

        [switch]$AllowDowngrade
    )

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
        Add-AppxPackage -Path $PackagePath -ForceUpdateFromAnyVersion
    }
    else {
        Write-InstallLog "Installing package with Add-AppxPackage..."
        Add-AppxPackage -Path $PackagePath
    }
    Write-InstallLog "Install command completed."
}

# 拉起一个短命的提权子进程去做「关 Codex + 装包」，并等它结束。
#
# 为什么提权只能发生在这里、不能放在 launcher 里：desktop/electron/ps.cjs 完全没有超时，
# 桌面应用是先 await 完 launcher 才转去 tail 日志的。UAC 弹窗要是卡在 launcher 那个进程里，
# 界面会永久停在「正在安装」—— 没有报错、没有超时、没有取消入口。放进 worker 之后，
# 等 UAC 的这段时间恰好落在 tail 已有的 12 分钟超时里。
#
# 为什么不让 worker 自己提权、而是再拉一个子进程：见 -ElevatedWorker 的注释。
function Invoke-CodexElevatedInstall {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackagePath,

        [Parameter(Mandatory = $true)]
        [string]$PackageName,

        [switch]$AllowDowngrade
    )

    Write-InstallLog "Requesting administrator privileges (a UAC prompt will appear)..."

    # 参数表必须完整：子进程是**另一个进程**，开关不会自己跟过去。尤其是 -LogPath ——
    # 少了它，提权子进程会落回插件目录下的默认日志，桌面应用 tail 的那个文件一个字都不涨，
    # 用户等满 12 分钟后只看到一句「安装超时」，而安装其实成功了。
    $elevatedArguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-ElevatedWorker",
        "-PackagePath", $PackagePath,
        "-PackageName", $PackageName,
        "-LogPath", $LogPath
    )

    if ($AllowDowngrade) {
        $elevatedArguments += "-AllowDowngrade"
    }

    # 和 launcher 同一套：每个参数补引号后拼成**单个字符串**（原因见上面 launcher 那段长注释，
    # 包括以反斜杠结尾的值会把收尾引号转义掉那个坑）。
    $quotedElevatedArguments = $elevatedArguments | ForEach-Object { ConvertTo-QuotedArgument $_ }

    try {
        # -RedirectStandardOutput 在这个参数集里不存在（它和 -Verb 互斥），所以子进程的报错
        # 只能靠它自己写进同一个日志文件，这里捞不回来。
        $elevatedProcess = Start-Process -FilePath (Get-CurrentPowerShellPath) `
            -Verb RunAs `
            -WindowStyle Hidden `
            -Wait `
            -PassThru `
            -ArgumentList ($quotedElevatedArguments -join " ")
    }
    catch {
        # 用户点「否」就是走到这里。实测（Windows PowerShell 5.1，2026-10-01）：抛的是
        # System.InvalidOperationException 而不是 Win32Exception，NativeErrorCode 为空 ——
        # 所以按错误码判别会落空，只能整段捕获。消息还被 Start-Process 套了一层壳
        # （"This command cannot be run due to the error: ..."），壳里那句是系统本地化的；
        # 单看它既看不出发生了什么，也看不出有没有留下烂摊子，所以自己写一条能直接读的。
        # 这条消息会被顶层 trap 变成日志里的 FATAL 行。
        throw ("Elevation was declined or could not start ({0}). Nothing was installed and Codex was not closed." -f $_.Exception.Message)
    }

    # 退出码只记录、不当判据。-Verb RunAs 走的是 ShellExecuteEx，拿回来的 Process 对象
    # 未必有真实的退出码句柄，把它当成功判据会在某台机器上给出随机结论。
    # 装没装上以调用方随后的 Get-AppxPackage 版本校验为准 —— 那才是权威判据。
    try {
        Write-InstallLog ("Elevated install worker exited with code {0}." -f $elevatedProcess.ExitCode)
    }
    catch {
        Write-InstallLog "Elevated install worker exit code was not readable."
    }
}

if (-not $Worker -and -not $ElevatedWorker) {
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
        "-ProbeExtensionSeconds", $ProbeExtensionSeconds,
        "-LogPath", $LogPath
    )

    if ($SkipLaunch) {
        $arguments += "-SkipLaunch"
    }

    # 开关必须自己传下去：worker 是另一个进程，父进程的参数不会自动继承。
    if ($AllowDowngrade) {
        $arguments += "-AllowDowngrade"
    }

    if ($AllowElevation) {
        $arguments += "-AllowElevation"
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

# 提权子进程：只做「关 Codex + 装包」，做完就退。
#
# 必须排在下面那两行日志和 Start-Sleep **之前**：它们是给非提权 worker 用的
# （"Worker started for package: ..." 对应界面上的「准备安装」4%）。提权子进程再写一遍，
# 界面就会在已经走到「正在请求管理员权限」（14%）之后又收到一条 4% 的旧阶段 ——
# 百分比被 Math.max 挡住不会退，措辞却跳回去了。
if ($ElevatedWorker) {
    Invoke-CodexInstallSteps -PackageName $PackageName -PackagePath $resolvedPackagePath -AllowDowngrade:$AllowDowngrade
    return
}

Write-InstallLog ("Worker started for package: {0}" -f $resolvedPackagePath)
Start-Sleep -Seconds $StartDelaySeconds

# 这个包装起来要不要管理员权限？必须在**关掉用户的 Codex 之前**问清楚：
# 装不上就不该先把人家正在编辑的窗口关掉。
$requiresElevation = Test-CodexPackageRequiresElevation -Path $resolvedPackagePath
if ($requiresElevation -and -not $AllowElevation) {
    # 调用方没允许提权（每日自动化就是不提权的那条路）。如实拒绝，别让 worker 带着
    # 0x80073D28 去失败 —— 那样自动化只会报一句看不懂的 HRESULT，用户也不知道该干什么。
    throw "This package declares a Windows service, so Windows requires administrator privileges to install it, and -AllowElevation was not given. Nothing was installed and Codex was not closed. Update from the Codex Updater desktop app instead. Package file kept: $resolvedPackagePath"
}

$elevatedAttempted = $false
if ($requiresElevation) {
    Invoke-CodexElevatedInstall -PackagePath $resolvedPackagePath -PackageName $PackageName -AllowDowngrade:$AllowDowngrade
    $elevatedAttempted = $true
}
else {
    try {
        Invoke-CodexInstallSteps -PackageName $PackageName -PackagePath $resolvedPackagePath -AllowDowngrade:$AllowDowngrade
    }
    catch {
        # 兜底：探测说不用提权、Windows 却说需要（Add-AppxPackage 抛 0x80073D28）。
        # 有这条，「探测失灵」的代价只是多弹一次 UAC，而不是让用户看到一个生 HRESULT。
        # 探测认不出来的情况是存在的：清单读不出来、包结构没见过等等。
        if (-not $AllowElevation -or $_.Exception.Message -notmatch '0x80073D28') {
            throw
        }

        Write-InstallLog ("Add-AppxPackage reported 0x80073D28 although the package check did not predict elevation: {0}" -f $_.Exception.Message)
        Invoke-CodexElevatedInstall -PackagePath $resolvedPackagePath -PackageName $PackageName -AllowDowngrade:$AllowDowngrade
        $elevatedAttempted = $true
    }
}

if ($elevatedAttempted) {
    # 提权跑完了，到底装上没有？以版本为准，**不是**以子进程的退出码为准
    # （原因见 Invoke-CodexElevatedInstall：-Verb RunAs 拿回来的退出码不可靠）。
    #
    # 单独在这里判一次，是为了让「提权跑完了但没装上」在界面上以这句话收场。否则用户看到的
    # 会是下面那条通用版本校验消息（「版本比请求的旧」），看不出跟提权有关；而提权子进程
    # 自己写的那行 FATAL（例如「用户取消了 UAC」）仍然留在日志里，点开就能看到。
    $elevatedInstalled = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    $elevatedVersion = if ($null -eq $elevatedInstalled) { $null } else { [version]$elevatedInstalled.Version }

    # 判定要跟下面升级/降级两条路保持同一套语义：降级判相等，升级判「不小于」。
    $elevatedMismatch = if ($AllowDowngrade) {
        $elevatedVersion -ne $packageMetadata.Version
    }
    else {
        $null -eq $elevatedVersion -or $elevatedVersion -lt $packageMetadata.Version
    }

    if ($elevatedMismatch) {
        throw "Elevated install did not take effect: installed version is '$elevatedVersion' while '$($packageMetadata.Version)' was requested. The elevated worker's own error, if any, is in the log above. Package file kept: $resolvedPackagePath"
    }

    Write-InstallLog ("Elevated install verified. Installed version: {0}" -f $elevatedVersion)
}

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
# 探针只回答一个问题：主窗口出现了没有。它**不**回答「为什么没出现」。
#
# 为什么不能顺口给出原因：「进程活着但没有主窗口」这个现象已经被实测证明有多种
# 互不相干的原因，光看进程和资源目录分不出来 ——
#   a) 官方的加密资源搬迁失败（真实存在，见 docs/codex-desktop-encrypted-copy-fix）；
#   b) 首次启动正在把几百 MB 运行时物化到用户缓存，纯粹是**还没到**而已。2026-10-01
#      实测：21:10:24 发出重启请求，21:10:30 才落下第一个 bundle，21:12:36 才落完
#      （约 132 秒），而当时探针只等 30 秒；结果界面断言了搬迁 bug，用户白跑一趟修复；
#   c) 被一个跟资源无关的启动对话框挡住（那次的模态框是「无法加载组织设置」），
#      用户重试一次就恢复了。
# 而且 MainWindowHandle 的判据是「无属主（GW_OWNER == 0）且可见」，被拥有的模态
# 对话框它看不见、无属主的对话框它又会当成主窗口 —— 正反两个方向都会错。
#
# 所以这里的规矩是：先按证据决定要不要多等一会儿，再按证据决定要不要说出原因，
# 说不出来就只报事实，绝不指控。
Write-InstallLog ("Probing for a visible main window (up to {0} s)..." -f $ProbeSeconds)
$windowUp = Test-CodexDesktopWindowUp -PackageName $PackageName -Seconds $ProbeSeconds

$probeBudgetSeconds = $ProbeSeconds
$diagnosis = $null

if (-not $windowUp -and $ProbeExtensionSeconds -gt 0) {
    $diagnosis = Get-CodexStartupDiagnosis -PackageName $PackageName
    if ($diagnosis.Verdict -eq 'still-preparing') {
        Write-InstallLog ("Codex is still materializing its runtime into the local cache ({0}). Extending the window probe by {1} s." -f ($diagnosis.Evidence -join '; '), $ProbeExtensionSeconds)
        $probeBudgetSeconds = $ProbeSeconds + $ProbeExtensionSeconds
        # 延长过就必须重判：上面那份快照已经过期。
        $diagnosis = $null
        # 不再传 -Launch：激活请求上面已经发过一次，Test-CodexDesktopWindowUp 见已有进程也会自己跳过。
        $windowUp = Test-CodexDesktopWindowUp -PackageName $PackageName -Seconds $ProbeExtensionSeconds
    }
}

if ($windowUp) {
    Write-InstallLog "Window probe OK: Codex main window is visible."
}
else {
    # 先把证据全部采集完，再写第一行日志。这条顺序是硬约束：Get-CodexRelocationHealth
    # 要对 cua_node\bin\node.exe 做 SHA-256、Get-CodexWindowInventory 首次还要 Add-Type
    # 编译 C#，两者都是数百毫秒到数秒的实打实开销；而桌面端是按「最后一行日志之后
    # DIAGNOSTIC_QUIET_MS (1200ms) 没有新行」（兜底 6 秒）判定诊断已经落完的 —— 中间插
    # 一段静默，整段诊断会被丢掉，而这恰恰是最需要诊断的那条路径。
    $health = $null
    $healthError = $null
    try {
        $health = Get-CodexRelocationHealth -PackageName $PackageName
    }
    catch {
        $healthError = $_.Exception.Message
    }

    if ($null -eq $diagnosis) {
        # 复用刚取的健康快照：判定只读 Installed / Id / Path 与目录 mtime，不读 State，
        # 所以这份快照既够用，又省掉一次 SHA-256。
        $diagnosis = Get-CodexStartupDiagnosis -PackageName $PackageName -Health $health
    }

    $windows = Get-CodexWindowInventory -PackageName $PackageName -InstallLocation $installedPackage.InstallLocation

    Write-InstallLog "WINDOW_PROBE=FAILED: Codex restarted but NO main window appeared within $probeBudgetSeconds s."
    Write-InstallLog ("STARTUP_DIAGNOSIS={0}" -f $diagnosis.Verdict)

    $evidenceText = if ($diagnosis.Evidence.Count -gt 0) { $diagnosis.Evidence -join '; ' } else { 'none' }
    switch ($diagnosis.Verdict) {
        'still-preparing' {
            Write-InstallLog ("This is NOT the encrypted-resource relocation bug. Codex is still materializing its runtime into the local cache. Recent write activity: {0}." -f $evidenceText)
        }
        'relocation-bug' {
            Write-InstallLog "This is the signature of the official encrypted-resource relocation bug."
            Write-InstallLog ("Evidence: {0}" -f $evidenceText)
        }
        default {
            Write-InstallLog ("No cause could be determined from the relocation-health evidence. This is not, by itself, evidence of the encrypted-resource relocation bug. Evidence: {0}." -f $evidenceText)
            Write-InstallLog "Next: check the app's own logs under %LOCALAPPDATA%\OpenAI\Codex, and whether a Codex dialog or a crash is blocking the main window."
        }
    }

    if ($null -ne $healthError) {
        Write-InstallLog ("Could not collect relocation health: {0}" -f $healthError)
    }
    elseif ($health -and $health.Installed) {
        Write-InstallLog "Relocation health snapshot:"
        foreach ($component in $health.Components) {
            Write-InstallLog ("  component {0,-10} state={1}" -f $component.Name, $component.State)
        }
        Write-InstallLog ("  bundled plugins materialized: {0}" -f $health.PluginsMaterialized)
    }

    if ($null -eq $windows) {
        Write-InstallLog "Window inventory unavailable."
    }
    else {
        Write-InstallLog "Codex top-level windows:"
        if ($windows.Count -eq 0) {
            Write-InstallLog "  (none visible)"
        }
        else {
            foreach ($window in $windows) {
                Write-InstallLog ("  pid={0} owned={1} class={2} title={3}" -f $window.ProcessId, $window.Owned, $window.Class, ('"{0}"' -f $window.Title))
            }
        }
    }

    if ($diagnosis.Verdict -eq 'relocation-bug') {
        Write-InstallLog "Remedy: run docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1 (from the repo root) with pwsh, then relaunch Codex."
    }
    exit 4
}
