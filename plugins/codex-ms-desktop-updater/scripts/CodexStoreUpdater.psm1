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
    }
}

function Invoke-RgAdguardQuery {
    param(
        [string]$StoreUrl = "https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK",
        [ValidateSet("url", "ProductId", "PackageFamilyName", "CategoryId")]
        [string]$Type = "url",
        [string]$Ring = "Retail",
        [string]$Language = "",
        [string]$BaseUrl = "https://store.rg-adguard.net"
    )

    $bodyParts = [ordered]@{
        type = $Type
        url = $StoreUrl
        ring = $Ring
        lang = $Language
    }

    $body = ($bodyParts.GetEnumerator() | ForEach-Object {
        "{0}={1}" -f [System.Net.WebUtility]::UrlEncode($_.Key), [System.Net.WebUtility]::UrlEncode([string]$_.Value)
    }) -join "&"

    $response = Invoke-WebRequest `
        -Uri "$BaseUrl/api/GetFiles" `
        -Method Post `
        -ContentType "application/x-www-form-urlencoded" `
        -Body $body `
        -Headers @{ "User-Agent" = "Codex-MS-Desktop-Updater/0.1"; "Referer" = "$BaseUrl/" } `
        -UseBasicParsing

    $response.Content
}

function Save-CodexPackage {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Package,

        [Parameter(Mandatory = $true)]
        [string]$DownloadDirectory
    )

    if (-not $Package.FileName.StartsWith("OpenAI.Codex_", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to download unexpected package '$($Package.FileName)'."
    }

    New-Item -ItemType Directory -Path $DownloadDirectory -Force | Out-Null
    $targetPath = Join-Path $DownloadDirectory $Package.FileName

    if (Test-Path -LiteralPath $targetPath) {
        return (Resolve-Path -LiteralPath $targetPath).Path
    }

    $partialPath = "$targetPath.partial"
    Invoke-WebRequest -Uri $Package.Uri -OutFile $partialPath -UseBasicParsing
    Move-Item -LiteralPath $partialPath -Destination $targetPath -Force

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
    Get-InstalledCodexPackageInfo, `
    Install-CodexPackage, `
    Invoke-RgAdguardQuery, `
    Remove-InstalledCodexPackageFiles, `
    Save-CodexPackage, `
    Select-BestCodexPackage, `
    Test-IsUpdateAvailable
