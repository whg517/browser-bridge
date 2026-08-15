# install.ps1 — build browser-bridge and register the Chrome native messaging
# host for the current Windows user.
#
# Running from an automation agent as SYSTEM/elevated? The current user's
# LOCALAPPDATA/HKCU won't be the desktop user's, so pass -TargetUser <account>
# to install into that user's profile + hive instead (issue #57). Running as
# SYSTEM without -TargetUser is refused with a clear message rather than
# silently installing to the wrong profile.

[CmdletBinding()]
param(
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId = 'mkjjlmjbcljpcfkfadfmhblmmddkdihf',
    # Chrome Web Store-assigned ID. Store users run the published build, whose ID
    # is fixed by the store and differs from the pinned unpacked ID above. The
    # host manifest trusts BOTH by default; passing -ExtensionId narrows trust to
    # just that one id.
    [ValidatePattern('^[a-p]{32}$')]
    [string]$StoreExtensionId = 'dgccjfjjilfpkbdllclmkiicajndkfcd',
    # Install for (or uninstall from) a DIFFERENT user than the one running this
    # script. Needed when an automation agent runs as SYSTEM/elevated but Chrome
    # runs as the desktop user: without this, LOCALAPPDATA and HKCU resolve to
    # the WRONG profile and Chrome never sees the host (permanent NOT_CONNECTED,
    # see issue #57). Pass the desktop account name, e.g. -TargetUser Administrator.
    [string]$TargetUser = '',
    # Remove exactly what this installer places (binary, native-host manifest,
    # HKCU registry key, run.lock) and leave Chrome and the extension untouched.
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Project root. In a release zip the installer sits at the archive root next to
# extension\ (Root == Here); in the source tree it lives in install\ with the
# project one level up (Root == Here\..). Detect by which layout is beside us.
if ((Test-Path -LiteralPath (Join-Path $Here 'extension')) -or
    (Test-Path -LiteralPath (Join-Path $Here 'Cargo.toml'))) {
    $Root = $Here
} else {
    $Root = Split-Path -Parent $Here
}
$HostName = 'com.browser_bridge.host'
$BinaryName = 'browser-bridge.exe'

# ---- resolve which user we install FOR ------------------------------------
# Default: the user running this script (its LOCALAPPDATA + HKCU). With
# -TargetUser we install into another user's profile + registry hive instead —
# the SYSTEM/elevated-automation case (issue #57).
$currentIsSystem = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).IsSystem
$TargetSid = $null
$TargetProfile = $null

if ($TargetUser) {
    $sid = ((New-Object System.Security.Principal.NTAccount($TargetUser)).Translate(
            [System.Security.Principal.SecurityIdentifier])).Value
    $profileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
    $profilePath = (Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
    if (-not $profilePath) { $profilePath = Join-Path 'C:\Users' $TargetUser }
    $TargetSid = $sid
    $TargetProfile = $profilePath
    $InstallDir = Join-Path $profilePath 'AppData\Local\browser-bridge'
    $registryRoot = "Registry::HKEY_USERS\$sid\Software\Google\Chrome\NativeMessagingHosts"
    Write-Host "[install] target user: $TargetUser  (SID $sid)"
    Write-Host "[install] target profile: $profilePath"
} else {
    if ($currentIsSystem) {
        throw @"
Running as SYSTEM without -TargetUser. LOCALAPPDATA and HKCU point to the SYSTEM
profile ($env:LOCALAPPDATA), not the desktop user's, so Chrome (running as that
user) would never see the host — a permanent NOT_CONNECTED. Either re-run this
script AS the desktop user, or pass the desktop account explicitly:
    -TargetUser <account>     e.g.  -TargetUser Administrator
"@
    }
    $InstallDir = Join-Path $env:LOCALAPPDATA 'browser-bridge'
    $registryRoot = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
}
$registryPath = "$registryRoot\$HostName"

# Run a registry action against the target user's hive. When installing for
# another user we write under HKEY_USERS\<SID>; if that hive isn't already
# mounted (user logged off) we reg-load NTUSER.DAT and unload afterwards. For
# the default (current user) this just runs the action against HKCU.
function Invoke-InTargetHive {
    param([scriptblock]$Action)
    if (-not $TargetSid) { & $Action; return }
    $mounted = Test-Path -LiteralPath "Registry::HKEY_USERS\$TargetSid"
    $loaded = $false
    if (-not $mounted) {
        $ntuser = Join-Path $TargetProfile 'NTUSER.DAT'
        if (-not (Test-Path -LiteralPath $ntuser)) { throw "cannot find $ntuser (wrong profile path?)" }
        & reg.exe load "HKU\$TargetSid" $ntuser | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "reg load failed for $TargetSid; run this script AS $TargetUser instead" }
        $loaded = $true
    }
    try { & $Action }
    finally {
        if ($loaded) { [gc]::Collect(); Start-Sleep -Milliseconds 200; & reg.exe unload "HKU\$TargetSid" | Out-Null }
    }
}

if ($Uninstall) {
    Write-Host '[uninstall] removing browser-bridge artifacts'

    # Registry key this installer created (mirrors the Set-Item below). Runs
    # against the target user's hive when -TargetUser was given.
    Invoke-InTargetHive -Action {
        if (Test-Path -LiteralPath $registryPath) {
            Remove-Item -LiteralPath $registryPath -Force
            Write-Host "[uninstall] removed registry key: $registryPath"
        } else {
            Write-Host "[uninstall] not present: $registryPath"
        }
    }

    # Files placed under $InstallDir: the manifest, the binary, and the run.lock
    # the server writes there (LockFile::path() uses LOCALAPPDATA on Windows).
    # Exact paths only — no wildcards, no recursive delete.
    $targets = @(
        (Join-Path $InstallDir "$HostName.json"),
        (Join-Path $InstallDir $BinaryName),
        (Join-Path $InstallDir 'run.lock')
    )
    # A running browser-bridge holds its own image, so removing the binary can
    # fail with access-denied. With $ErrorActionPreference = 'Stop' that aborted
    # the whole uninstall - after the registry key and manifest were already
    # gone, leaving a half-removed install that Chrome can no longer launch and
    # a re-run cannot tidy. Report each target and keep going instead.
    $stuck = @()
    foreach ($target in $targets) {
        if (-not (Test-Path -LiteralPath $target)) {
            Write-Host "[uninstall] not present: $target"
            continue
        }
        Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $target) {
            $stuck += $target
            Write-Host "[uninstall] still in use, left in place: $target"
        } else {
            Write-Host "[uninstall] removed: $target"
        }
    }

    # Binaries retired by an upgrade (see the retirement dance in the install
    # path). Same suffix filter as the install-time sweep, still scoped to this
    # directory - without this an uninstall could leave a stray .old behind and
    # then decline to remove the now "non-empty" directory below.
    foreach ($stale in @(Get-ChildItem -LiteralPath $InstallDir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "$BinaryName.old.*" -or $_.Name -like "$BinaryName.tmp.*" })) {
        Remove-Item -LiteralPath $stale.FullName -Force -ErrorAction SilentlyContinue
        # Report what actually happened. A retired binary stays locked while a
        # process started from it is alive, and claiming to have removed it
        # would leave the user puzzling over why the directory survives below.
        if (Test-Path -LiteralPath $stale.FullName) {
            Write-Host "[uninstall] still in use, left in place: $($stale.FullName)"
        } else {
            Write-Host "[uninstall] removed: $($stale.FullName)"
        }
    }

    # Drop $InstallDir only when it is now empty (never recursive).
    if ((Test-Path -LiteralPath $InstallDir) -and
        -not (Get-ChildItem -LiteralPath $InstallDir -Force)) {
        Remove-Item -LiteralPath $InstallDir -Force
        Write-Host "[uninstall] removed empty dir: $InstallDir"
    }

    if ($stuck.Count -gt 0) {
        Write-Host ''
        Write-Host '[uninstall] Some files were still in use and remain on disk:'
        foreach ($t in $stuck) { Write-Host "    $t" }
        Write-Host '    Quit your MCP client and close Chrome, then re-run this script to'
        Write-Host '    finish. The registration is already removed, so Chrome will not'
        Write-Host '    start browser-bridge again in the meantime.'
    }

    Write-Host '[uninstall] done. Host artifacts removed. Two things this script does NOT touch:'
    Write-Host '  1. The extension - remove it yourself at chrome://extensions (Browser Bridge).'
    Write-Host '  2. Any MCP client server entry pointing at the (now-deleted) binary:'
    Write-Host '     - Claude Code : claude mcp remove browser-bridge'
    Write-Host '     - Codex       : codex mcp remove browser-bridge'
    Write-Host '     - OpenClaw    : openclaw mcp remove browser-bridge'
    Write-Host '     - Claude Desktop / Cursor / Windsurf / Cline : delete the "browser-bridge" entry from mcpServers'
    return
}

function Find-Cargo {
    $command = Get-Command cargo.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $userCargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path -LiteralPath $userCargo) { return $userCargo }
    throw 'cargo.exe not found. Install Rust from https://rustup.rs and run this installer again.'
}

if (Test-Path -LiteralPath (Join-Path $Root 'Cargo.toml')) {
    $cargo = Find-Cargo
    Write-Host "[install] source mode - building with $cargo"
    & $cargo build --release --manifest-path (Join-Path $Root 'Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
    $binarySource = Join-Path $Root "target\release\$BinaryName"

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) {
        throw 'npm.cmd not found. Install Node.js from https://nodejs.org and run this installer again.'
    }
    Write-Host '[install] building extension bundle (esbuild)...'
    $extensionDir = Join-Path $Root 'extension'
    if (-not (Test-Path -LiteralPath (Join-Path $extensionDir 'node_modules'))) {
        & $npm.Source --prefix $extensionDir install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    }
    & $npm.Source --prefix $extensionDir run build
    if ($LASTEXITCODE -ne 0) { throw "extension build failed with exit code $LASTEXITCODE" }
    $distDir = Join-Path $extensionDir 'dist'
} else {
    Write-Host '[install] prebuilt mode - using shipped binary and extension'
    $binarySource = Join-Path $Root $BinaryName
    $distDir = Join-Path $Root 'extension\dist'
    if (-not (Test-Path -LiteralPath $binarySource)) { throw "prebuilt binary not found at $binarySource" }
    if (-not (Test-Path -LiteralPath $distDir)) { throw "extension bundle not found at $distDir" }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$installedBinary = Join-Path $InstallDir $BinaryName
$temporaryBinary = "$installedBinary.tmp.$PID"

# Sweep leftovers from earlier runs (see the retirement dance below) before we
# add our own. Scoped to this directory and to the two suffixes this installer
# creates - never a wildcard delete of the install dir.
foreach ($stale in @(Get-ChildItem -LiteralPath $InstallDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$BinaryName.old.*" -or $_.Name -like "$BinaryName.tmp.*" })) {
    Remove-Item -LiteralPath $stale.FullName -Force -ErrorAction SilentlyContinue
}

try {
    Copy-Item -LiteralPath $binarySource -Destination $temporaryBinary -Force

    try {
        # Fast path, and the only path on a fresh install or when the user has
        # closed everything: drop the new image straight onto the old one.
        Move-Item -LiteralPath $temporaryBinary -Destination $installedBinary -Force
    } catch {
        # Upgrading is the normal case, and on an upgrade the old binary is
        # usually RUNNING: the MCP client holds one (the server) and an open
        # Chrome holds another (the native host, spawned via the manifest).
        # Windows refuses to overwrite a running image, so the move above fails
        # with ERROR_ALREADY_EXISTS and every upgrade used to abort here (#133).
        #
        # Windows does allow RENAMING a running image, though - the lock is on
        # the path, not the bytes. So retire the old file out of the way and
        # move the new one into the path it just vacated. The live processes
        # keep running from the renamed file and exit on their own.
        $retired = "$installedBinary.old.$PID"
        try {
            Move-Item -LiteralPath $installedBinary -Destination $retired -Force
        } catch {
            throw @"
Cannot replace $installedBinary - it is in use and could not be moved aside.
Close the programs still holding it, then run this installer again:
  1. Quit your MCP client (Claude Code, Codex, Claude Desktop, ...), which runs
     browser-bridge as its MCP server.
  2. Close Google Chrome, which spawns browser-bridge as its native messaging host.
Underlying error: $($_.Exception.Message)
"@
        }
        try {
            Move-Item -LiteralPath $temporaryBinary -Destination $installedBinary -Force
        } catch {
            # The old image is out of the way and the new one did not land, so
            # the host manifest now points at a path with no file - a worse state
            # than the failure this whole branch exists to avoid. Put it back.
            Move-Item -LiteralPath $retired -Destination $installedBinary -Force -ErrorAction SilentlyContinue
            throw
        }
        # Best effort, and it usually fails: the extension holds its native-host
        # port open for as long as Chrome runs (the wake-alarm backstop), so a
        # process started from the retired image is still alive and Windows keeps
        # that file locked. Harmless - the sweep at the top of a later run, once
        # Chrome has been closed, collects it.
        Remove-Item -LiteralPath $retired -Force -ErrorAction SilentlyContinue
    }
} finally {
    # Never leave a half-installed .tmp behind, on any exit path.
    if (Test-Path -LiteralPath $temporaryBinary) {
        Remove-Item -LiteralPath $temporaryBinary -Force -ErrorAction SilentlyContinue
    }
}
Write-Host "[install] binary installed at $installedBinary"

# Chrome appends the calling extension origin on Windows. The executable uses
# that argument to select native-host mode, so no wrapper script is required.
# allowed_origins lists every extension ID the host will accept a connection
# from. By default trust both the store-published ID and the pinned unpacked ID;
# an explicit -ExtensionId narrows trust to just that one.
$trustedIds = if ($PSBoundParameters.ContainsKey('ExtensionId')) {
    @($ExtensionId)
} else {
    @($ExtensionId, $StoreExtensionId)
}
$allowedOrigins = @($trustedIds | ForEach-Object { "chrome-extension://$_/" })
$manifestPath = Join-Path $InstallDir "$HostName.json"
$manifest = [ordered]@{
    name = $HostName
    description = 'Browser Bridge native messaging host'
    path = $installedBinary
    type = 'stdio'
    allowed_origins = $allowedOrigins
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
    $manifestPath,
    $manifestJson,
    [System.Text.UTF8Encoding]::new($false)
)

Invoke-InTargetHive -Action {
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -Path $registryPath -Value $manifestPath
}
Write-Host "[install] native host registered at $registryPath"
Write-Host "[install] manifest written to $manifestPath"

# Backslashes must be doubled inside JSON/TOML double-quoted strings.
$escapedBinary = $installedBinary -replace '\\', '\\'

Write-Host ''
Write-Host 'NEXT STEPS'
Write-Host "1. Open chrome://extensions, enable Developer mode, and load unpacked: $distDir"
Write-Host '2. Register the MCP server with your client. Config below already has the'
Write-Host "   absolute path filled in ($installedBinary) - just paste:"
Write-Host ''
Write-Host '   - Claude Code (CLI):'
Write-Host "       claude mcp add browser-bridge -- `"$installedBinary`""
Write-Host ''
Write-Host '   - Codex (CLI, or %USERPROFILE%\.codex\config.toml):'
Write-Host "       codex mcp add browser-bridge -- `"$installedBinary`""
Write-Host '       [mcp_servers.browser-bridge]'
Write-Host "       command = `"$escapedBinary`""
Write-Host '       args = []'
Write-Host ''
Write-Host '   - OpenClaw (CLI):'
Write-Host "       openclaw mcp add browser-bridge --command `"$installedBinary`""
Write-Host ''
Write-Host '   - Hermes Agent (CLI):'
Write-Host "       hermes mcp add browser-bridge --command `"$installedBinary`""
Write-Host ''
Write-Host '   - Claude Desktop / Cursor / Windsurf / Cline (mcpServers JSON):'
Write-Host "       `"browser-bridge`": { `"command`": `"$escapedBinary`", `"args`": [] }"
Write-Host ''
Write-Host '   Every MCP host then auto-discovers the tools via tools/list.'
Write-Host '   Per-agent config paths + verify commands: docs\integrations.md'
Write-Host '3. Restart Chrome, then ask your agent to list browser tabs.'
if ($TargetUser) {
    Write-Host ''
    Write-Host "NOTE: installed for $TargetUser. Start your MCP client (and thus the"
    Write-Host '      browser-bridge server) AS THAT USER so its run.lock lands in the same'
    Write-Host '      profile Chrome reads. If the server must run under a different account,'
    Write-Host "      set BB_LOCK_DIR to a shared path for BOTH the server and Chrome."
}
Write-Host ''
Write-Host 'To uninstall later: powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall'
Write-Host '   (add -TargetUser <account> if you installed for another user)'
