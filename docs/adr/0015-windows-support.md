# ADR-0015: Support Running and Installing Locally on Windows

- Status: Accepted
- Date: 2026-07-13

## Background

The original implementation relied on Unix file permissions, `/dev/urandom`,
POSIX signals, and the macOS Native Messaging manifest directory, so it could
not be compiled or installed on Windows.

## Decision

1. On Windows the lock file is placed at
   `%LOCALAPPDATA%\browser-bridge\run.lock`, and the random token is generated
   by `BCryptGenRandom`.
2. Use the Win32 process API to detect and terminate the old MCP Server,
   preserving the new-session takeover semantics.
3. The Chrome Native Messaging manifest points directly at
   `browser-bridge.exe`. On Windows, Chrome appends the caller's
   `chrome-extension://` origin to the command line, and the program uses this
   to enter native-host mode; the explicit `--native-host` is still kept for
   testing and the Unix wrapper.
4. `install.ps1` places the manifest into `%LOCALAPPDATA%\browser-bridge` and
   registers the absolute path under the current user's
   `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser_bridge.host`.
   Installation does not require administrator privileges.
5. Windows `rename` does not overwrite an existing file, so the stale target is
   deleted before writing the new lock file. The temporary file is fully
   written and flushed; if the Native Host happens to read between the delete
   and the rename, the extension recovers via the existing two-second reconnect
   mechanism.

## Consequences

- The Rust backend can be compiled and run natively on Windows.
- Windows users can run `install.ps1` from source to complete a local
  installation.
- A prebuilt Windows release package has not yet been added to the release
  workflow; the current release still only publishes the macOS Apple Silicon
  package.
- Edge is not within the scope of support.
