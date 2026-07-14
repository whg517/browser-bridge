# 兼容性:协议与能力版本

> 本文说明 browser-bridge 的三种"版本"、内部桥接协议的兼容策略,以及版本/能力握手的
> **契约现状**。协议边界的总览见 [architecture.md §11](./architecture.md#11-协议边界错误分类与握手);
> 契约单一信源见 [`contracts/`](../contracts/README.md)。

## 三种互不相同的"版本"

谈兼容性前先分清三个层级(见 [architecture.md §11.2](./architecture.md#112-能力--版本握手capabilitiesjson--protocol-versionjson)):

| 版本 | 取值 | 单源 | 变化含义 |
|------|------|------|----------|
| MCP JSON-RPC 版本 | 日期串 `2025-06-18` | [ADR-0007](./adr/0007-mcp-protocol-version-2025-06-18.md) | MCP 客户端 ↔ MCP server 的外部协议;锁定不随意动 |
| 内部桥接协议版本 | 单调整数(当前 `1`) | [`contracts/protocol-version.json`](../contracts/protocol-version.json) | MCP server ↔ native host ↔ 扩展的 wire 契约 |
| 扩展/二进制发布版本 | SemVer(如 `0.1.0`) | `Cargo.toml`(见 [ADR-0013](./adr/0013-ci-and-toolchain.md)) | 发布物版本;发布纪律见 [release.md](./release.md) |

本文关注**内部桥接协议版本**:它是一个小整数,仅在桥接 wire 契约
(`BridgeReq`/`BridgeResp` 形状、`hello` 握手、op/能力语义)发生**不兼容**变更时 +1。
新增可选字段、新增工具、新增能力这类向后兼容变更不 bump 它(按 SemVer 落在发布版本的
minor 上,见 [release.md](./release.md#semver-规则)。

## 能力协商:capabilities.json

除了协议版本,连接还要协商**能力集**。
[`capabilities.json`](../contracts/capabilities.json) 把工具按共享的 Chrome 权限/作用域
分组(如 `page_eval`、`cookie_read`、`page_snapshot_precise`),由 `tools.json` 的
`permission`/`scope` 概念性推导而来。设计意图是:连接时扩展/native host 上报**实际可用**的
能力 id(权限已授予、工具未被禁用),某工具只有在其能力被 advertise 时才可调用。

## 握手与快速失败(契约已定义,wiring 待接线)

[`protocol-version.json`](../contracts/protocol-version.json) 的 `handshake` 段描述了
**意图中**的协商流程,叠加在既有的 `hello` secret 鉴权(见
[ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md))之上:

1. secret 校验通过后,扩展上报自己的 `protocolVersion` 与能力 id 列表。
2. server 比对协议版本:**不兼容则快速失败**,回
   [`errors.json`](../contracts/errors.json) 里的 `PROTOCOL_MISMATCH`
   (`category: protocol`、`retryable: false`)并给清晰消息,而不是接受连接、
   等某次 `tools/call` 才以"unknown op"晚爆。
3. 某工具所需能力未被 advertise → 前置拒绝该工具调用,而非派发一个扩展处理不了的 op。

**诚实说明现状**:上面这套"版本 + 能力握手"目前**只定义在契约里**(`protocol-version.json`
+ `capabilities.json` + [RFC-0001](./rfc/0001-connection-state-machine.md)),
代码侧的握手 **wiring 尚未接线**——这是路线图 P1#5 的待办
(见 [governance-roadmap.md](./governance-roadmap.md#p1协议和代码结构治理))。当前已落地的是
RFC-0001 的**首阶段**:pending 请求与 connection generation 绑定、generation-guarded 重连,
让旧连接无法影响新连接(见 [architecture.md §5.2](./architecture.md#52-native-host-重连流程))。
`PROTOCOL_MISMATCH` 错误码已在契约中就位,等 wiring 落地即可启用。

## 相关

- 错误分类与 `PROTOCOL_MISMATCH`:[architecture.md §11.1](./architecture.md#111-错误分类errorsjson)、
  [`contracts/errors.json`](../contracts/errors.json)。
- 连接状态机与重连语义:[RFC-0001](./rfc/0001-connection-state-machine.md)、
  [operations.md](./operations.md#native-host-重连)。
- 发布与 SemVer 纪律:[release.md](./release.md)。
