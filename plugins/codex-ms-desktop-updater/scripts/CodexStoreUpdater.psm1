$script:PackageExtensions = @(".msixbundle", ".msix", ".appxbundle", ".appx")

function Get-CodexPackageMetadata {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FileName,

        [Parameter(Mandatory = $true)]
        [string]$Uri
    )

    $pattern = '^(?<name>.+?)_(?<version>\d+(?:\.\d+){1,3})_(?<arch>[^_.]+)(?:_[^.]*)?\.(?<ext>msixbundle|msix|appxbundle|appx)$'
    $match = [regex]::Match($FileName, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
        return $null
    }

    [pscustomobject]@{
        Name = $match.Groups["name"].Value
        Version = [version]$match.Groups["version"].Value
        Architecture = $match.Groups["arch"].Value.ToLowerInvariant()
        Extension = $match.Groups["ext"].Value.ToLowerInvariant()
        FileName = $FileName
        Uri = $Uri
    }
}

function Get-FileNameFromLink {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Href,

        [string]$Text
    )

    $rawText = ""
    if ($null -ne $Text) {
        $rawText = $Text
    }
    $decodedText = [System.Net.WebUtility]::HtmlDecode(([regex]::Replace($rawText, "<[^>]+>", ""))).Trim()
    foreach ($extension in $script:PackageExtensions) {
        if ($decodedText.EndsWith($extension, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $decodedText
        }
    }

    try {
        $uri = [uri]$Href
        return [System.Net.WebUtility]::UrlDecode(($uri.Segments[-1]))
    }
    catch {
        return [System.Net.WebUtility]::UrlDecode((Split-Path -Leaf $Href))
    }
}

function ConvertFrom-RgAdguardHtml {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Html,

        [string]$PackageName = "OpenAI.Codex"
    )

    $anchorPattern = '<a\s+[^>]*href\s*=\s*["''](?<href>[^"'']+)["''][^>]*>(?<text>.*?)</a>'
    $matches = [regex]::Matches($Html, $anchorPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $packages = foreach ($match in $matches) {
        $href = [System.Net.WebUtility]::HtmlDecode($match.Groups["href"].Value)
        $fileName = Get-FileNameFromLink -Href $href -Text $match.Groups["text"].Value
        if ([string]::IsNullOrWhiteSpace($fileName)) {
            continue
        }

        $hasPackageExtension = $false
        foreach ($extension in $script:PackageExtensions) {
            if ($fileName.EndsWith($extension, [System.StringComparison]::OrdinalIgnoreCase)) {
                $hasPackageExtension = $true
                break
            }
        }
        if (-not $hasPackageExtension) {
            continue
        }

        if (-not $fileName.StartsWith("$PackageName`_", [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }

        Get-CodexPackageMetadata -FileName $fileName -Uri $href
    }

    @($packages | Where-Object { $null -ne $_ })
}

function Get-ArchitectureRank {
    param(
        [string]$PackageArchitecture,
        [string]$PreferredArchitecture
    )

    if ($PackageArchitecture -eq $PreferredArchitecture.ToLowerInvariant()) {
        return 3
    }
    if ($PackageArchitecture -eq "neutral") {
        return 2
    }
    if ([string]::IsNullOrWhiteSpace($PackageArchitecture)) {
        return 1
    }
    return 0
}

function Get-ExtensionRank {
    param([string]$Extension)

    switch ($Extension.ToLowerInvariant()) {
        "msixbundle" { 4; break }
        "msix" { 3; break }
        "appxbundle" { 2; break }
        "appx" { 1; break }
        default { 0 }
    }
}

function Select-BestCodexPackage {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Packages,

        [string]$Architecture = "x64"
    )

    $preferred = $Architecture.ToLowerInvariant()
    $candidates = @($Packages | Where-Object {
        $_.Architecture -eq $preferred -or $_.Architecture -eq "neutral"
    })

    if ($candidates.Count -eq 0) {
        $candidates = @($Packages)
    }

    $candidates |
        Sort-Object `
            @{ Expression = { $_.Version }; Descending = $true },
            @{ Expression = { Get-ArchitectureRank -PackageArchitecture $_.Architecture -PreferredArchitecture $preferred }; Descending = $true },
            @{ Expression = { Get-ExtensionRank -Extension $_.Extension }; Descending = $true } |
        Select-Object -First 1
}

function Test-IsUpdateAvailable {
    param(
        [version]$InstalledVersion,
        [Parameter(Mandatory = $true)]
        [version]$AvailableVersion
    )

    if ($null -eq $InstalledVersion) {
        return $true
    }

    return $AvailableVersion -gt $InstalledVersion
}

function ConvertTo-CodexPluginVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$VersionText
    )

    if ($VersionText -notmatch '^\d+(?:\.\d+){1,3}$') {
        throw "Plugin version '$VersionText' must be numeric SemVer-compatible text such as 0.2.0."
    }

    [version]$VersionText
}

function Test-IsPluginUpdateAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstalledVersion,

        [Parameter(Mandatory = $true)]
        [string]$AvailableVersion
    )

    $installed = ConvertTo-CodexPluginVersion -VersionText $InstalledVersion
    $available = ConvertTo-CodexPluginVersion -VersionText $AvailableVersion

    return $available -gt $installed
}

function ConvertFrom-AppxPackageText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    $name = [regex]::Match($Text, '(?m)^\s*Name\s*:\s*(?<value>.+?)\s*$').Groups["value"].Value
    $versionText = [regex]::Match($Text, '(?m)^\s*Version\s*:\s*(?<value>\d+(?:\.\d+){1,3})\s*$').Groups["value"].Value
    $architecture = [regex]::Match($Text, '(?m)^\s*Architecture\s*:\s*(?<value>.+?)\s*$').Groups["value"].Value

    if ([string]::IsNullOrWhiteSpace($versionText)) {
        return $null
    }

    [pscustomobject]@{
        Name = $name
        Version = [version]$versionText
        Architecture = $architecture
    }
}

function Get-InstalledCodexPackageInfo {
    param([string]$PackageName = "OpenAI.Codex")

    $package = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if ($null -eq $package) {
        return $null
    }

    [pscustomobject]@{
        Name = $package.Name
        Version = [version]$package.Version
        Architecture = $package.Architecture
        PackageFullName = $package.PackageFullName
        PackageFamilyName = $package.PackageFamilyName
        InstallLocation = $package.InstallLocation
    }
}

# ---------- Desktop health detection ----------
#
# The Microsoft Store (MSIX) build relocates its bundled resources into the
# user cache at first launch. On some versions the relocation silently fails
# (encrypted-copy bug): the app keeps running but the main window never
# appears. These helpers let callers detect that state without launching the
# app, by checking whether the versioned bundle directories exist.

# Bundle id algorithm (shared with docs/codex-desktop-encrypted-copy-fix):
# SHA256( concat over descriptors of (relPath + NUL + sha256hex + NUL) ),
# then take the first 16 hex chars. Works on Windows PowerShell 5.1 too.
function Get-Sha256Hex([string]$Path) {
    $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return $hash.Hash.ToLowerInvariant()
}

function Get-BundleIdText([string]$Root, [string[]]$RelativePaths) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($rp in $RelativePaths) {
        $file = Join-Path $Root ($rp.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $file)) { throw "Source file missing for bundle id: $file" }
        [void]$builder.Append($rp)
        [void]$builder.Append([char]0)
        [void]$builder.Append((Get-Sha256Hex $file))
        [void]$builder.Append([char]0)
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($builder.ToString())
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha.ComputeHash($bytes)
    }
    finally {
        $sha.Dispose()
    }
    return [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant().Substring(0, 16)
}

function Get-CodexRelocationHealth {
    param([string]$PackageName = 'OpenAI.Codex')

    $pkg = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if ($null -eq $pkg) {
        return [pscustomobject]@{
            Installed = $false
            Version = $null
            Overall = 'not-installed'
            Components = @()
        }
    }

    $res = Join-Path $pkg.InstallLocation 'app\resources'
    $localRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex'
    $codexHome = Join-Path $env:USERPROFILE '.codex'

    $specs = @(
        [pscustomobject]@{ Name = 'win-cli'; Root = $res; Rel = @('codex.exe', 'codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe'); Dest = (Join-Path $localRoot 'bin') }
        [pscustomobject]@{ Name = 'win-rg'; Root = $res; Rel = @('rg.exe'); Dest = (Join-Path $localRoot 'bin') }
        [pscustomobject]@{ Name = 'wsl-cli'; Root = $res; Rel = @('codex', 'codex-code-mode-host'); Dest = (Join-Path $codexHome 'bin\wsl') }
        [pscustomobject]@{ Name = 'wsl-rg'; Root = $res; Rel = @('rg'); Dest = (Join-Path $codexHome 'bin\wsl') }
        [pscustomobject]@{ Name = 'cua_node'; Root = (Join-Path $res 'cua_node'); Rel = @('manifest.json', 'bin/node.exe', 'bin/node_repl.exe'); Dest = (Join-Path $localRoot 'runtimes\cua_node') }
    )

    $components = foreach ($spec in $specs) {
        $id = $null
        try {
            $id = Get-BundleIdText -Root $spec.Root -RelativePaths $spec.Rel
        }
        catch {
            [pscustomobject]@{ Name = $spec.Name; Id = ''; State = 'error'; Path = ''; StagingCount = 0; Note = $_.Exception.Message }
            continue
        }
        $destDir = Join-Path $spec.Dest $id
        $present = Test-Path -LiteralPath $destDir
        $stagingCount = 0
        if (Test-Path -LiteralPath $spec.Dest) {
            $stagingCount = @(
                Get-ChildItem -LiteralPath $spec.Dest -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -like ('.staging-' + $id + '-*') -or $_.Name -like ('.repair-' + $id + '-*') }
            ).Count
        }
        $state = if ($present) { 'ok' }
                 elseif ($stagingCount -gt 0) { 'partial' }
                 else { 'missing' }
        [pscustomobject]@{ Name = $spec.Name; Id = $id; State = $state; Path = $destDir; StagingCount = $stagingCount; Note = '' }
    }
    $components = @($components)

    $pluginsRoot = Join-Path $codexHome '.tmp\bundled-marketplaces\openai-bundled'
    $pluginsMaterialized = Test-Path -LiteralPath (Join-Path $pluginsRoot '.materialization-key')

    $bad = @($components | Where-Object { $_.State -ne 'ok' })
    $overall = if ($bad.Count -eq 0) { 'ok' } else { 'degraded' }

    [pscustomobject]@{
        Installed = $true
        Name = $pkg.Name
        PackageFullName = $pkg.PackageFullName
        PackageFamilyName = $pkg.PackageFamilyName
        InstallLocation = $pkg.InstallLocation
        Version = [string]$pkg.Version
        Overall = $overall
        Components = $components
        PluginsMaterialized = $pluginsMaterialized
    }
}

# 找出属于某个 MSIX 包的所有进程。
#
# 为什么不能按字面量 "*\WindowsApps\<包名>_*" 匹配：MSIX 的安装位置并不保证叫
# WindowsApps，也不保证在系统盘（可以装到别的盘、别的路径）。写死这个目录名，
# 在那些机器上就永远匹配不到进程 —— 表现是「Codex 明明在跑，探测却说没有」，
# 于是把正常状态报成故障，甚至反过来把该关掉的进程留着去锁文件。
# 安装位置一律从 Get-AppxPackage 的 InstallLocation 现取（与修复脚本同一套做法）。
function Get-CodexPackageProcess {
    param(
        [string]$PackageName = 'OpenAI.Codex',

        # 调用方已经解析过包时可以传进来，省一次 Get-AppxPackage。
        [string]$InstallLocation
    )

    if ([string]::IsNullOrWhiteSpace($InstallLocation)) {
        $package = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue |
            Sort-Object Version -Descending |
            Select-Object -First 1
        if ($package) { $InstallLocation = $package.InstallLocation }
    }

    $prefix = $null
    if (-not [string]::IsNullOrWhiteSpace($InstallLocation)) {
        $prefix = $InstallLocation.TrimEnd('\') + '\'
    }

    @(
        Get-Process -ErrorAction SilentlyContinue | Where-Object {
            # .Path 对受保护 / 提权进程会抛「拒绝访问」。调用方普遍带着
            # $ErrorActionPreference='Stop'，一个这样的进程就能把整个探测打断，
            # 所以逐个兜住：取不到路径的进程直接跳过，不让它影响其余进程的判断。
            $path = $null
            try { $path = $_.Path } catch { return $false }
            if ([string]::IsNullOrWhiteSpace($path)) { return $false }

            if ($prefix) {
                return $path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
            }

            # 包信息取不到时的退路：MSIX 的包目录名形如
            # <Name>_<Version>_<Arch>__<PublisherId>，按包名匹配。
            return $path -like ("*\WindowsApps\$PackageName`_*")
        }
    )
}

# Launch (optional) and wait for a visible main window. Returns $true when any
# process of the package owns a main window within the timeout.
function Test-CodexDesktopWindowUp {
    param(
        [string]$PackageName = 'OpenAI.Codex',
        [string]$AppUserModelId,
        [int]$Seconds = 20,
        [switch]$Launch
    )

    if ($Launch -and $AppUserModelId) {
        $alreadyRunning = @(Get-CodexPackageProcess -PackageName $PackageName)
        if ($alreadyRunning.Count -eq 0) {
            Start-Process -FilePath 'explorer.exe' -ArgumentList ("shell:AppsFolder\{0}" -f $AppUserModelId)
        }
    }

    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $withWindow = @(Get-CodexPackageProcess -PackageName $PackageName | Where-Object { $_.MainWindowHandle -ne 0 })
        if ($withWindow.Count -gt 0) { return $true }
        Start-Sleep -Milliseconds 750
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Get-CodexAppUserModelId {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageFamilyName,

        # 兜底值必须是 AppxManifest.xml 里真实的 Application Id（当前为 "App"）。
        # 调用方都从 manifest 现取，只有 manifest 读不到时才落到这里 —— 正是最需要
        # 它正确的时刻：默认值写错的话，启动请求发出去也不会有人接，表现为「点了没反应」。
        [string]$AppId = "App"
    )

    if ([string]::IsNullOrWhiteSpace($PackageFamilyName)) {
        throw "PackageFamilyName is required."
    }
    if ([string]::IsNullOrWhiteSpace($AppId)) {
        throw "AppId is required."
    }

    "{0}!{1}" -f $PackageFamilyName, $AppId
}

function Invoke-RgAdguardQuery {
    param(
        [string]$StoreUrl = "https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK",
        [ValidateSet("url", "ProductId", "PackageFamilyName", "CategoryId")]
        [string]$Type = "url",
        [string]$Ring = "Retail",
        [string]$Language = "",
        [string]$BaseUrl = "https://store.rg-adguard.net",
        [int]$MaxAttempts = 3
    )

    if ($MaxAttempts -lt 1) {
        throw "MaxAttempts must be >= 1."
    }

    $bodyParts = [ordered]@{
        type = $Type
        url = $StoreUrl
        ring = $Ring
        lang = $Language
    }

    $body = ($bodyParts.GetEnumerator() | ForEach-Object {
        "{0}={1}" -f [System.Net.WebUtility]::UrlEncode($_.Key), [System.Net.WebUtility]::UrlEncode([string]$_.Value)
    }) -join "&"

    $endpoint = "$BaseUrl/api/GetFiles"
    $httpFallbackEndpoint = $null
    if ($endpoint.StartsWith("https://", [System.StringComparison]::OrdinalIgnoreCase)) {
        $httpFallbackEndpoint = "http://" + $endpoint.Substring("https://".Length)
    }
    $headers = @{ "User-Agent" = "Codex-MS-Desktop-Updater/0.1"; "Referer" = "$BaseUrl/" }

    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            # PowerShell 5.1 Invoke-WebRequest can fail on some networks/endpoints with TLS issues.
            # Prefer TLS 1.2 when available, and retry before falling back to curl.exe.
            try {
                [System.Net.ServicePointManager]::SecurityProtocol = `
                    [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.ServicePointManager]::SecurityProtocol
            }
            catch {
                # Ignore if the runtime doesn't support these enum values.
            }

            $response = Invoke-WebRequest `
                -Uri $endpoint `
                -Method Post `
                -ContentType "application/x-www-form-urlencoded" `
                -Body $body `
                -Headers $headers `
                -UseBasicParsing

            return $response.Content
        }
        catch {
            $lastError = $_

            # If HTTPS is failing due to TLS interception/credential issues, retry once over HTTP.
            if ($null -ne $httpFallbackEndpoint) {
                try {
                    $response = Invoke-WebRequest `
                        -Uri $httpFallbackEndpoint `
                        -Method Post `
                        -ContentType "application/x-www-form-urlencoded" `
                        -Body $body `
                        -Headers @{ "User-Agent" = $headers["User-Agent"]; "Referer" = ($httpFallbackEndpoint -replace "/api/GetFiles$", "/") } `
                        -UseBasicParsing

                    return $response.Content
                }
                catch {
                    $lastError = $_
                }
            }

            # Fallback: use curl.exe (different HTTP stack than Invoke-WebRequest on Windows).
            # This often succeeds when .NET Framework WebRequest fails with "unexpected error on a receive".
            $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
            if ($null -ne $curl) {
                try {
                    $curlEndpoint = $endpoint
                    $curlReferer = $headers["Referer"]
                    if ($null -ne $httpFallbackEndpoint) {
                        $curlEndpoint = $httpFallbackEndpoint
                        $curlReferer = ($httpFallbackEndpoint -replace "/api/GetFiles$", "/")
                    }
                    $curlArgs = @(
                        "-sS", "-L", "--fail",
                        "--noproxy", "*",
                        "-X", "POST",
                        "-H", "Content-Type: application/x-www-form-urlencoded",
                        "-H", ("User-Agent: {0}" -f $headers["User-Agent"]),
                        "-H", ("Referer: {0}" -f $curlReferer),
                        "--data", $body,
                        $curlEndpoint
                    )
                    $content = & $curl.Source @curlArgs
                    if ($LASTEXITCODE -ne 0) {
                        throw "curl.exe exited with code $LASTEXITCODE"
                    }
                    return $content
                }
                catch {
                    $lastError = $_
                }
            }

            if ($attempt -lt $MaxAttempts) {
                Start-Sleep -Seconds ([Math]::Min(5, $attempt))
            }
        }
    }

    throw $lastError
}

function Save-CodexPackage {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Package,

        [Parameter(Mandatory = $true)]
        [string]$DownloadDirectory,

        [int]$MaxAttempts = 3
    )

    if ($MaxAttempts -lt 1) {
        throw "MaxAttempts must be >= 1."
    }
    if (-not $Package.FileName.StartsWith("OpenAI.Codex_", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to download unexpected package '$($Package.FileName)'."
    }

    New-Item -ItemType Directory -Path $DownloadDirectory -Force | Out-Null
    $targetPath = Join-Path $DownloadDirectory $Package.FileName

    if (Test-Path -LiteralPath $targetPath) {
        return (Resolve-Path -LiteralPath $targetPath).Path
    }

    $partialPath = "$targetPath.partial"

    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            try {
                [System.Net.ServicePointManager]::SecurityProtocol = `
                    [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.ServicePointManager]::SecurityProtocol
            }
            catch { }

            # If we already have a partial download, prefer curl resume support.
            $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
            if ((Test-Path -LiteralPath $partialPath) -and ($null -ne $curl)) {
                $curlArgs = @(
                    "-sS", "-L", "--fail",
                    "--noproxy", "*",
                    "-C", "-",
                    "-o", $partialPath,
                    $Package.Uri
                )
                & $curl.Source @curlArgs
                if ($LASTEXITCODE -ne 0) {
                    throw "curl.exe exited with code $LASTEXITCODE"
                }
            }
            else {
                Invoke-WebRequest -Uri $Package.Uri -OutFile $partialPath -UseBasicParsing
            }

            Move-Item -LiteralPath $partialPath -Destination $targetPath -Force
            break
        }
        catch {
            $lastError = $_

            $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
            if ($null -ne $curl) {
                try {
                    if (Test-Path -LiteralPath $partialPath) {
                        # Keep partials when possible so we can resume; remove only when we are about to restart cleanly.
                    }
                    $curlArgs = @(
                        "-sS", "-L", "--fail",
                        "--noproxy", "*",
                        "-o", $partialPath,
                        $Package.Uri
                    )
                    & $curl.Source @curlArgs
                    if ($LASTEXITCODE -ne 0) {
                        throw "curl.exe exited with code $LASTEXITCODE"
                    }
                    Move-Item -LiteralPath $partialPath -Destination $targetPath -Force
                    break
                }
                catch {
                    $lastError = $_
                }
            }

            if ($attempt -lt $MaxAttempts) {
                Start-Sleep -Seconds ([Math]::Min(10, $attempt * 2))
            }
        }
    }

    if (-not (Test-Path -LiteralPath $targetPath)) {
        throw $lastError
    }

    (Resolve-Path -LiteralPath $targetPath).Path
}

function Get-CachedCodexPackages {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DownloadDirectory,

        [string]$PackageName = "OpenAI.Codex",

        [version]$InstalledVersion
    )

    if (-not (Test-Path -LiteralPath $DownloadDirectory)) {
        return @()
    }

    $packages = @()
    $files = Get-ChildItem -LiteralPath $DownloadDirectory -File -ErrorAction SilentlyContinue
    foreach ($file in $files) {
        if (-not $file.Name.StartsWith("$PackageName`_", [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }

        $metadata = Get-CodexPackageMetadata -FileName $file.Name -Uri $file.FullName
        if ($null -eq $metadata) {
            continue
        }

        if ($metadata.Name -ne $PackageName) {
            continue
        }

        # Relation 是给界面判断「这一行能不能回退」用的。判断留在这一侧，因为这里是
        # 唯一用 [version] 比较版本号的地方 —— 在 JS 里再写一份比较函数，两边迟早会
        # 对「26.9 和 26.10 谁大」这种问题给出不同答案。
        $relation = "unknown"
        if ($null -ne $InstalledVersion) {
            if ($metadata.Version -eq $InstalledVersion) {
                $relation = "installed"
            }
            elseif ($metadata.Version -lt $InstalledVersion) {
                $relation = "older"
            }
            else {
                $relation = "newer"
            }
        }

        $packages += [pscustomobject]@{
            Name = $metadata.Name
            Version = $metadata.Version
            Architecture = $metadata.Architecture
            Extension = $metadata.Extension
            SizeBytes = $file.Length
            LastWriteTime = $file.LastWriteTime
            Relation = $relation
            FullName = $file.FullName
        }
    }

    @($packages | Sort-Object -Property @{ Expression = { $_.Version }; Descending = $true })
}

# 清理下载缓存里「已经被取代」的安装包。
#
# 只删到 KeepCount 为止，而不是把不高于已安装版本的包全删掉 —— 这条策略是回退功能的
# 地基。以前是「版本 <= 已安装版本的都删」，删掉的恰好是用户正在用、且已知能用的那一版
# 的安装包；而 rg-adguard 只发最新版（三个 ring 都只返回同一个版本），删掉就再也下不回来，
# 于是「更新完发现有问题想回去」永远无解。
#
# 为什么下限是 2 而不是 1：新装上的那一版的安装包，作用是**下一次**更新时的回退目标。
# 只留 1 个（= 只留刚装上的那个），下次更新完就没有可退的版本，功能等于不存在。
#
# 版本高于已安装版本的文件不在管辖范围内：那是「已下载、还没装」的更新包。
function Remove-SupersededCodexPackageFiles {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DownloadDirectory,

        [version]$InstalledVersion,

        [string]$PackageName = "OpenAI.Codex",

        [int]$KeepCount = 2
    )

    if ($null -eq $InstalledVersion) {
        return @()
    }

    if ($KeepCount -lt 0) {
        throw "KeepCount must be >= 0."
    }

    $candidates = @(
        Get-CachedCodexPackages `
            -DownloadDirectory $DownloadDirectory `
            -PackageName $PackageName `
            -InstalledVersion $InstalledVersion |
            Where-Object { $_.Version -le $InstalledVersion } |
            Sort-Object -Property @{ Expression = { $_.Version }; Descending = $true }
    )

    $removedPaths = @()
    foreach ($candidate in ($candidates | Select-Object -Skip $KeepCount)) {
        Remove-Item -LiteralPath $candidate.FullName -Force
        $removedPaths += $candidate.FullName
    }

    $removedPaths
}

function Install-CodexPackage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        # 降级（回退到旧版本）必须显式声明：不加 -ForceUpdateFromAnyVersion 时 Windows
        # 会拒绝安装版本号低于已安装版本。做成开关而不是默认开启，是为了让「一键更新」
        # 那条路保持原来的严格行为，也便于从日志里判断这一跑到底是不是降级。
        [switch]$AllowDowngrade
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Package path does not exist: $Path"
    }

    if ($AllowDowngrade) {
        Add-AppxPackage -Path $Path -ForceUpdateFromAnyVersion
    }
    else {
        Add-AppxPackage -Path $Path
    }
}

# 在一个**已经打开**的 zip 里找清单、判断它有没有声明以 localSystem 运行的打包服务。
#
# 会递归一层：.msixbundle 里面装的是若干个完整的 .msix（**嵌套的 zip**），不是一批名字
# 叫 AppxManifest.xml 的条目 —— 只枚举外层的话，bundle 的清单一条都看不见，于是
# 「不用提权」被报出来，装的时候再撞 0x80073D28。这条不是理论风险：Select-BestCodexPackage
# 的 Get-ExtensionRank 把 msixbundle 排在 msix 之上，商店一旦提供 bundle 就优先选它。
function Test-CodexArchiveRequiresElevation {
    param(
        [Parameter(Mandatory = $true)]
        $Archive,

        [int]$Depth = 0
    )

    foreach ($entry in $Archive.Entries) {
        if ($entry.FullName -notmatch '(?i)(^|/)AppxManifest\.xml$') {
            continue
        }

        $reader = $null
        try {
            $reader = [System.IO.StreamReader]::new($entry.Open())
            if ($reader.ReadToEnd() -match 'Category\s*=\s*"windows\.service"') {
                return $true
            }
        }
        catch {
            # 单个条目读不出来不该让整个判断失败，继续看别的条目。
        }
        finally {
            if ($null -ne $reader) { $reader.Dispose() }
        }
    }

    # 一层就够：bundle 里装的是 .msix，而 .msix 里不会再有 .msix。
    # 加 Depth 只是不让畸形包把这里变成无底递归。
    if ($Depth -ge 1) {
        return $false
    }

    foreach ($entry in $Archive.Entries) {
        if ($entry.FullName -notmatch '(?i)\.(msix|appx)$') {
            continue
        }

        $innerStream = $null
        $innerArchive = $null
        try {
            $innerStream = $entry.Open()
            $innerArchive = [System.IO.Compression.ZipArchive]::new($innerStream)
            if (Test-CodexArchiveRequiresElevation -Archive $innerArchive -Depth ($Depth + 1)) {
                return $true
            }
        }
        catch {
        }
        finally {
            if ($null -ne $innerArchive) { $innerArchive.Dispose() }
            if ($null -ne $innerStream) { $innerStream.Dispose() }
        }
    }

    return $false
}

# 判断一个安装包是否必须由管理员权限安装。
#
# 新版 Codex 的清单里声明了一个以 localSystem 运行的打包服务，Windows 于是在
# Add-AppxPackage 那一步回 0x80073D28（「该程序包安装失败，因为需要管理员权限」），
# 非提权根本装不上。提前读包内清单把这件事看出来，调用方才有机会在**关掉用户的
# Codex 之前**决定是提权还是如实拒绝。
#
# 认的是 Category 属性值，不是元素名（<desktop6:Extension ...>）：windows.service 是
# 架构规定好的 Category 取值，而 desktop6 只是当前碰巧用了哪个命名空间前缀 —— 将来
# 换成 desktop7，认前缀的写法会一声不吭地失效，表现就是「又回去报 0x80073D28」。
#
# 读不出来一律返回 $false（失败要开放）：探测不准的后果应该是退回到今天的行为
# （Add-AppxPackage 自己把真实错误报出来，install-codex-msix-and-restart.ps1 里还有一条
# 「认出 0x80073D28 就改为提权重试」的兜底），而不是把一个合法安装包挡在门外。
function Test-CodexPackageRequiresElevation {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    try {
        # 5.1 下 [System.IO.Compression.ZipFile] 不是自动加载的：少了这一句，
        # 下面那行抛「Unable to find type」，而失败要开放会把异常吞掉 —— 于是
        # 每个包都被判成「不用提权」，功能一声不吭地失效。
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    }
    catch {
        return $false
    }

    try {
        return (Test-CodexArchiveRequiresElevation -Archive $archive)
    }
    catch {
        return $false
    }
    finally {
        # 一定要关：worker 判完之后还要在**同一个进程里**用 Add-AppxPackage 打开这个文件，
        # 句柄留着不放可能让安装本身失败。
        $archive.Dispose()
    }
}

Export-ModuleMember -Function `
    ConvertFrom-AppxPackageText, `
    ConvertFrom-RgAdguardHtml, `
    ConvertTo-CodexPluginVersion, `
    Get-CachedCodexPackages, `
    Get-CodexPackageMetadata, `
    Get-CodexAppUserModelId, `
    Get-CodexPackageProcess, `
    Get-CodexRelocationHealth, `
    Get-InstalledCodexPackageInfo, `
    Install-CodexPackage, `
    Invoke-RgAdguardQuery, `
    Remove-SupersededCodexPackageFiles, `
    Save-CodexPackage, `
    Select-BestCodexPackage, `
    Test-CodexDesktopWindowUp, `
    Test-CodexPackageRequiresElevation, `
    Test-IsPluginUpdateAvailable, `
    Test-IsUpdateAvailable
