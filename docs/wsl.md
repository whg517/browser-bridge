# WSL 使用指南

WSL 可以用两种方式运行 browser-bridge。选择哪一种取决于 **Chrome
运行在哪个操作系统中**。MCP Server、Chrome 启动的 Native Host 和 Chrome
本身必须属于同一个操作系统环境。

## 模式一：WSL 客户端 + Windows Chrome（推荐）

这是最常见的 WSL 使用方式：Codex、Claude Code 等 MCP 客户端运行在 WSL，
日常浏览器仍是 Windows Chrome。

1. 在 Windows 仓库中执行 `install.ps1`，并把 `extension/dist` 加载到
   Windows Chrome。
2. 在 WSL 的 MCP 配置中直接运行 Windows 安装的 `.exe`。WSL interop 会把
   它作为 Windows 进程启动，因此它与 Windows Chrome 使用相同的注册表、
   `%LOCALAPPDATA%` 锁文件和 Native Messaging host。

Codex 的 `~/.codex/config.toml` 示例：

```toml
[mcp_servers.browser-bridge]
command = "/mnt/c/Users/YOUR_WINDOWS_USER/AppData/Local/browser-bridge/browser-bridge.exe"
args = []
```

把 `YOUR_WINDOWS_USER` 换成 Windows 用户名，并确认该路径存在。此模式不需要
在 WSL 中运行 `install.sh`，也不需要在 WSL 中安装 Chrome。

## 模式二：WSLg + Linux Chrome/Chromium

如果浏览器本身运行在 WSLg 中，就使用 Linux 原生安装。先在 WSL 中安装
Rust、Node.js，以及 Google Chrome 或 Chromium，然后在 WSL 仓库执行：

```sh
./install.sh                    # 自动检测 Chrome 或 Chromium
./install.sh --browser chrome   # 仅 Google Chrome
./install.sh --browser chromium # 仅 Chromium
./install.sh --browser both     # 同时写入两种 manifest
```

默认安装位置：

- MCP Server：`~/.local/share/browser-bridge/browser-bridge`
- Google Chrome manifest：
  `~/.config/google-chrome/NativeMessagingHosts/com.browser_bridge.host.json`
- Chromium manifest：
  `~/.config/chromium/NativeMessagingHosts/com.browser_bridge.host.json`
- 运行锁文件：`$XDG_RUNTIME_DIR/browser-bridge/run.lock`；没有
  `XDG_RUNTIME_DIR` 时回退到 `$XDG_CACHE_HOME/browser-bridge/run.lock` 或
  `~/.cache/browser-bridge/run.lock`

在 Linux Chrome/Chromium 的 `chrome://extensions` 中加载当前 WSL 仓库的
`extension/dist`，然后将 MCP 客户端配置为运行 Linux 安装的二进制：

```toml
[mcp_servers.browser-bridge]
command = "/home/YOUR_WSL_USER/.local/share/browser-bridge/browser-bridge"
args = []
```

## 不要跨系统混用

- Windows Chrome 不能读取 WSL 中的 Linux Native Messaging manifest，也不能
  启动 Linux ELF 二进制。
- WSLg 中的 Linux Chrome 不读取 Windows 注册表，也不能使用 Windows Chrome
  的 Native Messaging 注册。
- 仅仅从 WSL 启动 Windows `.exe` 不算混用；该进程仍是 Windows 进程，这正是
  模式一能够工作的原因。

出现连接问题时，先确认 Chrome、Native Host 和 MCP Server 是否落在同一侧，
再分别检查 Windows 的 `%LOCALAPPDATA%\browser-bridge\run.lock` 或 Linux 的
XDG 锁文件。
