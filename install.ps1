# install.ps1 — build browser-bridge and register the Chrome native messaging
# host for the current Windows user.

[CmdletBinding()]
param(
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId = 'mkjjlmjbcljpcfkfadfmhblmmddkdihf',
    # Remove exactly what this installer places (binary, native-host manifest,
    # HKCU registry key, run.lock) and leave Chrome and the extension untouched.
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostName = 'com.browser_bridge.host'
$InstallDir = Join-Path $env:LOCALAPPDATA 'browser-bridge'
$BinaryName = 'browser-bridge.exe'

if ($Uninstall) {
    Write-Host '[uninstall] removing browser-bridge artifacts'

    # Registry key this installer created (mirrors the Set-Item below).
    $registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
    if (Test-Path -LiteralPath $registryPath) {
        Remove-Item -LiteralPath $registryPath -Force
        Write-Host "[uninstall] removed registry key: $registryPath"
    } else {
        Write-Host "[uninstall] not present: $registryPath"
    }

    # Files placed under $InstallDir: the manifest, the binary, and the run.lock
    # the server writes there (LockFile::path() uses LOCALAPPDATA on Windows).
    # Exact paths only — no wildcards, no recursive delete.
    $targets = @(
        (Join-Path $InstallDir "$HostName.json"),
        (Join-Path $InstallDir $BinaryName),
        (Join-Path $InstallDir 'run.lock')
    )
    foreach ($target in $targets) {
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Force
            Write-Host "[uninstall] removed: $target"
        } else {
            Write-Host "[uninstall] not present: $target"
        }
    }

    # Drop $InstallDir only when it is now empty (never recursive).
    if ((Test-Path -LiteralPath $InstallDir) -and
        -not (Get-ChildItem -LiteralPath $InstallDir -Force)) {
        Remove-Item -LiteralPath $InstallDir -Force
        Write-Host "[uninstall] removed empty dir: $InstallDir"
    }

    Write-Host '[uninstall] done. Chrome and the loaded extension were left untouched;'
    Write-Host '[uninstall] remove the unpacked extension yourself via chrome://extensions if desired.'
    return
}

function Find-Cargo {
    $command = Get-Command cargo.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $userCargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path -LiteralPath $userCargo) { return $userCargo }
    throw 'cargo.exe not found. Install Rust from https://rustup.rs and run this installer again.'
}

if (Test-Path -LiteralPath (Join-Path $Here 'Cargo.toml')) {
    $cargo = Find-Cargo
    Write-Host "[install] source mode - building with $cargo"
    & $cargo build --release --manifest-path (Join-Path $Here 'Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
    $binarySource = Join-Path $Here "target\release\$BinaryName"

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) {
        throw 'npm.cmd not found. Install Node.js from https://nodejs.org and run this installer again.'
    }
    Write-Host '[install] building extension bundle (esbuild)...'
    $extensionDir = Join-Path $Here 'extension'
    if (-not (Test-Path -LiteralPath (Join-Path $extensionDir 'node_modules'))) {
        & $npm.Source --prefix $extensionDir install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    }
    & $npm.Source --prefix $extensionDir run build
    if ($LASTEXITCODE -ne 0) { throw "extension build failed with exit code $LASTEXITCODE" }
    $distDir = Join-Path $extensionDir 'dist'
} else {
    Write-Host '[install] prebuilt mode - using shipped binary and extension'
    $binarySource = Join-Path $Here $BinaryName
    $distDir = Join-Path $Here 'extension\dist'
    if (-not (Test-Path -LiteralPath $binarySource)) { throw "prebuilt binary not found at $binarySource" }
    if (-not (Test-Path -LiteralPath $distDir)) { throw "extension bundle not found at $distDir" }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$installedBinary = Join-Path $InstallDir $BinaryName
$temporaryBinary = "$installedBinary.tmp.$PID"
Copy-Item -LiteralPath $binarySource -Destination $temporaryBinary -Force
Move-Item -LiteralPath $temporaryBinary -Destination $installedBinary -Force
Write-Host "[install] binary installed at $installedBinary"

# Chrome appends the calling extension origin on Windows. The executable uses
# that argument to select native-host mode, so no wrapper script is required.
$manifestPath = Join-Path $InstallDir "$HostName.json"
$manifest = [ordered]@{
    name = $HostName
    description = 'Browser Bridge native messaging host'
    path = $installedBinary
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
    $manifestPath,
    $manifestJson,
    [System.Text.UTF8Encoding]::new($false)
)

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath
Write-Host "[install] native host registered at $registryPath"
Write-Host "[install] manifest written to $manifestPath"

Write-Host ''
Write-Host 'NEXT STEPS'
Write-Host "1. Open chrome://extensions, enable Developer mode, and load unpacked: $distDir"
Write-Host "2. Configure your MCP client to run: $installedBinary"
Write-Host '3. Restart Chrome, then ask your MCP client to list browser tabs.'
