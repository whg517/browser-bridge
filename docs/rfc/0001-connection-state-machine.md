# RFC-0001:显式化连接状态机

- **状态**:Proposed(设计提案,尚未实现)
- **日期**:2026-07-13
- **相关**:[architecture.md §5.2](../architecture.md)、[ADR-0002](../adr/0002-three-process-architecture-localhost-tcp.md)、[contracts/errors.json](../../contracts/errors.json)、[contracts/protocol-version.json](../../contracts/protocol-version.json)

> 本文是**设计提案**,不是实现记录。目标是把当前隐式散落在 `session.rs` /
> 扩展 `background/port` 里的连接生命周期,收敛为一个显式、可测试的状态机。

## Problem(问题)

当前连接处理是**隐式**的:MCP server 侧的 `Session` 持有一个"当前 native 连接",
扩展侧的 `background/port` 持有一个 native Port,两端各自用零散的布尔量与回调管理
"连没连上、要不要重连"。这带来几个具体问题:

1. **重连竞态**:SW 每 5 分钟重启(见 [architecture.md §7.1](../architecture.md)),
   `onDisconnect` → `scheduleReconnect` 期间,旧连接的 in-flight 请求与新连接的响应
   可能交错。响应按 `BridgeReq.id` 配对,但**跨连接的 id 会复用**,理论上旧连接迟到的
   响应可能被错配到新连接的 pending 请求上。
2. **reader 线程泄漏/串台**:`attach_connection` 起的 reader 线程绑定在某个 TCP 连接上;
   连接被替换时,旧 reader 若未干净退出,会向已失效的 pending map 写入。
3. **状态不可观测**:没有单一的"连接现在处于什么状态"来源,日志与错误码
   (`NOT_CONNECTED` / `EXTENSION_NOT_READY` / `CONNECTION_LOST`,见
   [errors.json](../../contracts/errors.json))的产生点分散,难以断言"何时该报哪个"。
4. **无握手校验**:连接建立只做 `hello` secret 鉴权,不校验协议版本 / 能力集,
   版本漂移只能在某次 `tools/call` 时以"unknown op"的形式晚爆(见
   [protocol-version.json](../../contracts/protocol-version.json))。

## Proposed design(提案设计)

引入一个**显式的连接状态机 + 每连接 generation id**,作为 `Session` 的唯一连接真相源。

- **状态机**是唯一决定"当前能不能发请求、迟到响应该不该接受、reader 该不该继续"的地方。
- **generation id**(单调递增的 `u64`)在每次进入 `Connecting` 时自增。所有随该连接创建的
  资源——pending 请求 sender、reader 线程、in-flight 的 `BridgeReq.id`——都**打上当时的
  generation**。
- **绑定规则**:
  - reader 线程读到 `BridgeResp` 时,先比对自己的 generation 与当前 generation;不一致
    直接丢弃并退出(旧连接的迟到响应不会污染新连接)。
  - `Session::call` 注册 pending sender 时记录当前 generation;连接切换(进入
    `Reconnecting` / `Failed`)时,所有**旧 generation** 的 pending sender 被统一唤醒并
    以 `CONNECTION_LOST` 结束,不等 120s 超时。
  - 新连接握手成功(`Ready`)前的 `call` 一律返回 `EXTENSION_NOT_READY`(可重试);
    从未连接过则返回 `NOT_CONNECTED`。
- **握手**:进入 `Ready` 之前新增一步版本 + 能力协商(见
  [protocol-version.json](../../contracts/protocol-version.json)):host/扩展上报
  `protocolVersion` + `capabilities[]`;版本不兼容 → 直接进入 `Failed` 并回
  `PROTOCOL_MISMATCH`,而不是接受连接后晚爆。

这是**行为收敛**,不改变三进程架构本身;状态与 generation 仍然只活在最稳定的 MCP server
进程里(与 ADR-0002 一致)。

## States & transitions(状态与转移)

```
        (server 启动,未有 host 连接)
                  │
                  ▼
           ┌─────────────┐
           │ Disconnected│◀────────────────────────┐
           └──────┬──────┘                          │
        host 连接进来 / accept                        │ 放弃重试(超过上限)
                  ▼                                  │
           ┌─────────────┐        hello/版本失败     │
           │ Connecting  │───────────────────┐      │
           └──────┬──────┘                   ▼      │
     hello+版本+能力 OK               ┌─────────────┐│
     (generation++ 已在入口完成)       │   Failed    ││
                  ▼                   └──────┬──────┘│
           ┌─────────────┐                  │ 新的 accept
           │    Ready    │                  └────────┘
           └──────┬──────┘
     Port 断开 / reader EOF / 写失败
                  ▼
           ┌─────────────┐   退避后重连(host 由 Chrome 重新 spawn)
           │ Reconnecting│──────────────┐
           └─────────────┘              │
                  ▲                     ▼
                  └───────────── 回到 Connecting
```

| 状态 | 含义 | 允许的 `call` 结果 |
|------|------|--------------------|
| `Disconnected` | 从未连接 / 已彻底断开且未重连 | `NOT_CONNECTED` |
| `Connecting` | TCP 已 accept,正在做 hello + 版本/能力握手 | `EXTENSION_NOT_READY` |
| `Ready` | 握手通过,可正常收发 | 正常派发 |
| `Reconnecting` | 曾 Ready,连接掉了,等待 host 重新 spawn 连回 | in-flight → `CONNECTION_LOST`;新 `call` → `EXTENSION_NOT_READY` |
| `Failed` | 握手不兼容(版本/能力),不自动重试 | `PROTOCOL_MISMATCH`(或能力缺失的清晰错误) |

**generation 语义**:进入 `Connecting` 时 `generation += 1`。`Ready→Reconnecting` 不改
generation(同一逻辑连接的短暂中断由重连覆盖),但一旦重新走 `Connecting` 就再自增,
从而让任何仍持旧 generation 的 reader/pending 失效。

## Tests to add(需新增的测试)

Rust(`session.rs` 单元 / 集成):

1. **迟到响应隔离**:构造 gen=1 的 pending 请求,切到 gen=2,注入一条 gen=1 的
   `BridgeResp`,断言它被丢弃、gen=2 的 pending 不受影响。
2. **重连唤醒**:Ready 下发起一个 `call`,断开连接进入 `Reconnecting`,断言该 pending
   立即以 `CONNECTION_LOST` 结束(不等 120s)。
3. **状态→错误码映射**:对每个状态调用 `call`,断言返回的错误码正是上表所列
   (`NOT_CONNECTED` / `EXTENSION_NOT_READY` / `CONNECTION_LOST` / `PROTOCOL_MISMATCH`)。
4. **reader 生命周期**:替换连接后,旧 reader 线程在下一次读到消息或 EOF 时退出,断言
   不再向 pending map 写入(可用计数器/通道关闭观测)。
5. **握手失败进 Failed**:mock host 上报不兼容 `protocolVersion`,断言进入 `Failed` 且
   `call` 返回 `PROTOCOL_MISMATCH`,且不触发自动重连。
6. **能力缺失**:host 未 advertise `page_eval` 能力时调用 `page_eval`,断言前置拒绝并给出
   清晰消息,而非派发出去晚爆。

扩展侧(`background/port`,bun/dom 测试):

7. **退避重连**:`onDisconnect` 后按退避重连,断言不会并发拉起多个 Port。

## Alternatives(考虑过的替代)

- **A:维持现状(隐式布尔量 + 回调)**。改动最小,但上述竞态与错配无法被结构性排除,
  也无处挂版本握手。排除。
- **B:只加 generation id,不引入显式状态枚举**。能解决迟到响应错配,但"该报哪个错误码"
  仍是散落判断,可观测性没改善。作为 A 与本提案之间的折中,可作为分阶段落地的第一步。
- **C:每次断开都新建一个全新的 `Session`(丢弃全部状态)**。实现简单,但违背 ADR-0002
  "会话状态要在最稳定进程里存活 SW 重启"的核心目标——当前 tab、ref map 会丢。排除。
- **D:用成熟 actor / async 运行时(如 tokio)托管连接生命周期**。表达力强,但与
  [ADR-0001](../adr/0001-use-rust-single-binary.md)"最小依赖、不引入 tokio"冲突,单二进制
  体积与编译约束优先。排除;若未来放宽依赖政策可重议。
