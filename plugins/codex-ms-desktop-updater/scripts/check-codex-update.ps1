[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$DownloadOnly,
    [switch]$Install,
    [switch]$InstallWithRestart,

    # 允许安装时弹一次 UAC。桌面应用走 install-codex-msix-and-restart.ps1 时自带这个开关；
    # 每日自动化**不带**（后台不许弹窗），于是需要管理员的包会走到下面那段如实报告里。
    [switch]$AllowElevation,

    [switch]$NoProxy,
    [string]$StoreUrl = "https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK",
    [string]$Ring = "Retail",
    [string]$Architecture = "x64",
    [string]$PackageName = "OpenAI.Codex",
    [string]$DownloadDirectory
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Split-Path -Parent $scriptRoot
if ([string]::IsNullOrWhiteSpace($DownloadDirectory)) {
    $DownloadDirectory = Join-Path $pluginRoot "downloads"
}

Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1") -Force

$writeModes = @($CheckOnly, $DownloadOnly, $Install, $InstallWithRestart) | Where-Object { $_ }
if ($writeModes.Count -gt 1) {
    throw "Use only one of -CheckOnly, -DownloadOnly, -Install, or -InstallWithRestart."
}

if ($NoProxy) {
    $env:HTTP_PROXY = ""
    $env:HTTPS_PROXY = ""
    $env:ALL_PROXY = ""
    $env:NO_PROXY = "*"
    [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy
}

Write-Host "Querying Codex package links from store.rg-adguard.net..."
$html = Invoke-RgAdguardQuery -StoreUrl $StoreUrl -Ring $Ring
$packages = ConvertFrom-RgAdguardHtml -Html $html -PackageName $PackageName
if ($packages.Count -eq 0) {
    throw "No '$PackageName' MSIX/AppX links were found in the rg-adguard response."
}

$selected = Select-BestCodexPackage -Packages $packages -Architecture $Architecture
if ($null -eq $selected) {
    throw "Could not select a package from rg-adguard response."
}

$installed = Get-InstalledCodexPackageInfo -PackageName $PackageName
$installedVersion = if ($null -eq $installed) { $null } else { $installed.Version }
$updateAvailable = Test-IsUpdateAvailable -InstalledVersion $installedVersion -AvailableVersion $selected.Version

Write-Host ("Installed version: {0}" -f $(if ($null -eq $installedVersion) { "not installed or not visible to Get-AppxPackage" } else { $installedVersion.ToString() }))
Write-Host ("Available version: {0}" -f $selected.Version)
Write-Host ("Selected package: {0}" -f $selected.FileName)
Write-Host ("Update available: {0}" -f $updateAvailable)

$removedPackagePaths = Remove-SupersededCodexPackageFiles `
    -DownloadDirectory $DownloadDirectory `
    -InstalledVersion $installedVersion `
    -PackageName $PackageName
if ($removedPackagePaths.Count -gt 0) {
    Write-Host ("Removed {0} superseded package file(s) from download cache:" -f $removedPackagePaths.Count)
    foreach ($removedPackagePath in $removedPackagePaths) {
        Write-Host ("  {0}" -f $removedPackagePath)
    }
}

if ($CheckOnly -or (-not $DownloadOnly -and -not $Install -and -not $InstallWithRestart)) {
    return
}

if (-not $updateAvailable) {
    Write-Host "No newer package was found. Skipping download."
    return
}

$packagePath = Save-CodexPackage -Package $selected -DownloadDirectory $DownloadDirectory
Write-Host ("Downloaded package: {0}" -f $packagePath)

if ($Install) {
    Write-Host "Installing package with Add-AppxPackage..."
    Install-CodexPackage -Path $packagePath
    Write-Host "Install command completed."

    $installedAfterInstall = Get-InstalledCodexPackageInfo -PackageName $PackageName
    $installedVersionAfterInstall = if ($null -eq $installedAfterInstall) { $null } else { $installedAfterInstall.Version }
    $removedAfterInstall = Remove-SupersededCodexPackageFiles `
        -DownloadDirectory $DownloadDirectory `
        -InstalledVersion $installedVersionAfterInstall `
        -PackageName $PackageName
    if ($removedAfterInstall.Count -gt 0) {
        Write-Host ("Removed {0} superseded package file(s) after install:" -f $removedAfterInstall.Count)
        foreach ($removedPackagePath in $removedAfterInstall) {
            Write-Host ("  {0}" -f $removedPackagePath)
        }
    }
}

if ($InstallWithRestart) {
    $installRestartScript = Join-Path $scriptRoot "install-codex-msix-and-restart.ps1"

    # 需要管理员权限的包：在拉起 worker **之前**就拒绝，并且说清楚下一步该做什么。
    #
    # 这一步不是锦上添花，是必须的：worker 是分离进程，下面只看它有没有被拉起来；让它
    # 在后台异步地撞 0x80073D28 失败，自动化这边会**报成功** —— 正是下面那段注释警告的坑，
    # 只不过换了个触发方式（包路径不对 → 这次是权限不够）。而且用户除了日志里一句生
    # HRESULT 之外什么也得不到，不知道该怎么办。
    #
    # 这里刻意不提权：每日自动化是无人值守的，弹 UAC 只会挂在那里等人。改为如实报告，
    # 让用户自己去桌面应用点更新（那边会弹一次 UAC，仍然是一键）。
    if (-not $AllowElevation -and (Test-CodexPackageRequiresElevation -Path $packagePath)) {
        Write-Host "ADMIN_PRIVILEGES_REQUIRED: 这个版本的 Codex 声明了 Windows 服务，安装需要管理员权限。"
        Write-Host "自动维护不提权（后台不能弹 UAC 让无人值守的流程挂住），所以已跳过安装 —— 没有做任何改动。"
        Write-Host ("安装包已经下载好：{0}" -f $packagePath)
        Write-Host "请打开 Codex Updater 桌面应用点「一键更新」（会弹一次 UAC 授权）。"
        Write-Host "（命令行用户也可以在提权的 PowerShell 里自己跑：）"
        Write-Host ("  powershell -NoProfile -ExecutionPolicy Bypass -File `"{0}`" -PackagePath `"{1}`" -AllowElevation" -f $installRestartScript, $packagePath)
        return
    }

    Write-Host "Starting detached install-and-restart workflow..."

    # 必须自己看退出码。`&` 调用的是**同进程**脚本，而 worker 脚本里那个 trap 会把它
    # 自己的终止性错误就地吃掉、再 `exit 1` —— 实测这两种收尾方式对调用方的效果完全不同：
    #   · 没有 trap、直接 throw：错误向上传播，本脚本当场被终止，进程退出码 1（会响）
    #   · trap + exit 1：只退出子脚本，本脚本照常往下走到底，进程退出码 **0**（不响）
    # 也就是说 trap 把「会杀掉调用方的错误」换成了「调用方看不见的退出码」。不看这一行，
    # 「包路径不对 / 不是 Codex 的包」这类前置校验失败就是一次静默成功 —— 自动化每天
    # 报成功、实际什么都没装。
    #
    # 先清零：$LASTEXITCODE 是全局变量，会残留上一个原生命令的值（模块里跑过 curl.exe），
    # 而子脚本正常 return 时**不会**改它（实测先置 7，子脚本正常返回后读回的还是 7）。
    # 不清零就会把陈旧的非零值当成这次的失败。
    $LASTEXITCODE = 0
    & $installRestartScript -PackagePath $packagePath -PackageName $PackageName -AllowElevation:$AllowElevation
    if ($LASTEXITCODE -ne 0) {
        throw "install-codex-msix-and-restart.ps1 exited with code $LASTEXITCODE before the install worker could start."
    }
}
