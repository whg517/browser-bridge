# ADR-0015: 支持 Windows 本地运行与安装

- 状态:Accepted
- 日期:2026-07-13

## 背景

原实现依赖 Unix 文件权限、`/dev/urandom`、POSIX 信号和 macOS Native
Messaging manifest 目录,无法在 Windows 编译和安装。

## 决策

1. Windows 锁文件放在 `%LOCALAPPDATA%\browser-bridge\run.lock`,随机令牌由
   `BCryptGenRandom` 生成。
2. 使用 Win32 process API 检测并终止旧 MCP Server,保留新会话接管语义。
3. Chrome Native Messaging manifest 直接指向 `browser-bridge.exe`。Windows
   Chrome 会在命令行附加调用方的 `chrome-extension://` origin,程序据此进入
   native-host 模式;显式 `--native-host` 仍然保留用于测试和 Unix wrapper。
4. `install.ps1` 将 manifest 放入 `%LOCALAPPDATA%\browser-bridge`,并把绝对
   路径注册到当前用户的
   `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser_bridge.host`。
   安装不需要管理员权限。
5. Windows 的 `rename` 不覆盖已有文件,写新锁文件前删除陈旧目标。临时文件
   已完整写入并 flush;删除与 rename 之间若恰逢 Native Host 读取,扩展会按既有
   两秒重连机制恢复。

## 结果

- Rust 后端可在 Windows 原生编译运行。
- Windows 用户可从源码执行 `install.ps1` 完成本地安装。
- Windows 预编译发布包尚未加入 release workflow;当前 release 仍仅发布
  macOS Apple Silicon 包。
- Edge 未纳入支持范围。
