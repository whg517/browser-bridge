# ADR-0016: Support Dual Run Modes for Linux and WSL

- Status: Accepted
- Date: 2026-07-13

## Context

The original Linux implementation reused the install directory and lock-file
paths from macOS, and the release workflow only produced macOS Apple Silicon
packages. WSL additionally has two deployment topologies at once — Windows
Chrome and a WSLg Linux browser — and mixing binaries, manifests, or lock files
across them prevents Native Messaging from connecting.

## Decision

1. The Linux lock file is placed preferentially at
   `$XDG_RUNTIME_DIR/browser-bridge/run.lock`, with directory permissions of
   `0700`; when a runtime dir is missing, it falls back in order to
   `$XDG_CACHE_HOME`, `~/.cache`, and a UID-isolated temporary directory. The
   lock file itself stays `0600`.
2. Linux installs follow XDG: the binary is installed by default to
   `${XDG_DATA_HOME:-$HOME/.local/share}/browser-bridge`, and the Native
   Messaging manifests for Google Chrome and Chromium are written into their
   respective XDG config directories.
3. `install.sh` supports `--browser chrome|chromium|both`, defaulting to
   auto-detection; `--skip-extension-build` lets you reuse an already-built
   `extension/dist`.
4. WSL uses two explicit topologies:
   - Windows Chrome: the WSL MCP client launches the Windows-installed `.exe`
     via interop.
   - WSLg Linux Chrome/Chromium: all components are installed and run natively
     inside WSL.
5. The release pipeline adds a Linux x64 prebuilt package; CI verifies with
   isolated XDG directories that the Linux installer writes both the Chrome and
   Chromium manifests.
6. Cross-platform text such as Shell, Python, and YAML is fixed to LF, and
   PowerShell scripts are fixed to CRLF, to prevent Git working-tree
   configuration from changing script line endings.

## Consequences

- Linux and WSLg users can install and run browser-bridge natively.
- WSL users can keep using their everyday Windows Chrome without reinstalling a
  browser inside WSL.
- The three runtime components must live within the same OS boundary; Windows
  Chrome cannot directly launch a Linux ELF, and Linux Chrome cannot read a
  Windows Native Messaging registration.
- The Linux prebuilt release currently covers x64; other Linux architectures
  still need to be built from source.
