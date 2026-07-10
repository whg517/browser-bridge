# ADR-0002:三进程架构 + localhost TCP 桥接

- **状态**:Accepted
- **日期**:2026-07-07

## 背景

browser-bridge 涉及两个独立的"宿主":

- **MCP 客户端**(如 Claude Code、Codex)会 spawn 一个进程作为 MCP server(stdio JSON-RPC)
- **Chrome** 会 spawn 一个进程作为 native messaging host(stdio NM 帧)

这两个宿主**各自独立 spawn 自己的进程**,它们不是父子关系,无法共享 stdin/stdout。因此必须有某种 IPC 让 MCP server 进程和 native host 进程交换消息。

此外,MV3 的 Service Worker 会被 Chrome 每 5 分钟强制重启(Chromium #40733525),重启时所有内存状态丢失,扩展的 native Port 也会关闭。这意味着任何"会话状态"(当前焦点 tab、最近 snapshot 的 ref 映射)都不能存在 SW 或 native host 里。

## 决策

**采用三进程架构,用 localhost TCP + 锁文件作为 IPC:**

1. **MCP server 进程**(MCP 客户端 spawn,长期):持有所有会话状态,监听 `127.0.0.1:0`(随机端口),把端口 + per-run secret 写到 0600 锁文件
2. **native host 进程**(Chrome spawn,随 Port 生命周期):极薄,只做 stdin NM 帧 ↔ TCP NDJSON 的协议翻译
3. **Chrome 扩展**(SW + content):实际页面操作

native host 连接 MCP server 时,先发一行 `{"hello": "<secret>"}` 鉴权,匹配锁文件里的 secret 才接受连接。

## 考虑过的替代方案

### 方案 A:MCP server 和 native host 合并为一个进程
- **不可行**:两个宿主(MCP 客户端、Chrome)各自 spawn,进程不是父子关系,stdin/stdout 不共享。除非用 socket activation 之类的机制,但 Chrome 的 native messaging 不支持。

### 方案 B:Unix domain socket(替代 TCP)
- **优点**:文件权限可限 0600,只有当前用户能连,安全面更小
- **缺点**:
  - Windows 不支持(当前只针对 macOS,所以这条不影响)
  - 路径管理略繁(要处理 `/tmp` vs 用户目录)
- **未被选中的原因**:用户在决策时选了 localhost TCP(调试方便,能 telnet)。TCP 配合 per-run secret + 0600 锁文件,在单用户机器上安全足够

### 方案 C:文件 IPC(MCP server 和 host 不直接通信,都读写同一文件)
- **缺点**:并发/时效差;不适合交互式控制(每次工具调用要往返)
- **排除**:用户在选项里明确标记"不推荐"

### 方案 D:native host 持有会话状态(不让 MCP server 持有)
- **问题**:native host 随 Chrome Port 生命周期,SW 重启就丢;且 native host 是"被动"的(Chrome spawn),不适合做协调者
- **排除**:状态必须在最稳定的进程(MCP server)里

## 后果

### 正面
- **会话状态稳定**:MCP server 进程不随 SW/Chrome 重启而丢状态
- **host 极薄**:native host 只做协议翻译,逻辑全在 MCP server,易测试、易维护
- **可调试**:localhost TCP 能用 telnet/nc 手动连上去调试
- **鉴权**:per-run secret + 0600 锁文件,防止同机其他用户/进程误连

### 负面
- **多一层 IPC**:理论上多一次序列化/反序列化开销(实际本地 TCP < 1ms,可忽略)
- **锁文件管理**:MCP server 退出要清理锁文件;stale 锁文件会导致 host 连接失败(已处理:host 连不上会删除锁文件)
- **端口随机**:每次 MCP server 启动端口不同,锁文件是唯一的发现机制
- **理论上同机其他用户可连**:secret 防护依赖锁文件 0600;在多用户机器上不安全(本项目设计前提是单用户)

### 中性
- localhost TCP 在 macOS/Linux/Windows 都支持,跨平台无障碍(虽然 v0.1 只测 macOS)

## 鉴权细节

- **锁文件**:`~/Library/Application Support/browser-bridge/run.lock`(macOS),权限 0600
- **内容**:`{port, secret, pid}`,secret 是 128 位熵(/dev/urandom)
- **写入**:原子 rename(tmp 文件 → 正式文件),防止 host 读到半写
- **校验流程**:host 连上后第一行发 `{"hello": secret}`,MCP server 比对锁文件里的 secret,不匹配则拒绝
- **stale 处理**:host 连接失败时主动删除锁文件,让下次 MCP server 启动能干净开始

## 实施

- `src/ipc.rs`:`listen()`(bind + 生成 LockFile)、`connect()`(读锁 + 连 + 发 hello)、`validate_hello()`
- `src/session.rs`:`attach_connection()`(校验 hello + 起 reader 线程分发 BridgeResp)、`call()`(注册 pending sender → 发 BridgeReq → 等响应,120s 超时)
- `src/native_host.rs`:两个线程,stdin→TCP 和 TCP→stdout
- MCP server 退出时(`stdin EOF`)删除锁文件

## 已验证

端到端测试 PASS:
1. mock host 连接 → hello 鉴权通过 → 工具调用往返成功
2. `--native-host` 模式真实 NM 帧双向流通 + 完整往返
