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
        $alreadyRunning = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ("*\WindowsApps\$PackageName`_*") })
        if ($alreadyRunning.Count -eq 0) {
            Start-Process -FilePath 'explorer.exe' -ArgumentList ("shell:AppsFolder\{0}" -f $AppUserModelId)
        }
    }

    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $withWindow = @(
            Get-Process -ErrorAction SilentlyContinue |
                Where-Object { $_.Path -like ("*\WindowsApps\$PackageName`_*") -and $_.MainWindowHandle -ne 0 }
        )
        if ($withWindow.Count -gt 0) { return $true }
        Start-Sleep -Milliseconds 750
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Get-CodexAppUserModelId {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageFamilyName,

        [string]$AppId = "Codex"
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

function Remove-InstalledCodexPackageFiles {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DownloadDirectory,

        [version]$InstalledVersion,

        [string]$PackageName = "OpenAI.Codex"
    )

    if ($null -eq $InstalledVersion) {
        return @()
    }

    if (-not (Test-Path -LiteralPath $DownloadDirectory)) {
        return @()
    }

    $removedPaths = @()
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

        if ($metadata.Version -le $InstalledVersion) {
            $removedPaths += $file.FullName
            Remove-Item -LiteralPath $file.FullName -Force
        }
    }

    $removedPaths
}

function Install-CodexPackage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Package path does not exist: $Path"
    }

    Add-AppxPackage -Path $Path
}

Export-ModuleMember -Function `
    ConvertFrom-AppxPackageText, `
    ConvertFrom-RgAdguardHtml, `
    ConvertTo-CodexPluginVersion, `
    Get-CodexPackageMetadata, `
    Get-CodexAppUserModelId, `
    Get-CodexRelocationHealth, `
    Get-InstalledCodexPackageInfo, `
    Install-CodexPackage, `
    Invoke-RgAdguardQuery, `
    Remove-InstalledCodexPackageFiles, `
    Save-CodexPackage, `
    Select-BestCodexPackage, `
    Test-CodexDesktopWindowUp, `
    Test-IsPluginUpdateAvailable, `
    Test-IsUpdateAvailable
