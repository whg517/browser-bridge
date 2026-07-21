# CLI 与故障排查:browser-bridge

> 本文覆盖 `browser-bridge` 二进制的子命令与常见排查路径。
> 组件与进程边界见 [architecture.md](./architecture.md);安装产物路径见 [architecture.md §4.3](./architecture.md#43-安装产物)。

## 子命令一览

`browser-bridge` 是单二进制 + 子命令分发(见 [ADR-0001](./adr/0001-use-rust-single-binary.md)):

| 调用 | 模式 | 说明 |
|------|------|------|
| `browser-bridge`(无参数) | MCP server | 默认模式:监听 TCP、持有会话状态、分发工具。由 MCP 客户端 spawn。 |
| `browser-bridge tools [--json]` | 自描述 | 打印工具目录(名字 + 描述 + 参数)。`--json` 与 MCP `tools/list` 同形。**不启动桥接、无副作用**。 |
| `browser-bridge call <tool> [json]` | 一次性工具调用 | 面向非 MCP 调用方(脚本 / agent):跑一个工具、打印其**原始结果**、退出。见下。 |
| `browser-bridge --native-host` | native host | 薄桥接:stdin/stdout NM 帧 ↔ TCP NDJSON。由 Chrome(经 wrapper)spawn。 |
| `browser-bridge doctor`(别名 `status`) | 只读诊断 | 打印环境与连接自检,不启动 server、不改任何状态。 |
| `browser-bridge --help` | 帮助 | 用法说明。 |

## `tools`:自描述(给非 MCP agent 发现能力)

MCP 客户端靠 `tools/list` 知道"有哪些工具、怎么调";非 MCP 的 agent(如 OpenClaw)
看不到它。`tools` 把同一份能力清单直接吐出来,**不需要浏览器、不启动桥接**:

```sh
browser-bridge tools          # 人读:每个工具的名字、描述、参数(名/类型/必填/说明)
browser-bridge tools --json   # 机读:{ "tools": [ { name, description, inputSchema } ] },
                              #        与 MCP tools/list 完全同形,agent 可直接 parse
```

**给非 MCP agent 的接入闭环**:先 `tools --json` 学能力 → 再 `call <tool> '<json>'` 执行。
把这两条告诉你的 agent(或写进它的工具说明),它就能自助使用 browser-bridge,无需实现 MCP。

## `call`:面向非 MCP 调用方的一次性工具调用

不想实现 MCP 握手(initialize → tools/call → 解析嵌套 JSON)的脚本 / agent,可以直接:

```sh
browser-bridge call tab_list
browser-bridge call tab_open '{"url":"https://example.com"}'
browser-bridge call page_fill '{"selector":"#kw","value":"hello"}'
browser-bridge call page_text
```

它内部起一个桥接、等扩展连上、跑这**一个**工具、把结果打到 **stdout**(工具的原始 JSON,
**不**套 MCP 的 `{content:[{text}]}`),然后退出。诊断/日志走 stderr(受 `BB_LOG` 控制),
所以 stdout 保持干净、可管道。`page_screenshot` 打印 base64 PNG。

**退出码**:`0` 成功 · `1` 工具报错 · `2` 参数/工具名错误 · `3` 等扩展连接超时(15s)·
`4` 已有活跃 MCP server 占用桥接。

**单桥接限制**:`call` 与你的 MCP 客户端**共用同一个桥接连接**。检测到有活跃的 MCP server
时,`call` 会**明确拒绝(退出 4)**而不是把它挤下线——先停掉 MCP 客户端,或直接让客户端发起
调用。守护进程(`daemon`)/ HTTP 模式需要连接层的多路复用(见 issue #45),本次不做。

## `doctor` / `status`:只读自检

`doctor`(等价别名 `status`)是一个**只读**子命令:它不监听端口、不写锁文件、不 spawn
任何子进程,只探测当前环境并把结论打印出来,用于回答"为什么连不上"。

它报告:

- **版本 / 平台**:二进制版本(以 Cargo 为源,见 [ADR-0013](./adr/0013-ci-and-toolchain.md))与运行平台(macOS/Windows)。
- **锁文件**:用户目录下桥接锁文件是否存在,以及其中记录的 **端口 / pid**
  (锁文件机制见 [ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md))。
- **MCP server 可达性**:对锁文件里的 `127.0.0.1:<端口>` 做一次 localhost 探测,
  报告 server 是否在监听(`reachable` / `not reachable`)。
- **native host manifest**:Chrome 的 native messaging host manifest
  (`com.browser_bridge.host.json`)是否就位(路径见 [architecture.md §4.3](./architecture.md#43-安装产物))。

### 如何解读 "server not reachable"

"server not reachable" 表示 `doctor` 读到了锁文件里的端口,但对该端口的 localhost 探测失败。
常见原因与处置:

1. **MCP server 未在运行**:MCP server 由 MCP 客户端(如 Claude Code)在其会话内 spawn。
   若客户端未启动或该 server 未配置/未拉起,端口自然无人监听。→ 确认客户端已加载
   browser-bridge 的 MCP server 配置并处于运行会话中。
2. **陈旧锁文件**:上一个 server 异常退出但锁文件残留(端口/pid 已失效)。新 server 启动时
   会检测并替换陈旧锁文件(见 [architecture.md §9](./architecture.md#9-已知限制));
   若当前没有活着的 server,`doctor` 报 not reachable 属预期。→ 重新拉起客户端会话即可。
3. **端口被占用/被防火墙拦截**:localhost 回环通常不涉及防火墙,但本机安全软件可能拦截。
   → 检查是否有其他进程占用该端口。

> `doctor` 只做探测、不做修复:它**不会**杀进程、删锁文件或重启 server。看到 not reachable
> 时,正确动作是回到 MCP 客户端侧重新建立会话,而不是手动干预进程。

若 **manifest 缺失**,则说明扩展侧的 native host 无法被 Chrome spawn(Chrome 找不到 host 声明)。
→ 重新运行安装脚本(`install.sh` / `install.ps1`)以写入 manifest。

## 日志与审计(`BB_LOG` / `BB_LOG_FORMAT`)

两种模式的诊断都写到 **stderr**(stdout 被协议帧占用)。两个环境变量控制输出:

| 变量 | 取值 | 作用 |
|------|------|------|
| `BB_LOG` | `error` \| `warn` \| `info`(默认) \| `debug` | 日志阈值。`info` 及以上会打印审计行;设为 `warn`/`error` 可静默审计。 |
| `BB_LOG_FORMAT` | `text`(默认) \| `json` | 审计行的格式。`json` 每行输出一个 JSON 对象,便于机器采集。 |
| `BB_LOCK_DIR` | 绝对目录 | 覆盖锁文件所在目录。当 MCP server 与 native host 运行在**不同用户上下文**(如 Windows 自动化以 SYSTEM 运行、Chrome 以桌面用户运行)时,给两侧设**相同值**,让双方都能找到桥接锁文件(见 issue #57)。 |

**审计事件**:MCP server 每处理一次 `tools/call` 就发一条审计行,字段包括每次调用的
`req`(单调请求 id)、`tool`(工具名)、`outcome`(`ok`/`error`)、`code`(错误时为
[errors.json](../contracts/errors.json) 的稳定错误码,否则 `-`)、`dur_ms`(耗时)。

```text
# BB_LOG_FORMAT 默认(text)
[AUDIT] ts=1721000000000 req=7 tool=page_click outcome=ok code=- dur_ms=12
# BB_LOG_FORMAT=json
{"kind":"audit","ts":1721000000000,"req":"7","tool":"page_eval","outcome":"error","code":"EXECUTION_FAILED","dur_ms":8}
```

错误码与错误分类见 [architecture.md §11.1](./architecture.md#111-错误分类errorsjson)。

## 相关

- 连接生命周期与断线/重连语义:[architecture.md §5.2](./architecture.md#52-native-host-重连流程)。
- 错误分类(`NOT_CONNECTED` / 断开类):[architecture.md §11.1](./architecture.md#111-错误分类errorsjson)。
