# WSL Usage Guide

WSL can run browser-bridge in two ways. Which one you choose depends on **which
operating system Chrome runs in**. The MCP Server, the Native Host that Chrome
launches, and Chrome itself must all belong to the same operating system
environment.

## Mode 1: WSL client + Windows Chrome (recommended)

This is the most common way to use WSL: MCP clients such as Codex and Claude
Code run in WSL, while your everyday browser is still Windows Chrome.

1. Run `install/install.ps1` in the Windows repository, and load `extension/dist`
   into Windows Chrome.
2. In the WSL MCP configuration, run the Windows-installed `.exe` directly. WSL
   interop launches it as a Windows process, so it uses the same registry,
   `%LOCALAPPDATA%` lock file, and Native Messaging host as Windows Chrome.

Example `~/.codex/config.toml` for Codex:

```toml
[mcp_servers.browser-bridge]
command = "/mnt/c/Users/YOUR_WINDOWS_USER/AppData/Local/browser-bridge/browser-bridge.exe"
args = []
```

Replace `YOUR_WINDOWS_USER` with your Windows username, and confirm that the path
exists. This mode does not require running `install.sh` in WSL, nor does it
require installing Chrome in WSL.

## Mode 2: WSLg + Linux Chrome/Chromium

If the browser itself runs in WSLg, use a native Linux installation. First
install Rust, Node.js, and either Google Chrome or Chromium in WSL, then run the
following in the WSL repository:

```sh
./install/install.sh                    # auto-detect Chrome or Chromium
./install/install.sh --browser chrome   # Google Chrome only
./install/install.sh --browser chromium # Chromium only
./install/install.sh --browser both     # write both manifests
```

Default installation locations:

- MCP Server: `~/.local/share/browser-bridge/browser-bridge`
- Google Chrome manifest:
  `~/.config/google-chrome/NativeMessagingHosts/com.browser_bridge.host.json`
- Chromium manifest:
  `~/.config/chromium/NativeMessagingHosts/com.browser_bridge.host.json`
- Runtime lock file: `$XDG_RUNTIME_DIR/browser-bridge/run.lock`; when there is no
  `XDG_RUNTIME_DIR`, it falls back to `$XDG_CACHE_HOME/browser-bridge/run.lock` or
  `~/.cache/browser-bridge/run.lock`

In Linux Chrome/Chromium, load the `extension/dist` of the current WSL repository
at `chrome://extensions`, then configure the MCP client to run the
Linux-installed binary:

```toml
[mcp_servers.browser-bridge]
command = "/home/YOUR_WSL_USER/.local/share/browser-bridge/browser-bridge"
args = []
```

## Do not mix across systems

- Windows Chrome cannot read the Linux Native Messaging manifest in WSL, nor can
  it launch a Linux ELF binary.
- Linux Chrome in WSLg does not read the Windows registry, nor can it use the
  Native Messaging registration of Windows Chrome.
- Simply launching a Windows `.exe` from WSL does not count as mixing; that
  process is still a Windows process, which is exactly why Mode 1 works.

When you run into connection problems, first confirm whether Chrome, the Native
Host, and the MCP Server all land on the same side, then check the Windows
`%LOCALAPPDATA%\browser-bridge\run.lock` or the Linux XDG lock file separately.
