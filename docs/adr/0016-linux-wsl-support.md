# ADR-0016: 支持 Linux 与 WSL 双运行模式

- 状态:Accepted
- 日期:2026-07-13

## 背景

Linux 原实现沿用了 macOS 的安装目录和锁文件路径，release workflow 也只生成
macOS Apple Silicon 包。WSL 又同时存在 Windows Chrome 与 WSLg Linux 浏览器
两种部署拓扑，若混用二进制、manifest 或锁文件，会导致 Native Messaging
无法连接。

## 决策

1. Linux 锁文件优先放在 `$XDG_RUNTIME_DIR/browser-bridge/run.lock`，目录权限为
   `0700`；缺少 runtime dir 时依次回退到 `$XDG_CACHE_HOME`、`~/.cache` 和按
   UID 隔离的临时目录。锁文件仍保持 `0600`。
2. Linux 安装遵循 XDG：二进制默认放在
   `${XDG_DATA_HOME:-$HOME/.local/share}/browser-bridge`，Google Chrome 和
   Chromium 的 Native Messaging manifest 分别写入各自的 XDG config 目录。
3. `install.sh` 支持 `--browser chrome|chromium|both`，默认自动检测；通过
   `--skip-extension-build` 可复用已构建的 `extension/dist`。
4. WSL 使用两种明确拓扑：
   - Windows Chrome：WSL MCP 客户端通过 interop 启动 Windows 安装的 `.exe`。
   - WSLg Linux Chrome/Chromium：全部组件在 WSL 内原生安装和运行。
5. 发布流水线增加 Linux x64 预编译包；CI 用隔离的 XDG 目录验证 Linux
   安装器同时写入 Chrome 与 Chromium manifest。
6. Shell、Python、YAML 等跨平台文本固定为 LF，PowerShell 脚本固定为 CRLF，
   避免 Git 工作树配置改变脚本换行符。

## 结果

- Linux 和 WSLg 用户可原生安装并运行 browser-bridge。
- WSL 用户可以继续操作 Windows 日常 Chrome，而无需在 WSL 重装浏览器。
- 三个运行组件必须位于同一操作系统边界；不支持 Windows Chrome 直接启动
  Linux ELF，也不支持 Linux Chrome 读取 Windows Native Messaging 注册。
- Linux 预编译发布目前覆盖 x64；其他 Linux 架构仍需从源码构建。
