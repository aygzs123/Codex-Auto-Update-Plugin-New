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

$metadata = Get-CodexPackageMetadata -FileName "OpenAI.Codex_26.512.10.0_x64.msix" -Uri "C:\Downloads\OpenAI.Codex_26.512.10.0_x64.msix"
Assert-Equal "OpenAI.Codex" $metadata.Name "parses package metadata name for install validation"
Assert-Equal "26.512.10.0" $metadata.Version.ToString() "parses package metadata version for cleanup validation"

$selected = Select-BestCodexPackage -Packages $packages -Architecture "x64"
Assert-Equal "OpenAI.Codex_26.512.10.0_x64.msix" $selected.FileName "selects newest matching architecture package"

$installed = ConvertFrom-AppxPackageText -Text "Name : OpenAI.Codex`nVersion : 26.506.3741.0`nArchitecture : X64"
Assert-Equal "26.506.3741.0" $installed.Version.ToString() "parses installed package version"

Assert-True -Condition (Test-IsUpdateAvailable -InstalledVersion ([version]"26.506.3741.0") -AvailableVersion ([version]"26.512.10.0")) -Message "detects newer available version"
Assert-True -Condition (-not (Test-IsUpdateAvailable -InstalledVersion ([version]"26.512.10.0") -AvailableVersion ([version]"26.512.10.0"))) -Message "does not update equal versions"

$tempDownloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-store-updater-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDownloadDirectory -Force | Out-Null

# 缓存夹具：清空目录后按给定的文件名重建。
#
# 保留策略这一组用例的**全部意义**在于「哪些文件还在」。删错一个 = 用户再也退不回那一版
# （rg-adguard 只发最新版，删掉就下不回来），所以每个用例都重新铺一遍夹具，
# 不让上一个用例的删除结果影响下一个。
function New-CacheFixture {
    param([string[]]$FileNames)

    Get-ChildItem -LiteralPath $tempDownloadDirectory -File -ErrorAction SilentlyContinue | Remove-Item -Force
    foreach ($fileName in $FileNames) {
        Set-Content -LiteralPath (Join-Path $tempDownloadDirectory $fileName) -Value "test"
    }
}

try {
    # 已安装 26.512.10.0，缓存里有：
    #   26.513.1.0  比当前新（已下载、还没装），不在保留策略的管辖范围内
    #   26.512.10.0 当前已安装 —— 它是**下一次**更新时的回退目标，必须留下
    #   26.510.0.0  上一版 —— 这次的 回退目标，必须留下
    #   26.506.3741.0 更旧，超出「留 2 个」的额度，删
    $cacheFixture = @(
        "OpenAI.Codex_26.506.3741.0_x64.msix",
        "OpenAI.Codex_26.510.0.0_x64.msix",
        "OpenAI.Codex_26.512.10.0_x64.msix",
        "OpenAI.Codex_26.513.1.0_x64.msix",
        "Other.App_1.0.0.0_x64.msix",
        "OpenAI.Codex_26.512.10.0_x64.msix.partial"
    )
    $pathOf = { param($fileName) Join-Path $tempDownloadDirectory $fileName }

    New-CacheFixture -FileNames $cacheFixture
    $removedPackages = Remove-SupersededCodexPackageFiles `
        -DownloadDirectory $tempDownloadDirectory `
        -InstalledVersion ([version]"26.512.10.0") `
        -PackageName "OpenAI.Codex"

    Assert-Equal 1 $removedPackages.Count "removes only packages beyond the retention count"
    Assert-True -Condition (-not (Test-Path -LiteralPath (& $pathOf "OpenAI.Codex_26.506.3741.0_x64.msix"))) `
        -Message "removes the oldest package once the retention count is exceeded"
    # 这两条是回退功能的命根子：删掉当前这一版的包，下一次更新就没有可退的版本了。
    Assert-True -Condition (Test-Path -LiteralPath (& $pathOf "OpenAI.Codex_26.512.10.0_x64.msix")) `
        -Message "keeps the currently installed package (it is the rollback target for the next update)"
    Assert-True -Condition (Test-Path -LiteralPath (& $pathOf "OpenAI.Codex_26.510.0.0_x64.msix")) `
        -Message "keeps the previous version (it is the rollback target right now)"
    Assert-True -Condition (Test-Path -LiteralPath (& $pathOf "OpenAI.Codex_26.513.1.0_x64.msix")) `
        -Message "keeps newer package"
    Assert-True -Condition (Test-Path -LiteralPath (& $pathOf "Other.App_1.0.0.0_x64.msix")) `
        -Message "keeps other app package"
    Assert-True -Condition (Test-Path -LiteralPath (& $pathOf "OpenAI.Codex_26.512.10.0_x64.msix.partial")) `
        -Message "keeps partial file"

    # 保留额度必须可调，而且 1（= 只留刚装上的那个）是允许的下限 —— 它等于关掉回退，
    # 所以这个用例是**故意**钉住「1 会删掉上一版」的，免得有人把默认值改成 1。
    New-CacheFixture -FileNames $cacheFixture
    $removedWithOne = Remove-SupersededCodexPackageFiles `
        -DownloadDirectory $tempDownloadDirectory `
        -InstalledVersion ([version]"26.512.10.0") `
        -PackageName "OpenAI.Codex" `
        -KeepCount 1
    Assert-Equal 2 $removedWithOne.Count "KeepCount=1 removes the rollback target as well"
    Assert-True -Condition (-not (Test-Path -LiteralPath (& $pathOf "OpenAI.Codex_26.510.0.0_x64.msix"))) `
        -Message "KeepCount=1 deletes the previous version"

    New-CacheFixture -FileNames $cacheFixture
    $removedWithThree = Remove-SupersededCodexPackageFiles `
        -DownloadDirectory $tempDownloadDirectory `
        -InstalledVersion ([version]"26.512.10.0") `
        -PackageName "OpenAI.Codex" `
        -KeepCount 3
    Assert-Equal 0 $removedWithThree.Count "KeepCount=3 keeps every installed-or-older package"
    Assert-True -Condition (Test-Path -LiteralPath (& $pathOf "OpenAI.Codex_26.506.3741.0_x64.msix")) `
        -Message "KeepCount=3 keeps the oldest package"

    # 没装 Codex 时无从判断「哪些已经被取代」，一律不动（也是回退功能的最后一道保险：
    # 判断不出装的是哪一版就绝不删）。
    New-CacheFixture -FileNames $cacheFixture
    $removedWhenNotInstalled = Remove-SupersededCodexPackageFiles `
        -DownloadDirectory $tempDownloadDirectory `
        -PackageName "OpenAI.Codex"
    Assert-Equal 0 $removedWhenNotInstalled.Count "removes nothing when the installed version is unknown"

    # -KeepAll：桌面应用的默认行为 —— 一个旧包都不删。
    #
    # 不能靠「把 KeepCount 调大」表达这件事：KeepCount 是「按版本倒序留 N 个」，0 表示
    # 一个不留（照旧删光），没有任何取值等于「不限制」。所以它是独立开关，而且必须在
    # 删任何文件**之前**短路。
    New-CacheFixture -FileNames $cacheFixture
    $removedWithKeepAll = Remove-SupersededCodexPackageFiles `
        -DownloadDirectory $tempDownloadDirectory `
        -InstalledVersion ([version]"26.512.10.0") `
        -PackageName "OpenAI.Codex" `
        -KeepAll
    Assert-Equal 0 $removedWithKeepAll.Count "KeepAll removes nothing"
    # 逐个数清楚：缓存里 4 个 Codex 包一个都不能少（其余两个本来就不归它管）。
    foreach ($keptName in @(
            "OpenAI.Codex_26.506.3741.0_x64.msix",
            "OpenAI.Codex_26.510.0.0_x64.msix",
            "OpenAI.Codex_26.512.10.0_x64.msix",
            "OpenAI.Codex_26.513.1.0_x64.msix")) {
        Assert-True -Condition (Test-Path -LiteralPath (& $pathOf $keptName)) `
            -Message "KeepAll keeps $keptName"
    }

    # ---------- 清空缓存（桌面应用那颗按钮）----------
    #
    # 真跑一遍脚本，而不是只看代码行。这个动作是**不可逆**的（rg-adguard 只发最新版，
    # 删掉的旧包下不回来），所以「到底删了哪些」必须由行为测试钉住。
    $clearScript = Join-Path $pluginRoot "scripts/clear-cached-codex-packages.ps1"

    New-CacheFixture -FileNames $cacheFixture
    # `6>&1` 不能省：脚本用 Write-Host 输出（桌面端是当子进程跑、读它的 stdout，所以那边
    # 拿得到），而进程内 `&` 调用时 Write-Host 走的是信息流，不进管道 —— 少了这个重定向，
    # 下面每一条输出断言拿到空字符串，就都成了恒真的空洞断言。
    $clearOutput = & $clearScript -DownloadDirectory $tempDownloadDirectory -PackageName "OpenAI.Codex" 6>&1

    # 只认 Codex 自己的安装包：别的 app、以及下载中的 .partial 都必须原样留着。
    # 这条不是洁癖 —— 用户把缓存目录指到自己某个盘上的文件夹时，越界删除就是删别人的东西。
    Assert-True -Condition (Test-Path -LiteralPath (& $pathOf "Other.App_1.0.0.0_x64.msix")) `
        -Message "clearing the cache must not touch packages belonging to other apps"
    Assert-True -Condition (Test-Path -LiteralPath (& $pathOf "OpenAI.Codex_26.512.10.0_x64.msix.partial")) `
        -Message "clearing the cache must not touch an in-flight .partial download"
    foreach ($clearedName in @(
            "OpenAI.Codex_26.506.3741.0_x64.msix",
            "OpenAI.Codex_26.510.0.0_x64.msix",
            "OpenAI.Codex_26.512.10.0_x64.msix",
            "OpenAI.Codex_26.513.1.0_x64.msix")) {
        Assert-True -Condition (-not (Test-Path -LiteralPath (& $pathOf $clearedName))) `
            -Message "clearing the cache must delete $clearedName (no retention policy is applied here)"
    }
    # 输出契约：desktop/electron/parse.cjs 的 parseClearedPackages 逐行读这几行。
    $clearOutputText = $clearOutput -join "`n"
    Assert-True -Condition ($clearOutputText -match 'Cleared package count: 4') `
        -Message "the clear script must report how many packages it deleted (got: $clearOutputText)"
    Assert-True -Condition ($clearOutputText -match 'Failed package count: 0') `
        -Message "the clear script must report the failure count even when it is zero"
    Assert-True -Condition ($clearOutputText -match 'Cache directory: ') `
        -Message "the clear script must echo the directory it used (the desktop app displays it)"

    # 删不掉的（被杀毒软件或安装进程占着）不能中断整批，也不能报成「删除失败」了事：
    # 逐个记下来，把数量交给界面去说。拿真实文件锁来复现，不靠猜。
    New-CacheFixture -FileNames $cacheFixture
    $lockedPath = & $pathOf "OpenAI.Codex_26.510.0.0_x64.msix"
    $lock = [System.IO.File]::Open($lockedPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    try {
        $clearOutput = & $clearScript -DownloadDirectory $tempDownloadDirectory -PackageName "OpenAI.Codex" 6>&1
        $clearOutputText = $clearOutput -join "`n"
    }
    finally {
        # $lock 可能是 $null（Open 自己就抛了）。不加这个判断的话，finally 里那句
        # 「在 $null 上调用方法」会把真正的失败原因盖掉，CI 上只剩一句看不懂的报错。
        if ($null -ne $lock) {
            $lock.Dispose()
        }
    }
    Assert-True -Condition ($clearOutputText -match 'Cleared package count: 3') `
        -Message "a locked package must not abort the batch (got: $clearOutputText)"
    Assert-True -Condition ($clearOutputText -match 'Failed package count: 1') `
        -Message "a locked package must be counted, not thrown (got: $clearOutputText)"
    Assert-True -Condition ($clearOutputText -match [regex]::Escape($lockedPath)) `
        -Message "the undeletable path must be named so the UI can tell the user which one is stuck"
    Assert-True -Condition (Test-Path -LiteralPath $lockedPath) `
        -Message "the script must not report a failure as a success"

    # ---------- Get-CachedCodexPackages：界面上「版本历史」的数据源 ----------
    New-CacheFixture -FileNames $cacheFixture
    $cached = @(Get-CachedCodexPackages `
        -DownloadDirectory $tempDownloadDirectory `
        -InstalledVersion ([version]"26.512.10.0") `
        -PackageName "OpenAI.Codex")

    # 只认 Codex 自己的安装包：别的 app、以及 .partial 这种下载残留都不该出现在列表里
    # —— 它们的路径会被界面拿去 Add-AppxPackage。
    #
    # 4 个（而不是保留额度 2 个）：这个枚举器只如实报告缓存里有什么，不管保留策略。
    # 「清到只剩 2 个」是 Remove-SupersededCodexPackageFiles 的职责，两者混在一起之后
    # 就再也分不清「列表少了一行」是策略生效还是枚举漏了文件。
    Assert-Equal 4 $cached.Count "lists only parseable Codex package files"
    # 按版本倒序：界面直接按这个顺序渲染，最新的一版在最上面。
    Assert-Equal "26.513.1.0" $cached[0].Version.ToString() "sorts cached packages newest first"
    Assert-Equal "26.512.10.0" $cached[1].Version.ToString() "keeps the installed version second"
    Assert-Equal "26.510.0.0" $cached[2].Version.ToString() "keeps the previous version third"
    Assert-Equal "26.506.3741.0" $cached[3].Version.ToString() "keeps the oldest package last"

    $relationByVersion = @{}
    foreach ($package in $cached) {
        $relationByVersion[$package.Version.ToString()] = $package.Relation
    }
    Assert-Equal "newer" $relationByVersion["26.513.1.0"] "marks a newer cached package as newer"
    Assert-Equal "installed" $relationByVersion["26.512.10.0"] "marks the installed version as installed"
    Assert-Equal "older" $relationByVersion["26.510.0.0"] "marks an older cached package as older"
    Assert-Equal "older" $relationByVersion["26.506.3741.0"] "marks the oldest cached package as older"
    Assert-True -Condition ($cached[2].SizeBytes -gt 0) -Message "reports the package size for the UI"
    Assert-True -Condition ($cached[2].FullName.EndsWith("OpenAI.Codex_26.510.0.0_x64.msix")) `
        -Message "reports the full path (the rollback install uses it verbatim)"

    # 版本比较只在 PowerShell 这一侧做，所以没装时 relation 只能是 unknown —— 界面据此
    # 不给回退按钮，而不是拿一个猜出来的结论当依据。
    $uncomparable = @(Get-CachedCodexPackages -DownloadDirectory $tempDownloadDirectory -PackageName "OpenAI.Codex")
    Assert-True -Condition (@($uncomparable | Where-Object { $_.Relation -ne "unknown" }).Count -eq 0) `
        -Message "marks every package as unknown when the installed version is unavailable"

    # 目录还不存在时给空列表而不是抛错：exe 的默认缓存目录在第一次下载前就是没有的。
    $missingDirectory = Join-Path $tempDownloadDirectory "does-not-exist"
    Assert-Equal 0 @(Get-CachedCodexPackages -DownloadDirectory $missingDirectory).Count `
        "returns an empty list for a missing download directory"
}
finally {
    Remove-Item -LiteralPath $tempDownloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

Assert-True -Condition (Test-IsPluginUpdateAvailable -InstalledVersion "0.1.1" -AvailableVersion "0.2.0") -Message "detects newer plugin version"
Assert-True -Condition (-not (Test-IsPluginUpdateAvailable -InstalledVersion "0.2.0" -AvailableVersion "0.2.0")) -Message "does not update equal plugin version"

$invalidPluginVersionThrew = $false
try {
    ConvertTo-CodexPluginVersion -VersionText "0.2.0-beta" | Out-Null
}
catch {
    $invalidPluginVersionThrew = $true
}
Assert-True -Condition $invalidPluginVersionThrew -Message "requires numeric plugin versions"
$appUserModelId = Get-CodexAppUserModelId -PackageFamilyName "OpenAI.Codex_2p2nqsd0c76g0" -AppId "Codex"
Assert-Equal "OpenAI.Codex_2p2nqsd0c76g0!Codex" $appUserModelId "builds Codex AppUserModelId"
# 兜底值的回归：manifest 读不到时才用它，而那正是它必须正确的时刻 ——
# AppId 写错的话启动请求发出去没人接，用户看到的就是「点了没反应」。
Assert-Equal "OpenAI.Codex_2p2nqsd0c76g0!App" (Get-CodexAppUserModelId -PackageFamilyName "OpenAI.Codex_2p2nqsd0c76g0") `
    "defaults to the manifest Application Id (App) when the caller cannot read the manifest"

$installRestartScript = Join-Path $pluginRoot "scripts/install-codex-msix-and-restart.ps1"
Assert-True -Condition (Test-Path -LiteralPath $installRestartScript) -Message "provides install-and-restart script"
$installRestartScriptText = Get-Content -LiteralPath $installRestartScript -Raw
Assert-True -Condition ($installRestartScriptText -match '\[switch\]\$Worker') -Message "install-and-restart script has detached worker mode"
Assert-True -Condition ($installRestartScriptText -match 'Add-AppxPackage') -Message "install-and-restart script installs MSIX package"
Assert-True -Condition ($installRestartScriptText -match 'Get-CodexPackageMetadata') -Message "install-and-restart script validates package metadata"
Assert-True -Condition ($installRestartScriptText -match '\[switch\]\$SkipLaunch') -Message "install-and-restart script can skip launch for the desktop wizard"

# ---------- 降级（版本回退）----------
#
# 三条不变量，缺一条回退功能就是坏的：
#   1. 只有回退这条路允许降级 —— 正常的「一键更新」必须保持严格，否则一条错误的调用
#      就能把用户悄悄降级；
#   2. 降级必须真的带上 -ForceUpdateFromAnyVersion —— 不带的话 Windows 拒绝安装更低的
#      版本，而 Add-AppxPackage 不会因此报错到我们能看见的地方；
#   3. 降级后的版本校验必须用**相等**判定。用 -lt 的话，Windows 拒绝降级时
#      「装上的版本 < 请求的版本」恰好为假，失败会被报成成功。
Assert-True -Condition ($installRestartScriptText -match '\[switch\]\$AllowDowngrade') `
    -Message "install-and-restart script exposes an explicit downgrade switch"
# 参数名是 $PackagePath，不是脚本级的 $resolvedPackagePath：安装步骤抽成了函数，函数里
# 动态读父作用域也能跑通，但提权子进程正是靠这个参数拿到包路径的，契约必须是参数。
Assert-True -Condition ($installRestartScriptText -match 'Add-AppxPackage -Path \$PackagePath -ForceUpdateFromAnyVersion') `
    -Message "install-and-restart script passes -ForceUpdateFromAnyVersion on the downgrade path"
Assert-True -Condition ($installRestartScriptText -match 'if \(\$AllowDowngrade\) \{\s*\$arguments \+= "-AllowDowngrade"') `
    -Message "install-and-restart script forwards -AllowDowngrade to the detached worker (a new process does not inherit switches)"
# 同一个坑：worker 是分离进程，桌面应用传进来的 -KeepAll 不会自动继承。少了这行转发，
# 用户明明选了「不限制保留」，装完之后 worker 那一侧照旧按 KeepCount 删 —— 表现就是
# 「设置好像没生效」，而且日志里一个字都不会提。
Assert-True -Condition ($installRestartScriptText -match 'if \(\$KeepAll\) \{\s*\$arguments \+= "-KeepAll"') `
    -Message "install-and-restart script forwards -KeepAll to the detached worker"
Assert-True -Condition ($installRestartScriptText -match 'if \(\$installedVersion -ne \$packageMetadata\.Version\)') `
    -Message "install-and-restart script verifies a downgrade by equality (a -lt check reports a refused downgrade as success)"
# 而那条「不小于」的判定必须退到 elseif：它只对升级路径成立。写成 if/else 两条独立
# 判断的话，降级时它会被执行到，于是又回到「失败报成成功」。
Assert-True -Condition ($installRestartScriptText -match 'elseif \(\$installedVersion -lt \$packageMetadata\.Version\)') `
    -Message "the -lt check must be the non-downgrade branch only"
# 装完之后**不能**再把自己刚用的那个包删掉：它是下一次更新时的回退目标。
Assert-True -Condition (-not ($installRestartScriptText -match 'Remove-Item -LiteralPath \$resolvedPackagePath')) `
    -Message "install-and-restart script must not delete the package it just installed"
Assert-True -Condition ($installRestartScriptText -match 'Remove-SupersededCodexPackageFiles') `
    -Message "install-and-restart script prunes the cache by the retention policy instead"

$moduleCodeText = ((Get-Content -LiteralPath $modulePath -Raw) -split "`n" | Where-Object { $_.TrimStart() -notmatch '^#' }) -join "`n"
Assert-True -Condition ($moduleCodeText -match '\[int\]\$KeepCount = 2') `
    -Message "the retention count defaults to 2 (1 would delete the rollback target)"
Assert-True -Condition ($moduleCodeText -match 'Select-Object -Skip \$KeepCount') `
    -Message "the retention policy prunes by skipping the newest KeepCount candidates"
# 「不限制」只能靠独立开关表达：KeepCount 是「按版本倒序留 N 个」，0 反而是一个不留。
# 而且它必须默认关闭 —— 每日自动化那条路不传这个开关，默认一变，无人值守的缓存就没边了。
Assert-True -Condition ($moduleCodeText -match '\[switch\]\$KeepAll') `
    -Message "the retention policy must expose -KeepAll (KeepCount has no 'unlimited' value: 0 deletes everything)"
Assert-True -Condition ($moduleCodeText -notmatch '\[switch\]\$KeepAll\s*=') `
    -Message "-KeepAll must NOT default to true, otherwise the daily automation stops pruning"
Assert-True -Condition ($moduleCodeText -match 'Get-CachedCodexPackages,') `
    -Message "exports the cached-package enumerator used by the desktop UI"
Assert-True -Condition (-not ($moduleCodeText -match 'Remove-InstalledCodexPackageFiles')) `
    -Message "the old installed-or-older remover must be gone (its rule is what broke rollback)"

$listCachedScript = Join-Path $pluginRoot "scripts/list-cached-codex-packages.ps1"
Assert-True -Condition (Test-Path -LiteralPath $listCachedScript) -Message "provides the read-only cached-package listing script"
$listCachedScriptText = Get-Content -LiteralPath $listCachedScript -Raw
# 输出契约：desktop/electron/parse.cjs 的 parseCachedPackages 按这些行解析。
Assert-True -Condition ($listCachedScriptText -match 'Cached package count: ') -Message "listing script prints the package count line"
Assert-True -Condition ($listCachedScriptText -match 'Installed version: ') -Message "listing script prints the installed version line"
Assert-True -Condition ($listCachedScriptText -match 'Download directory: ') -Message "listing script prints the download directory line"
Assert-True -Condition (-not ($listCachedScriptText -match 'Remove-Item|Set-Content|New-Item')) `
    -Message "listing script must stay read-only"

$clearCachedScript = Join-Path $pluginRoot "scripts/clear-cached-codex-packages.ps1"
Assert-True -Condition (Test-Path -LiteralPath $clearCachedScript) -Message "provides the cache-clearing script"
$clearCachedScriptText = Get-Content -LiteralPath $clearCachedScript -Raw
$clearCachedCode = ($clearCachedScriptText -split "`n" | Where-Object { $_.TrimStart() -notmatch '^#' }) -join "`n"
# 删除范围必须由 Get-CachedCodexPackages 决定，而不是「把目录里的文件都删掉」。
# 缓存目录可以是用户自己选的任意文件夹 —— 一旦退化成对整个目录 rm -rf，那就是删别人的东西。
Assert-True -Condition ($clearCachedCode -match 'Get-CachedCodexPackages') `
    -Message "the clear script must delete exactly what Get-CachedCodexPackages recognises"
Assert-True -Condition (-not ($clearCachedCode -match 'Get-ChildItem')) `
    -Message "the clear script must not enumerate the directory itself (that is an rm -rf on a user-chosen folder)"
# 输出契约：desktop/electron/parse.cjs 的 parseClearedPackages 按这些行解析。
foreach ($line in @('Cache directory: ', 'Cleared package count: ', 'Cleared bytes: ', 'Failed package count: ')) {
    Assert-True -Condition ($clearCachedScriptText.Contains($line)) `
        -Message "clear script must print the '$line' line (parse.cjs parses it)"
}

$checkScript = Join-Path $pluginRoot "scripts/check-codex-update.ps1"
$checkScriptText = Get-Content -LiteralPath $checkScript -Raw
Assert-True -Condition ($checkScriptText -match '\[switch\]\$InstallWithRestart') -Message "check script exposes install-with-restart mode"
Assert-True -Condition ($checkScriptText -match 'install-codex-msix-and-restart\.ps1') -Message "check script invokes install-and-restart script"

# ---------- 桌面端的「不限制保留」必须贯通到脚本这一层 ----------
#
# 桌面端把「留几个」交给了用户：界面显示缓存多大 + 一个「清空缓存」按钮，不再自动删。
# 这条链路要经过三个文件，任何一环漏了都会**静默**失效 —— 开关默认关，漏传的表现就是
# 「旧包照删」，而用户以为自己已经选了不限制。
#
# 数清楚是 2 处而不是「至少 1 处」：check 脚本里有**两个**剪枝点，而且第一个排在
# `-CheckOnly` 提前 return **之前** —— 只给安装后那处加开关的话，用户点一次「检查更新」
# 就把缓存删了，这正是这次要修掉的行为。
$keepAllAtPruneSites = [regex]::Matches($checkScriptText, '-KeepAll:\$KeepAll').Count
Assert-True -Condition ($keepAllAtPruneSites -eq 2) `
    -Message "check script must pass -KeepAll at both prune sites, found $keepAllAtPruneSites (one runs before the -CheckOnly early return: just checking the version would delete packages)"
Assert-True -Condition ($checkScriptText -match '\[switch\]\$KeepAll') `
    -Message "check script must accept -KeepAll"
# 开关必须落在**参数块**里：写成脚本中段的普通变量，上游传 -KeepAll 会因为「找不到参数」
# 直接报错，自动化每天都会响。
Assert-True -Condition ($checkScriptText -match '(?s)param\(.*?\[switch\]\$KeepAll') `
    -Message "check script's -KeepAll must be a declared parameter"

# ---------- 调用方必须看子脚本的退出码 ----------
#
# 回归：worker 脚本里的 trap 会把它自己的终止性错误**就地吃掉**、再 `exit 1`，而被 `&`
# 同进程调用时，`exit` 只退子脚本。实测三种收尾方式对调用方的效果完全不同：
#   · 无 trap、直接 throw  → 错误向上传播，调用方当场被终止，进程退出码 1（会响）
#   · trap + exit 1        → 调用方一路跑到底，进程退出码 **0**（静默成功）
#   · 正常 return          → 退出码 0（应当如此）
# 所以加了 trap 之后，调用点必须自己看 $LASTEXITCODE，否则「包路径不对 / 不是 Codex 的包」
# 这类前置校验失败就是一次静默成功：每天跑的自动化报成功，实际什么都没装。
# 断言只看代码行 —— 上面那段解释里就带着 `trap + exit 1` 这种字样。
$checkCode = ($checkScriptText -split "`n" | Where-Object { $_.TrimStart() -notmatch '^#' }) -join "`n"
Assert-True -Condition ($checkCode -match '\$LASTEXITCODE = 0') `
    -Message "check script must reset `$LASTEXITCODE before invoking the worker (it is global, and a child that returns normally leaves it untouched)"
Assert-True -Condition ($checkCode -match 'if \(\$LASTEXITCODE -ne 0\)') `
    -Message "check script must inspect the worker exit code; the worker's trap converts a fatal error into a silent exit 0"
Assert-True -Condition ($checkCode -match 'throw "install-codex-msix-and-restart\.ps1 exited with code') `
    -Message "check script must turn a failed worker launch into a terminating error"

$pluginUpdateScript = Join-Path $pluginRoot "scripts/update-installed-plugin.ps1"
Assert-True -Condition (Test-Path -LiteralPath $pluginUpdateScript) -Message "provides plugin self-update script"
$pluginUpdateScriptText = Get-Content -LiteralPath $pluginUpdateScript -Raw
Assert-True -Condition ($pluginUpdateScriptText -match 'aygzs123') -Message "plugin update script defaults to repository owner"
Assert-True -Condition ($pluginUpdateScriptText -match 'Codex-Auto-Update-Plugin-New') -Message "plugin update script defaults to remote repository"
Assert-True -Condition ($pluginUpdateScriptText -match 'raw\.githubusercontent\.com') -Message "plugin update script reads remote manifest"
Assert-True -Condition ($pluginUpdateScriptText -match 'codeload\.github\.com') -Message "plugin update script downloads repository archive"
Assert-True -Condition ($pluginUpdateScriptText -match 'Copy-PluginWithoutDownloads') -Message "plugin update script skips downloads cache"

$maintenanceScript = Join-Path $pluginRoot "scripts/run-automatic-maintenance.ps1"
Assert-True -Condition (Test-Path -LiteralPath $maintenanceScript) -Message "provides automatic maintenance script"
$maintenanceScriptText = Get-Content -LiteralPath $maintenanceScript -Raw
Assert-True -Condition ($maintenanceScriptText -match 'update-installed-plugin\.ps1') -Message "maintenance script updates plugin first"
Assert-True -Condition ($maintenanceScriptText -match 'check-codex-update\.ps1') -Message "maintenance script checks Codex package"
Assert-True -Condition ($maintenanceScriptText -match 'InstallWithRestart') -Message "maintenance script installs Codex update with restart"
# 每日自动化**故意**不带 -KeepAll：后台无人看着，缓存不能无界增长。
# 这条与「桌面应用必须带」是一对 —— 只测一边的话，把开关默认翻过来或者顺手给自动化也加上，
# 都不会有人发现。
Assert-True -Condition (-not ($maintenanceScriptText -match 'KeepAll')) `
    -Message "the daily automation must keep pruning by KeepCount (an unattended run cannot let the cache grow without bound)"

# ---------- AppId 解析必须产出字符串 ----------
#
# 回归：`@($manifest.Package.Applications.Application | Select-Object -First 1
# -ExpandProperty Id)` 得到的是一个单元素数组。Windows PowerShell 5.1 把数组绑到
# [string] 参数上会抛 "Cannot process argument transformation on parameter 'AppId'"
# —— check-codex-desktop-health.ps1 的窗口探测因此从来没跑完过：脚本在打印 RESULT=
# 之前就断了，于是「进程在跑但没有主窗口」这个本脚本唯一要复现的故障，永远报不出来，
# 退出码还停在那个看不出问题的 1。去掉 @() 后属性展开只剩一个字符串，对照实测：
# 5.1 下从 Object[] 变成 System.String，探测随即能跑完整。
foreach ($name in @("check-codex-desktop-health.ps1", "install-codex-msix-and-restart.ps1")) {
    $scriptText = Get-Content -LiteralPath (Join-Path $pluginRoot "scripts/$name") -Raw
    Assert-True -Condition (-not ($scriptText -match '@\(\s*\$manifest\.Package\.Applications\.Application')) `
        -Message "$name must not wrap the manifest AppId expansion in @() (breaks [string] binding on PowerShell 5.1)"
    Assert-True -Condition ($scriptText -match '\$manifest\.Package\.Applications\.Application \| Select-Object -First 1 -ExpandProperty Id') `
        -Message "$name must still resolve the AppId from the manifest"
}

# ---------- 进程归属必须按包的真实安装位置判断 ----------
#
# 回归：以前用字面量 "*\WindowsApps\<包名>_*" 匹配属于该包的进程。MSIX 并不保证装在
# 名为 WindowsApps 的目录下（可以装到别的盘、别的路径），写死目录名在那些机器上会
# 一个进程都匹配不到 —— 表现为「Codex 明明在跑，探测却说没有」，把正常状态报成故障，
# 或者该关掉的进程没关掉、留着锁文件。安装位置只能从包本身现取。
$moduleText = Get-Content -LiteralPath $modulePath -Raw
Assert-True -Condition ($moduleText -match 'function Get-CodexPackageProcess') -Message "provides a package-process resolver"
Assert-True -Condition ($moduleText -match 'Get-CodexPackageProcess,') -Message "exports the package-process resolver"
Assert-True -Condition ($moduleText -match 'InstallLocation') -Message "package-process resolver uses the real install location"
Assert-True -Condition ($moduleText -match 'StartsWith\(\$prefix') -Message "package-process resolver matches by install-location prefix"

# 匹配真实写法 `-like ("*\WindowsApps...`。
#
# 这条正则原先写成 '\$\.Path -like\s*\("\*\\WindowsApps'，多出来的 `\$\.Path ` 与 `\s*`
# 让它在本仓库里一处都匹配不到（真实位置写的是 `return $path -like (...`，不是 `$_.Path`），
# 于是计数恒为 0；再配上 `-le 1`（而提示语写的是 must not，也就是 0），这句话就永远为真 ——
# 把匹配逻辑整个改回字面量它也不会响。额度按文件写死，别用「小于等于某个数」：
# 数字和提示语对不上时，为真的那一侧永远是断言失效的那一侧。
foreach ($case in @(
        @{ Name = "check-codex-desktop-health.ps1"; LiteralBudget = 0 },
        @{ Name = "install-codex-msix-and-restart.ps1"; LiteralBudget = 0 },
        # 模块里那条退路是允许的：拿不到 InstallLocation 时才走，见下面的位置断言。
        @{ Name = "CodexStoreUpdater.psm1"; LiteralBudget = 1 }
    )) {
    $scriptText = Get-Content -LiteralPath (Join-Path $pluginRoot "scripts/$($case.Name)") -Raw
    # 只看代码行，注释里说明「为什么不这么做」是允许且应该保留的。
    $codeLines = ($scriptText -split "`n" | Where-Object { $_.TrimStart() -notmatch '^#' }) -join "`n"
    $literalMatches = [regex]::Matches($codeLines, '-like\s*\("\*\\WindowsApps').Count
    Assert-True -Condition ($literalMatches -eq $case.LiteralBudget) `
        -Message "$($case.Name): literal WindowsApps 匹配应出现 $($case.LiteralBudget) 次，实际 $literalMatches 次"

    if ($case.LiteralBudget -gt 0) {
        # 光有额度不够 —— 必须钉住它在**哪**：那一处只能是 $prefix 分支之后的退路。
        # 放在前面就等于「优先按目录名猜」，安装到别处的机器上照样匹配不到进程。
        $prefixGuardAt = $codeLines.IndexOf('if ($prefix) {')
        $literalAt = $codeLines.IndexOf('-like ("*\WindowsApps')
        Assert-True -Condition ($prefixGuardAt -ge 0) `
            -Message "$($case.Name): 找不到 `$prefix 分支，字面量退路无从谈起"
        Assert-True -Condition ($literalAt -gt $prefixGuardAt) `
            -Message "$($case.Name): 字面量匹配必须排在 `$prefix 分支之后（退路），现在排在前面"
    }
}

# ---------- 分离 worker 的参数必须自己补引号 ----------
#
# 回归（这套脚本里最严重的一个）：Windows PowerShell 5.1 的 Start-Process -ArgumentList
# 收到数组时，会把元素用单个空格拼成一条命令行，并且**不加引号**。本应用的日志目录固定在
# %APPDATA%\Codex Updater\logs（main.cjs 里的 app.setName("Codex Updater")），必然含空格，
# 于是 -LogPath / -PackagePath 都在空格处被截断：worker 拿到半截路径，在 Resolve-Path 那
# 一行就抛错，而父进程不带 -Wait，只会回报「已启动」。安装与回退因此从来没有真正跑起来过，
# 插件那条路能用只是因为本机 %USERPROFILE% 恰好没有空格。
# 断言只看**代码行**，注释必须剔掉。
#
# 解释「为什么不那么写」的注释里，必然会出现那个被禁掉的写法本身（「用
# [Console]::Error.WriteLine 而不是 Write-Error」「不用 Add-Content -Encoding UTF8」）。
# 拿整份文本去匹配，正向断言会因为注释里提到过而恒真，负向断言会因为同一句话而恒假 ——
# 两种都是空洞断言：代码改坏了测试照样绿。（实测踩过：删掉 trap 里回写 stderr 的代码行，
# 只因为注释里提到过 [Console]::Error.WriteLine，断言照样通过。）
# 所以下面整个 install worker 的断言块统一用这份去注释文本。$installText 只作为中间变量，
# 不再直接参与断言 —— 免得后来人顺手拿它写一条新的空洞断言。
$installText = Get-Content -LiteralPath (Join-Path $pluginRoot "scripts/install-codex-msix-and-restart.ps1") -Raw
$installCode = ($installText -split "`n" | Where-Object { $_.TrimStart() -notmatch '^#' }) -join "`n"
Assert-True -Condition ($installCode -match '-ArgumentList \(\$quotedArguments -join " "\)') `
    -Message "install worker arguments must be joined into one self-quoted string"
Assert-True -Condition ($installCode -notmatch '-ArgumentList \$arguments\b') `
    -Message "must not hand the raw argument array to Start-Process (paths containing spaces get truncated)"

# 补引号本身还有第二层坑：只补一对引号的话，**以反斜杠结尾的值会把收尾引号转义掉**
# （Windows 命令行里 `\"` 是转义引号），命令行从那里断开，后面的参数整段被吞进这个值。
# 实测（值同时含空格与尾部反斜杠）：子进程收到 DownloadDirectory=<C:\Temp\my cache" >，
# 剪枝目录变成一个不存在的路径 —— 剪枝静默失效，缓存一直涨。
# 这条对用户是可达的：-DownloadDirectory 是唯一由用户手填的值参数，codex.cjs 的
# resolveDownloadDirectory 只做 trim()，在高级设置里填 "D:\My Cache\" 就会命中。
#
# 两条断言缺一不可，因为它们各挡一半：
#   1) 「真的用它」—— 只测函数的话，把调用点换回就地拼一对引号，函数还是那个对的函数，
#      测试照样绿（实测过）。
#   2) 「它算得对」—— 只测调用点的话，函数里的加倍逻辑被删掉也看不出来。
# 上面那条 `-ArgumentList ($quotedArguments -join " ")` 两者都挡不住：它只证明引号被拼
# 进去了，证明不了拼得对。
$quoteCallLine = ($installCode -split "`n" | Where-Object { $_ -match '\$quotedArguments\s*=' }) -join "`n"
Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($quoteCallLine)) `
    -Message "找不到构造 quotedArguments 的那一行"
Assert-True -Condition ($quoteCallLine -match 'ConvertTo-QuotedArgument') `
    -Message "补引号要走 ConvertTo-QuotedArgument：就地拼一对引号会踩尾部反斜杠那个坑"

# 收尾的 } 要锚在行首：函数体里 `if (...) { return $Value }` 的那个 } 不是行首，
# 用非贪婪的 .*?\} 会停在那里，切出半截函数（MissingEndCurlyBrace）。
$quotedFnSource = [regex]::Match($installCode, '(?s)function ConvertTo-QuotedArgument \{.*?\n\}').Value
Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($quotedFnSource)) `
    -Message "找不到 ConvertTo-QuotedArgument 函数体（补引号的逻辑必须收在一个函数里）"
Invoke-Expression $quotedFnSource

# 期望值来自实测：这些字符串喂进 Start-Process -ArgumentList，由 Windows 的命令行解析
# 还原出来后与输入逐字符相同。
$quoteCases = @(
    @{ In = 'C:\Temp\my cache\'; Out = '"C:\Temp\my cache\\"' },   # 空格 + 尾部反斜杠（出过事的那条）
    @{ In = 'C:\Temp\my cache'; Out = '"C:\Temp\my cache"' },      # 只有空格
    @{ In = 'C:\Temp\plain\'; Out = 'C:\Temp\plain\' },            # 只有尾部反斜杠：不能加引号
    @{ In = 'C:\Temp\plain'; Out = 'C:\Temp\plain' },              # 什么都不含
    @{ In = 'C:\Temp\a"b\'; Out = '"C:\Temp\a\"b\\"' }             # 内嵌引号 + 尾部反斜杠
)
foreach ($case in $quoteCases) {
    $actual = ConvertTo-QuotedArgument $case.In
    Assert-True -Condition ($actual -ceq $case.Out) `
        -Message ("参数 [{0}] 应补成 [{1}]，实际 [{2}]" -f $case.In, $case.Out, $actual)
}
# 「什么都不含」那条必须是**原样**返回：一律加引号会把本来安全的用例弄坏
# （C:\Temp\plain\ 一旦被引号包住，尾部反斜杠又会去转义收尾引号）。
Assert-True -Condition ((ConvertTo-QuotedArgument 'C:\Temp\plain') -ceq 'C:\Temp\plain') `
    -Message "不含空格也不含引号的值不能加引号"

# ---------- 未捕获的失败必须落进安装日志 ----------
#
# worker 没有控制台，stderr 全部丢失，父进程又不带 -Wait。所以任何未捕获的终止性错误
# 都表现为「日志文件永远不出现 → 界面等满 12 分钟超时」，真实原因一个字也留不下。
Assert-True -Condition ($installCode -match 'trap \{') -Message "install worker must trap terminating errors"
Assert-True -Condition ($installCode -match 'FATAL: \{0\}') `
    -Message "the trap must write the real reason into the install log"
# 父进程那条路不读日志文件（桌面应用只看 stderr 和退出码）。trap 只往日志里写的话，
# 父进程侧失败会退化成一句「PowerShell 退出码 1」，比修复前更难查。
Assert-True -Condition ($installCode -match '\[Console\]::Error\.WriteLine') `
    -Message "the trap must also write to stderr (the parent reads stderr, not the log file)"

# ---------- 安装日志必须是 UTF-8（无 BOM） ----------
#
# 读取方 desktop/electron/codex.cjs 用 toString("utf8") 解码，而 Add-Content 在
# PowerShell 5.1 下按系统 ANSI 代码页写盘 —— 中文异常消息（"拒绝访问。"）两边对不上就是
# 乱码，偏偏失败时唯一能看的就是这几行。又不能图省事用 Add-Content -Encoding UTF8：
# 它会写 BOM，而 BOM 会让第一行的时间戳正则失配，首个进度事件凭空丢失。
Assert-True -Condition ($installCode -match '\[System\.IO\.File\]::AppendAllText') `
    -Message "install log must be written with an explicit encoding"
Assert-True -Condition ($installCode -match 'UTF8Encoding\(\$false\)') `
    -Message "install log encoding must be UTF-8 without BOM"
Assert-True -Condition ($installCode -notmatch 'Add-Content -LiteralPath \$LogPath') `
    -Message "must not go back to Add-Content (ANSI on PowerShell 5.1)"

# ---------- 剪枝目录由调用方给出，不从安装包路径反推 ----------
#
# exe 允许用户把缓存换到别的盘，而 -PackagePath 是调用方给什么就是什么（旧包、手工下的
# 包都行）。反推出来的目录未必是缓存，剪错目录会把不相干的安装包删掉。
Assert-True -Condition ($installCode -match '\[string\]\$DownloadDirectory') `
    -Message "install script must accept -DownloadDirectory"
Assert-True -Condition ($installCode -match '-DownloadDirectory", \$DownloadDirectory') `
    -Message "must forward -DownloadDirectory to the detached worker"
Assert-True -Condition ($installCode -match '-DownloadDirectory \$cacheDirectory') `
    -Message "pruning must run against the resolved cache directory"

# ---------- 需要管理员权限的包必须被提前认出来 ----------
#
# 新版 Codex 的清单里声明了一个以 localSystem 运行的打包服务，Add-AppxPackage 于是必须
# 由管理员上下文执行，否则回 0x80073D28。认不出来，用户拿到的就是一句生 HRESULT、
# 既看不懂也不知道下一步做什么。所以这里用**真的 zip 包**验，而不是拿字符串匹配凑数。
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-FakeCodexPackage {
    param(
        [string]$Directory,
        [string]$ManifestText,
        [string]$TargetPath
    )

    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $Directory "AppxManifest.xml") -Value $ManifestText -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $Directory "resources.pri") -Value "payload" -Encoding ASCII
    [System.IO.Compression.ZipFile]::CreateFromDirectory($Directory, $TargetPath)
}

$elevationFixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-elevation-" + [guid]::NewGuid().ToString("N"))
try {
    # 逐字取自真实安装包的清单片段（服务名和 StartAccount 都是实际值）。
    $serviceManifest = @'
<Package>
  <Extensions>
    <desktop6:Extension Category="windows.service" Executable="app/resources/codex-windows-sandbox-service.exe" EntryPoint="Windows.FullTrustApplication">
      <desktop6:Service Name="CodexSandboxService.OpenAI.Codex" StartupType="auto" StartAccount="localSystem" />
    </desktop6:Extension>
  </Extensions>
</Package>
'@
    $plainManifest = '<Package><Applications><Application Id="App" /></Applications></Package>'

    $servicePackagePath = Join-Path $elevationFixtureRoot "OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0.msix"
    $plainPackagePath = Join-Path $elevationFixtureRoot "OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0.msix"
    New-FakeCodexPackage -Directory (Join-Path $elevationFixtureRoot "service") -ManifestText $serviceManifest -TargetPath $servicePackagePath
    New-FakeCodexPackage -Directory (Join-Path $elevationFixtureRoot "plain") -ManifestText $plainManifest -TargetPath $plainPackagePath

    Assert-True -Condition (Test-CodexPackageRequiresElevation -Path $servicePackagePath) `
        -Message "a manifest declaring Category=""windows.service"" must be detected as requiring elevation"
    Assert-True -Condition (-not (Test-CodexPackageRequiresElevation -Path $plainPackagePath)) `
        -Message "a package without the service declaration must not be flagged (the pre-upgrade 26.901 build has no service)"

    # bundle：内层 .msix 是**嵌套的 zip**，只枚举外层条目永远看不到它们的清单。
    # 这条不是理论风险 —— module 里 Get-ExtensionRank 把 msixbundle 排在 msix 之上，
    # 商店一旦提供 bundle，Select-BestCodexPackage 就优先选它。
    $bundleSource = Join-Path $elevationFixtureRoot "bundle"
    New-Item -ItemType Directory -Path $bundleSource -Force | Out-Null
    Copy-Item -LiteralPath $servicePackagePath -Destination (Join-Path $bundleSource "OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0.msix")
    $bundlePath = Join-Path $elevationFixtureRoot "OpenAI.Codex_26.928.3736.0_x64.msixbundle"
    [System.IO.Compression.ZipFile]::CreateFromDirectory($bundleSource, $bundlePath)
    Assert-True -Condition (Test-CodexPackageRequiresElevation -Path $bundlePath) `
        -Message "a bundle must be inspected through its nested .msix, not only its own entries"

    # 失败要开放：读不出来就返回 $false，让 Add-AppxPackage 自己去报真实错误
    # （worker 里还有一条「认出 0x80073D28 就改为提权重试」的兜底），
    # 而不是把一个合法安装包挡在门外。
    Assert-True -Condition (-not (Test-CodexPackageRequiresElevation -Path (Join-Path $elevationFixtureRoot "missing.msix"))) `
        -Message "a missing package path must not report elevation required"
    $notAnArchive = Join-Path $elevationFixtureRoot "not-an-archive.msix"
    Set-Content -LiteralPath $notAnArchive -Value "not a zip" -Encoding ASCII
    Assert-True -Condition (-not (Test-CodexPackageRequiresElevation -Path $notAnArchive)) `
        -Message "a corrupt package must not report elevation required"
}
finally {
    if (Test-Path -LiteralPath $elevationFixtureRoot) {
        Remove-Item -LiteralPath $elevationFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------- 提权路径的形状 ----------
#
# 提权的**位置**和**参数**是这段功能里唯二容易悄悄坏掉的东西，各钉一条：
#   · 位置：提权必须发生在 worker 里（launcher 那条路没有超时，UAC 卡在那里界面会永久
#     停在「正在安装」），而提权子进程只做「关 + 装」，不做重启与窗口探测。
#   · 参数：新进程不继承开关，尤其是 -LogPath —— 少了它桌面应用 tail 的日志一个字都不涨。
Assert-True -Condition ($installRestartScriptText -match '\[switch\]\$AllowElevation') `
    -Message "install-and-restart script exposes an explicit elevation switch"
Assert-True -Condition ($installRestartScriptText -match '\[switch\]\$ElevatedWorker') `
    -Message "install-and-restart script exposes the short-lived elevated worker mode"
Assert-True -Condition ($installRestartScriptText -match '-Verb RunAs') `
    -Message "the elevated install must request administrator rights"
# 提权子进程只做「关 Codex + 装包」：它绝不能带上重启与窗口探测 —— 从提权进程发
# explorer.exe shell:AppsFolder 激活请求行为不确定，探测失败还会打出那套误导性结论。
Assert-True -Condition ($installRestartScriptText -match 'if \(\$ElevatedWorker\) \{[\s\S]*?Invoke-CodexInstallSteps[\s\S]*?return\s*\n\}') `
    -Message "the elevated worker branch must only run the install steps and return"
# 每个参数都要补引号后拼成单个字符串。数组直接交给 Start-Process 会在空格处截断
# （本应用的日志目录固定叫 %APPDATA%\Codex Updater\logs，那个空格每个用户都有）。
Assert-True -Condition ($installRestartScriptText -match '\$quotedElevatedArguments -join " "') `
    -Message "the elevated child's argument list must go through the quoting helper"
Assert-True -Condition (-not ($installRestartScriptText -match '-ArgumentList \$elevatedArguments')) `
    -Message "the elevated child must not be started with a bare argument array"
Assert-True -Condition ($installRestartScriptText -match '-LogPath", \$LogPath') `
    -Message "the elevated child must receive -LogPath (otherwise the desktop app tails a file that never grows)"
Assert-True -Condition ($installRestartScriptText -match "if \(\`$AllowDowngrade\) \{\s*\`$elevatedArguments \+= ""-AllowDowngrade""") `
    -Message "the elevated child must receive -AllowDowngrade when rolling back"

# 提权子进程分支必须排在「Worker started for package」（界面上的「准备安装」4%）之前。
# 排在后面的话，界面会在已经走到「正在请求管理员权限」之后又收到一条 4% 的旧阶段：
# 百分比被 Math.max 挡住不会退，措辞却跳回去了。
$elevatedBranchIndex = $installRestartScriptText.IndexOf('if ($ElevatedWorker) {')
$workerStartedIndex = $installRestartScriptText.IndexOf('Write-InstallLog ("Worker started for package:')
Assert-True -Condition ($elevatedBranchIndex -ge 0 -and $workerStartedIndex -ge 0 -and $elevatedBranchIndex -lt $workerStartedIndex) `
    -Message "the elevated worker branch must come before the 'Worker started' log line"

# 判定必须发生在关掉用户的 Codex **之前**：装不上就不该先把人家正在编辑的窗口关了。
# 只看 worker 那段（「Worker started」之后）—— 上面提权子进程分支里也有一次同样的调用，
# 拿全文件的 IndexOf 比会指到它，断言就白写了。
$workerBody = $installRestartScriptText.Substring($workerStartedIndex)
$elevationCheckIndex = $workerBody.IndexOf('Test-CodexPackageRequiresElevation -Path $resolvedPackagePath')
$installStepsCallIndex = $workerBody.IndexOf('Invoke-CodexInstallSteps -PackageName $PackageName')
Assert-True -Condition ($elevationCheckIndex -ge 0 -and $installStepsCallIndex -ge 0 -and $elevationCheckIndex -lt $installStepsCallIndex) `
    -Message "the elevation check must run before anything starts closing Codex processes"

# 兜底：探测失灵时（例如清单读不出来）Add-AppxPackage 会回 0x80073D28，
# 这条路必须能改成提权重试，而不是把生 HRESULT 交给用户。
Assert-True -Condition ($installRestartScriptText -match '0x80073D28') `
    -Message "the worker must fall back to elevation when Add-AppxPackage reports 0x80073D28 despite the check"

# ---------- 自动化必须如实报告，而不是让 worker 在后台异步失败 ----------
#
# worker 是分离进程，调用点只看它有没有被拉起来。让它在后台撞 0x80073D28，
# 自动化这边会**报成功** —— 与上面「调用方必须看子脚本的退出码」是同一个坑。
$refusalIndex = $checkScriptText.IndexOf('Test-CodexPackageRequiresElevation -Path $packagePath')
$workerInvokeIndex = $checkScriptText.IndexOf('& $installRestartScript')
Assert-True -Condition ($refusalIndex -ge 0) `
    -Message "check script must detect packages that need administrator privileges before starting the worker"
Assert-True -Condition ($refusalIndex -lt $workerInvokeIndex) `
    -Message "the refusal must happen before the detached worker is started"
Assert-True -Condition ($checkScriptText -match '-AllowElevation:\$AllowElevation') `
    -Message "check script must forward -AllowElevation so an opted-in caller still installs"
Assert-True -Condition ($checkScriptText -match '\[switch\]\$AllowElevation') `
    -Message "check script must accept -AllowElevation"

# ---------- 启动诊断：没等到窗口时不许凭空指控「加密资源搬迁 bug」 ----------
#
# 2026-10-01 的真实故障：安装本身成功，探针 30 秒没等到主窗口，界面于是断言
# 「这是官方已知的加密资源搬迁问题的特征」并让用户去跑修复脚本。而实测时间线是：
# 重启请求 21:10:24 → 21:10:30 win-cli 落盘 → 21:10:54 探针超时断言 bug →
# 21:12:35~36 cua_node 与 win-rg 才落盘（首次启动要物化约 420 MB，实测 132 秒）→
# 21:12:58 一个与应用无关的组织策略对话框弹出 → 用户 21:23 重试即恢复。
# 也就是说：断言是在没有任何证据的情况下下的，用户照着修了一遍根本不存在的问题。
#
# 更早的两次实测还证明，旧判据（拿组件状态推断原因）**正反两个方向都是错的**：
#   · 2026-09-07 那次**真的**搬迁 bug：win-cli 自己物化成功了，主窗口照样没出现；
#   · 今天这台**正常**机器的健康快照：wsl-cli = missing、PluginsMaterialized = False，
#     而 Codex 一切正常。
# 所以判定**完全不读组件状态**，只看两件事：最近有没有写入（还在准备），
# 以及有没有陈旧且最终目录没落成的 staging 残留（才是 bug）。
#
# 下面 6 条行为用例把这个矩阵钉住，第 4 条就是今天这台机器的形状 ——
# 它必须判 unknown，绝不能判成 bug。

$diagnosisFixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-diagnosis-" + [guid]::NewGuid().ToString("N"))
try {
    $bundleId = '8e5b6932251c2c1c'
    $now = Get-Date

    function New-DiagnosisHealth {
        param(
            [object[]]$Components,
            [bool]$Installed = $true
        )

        # 只造判定真正读得到的字段。刻意**不**提供 StagingCount：判定必须自己现取目录，
        # 因为延长探针 150 秒之后要重新判，快照里的旧计数已经过期。
        [pscustomobject]@{ Installed = $Installed; Components = $Components }
    }

    function New-DiagnosisComponent {
        param([string]$Name, [string]$Path)

        [pscustomobject]@{ Name = $Name; Id = $bundleId; Path = $Path; State = 'missing'; Leftovers = 0 }
    }

    # 1) 落点目录 5 秒前还在写 → 还在准备（首次启动物化运行时的形态）
    $freshBin = Join-Path $diagnosisFixtureRoot "fresh\bin"
    New-Item -ItemType Directory -Path $freshBin -Force | Out-Null
    (Get-Item -LiteralPath $freshBin).LastWriteTime = $now.AddSeconds(-5)
    $diagnosis = Get-CodexStartupDiagnosis -PackageName 'OpenAI.Codex' -Health (New-DiagnosisHealth -Components @(
            (New-DiagnosisComponent -Name 'win-cli' -Path (Join-Path $freshBin $bundleId))
        ))
    Assert-Equal 'still-preparing' $diagnosis.Verdict "a bundle dir written 5 s ago means Codex is still materializing its runtime"
    Assert-True -Condition ($diagnosis.ActivePaths.Count -eq 1) "the active path must be reported as evidence"
    Assert-True -Condition ($diagnosis.ActivePaths[0].Contains($freshBin)) `
        -Message "the evidence must point at the directory that was just written"

    # 2) 只有 staging 目录新、落点目录本身已经很久没动 → 同样是在准备。
    #    父目录的 mtime 必须显式压老，否则这条会被父目录的「新」蒙对 ——
    #    那就证明不了判据真的看了 staging（而 deep copy 的后半程恰恰只动 staging 内部）。
    $stagingBin = Join-Path $diagnosisFixtureRoot "fresh-staging\bin"
    $stagingDir = Join-Path $stagingBin ('.staging-' + $bundleId + '-aaa')
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    (Get-Item -LiteralPath $stagingBin).LastWriteTime = $now.AddSeconds(-600)
    (Get-Item -LiteralPath $stagingDir).LastWriteTime = $now.AddSeconds(-10)
    $diagnosis = Get-CodexStartupDiagnosis -PackageName 'OpenAI.Codex' -Health (New-DiagnosisHealth -Components @(
            (New-DiagnosisComponent -Name 'win-cli' -Path (Join-Path $stagingBin $bundleId))
        ))
    Assert-Equal 'still-preparing' $diagnosis.Verdict "a staging dir written 10 s ago means the copy is still in flight"
    Assert-True -Condition ($diagnosis.ActivePaths[0].Contains('.staging-')) `
        -Message "the evidence must name the staging directory, not the parent"

    # 3) 三个条件同时成立才算 bug：有 staging 残留 + 最终目录没落成 + 残留已经陈旧。
    $bugBin = Join-Path $diagnosisFixtureRoot "abandoned\bin"
    $bugStaging = Join-Path $bugBin ('.staging-' + $bundleId + '-bbb')
    New-Item -ItemType Directory -Path $bugStaging -Force | Out-Null
    foreach ($item in @($bugBin, $bugStaging)) {
        (Get-Item -LiteralPath $item).LastWriteTime = $now.AddSeconds(-3600)
    }
    $diagnosis = Get-CodexStartupDiagnosis -PackageName 'OpenAI.Codex' -Health (New-DiagnosisHealth -Components @(
            (New-DiagnosisComponent -Name 'cua_node' -Path (Join-Path $bugBin $bundleId))
        ))
    Assert-Equal 'relocation-bug' $diagnosis.Verdict "stale staging leftovers plus a missing destination is the real bug"
    Assert-True -Condition (($diagnosis.Evidence -join ' ') -match 'abandoned staging') `
        -Message "the bug verdict must cite the abandoned staging directory"
    Assert-Equal 0 $diagnosis.ActivePaths.Count "nothing was written recently, so there is no activity evidence"

    # 4) 今天这台机器的形状：什么都没在写、也没有任何残留 → **unknown**。
    #    这条是本次修复的核心：同样是「窗口没出现」，这里的答案必须是「判不出来」，
    #    而不是「就是那个 bug」。
    $healthyBin = Join-Path $diagnosisFixtureRoot "healthy\bin"
    New-Item -ItemType Directory -Path $healthyBin -Force | Out-Null
    (Get-Item -LiteralPath $healthyBin).LastWriteTime = $now.AddSeconds(-3600)
    $diagnosis = Get-CodexStartupDiagnosis -PackageName 'OpenAI.Codex' -Health (New-DiagnosisHealth -Components @(
            (New-DiagnosisComponent -Name 'win-cli' -Path (Join-Path $healthyBin $bundleId)),
            # 第二个组件整个不存在，正是今天这台机器上 wsl-cli 的样子 ——
            # 它绝不能把结论推向任何一边。
            (New-DiagnosisComponent -Name 'wsl-cli' -Path (Join-Path $diagnosisFixtureRoot "healthy\wsl\deadbeefdeadbeef"))
        ))
    Assert-Equal 'unknown' $diagnosis.Verdict "a quiet machine with a missing bundle must NOT be accused of the relocation bug"

    # 5) 拿不到信息时一律 unknown，且**绝不抛错**：这是失败路径上的诊断，抛出去会把
    #    「包已经装好了」报成崩溃。首次启动时 %LOCALAPPDATA%\OpenAI\Codex 可能整个不存在。
    $diagnosis = Get-CodexStartupDiagnosis -PackageName 'OpenAI.Codex' -Health (New-DiagnosisHealth -Components @() -Installed $false)
    Assert-Equal 'unknown' $diagnosis.Verdict "an unresolved package must not be diagnosed"
    $diagnosis = Get-CodexStartupDiagnosis -PackageName 'OpenAI.Codex' -Health (New-DiagnosisHealth -Components @(
            (New-DiagnosisComponent -Name 'win-cli' -Path (Join-Path $diagnosisFixtureRoot "does-not-exist\bin\$bundleId"))
        ))
    Assert-Equal 'unknown' $diagnosis.Verdict "a wholly missing destination with no leftovers must not be diagnosed"
    # 整个 health 对象缺失时也要能跑（内部会自己去取，取不到就 unknown）。
    $diagnosis = Get-CodexStartupDiagnosis -PackageName 'Definitely.Not.Installed' -Health $null
    Assert-Equal 'unknown' $diagnosis.Verdict "a package that cannot be resolved must not be diagnosed"

    # 6) 不变式：陈旧门槛（180 s）必须等于探针总预算（30 + 150 s）。
    #    staging 顶层目录的 LastWriteTime 只在**直接子项**被创建时更新，deep copy 的后半程
    #    一直往已存在的子树里写文件，所以它看起来可以「很久没动」。把门槛压到总预算，
    #    就保证了本次启动期间创建的 staging 永远够不到陈旧门槛。
    #    这条用例取中间那段（100 s，既过了 90 s 的活动窗口、又没到 180 s 的陈旧门槛）：
    #    正确结论是 unknown —— 不指控，而不是误判成 bug。
    $partialBin = Join-Path $diagnosisFixtureRoot "partial\bin"
    $partialStaging = Join-Path $partialBin ('.staging-' + $bundleId + '-ccc')
    New-Item -ItemType Directory -Path $partialStaging -Force | Out-Null
    (Get-Item -LiteralPath $partialBin).LastWriteTime = $now.AddSeconds(-3600)
    (Get-Item -LiteralPath $partialStaging).LastWriteTime = $now.AddSeconds(-100)
    $diagnosis = Get-CodexStartupDiagnosis -PackageName 'OpenAI.Codex' -Health (New-DiagnosisHealth -Components @(
            (New-DiagnosisComponent -Name 'cua_node' -Path (Join-Path $partialBin $bundleId))
        )) -ActivitySeconds 90 -StaleSeconds 180
    Assert-Equal 'unknown' $diagnosis.Verdict "a staging dir between the activity and stale windows must stay undiagnosed"
}
finally {
    if (Test-Path -LiteralPath $diagnosisFixtureRoot) {
        Remove-Item -LiteralPath $diagnosisFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------- 窗口清单：探针失败时桌面上到底有什么 ----------
#
# 光知道「没有主窗口」不够。2026-10-01 那次真正挡住主窗口的是一个**有属主**的模态框
# （「无法加载组织设置」），而 .NET 的 Process.MainWindowHandle 恰恰看不见有属主的窗口，
# 所以只能上 EnumWindows 自己枚举。
$inventory = Get-CodexWindowInventory -PackageName 'Definitely.Not.Installed'
Assert-True -Condition ($null -ne $inventory) `
    -Message "an unresolvable package must yield an empty inventory, not the 'could not collect' null"
Assert-Equal 0 $inventory.Count "a package that is not installed owns no windows"

# 真跑一遍 P/Invoke：拿 powershell.exe 自己当「属于该包的进程」。当前进程没有顶层窗口
# （控制台窗口归 conhost），所以期望是 0 个 —— 但这条会真正编译那段 C#、真正调一次
# EnumWindows，能证明窗口清单不是「只存在于注释里」。返回 $null 就说明收集失败了。
$inventory = Get-CodexWindowInventory -PackageName 'Windows PowerShell' -InstallLocation $PSHOME
Assert-True -Condition ($null -ne $inventory) `
    -Message "the window inventory must be collectable against a real process list (a null means Add-Type or the enum failed)"
Assert-Equal 0 $inventory.Count "powershell.exe owns no top-level window of its own"

Assert-True -Condition ($moduleText -match 'function Get-CodexStartupDiagnosis') `
    -Message "provides a startup diagnosis resolver"
Assert-True -Condition ($moduleText -match 'Get-CodexStartupDiagnosis,') `
    -Message "exports the startup diagnosis resolver"
Assert-True -Condition ($moduleText -match 'function Get-CodexWindowInventory') `
    -Message "provides a window inventory resolver"
Assert-True -Condition ($moduleText -match 'Get-CodexWindowInventory,') `
    -Message "exports the window inventory resolver"
Assert-True -Condition ($moduleText -match 'public static extern bool EnumWindows') `
    -Message "the window inventory must enumerate top-level windows via EnumWindows"
Assert-True -Condition ($moduleText -match 'Add-Type -TypeDefinition') `
    -Message "the window inventory must declare its P/Invoke surface"
# MainWindowHandle 只认「无属主且可见」的窗口，有属主的模态框一律看不见 —— 必须自己取属主。
Assert-True -Condition ($moduleText -match 'GetWindow\(IntPtr hWnd, uint uCmd\)') `
    -Message "the window inventory must read GW_OWNER itself"
# 只看 DllImport 声明这一处（注释里会提到无 W 后缀的名字，那是解释用的）。
# 无 W 的版本对**其他进程**的窗口会发 WM_GETTEXT 同步等待，目标进程卡死就把调用方一起
# 挂住 —— worker 是无人值守的隐藏进程，挂住 = 界面永久停在 working（ps.cjs 没有超时）。
Assert-True -Condition ($moduleText -match 'public static extern int GetWindowTextW\(') `
    -Message "window titles must be read with GetWindowTextW"
Assert-True -Condition (-not ($moduleText -match 'public static extern int GetWindowText\(')) `
    -Message "must not use the non-W GetWindowText (it blocks on a stuck target process)"

# ---------- 输出契约：判定行必须夹在失败行与结论之间 ----------
#
# 下面这些断言用的是**去注释**后的代码，位置全用 IndexOf 相对比较 —— 只断言「出现过」
# 挡不住真正要防的回归：把签名句挪回无条件输出的位置，字符串照样在文件里。
$healthText = Get-Content -LiteralPath (Join-Path $pluginRoot "scripts/check-codex-desktop-health.ps1") -Raw
$healthCode = ($healthText -split "`n" | Where-Object { $_.TrimStart() -notmatch '^#' }) -join "`n"

foreach ($case in @(
        @{ Name = 'install-codex-msix-and-restart.ps1'; Code = $installCode; Failure = 'WINDOW_PROBE=FAILED:'; Diagnosis = 'Write-InstallLog ("STARTUP_DIAGNOSIS={0}"'; Repair = 'Remedy: run docs/' },
        @{ Name = 'check-codex-desktop-health.ps1'; Code = $healthCode; Failure = 'Write-Host "RESULT=window-not-visible"'; Diagnosis = 'Write-Host ("STARTUP_DIAGNOSIS={0}"'; Repair = 'Run the repair script from docs/' }
    )) {
    $code = $case.Code
    $failureAt = $code.IndexOf($case.Failure)
    $diagnosisAt = $code.IndexOf($case.Diagnosis)
    $stillPreparingAt = $code.IndexOf("'still-preparing' {")
    $notBugAt = $code.IndexOf('This is NOT the encrypted-resource relocation bug')
    $bugBranchAt = $code.IndexOf("'relocation-bug' {")
    $signatureAt = $code.IndexOf('This is the signature of the official')
    $unknownAt = $code.IndexOf('No cause could be determined from the relocation-health evidence')
    $repairAt = $code.IndexOf($case.Repair)

    Assert-True -Condition ($failureAt -ge 0) -Message "$($case.Name): 找不到「窗口没出现」这一行"
    Assert-True -Condition ($diagnosisAt -gt $failureAt) `
        -Message "$($case.Name): 判定行必须紧跟在失败行之后（否则界面拿不到原因）"
    # 签名句只能在 relocation-bug 这一支里：无条件输出 = 误诊原样复现。
    Assert-True -Condition ($signatureAt -gt $bugBranchAt) `
        -Message "$($case.Name): 「就是加密资源搬迁 bug」这句必须落在 relocation-bug 分支之内"
    Assert-True -Condition ($stillPreparingAt -ge 0 -and $notBugAt -gt $stillPreparingAt -and $notBugAt -lt $bugBranchAt) `
        -Message "$($case.Name): 「这不是搬迁 bug」这句必须落在 still-preparing 分支之内"
    Assert-True -Condition ($unknownAt -gt $bugBranchAt) `
        -Message "$($case.Name): 「判不出原因」这句必须落在默认分支里（排在 relocation-bug 之后）"
    Assert-True -Condition ($repairAt -gt $bugBranchAt) `
        -Message "$($case.Name): 修复脚本提示只能出现在 relocation-bug 之后"
    Assert-True -Condition ($code -match 'if \(\$diagnosis\.Verdict -eq ''relocation-bug''\) \{\s*\r?\n\s*Write-(Host|InstallLog)') `
        -Message "$($case.Name): 修复脚本提示必须由 relocation-bug 判定把守，不能无条件写出来"
    # 窗口清单是探针失败时最有价值的一栏，必须也在这条路径上。
    Assert-True -Condition ($code -match 'Get-CodexWindowInventory -PackageName \$PackageName') `
        -Message "$($case.Name): 探针失败时必须枚举 Codex 的顶层窗口"
}

# ---------- 修复脚本与健康检查必须算出同一个 bundle ID ----------
#
# 「修复资源副本」按钮走 docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1，
# 健康检查走本模块的 Get-BundleIdText —— 同一个算法在仓库里有两份实现，两份必须
# **逐字节等价**：修复脚本物化到哪个目录，健康检查就要去哪个目录找。差一个字符，
# 修完的组件在面板上依然是「缺失」。
#
# 它们曾经不等价：修复脚本用的是 [SHA256]::HashData() + [Convert]::ToHexString()，
# 两个都是 .NET 5+ / pwsh 7 才有、.NET Framework 4.8 里没有的 API。而桌面端
# （desktop/electron/ps.cjs:32）只用 powershell.exe 5.1 调它。Get-BundleId 是
# Materialize-Bundle 的第一行，于是整份脚本在写任何文件之前就抛「找不到方法 HashData」——
# 点「修复资源副本」什么都不会发生、也不留任何痕迹，看起来就像按钮坏了。
# 2026-10-02 用户在真机上遇到的正是这个：.codex\bin\wsl 下连一个 .repair-* 都没有，
# 目录 mtime 还停在手工用 pwsh 7 修过一次的那天。
#
# 所以下面把两份实现都**真的执行一遍**：既是「两份算法必须一致」的契约，也是一道
# 「不许再用 5.1 跑不动的 API」的闸门 —— 换回 HashData 就会在这里红。
#
# 两组函数都是各自文件里的私有实现（Get-Sha256Hex / Get-BundleIdText 不在
# Export-ModuleMember 列表里，修复脚本则是一跑就干活、不能整份 dot-source），
# 所以要用 AST 解析器只把函数定义抠出来。不用正则是因为本文件上面已经记过教训：
# 函数体里的 `}` 会让非贪婪匹配切出半截函数（MissingEndCurlyBrace）。
function Get-FunctionDefinitionText {
    param([string]$Path, [string[]]$Names)

    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
    Assert-Equal 0 @($parseErrors).Count "「$Path」必须能被 PowerShell 解析"

    $definitions = $ast.FindAll(
        { param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)

    $texts = @()
    foreach ($name in $Names) {
        $match = @($definitions | Where-Object { $_.Name -eq $name })
        Assert-Equal 1 $match.Count "「$Path」里必须恰好有一个 $name"
        $texts += $match[0].Extent.Text
    }
    return $texts
}

$bundleFixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-bundle-id-test-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path (Join-Path $bundleFixtureRoot "bin") -Force | Out-Null
    # 内容写死成纯 ASCII 字节。期望值 6b702184007a271f 是用一份与 PowerShell 无关的独立
    # 实现、按 docs/codex-desktop-encrypted-copy-fix/README.md 第 6 节的算法算出来的。
    # 字节一变期望值就必须重算 —— 不要照着实际输出改，那就白测了。
    [System.IO.File]::WriteAllBytes((Join-Path $bundleFixtureRoot "alpha.exe"), [System.Text.Encoding]::ASCII.GetBytes("codex-alpha"))
    [System.IO.File]::WriteAllBytes((Join-Path $bundleFixtureRoot "bin\node.exe"), [System.Text.Encoding]::ASCII.GetBytes("cafe"))

    # 顺序即算法的一部分，不能排序；带一个斜杠用来钉住路径归一化 —— 两份实现一个用
    # -replace、一个用 .Replace，那都只该影响「去哪里取文件」，不该影响参与哈希的字符串。
    $bundleRelPaths = @('alpha.exe', 'bin/node.exe')

    $repairScriptPath = Join-Path (Split-Path -Parent (Split-Path -Parent $pluginRoot)) `
        "docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1"
    Assert-True -Condition (Test-Path -LiteralPath $repairScriptPath) `
        -Message "修复脚本必须在 docs/ 下（install.ps1 与 sync-ps-scripts.mjs 都从那里取）"

    Invoke-Expression ((Get-FunctionDefinitionText -Path $repairScriptPath -Names @('Get-Sha256Lower', 'Get-BundleId')) -join "`n")
    Invoke-Expression ((Get-FunctionDefinitionText -Path $modulePath -Names @('Get-Sha256Hex', 'Get-BundleIdText')) -join "`n")

    $idFromHealthCheck = Get-BundleIdText -Root $bundleFixtureRoot -RelativePaths $bundleRelPaths
    $idFromRepairScript = Get-BundleId -Root $bundleFixtureRoot -RelativePaths $bundleRelPaths

    Assert-Equal "6b702184007a271f" $idFromHealthCheck "bundle ID 与独立实现算出的黄金值一致（算法本身被钉住）"
    Assert-Equal $idFromHealthCheck $idFromRepairScript "修复脚本必须物化到健康检查去找的那个目录名"
    Assert-True -Condition ($idFromRepairScript -match '\A[0-9a-f]{16}\z') -Message "bundle ID 是 16 位小写十六进制"
}
finally {
    Remove-Item -LiteralPath $bundleFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "All CodexStoreUpdater tests passed."
