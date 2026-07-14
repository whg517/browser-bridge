# 运维:运行与操作 browser-bridge

> 本文覆盖运行时如何操作 browser-bridge:两种二进制模式、只读诊断、日志/审计、
> 锁文件与 native host 重连。子命令的完整用法与"server not reachable"排查见
> [cli.md](./cli.md)(本文不重复),组件边界见 [architecture.md](./architecture.md)。

## 两种二进制模式

`browser-bridge` 是单二进制 + 子命令分发(见 [ADR-0001](./adr/0001-use-rust-single-binary.md)):

- **MCP server**(无参数):默认模式,由 MCP 客户端 spawn。监听 localhost TCP、持有会话
  状态、分发工具。stdout 走 MCP JSON-RPC。
- **native host**(`--native-host`):薄桥接,由 Chrome 经 wrapper spawn。在 stdin/stdout 的
  Native Messaging 帧与 TCP NDJSON 之间转发。stdout 走 NM 帧。

两种模式的 **stdout 都只承载协议字节**,任何诊断都写 stderr——一次误写就会破坏帧流
(见 [trust-boundaries.md](./security/trust-boundaries.md))。

## 只读诊断:doctor / status

`browser-bridge doctor`(别名 `status`)是**只读**自检:不监听端口、不写锁文件、不 spawn
子进程,只探测并打印环境与连接结论(版本/平台、锁文件端口/pid、MCP server 可达性、
native host manifest 是否就位)。它**不做修复**——不杀进程、不删锁文件、不重启 server。
逐项含义与"server not reachable"的解读见 [cli.md](./cli.md#doctor--status只读自检)。

## 日志与审计:BB_LOG / BB_LOG_FORMAT

诊断都写 **stderr**,两个环境变量控制输出(完整表格见 [cli.md](./cli.md#日志与审计bb_log--bb_log_format)):

- `BB_LOG`:`error` / `warn` / `info`(默认) / `debug`,日志阈值。
- `BB_LOG_FORMAT`:`text`(默认) / `json`,审计行格式。

**结构化审计事件**:MCP server 每处理一次 `tools/call` 就发一条审计行,带每次调用的
`req`(单调请求 id)、`tool`、`outcome`(`ok`/`error`)、`code`(错误时为
[`errors.json`](../contracts/errors.json) 的稳定码)、`dur_ms`。`BB_LOG_FORMAT=json`
时每行是一个 JSON 对象,便于机器采集。日志分级设计见
[ADR-0014](./adr/0014-leveled-logging.md)。

审计行**不记录**敏感内容(页面全文、cookie/storage value、eval 完整返回、表单填写值)——
脱敏在扩展侧完成(见 [threat-model.md](./security/threat-model.md))。

> 审计行同时带**每次调用的 request id** 与跨连接的 **connection id**(`conn` 字段,
> 由 `Session::current_generation()` 提供),便于跨重连关联到具体连接。

## 锁文件

桥接 socket 用**用户目录下的锁文件**发布端口并鉴权:MCP server 启动时写入
`{ 端口, pid, per-run secret }`,Unix 下文件权限 `0600`;native host 连接时读锁文件、
连 TCP、用 secret 发 `hello`。设计见
[ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md)、
[trust-boundaries.md](./security/trust-boundaries.md)。

**陈旧锁文件**:上一个 server 异常退出可能残留锁文件(端口/pid 已失效);新 server 启动时
检测并替换它(Windows 用 `TerminateProcess` 接管旧 server,见
[architecture.md §9](./architecture.md#9-已知限制))。`doctor` 只读锁文件、不清理。

## native host 重连

MV3 Service Worker 每 5 分钟会被强制重启(Chromium #40733525),导致 Port 关闭、
native host 收到 stdin EOF 而退出。重连由扩展驱动(见
[architecture.md §5.2](./architecture.md#52-native-host-重连流程)):

```
Chrome 关闭扩展 Port → native host stdin EOF → host 退出
扩展 onDisconnect → scheduleReconnect(2s)
2s 后 connectNative() → Chrome 重新 spawn host → 读锁文件 → 连 TCP → 发 hello
MCP server validate_hello → session.attach_connection(替换旧连接)
```

会话状态(当前 tab、ref map)放在 MCP server 进程而非 SW,因此 SW 重启不丢会话;
ref 标记打在 DOM 属性上,content script 可在重启后重建 refMap。pending 请求与
**connection generation** 绑定,generation-guarded 重连保证旧连接无法影响新连接
(见 [compatibility.md](./compatibility.md))。

## 相关

- 子命令用法与故障排查:[cli.md](./cli.md)。
- 版本与握手:[compatibility.md](./compatibility.md)。
- 安全事件处置:[security/incident-response.md](./security/incident-response.md)。
