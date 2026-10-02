<#
================================================================================
repair-codex-desktop-bundles.ps1
================================================================================
Purpose
    Workaround for the OpenAI Codex Desktop (Microsoft Store / MSIX) startup bug
    where the app fails to relocate its encrypted bundled resources
    (Codex CLI, ripgrep, WSL helpers, cua_node runtime) into the user cache.

Background
    MSIX resources under "C:\Program Files\WindowsApps\..." carry the Windows
    "Encrypted" file attribute. The Electron app copies them to a plain user
    directory at first launch using Node's fs.copyFileSync, which fails with
    errno=-4094 / code=UNKNOWN for such files. The app's own fallback only
    triggers on errno=6000, so it never runs. Result: relocation fails, the
    startup bootstrap is blocked, and the main window never appears even
    though child processes stay alive.

    The workaround materializes the missing bundles by byte-stream copy
    (reading the encrypted source and writing plain destinations), which
    succeeds and produces identical content.

Scope / safety
    * Only writes under %LOCALAPPDATA%\OpenAI\Codex and %USERPROFILE%\.codex.
    * NEVER modifies anything under C:\Program Files\WindowsApps (no ACL/owner
      /content changes).
    * Uses staging dir + per-file SHA-256 verification + atomic rename.
    * Idempotent: for a healthy cache it prints SKIP and does nothing.
    * If an outdated bundle dir exists it is renamed to *.pre-repair-<ts>
      instead of being deleted.

Usage
    powershell -NoProfile -ExecutionPolicy Bypass -File repair-codex-desktop-bundles.ps1
    Must run on Windows PowerShell 5.1 as well as pwsh 7+: the desktop app
    always invokes it through powershell.exe (5.1 / .NET Framework 4.8), so
    no API newer than .NET Framework 4.8 may be used here.

    The script detects the currently installed OpenAI.Codex package, computes
    the five bundle IDs for THAT version, and materializes whatever is
    missing/mismatched. Run it again after any future Store update.

Exit / output
    Prints per-bundle status: OK / SKIP / moved stale. A failure is thrown,
    printed as "ERROR: ..." and exits with code 1.
================================================================================
#>

[CmdletBinding()]
param(
    [string]$LogFile = ""
)

$ErrorActionPreference = 'Stop'
$progressPreference = 'SilentlyContinue'

# ---------- helpers ----------

function Get-CodexPackage {
    $p = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
    if ($null -eq $p) { throw 'OpenAI.Codex package not found.' }
    return $p
}

function Get-Sha256Lower([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-Encrypted([string]$Path) {
    $a = [System.IO.File]::GetAttributes($Path)
    return (($a -band [System.IO.FileAttributes]::Encrypted) -ne 0)
}

# Bundle ID algorithm (same as the upstream community repair guide):
# SHA256( concat over descriptors of (relPath + NUL + sha256hex + NUL) ), first 16 hex chars.
function Get-BundleId([string]$Root, [string[]]$RelativePaths) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($rp in $RelativePaths) {
        $file = Join-Path $Root ($rp -replace '/', '\')
        if (-not (Test-Path -LiteralPath $file)) { throw "Source file missing for bundle id: $file" }
        [void]$builder.Append($rp)
        [void]$builder.Append([char]0)
        [void]$builder.Append((Get-Sha256Lower $file))
        [void]$builder.Append([char]0)
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($builder.ToString())
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hashBytes = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    return [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant().Substring(0, 16)
}

# Byte-stream copy that bypasses the encrypted-copy bug.
function Copy-DecryptedFile([string]$Source, [string]$Destination) {
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent)) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
    if (Test-Path -LiteralPath $Destination) { throw "Destination already exists: $Destination" }
    $in = [System.IO.File]::Open($Source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        $out = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $in.CopyTo($out, 1048576); $out.Flush($true) } finally { $out.Dispose() }
    }
    finally { $in.Dispose() }
}

# Recursive byte-stream tree copy (preserves empty dirs).
function Copy-TreeDecrypted([string]$SrcRoot, [string]$DstRoot) {
    if (Test-Path -LiteralPath $DstRoot) { throw "Dest root already exists: $DstRoot" }
    [System.IO.Directory]::CreateDirectory($DstRoot) | Out-Null
    $entries = [System.IO.Directory]::EnumerateFileSystemEntries($SrcRoot, '*', [System.IO.SearchOption]::AllDirectories)
    foreach ($e in $entries) {
        $rel = $e.Substring($SrcRoot.Length).TrimStart('\', '/')
        $target = Join-Path $DstRoot $rel
        if ([System.IO.Directory]::Exists($e)) { [System.IO.Directory]::CreateDirectory($target) | Out-Null }
        elseif ([System.IO.File]::Exists($e)) { Copy-DecryptedFile -Source $e -Destination $target }
    }
}

function Test-SetMatch([string]$SrcRoot, [string]$DstRoot, [string[]]$Rel) {
    if (-not (Test-Path -LiteralPath $DstRoot)) { return $false }
    foreach ($r in $Rel) {
        $sp = Join-Path $SrcRoot $r
        $dp = Join-Path $DstRoot $r
        if (-not (Test-Path -LiteralPath $dp)) { return $false }
        if ((Get-Item -LiteralPath $sp).Length -ne (Get-Item -LiteralPath $dp).Length) { return $false }
        if ((Get-Sha256Lower $sp) -ne (Get-Sha256Lower $dp)) { return $false }
        if (Test-Encrypted $dp) { return $false }
    }
    return $true
}

function Test-TreeMatch([string]$SrcRoot, [string]$DstRoot) {
    if (-not (Test-Path -LiteralPath $DstRoot)) { return $false }
    $srcFiles = @([System.IO.Directory]::EnumerateFiles($SrcRoot, '*', [System.IO.SearchOption]::AllDirectories))
    $dstFiles = @([System.IO.Directory]::EnumerateFiles($DstRoot, '*', [System.IO.SearchOption]::AllDirectories))
    if ($srcFiles.Count -ne $dstFiles.Count) { return $false }
    foreach ($sf in $srcFiles) {
        $rel = $sf.Substring($SrcRoot.Length).TrimStart('\', '/')
        $df = Join-Path $DstRoot $rel
        if (-not (Test-Path -LiteralPath $df)) { return $false }
        if ((Get-Item -LiteralPath $sf).Length -ne (Get-Item -LiteralPath $df).Length) { return $false }
        if ((Get-Sha256Lower $sf) -ne (Get-Sha256Lower $df)) { return $false }
        if (Test-Encrypted $df) { return $false }
    }
    return $true
}

function Write-Log([string]$Msg) {
    Write-Host $Msg
    if ($LogFile) { Add-Content -LiteralPath $LogFile -Value $Msg }
}

# ---------- core materialization ----------

function Materialize-Bundle {
    param(
        [string]$Name,
        [string]$SrcRoot,          # root that rel paths are relative to / tree root
        [string[]]$RelForId,       # descriptors used to compute the bundle id
        [string]$DestParent,       # parent dir that will contain <id>
        [switch]$TreeCopy,         # copy entire SrcRoot tree instead of the rel files
        [string[]]$RelForCopy = $RelForId
    )

    # compute id
    $id = Get-BundleId -Root $SrcRoot -RelativePaths $RelForId
    $finalDir = Join-Path $DestParent $id

    $healthy = if ($TreeCopy) { Test-TreeMatch -SrcRoot $SrcRoot -DstRoot $finalDir }
               else { Test-SetMatch -SrcRoot $SrcRoot -DstRoot $finalDir -Rel $RelForCopy }

    if ($healthy) { Write-Log "[$Name] SKIP (already valid): $finalDir"; return }

    if (Test-Path -LiteralPath $finalDir) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = "$finalDir.pre-repair-$stamp"
        Rename-Item -LiteralPath $finalDir -NewName (Split-Path -Leaf $backup)
        Write-Log "[$Name] moved stale -> $backup"
    }

    if (-not (Test-Path -LiteralPath $DestParent)) { [System.IO.Directory]::CreateDirectory($DestParent) | Out-Null }

    $staging = Join-Path $DestParent ('.repair-' + $id + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    if ($TreeCopy) {
        Copy-TreeDecrypted -SrcRoot $SrcRoot -DstRoot $staging
        if (-not (Test-TreeMatch -SrcRoot $SrcRoot -DstRoot $staging)) { throw "[$Name] staging verify FAILED" }
    }
    else {
        foreach ($r in $RelForCopy) { Copy-DecryptedFile -Source (Join-Path $SrcRoot $r) -Destination (Join-Path $staging $r) }
        if (-not (Test-SetMatch -SrcRoot $SrcRoot -DstRoot $staging -Rel $RelForCopy)) { throw "[$Name] staging verify FAILED" }
    }

    Rename-Item -LiteralPath $staging -NewName $id
    $finalHealthy = if ($TreeCopy) { Test-TreeMatch -SrcRoot $SrcRoot -DstRoot $finalDir }
                    else { Test-SetMatch -SrcRoot $SrcRoot -DstRoot $finalDir -Rel $RelForCopy }
    if (-not $finalHealthy) { throw "[$Name] final verify FAILED" }
    Write-Log "[$Name] OK -> $finalDir"
}

# ---------- main ----------

try {
    $pkg = Get-CodexPackage
    Write-Log ("Package : {0}" -f $pkg.PackageFullName)
    Write-Log ("Version : {0}" -f $pkg.Version)
    Write-Log ("Install : {0}" -f $pkg.InstallLocation)

    $res        = Join-Path $pkg.InstallLocation 'app\resources'
    $localRoot  = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex'
    $codexHome  = Join-Path $env:USERPROFILE '.codex'
    $wslBin     = Join-Path $codexHome 'bin\wsl'

    # stop the app so files are not locked / app does not race the copy
    $stopped = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($pkg.InstallLocation, [System.StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($p in $stopped) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($stopped.Count -gt 0) { Write-Log ("Stopped {0} running ChatGPT.exe process(es)." -f $stopped.Count) }
    Start-Sleep -Milliseconds 800

    # bundle inventory. Rel list order matters for the bundle id computation.
    Materialize-Bundle -Name 'win-cli'  -SrcRoot $res       -RelForId @('codex.exe','codex-code-mode-host.exe','codex-windows-sandbox-setup.exe','codex-command-runner.exe') -DestParent (Join-Path $localRoot 'bin')
    Materialize-Bundle -Name 'win-rg'   -SrcRoot $res       -RelForId @('rg.exe') -DestParent (Join-Path $localRoot 'bin')
    Materialize-Bundle -Name 'wsl-cli'  -SrcRoot $res       -RelForId @('codex','codex-code-mode-host') -DestParent $wslBin
    Materialize-Bundle -Name 'wsl-rg'   -SrcRoot $res       -RelForId @('rg') -DestParent $wslBin
    Materialize-Bundle -Name 'cua_node' -SrcRoot (Join-Path $res 'cua_node') -RelForId @('manifest.json','bin/node.exe','bin/node_repl.exe') -DestParent (Join-Path $localRoot 'runtimes\cua_node') -TreeCopy

    Write-Log 'ALL_DONE'
}
catch {
    Write-Log ("ERROR: {0}" -f $_.Exception.Message)
    exit 1
}
