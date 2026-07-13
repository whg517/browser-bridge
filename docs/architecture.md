# 架构文档:browser-bridge

> 本文档描述 browser-bridge 的组件结构、数据流、协议、安全模型和关键约束。
> 设计决策的"为什么"见 [adr/](./adr/)。

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                       browser-bridge(Rust 单二进制)                  │
│                                                                      │
│  ┌──────────────────────┐    localhost TCP    ┌──────────────────┐  │
│  │ MCP server(默认模式)│  ◀──NDJSON JSON──▶  │ --native-host    │  │
│  │ - 持有会话状态        │   127.0.0.1:<随机>  │ (薄桥接)         │  │
│  │ - 监听 TCP,写锁文件   │                     │ - stdin NM 帧→TCP │  │
│  │ - 工具分发            │                     │ - TCP→stdout NM 帧│  │
│  └──────────┬───────────┘                     └────────┬─────────┘  │
└─────────────┼─────────────────────────────────────────┼────────────┘
              ▲ stdio(NDJSON)                          ▲ stdin/stdout
              │ JSON-RPC 2.0                            │ NM 帧(4B LE 长度+JSON)
              │                                         │
┌─────────────┴──────────────┐              ┌───────────┴──────────────┐
│  MCP 客户端(Claude Code 等)│              │  Chrome(自己 spawn host)│
│  客户端管理连接             │              │                          │
└────────────────────────────┘              └────────────┬─────────────┘
                                                          │ chrome.runtime.connectNative
                                                          ▼
                                            ┌──────────────────────────┐
                                            │  Browser Bridge 扩展     │
                                            │  (MV3)                   │
                                            │  background.js (SW):     │
                                            │   - native port + 重连   │
                                            │   - 请求分发到 content    │
                                            │   - 白名单管理            │
                                            │  content.js:             │
                                            │   - snapshot/click/fill  │
                                            │   - Toast/脱敏            │
                                            └────────────┬─────────────┘
                                                         │ chrome.tabs.sendMessage
                                                         ▼
                                            ┌──────────────────────────┐
                                            │  用户的真实页面(已登录) │
                                            └──────────────────────────┘
```

## 2. 三个进程

整个系统涉及三个独立进程,理解它们的边界是理解整个架构的关键。

| 进程 | 谁启动它 | 职责 | 生命周期 |
|------|---------|------|---------|
| **MCP server** | MCP 客户端(通过其 server 配置 spawn) | 持有会话状态、监听 TCP、工具逻辑分发 | 随客户端会话 |
| **native host** | Chrome(通过 host manifest) | stdin/stdout NM 帧 ↔ TCP NDJSON 的薄桥接 | 随 Chrome 扩展的 Port |
| **Chrome 扩展(SW + content)** | Chrome | 实际页面操作、白名单、Toast | SW 每 5 分钟重启;扩展随浏览器 |

**为什么是三个进程而不是一个**:Chrome 自己 spawn native host(通过 manifest),MCP 客户端自己 spawn MCP server,两者**不是父子关系**,无法共享 stdin/stdout,必须有一条 IPC。详见 [ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md)。

**为什么 native host 极薄**:所有逻辑在 MCP server。这样 SW 重启、host 重启都不丢会话状态(状态在 MCP server)。native host 只是协议翻译器。

## 3. 协议层

系统涉及三种协议,各自有不同的传输和帧格式。

### 3.1 Native Messaging(扩展 ↔ native host)

Chrome 官方协议,定义在 [developer.chrome.com/native-messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。

- **帧格式**:`4 字节小端 u32 长度` + `UTF-8 JSON`
- **长度**:只算 JSON 字节,**不含** 4 字节前缀
- **出方向(host→Chrome)硬上限**:**1 MB**(超了 Chrome 直接断开 Port)
- **入方向(Chrome→host)**:64 MB
- **关闭信号**:**stdin EOF**(不是 SIGTERM);host 读到 EOF 应优雅退出
- **stderr**:不展示给用户,但可写日志(Chrome 内部日志记录)
- **argv[1]**:Chrome 传入调用方 origin(如 `chrome-extension://<id>/`),可用于多扩展区分

**关键陷阱**(实现时已处理):
- 所有 stdout 写入必须**单线程** + 每帧 **flush**(并发写会因 pipe buffer 交错而损坏帧)
- panic 默认打到 stdout 会污染流 → 必须装 **stderr panic hook**
- 用 `BufWriter` 必须每帧后显式 flush
- `panic = "abort"`(Cargo profile)+ stderr hook 双保险

### 3.2 MCP JSON-RPC(MCP server ↔ MCP 客户端)

基于 JSON-RPC 2.0,NDJSON 传输,定义在 [modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-06-18)。

- **传输**:stdin/stdout,NDJSON(每条消息一行,LF 结尾)
- **禁止内嵌换行**(serde 序列化自动转义 `\n`)
- **协议版本**:锁定 `2025-06-18`。详见 [ADR-0007](./adr/0007-mcp-protocol-version-2025-06-18.md)
- **握手三步**:`initialize`(请求/响应)→ `notifications/initialized`(通知,无需响应)→ 运行
- **工具错误**:用 result 内 `isError: true`,**不**用 JSON-RPC error(让模型看到错误文本并反应)
- **必须处理**:`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`
- **错误码**:未知方法 `-32601`,解析错 `-32700`

**最小可行消息集**(v0.1 实现):`initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`。其他方法返回 `-32601`。

### 3.3 内部桥接协议(MCP server ↔ native host)

自定义,走 localhost TCP,NDJSON 传输。

```typescript
// MCP server → native host → 扩展的请求
interface BridgeReq {
  id: number;        // 单调递增,用于配对响应
  op: string;        // 操作名,如 "tab_list"、"page_click"
  tabId?: number;    // 目标标签页(可选,缺省=当前激活页)
  args: any;         // 操作参数
}

// 扩展 → native host → MCP server 的响应
interface BridgeResp {
  id: number;        // 对应 BridgeReq.id
  ok: boolean;
  data?: any;        // 成功时的返回数据
  error?: string;    // 失败时的错误信息
}
```

**鉴权**:连接建立时,native host 先发一行 `{"hello": "<secret>"}`,MCP server 用锁文件里的 secret 校验。详见 [ipc.rs](../src/ipc.rs)。

## 4. 组件详解

### 4.1 Rust 后端(`src/`)

| 文件 | 职责 |
|------|------|
| `main.rs` | 模式分发:无参数=MCP server,`--native-host`=native host,`--help`=帮助 |
| `protocol.rs` | 三种协议的消息类型 + 读写函数;stderr panic hook;SIGPIPE 忽略 |
| `ipc.rs` | localhost TCP listener + 用户目录锁文件 + hello 鉴权 + 系统随机源 secret |
| `native_host.rs` | `--native-host` 模式:两个线程(stdin→TCP、TCP→stdout),EOF 优雅退出 |
| `mcp_server.rs` | 默认模式:TCP accept 线程 + stdin JSON-RPC 主循环 + 消息分发 |
| `tools.rs` | 15 个工具的 schema 定义 + dispatch 到 session.call |
| `session.rs` | 连接管理 + 请求/响应按 id 配对(mpsc channel per id)+ 120s 超时 |
| `error.rs` | 工具调用边界的类型化错误 `CallError`(thiserror);Display 即模型可见文本。详见 [ADR-0014](./adr/0014-leveled-logging.md) |
| `log.rs` | `BB_LOG` 控制的分级 stderr 日志器(error/warn/info/debug,默认 info)+ `log_*!` 宏。详见 [ADR-0014](./adr/0014-leveled-logging.md) |

### 4.2 Chrome 扩展(`extension/`)

扩展源码用 **TypeScript**(strict)写在 `extension/src/*.ts`,由 **esbuild** 打包成 IIFE 到 `extension/dist/`,静态资源(manifest/HTML/CSS/icons)一并拷入;**load-unpacked 目标是 `extension/dist/`**(不是 `extension/`)。改代码须先 `npm run build`(或 `make ext-build`)。详见 [ADR-0012](./adr/0012-typescript-esbuild-extension-build.md)。

| 源文件(`src/`) | 产物(`dist/`) | 职责 |
|------|------|------|
| `manifest.json`(静态,拷入 dist) | `manifest.json` | MV3;permissions=[tabs,scripting,storage,nativeMessaging];**无静态 host_permissions**(全走 optional 按需申请) |
| `background.ts` | `background.js` | SW **入口**(约 20 行):注册 onMessage 路由 + 启动时 connectNative。真实逻辑在 `src/background/*`(见下) |
| `content.ts` | `content.js` | content script **入口**(约 30 行):重注入 guard + onMessage 监听 → `handle`。真实逻辑在 `src/content/*`(见下) |
| `options.ts` + `options.html` | `options.js` + `options.html` | 独立 Options 配置页(详见 [ADR-0011](./adr/0011-options-page-for-settings.md)) |
| `popup.ts` + `popup.html` | `popup.js` + `popup.html` | 授权 UI:显示连接状态、白名单(可撤销)、待授权请求的 Allow/Deny |
| `toast.css`(静态,拷入 dist) | `toast.css` | 高危确认 Toast 样式 |

**模块化结构**:两个巨型文件已拆成内聚模块,esbuild 会把 import 重新打包回单个 IIFE,运行时行为不变(靠 dom_test 77 / smoke / e2e 验证)。

- `src/shared/`(两端共用,纯逻辑,有单元测试)— `types`(桥接/消息/设置类型)、`settings`(DEFAULTS + getSetting)、`masking`(脱敏 pattern 目录)、`allowlist`(glob 匹配/域名归一)、`ops`(工具目录,单测校验与 `tools.rs` 一致)
- `src/background/` — `port`(native 端口生命周期)、`dispatch`(BridgeReq 路由 + 工具禁用门)、`tabs`(目标 tab 解析/注入 + tab_* 工具)、`precise`(page_snapshot_precise / CDP)、`cookies`(cookie_get)、`allowlist-store`(存储白名单 + 授权流)、`messages`(runtime.onMessage 路由)
- `src/content/` — `refs`(封装的 ref 状态)、`snapshot`(a11y 树)、`actions`(click/fill/text/screenshot/scroll)、`wait`、`eval`、`storage`、`toast`、`handle`(op 分发)

依赖是无环 DAG:`shared/*` → `background/allowlist-store` → `tabs` → `precise`/`cookies` → `dispatch` → `port` → `messages`;content 侧 `shared/*`/`util` → `refs`/`snapshot` → `toast` → `actions`/`eval` → `handle`。单元测试(`src/shared/*.test.ts`,bun)覆盖纯模块,含一条跨语言守卫(op 列表须与 `tools.rs` 一致)。

### 4.3 安装产物

macOS:

```
~/.browser-bridge/
├── browser-bridge       # release 二进制(608KB)
└── run-host.sh          # wrapper:exec browser-bridge --native-host
                         # (绕过 NM manifest 无 args 字段的限制)

~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
└── com.browser_bridge.host.json   # host manifest,path 指向 run-host.sh
```

Windows:

```text
%LOCALAPPDATA%\browser-bridge\
├── browser-bridge.exe
└── com.browser_bridge.host.json

HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser_bridge.host
└── (Default) = 上述 manifest 的绝对路径
```

Linux:

```text
${XDG_DATA_HOME:-~/.local/share}/browser-bridge/
├── browser-bridge
└── run-host.sh

${XDG_CONFIG_HOME:-~/.config}/google-chrome/NativeMessagingHosts/
└── com.browser_bridge.host.json

${XDG_CONFIG_HOME:-~/.config}/chromium/NativeMessagingHosts/
└── com.browser_bridge.host.json   # 选择 Chromium 或 --browser both 时
```

Windows 的 manifest 直接指向 EXE。Chrome 启动 native host 时会追加调用方
extension origin,二进制据此进入 native-host 模式;macOS/Linux 则由 wrapper
显式传入 `--native-host`。Linux 锁文件优先位于
`$XDG_RUNTIME_DIR/browser-bridge/run.lock`,没有 runtime dir 时回退到 XDG cache;
详见 [ADR-0016](./adr/0016-linux-wsl-support.md)。

扩展本身以 **load-unpacked** 方式从 **`extension/dist/`**(esbuild 构建产物,由 `src/*.ts` 打包 + 静态资源拷贝而来)加载,`install.sh`/`install.ps1` 会先构建。dist/ 不入库,克隆后须先 `npm run build`(或 `make ext-build`)。详见 [ADR-0012](./adr/0012-typescript-esbuild-extension-build.md)。

## 5. 关键数据流

### 5.1 一次工具调用的完整往返(`page_click(ref="e3")`)

```
1. MCP 客户端 → MCP server(stdin NDJSON):
   {"jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{"name":"page_click","arguments":{"ref":"e3"}}}

2. mcp_server.handle() → tools.dispatch()
   → session.call("page_click", None, {"ref":"e3"})
   → 分配 BridgeReq.id=1,写入 TCP

3. native host 读 TCP NDJSON → 转 NM 帧 → 写 stdout

4. background.js Port.onMessage 收到 {op:"page_click",args:{ref:"e3"}}
   → resolveTargetTab(当前激活页)
   → ensureAllowed(tab.url)  // 白名单校验,未授权则弹 popup
   → injectIfNeeded(tab.id)  // 动态注入 content.js
   → chrome.tabs.sendMessage(tab.id, {op, args})

5. content.js handle()
   → resolveTarget({ref:"e3"}) // 查 refMap → element
   → isHighRiskClick(el)? // 若是 submit/link → confirmWithToast()
     → 注入 Toast DOM,用户点 Allow → 继续;Deny/超时 → throw
   → el.scrollIntoView() + el.click()

6. 结果原路返回:
   content → chrome.runtime.sendMessage 响应
   → background Port.postMessage({id:1,ok:true,data:{clicked:"e3"}})
   → native host 读 NM 帧 → 转 NDJSON → 写 TCP

7. session 收到 BridgeResp → 按 id=1 找到 pending sender → 唤醒
   → mcp_server 返回 tools/call result → MCP 客户端
```

### 5.2 native host 重连流程

```
Chrome 关闭扩展 Port → native host stdin EOF → host 退出
扩展 background.js 的 onDisconnect 触发 → scheduleReconnect(2s)
2s 后 connectNative() → Chrome 重新 spawn host → host 读锁文件 → 连 TCP → 发 hello
MCP server accept → validate_hello → session.attach_connection(替换旧连接)
```

## 6. 安全模型

详见各 ADR,这里给总览。

| 边界 | 机制 | ADR |
|------|------|-----|
| 域名白名单 | chrome.storage.local + popup 授权 + permissions.request | [0004](./adr/0004-allowlist-with-optional-host-permissions.md) |
| 高危动作确认 | content script 注入 Toast,30s 超时拒绝,60s 免确认窗口 | [0006](./adr/0006-toast-confirmation-for-high-risk.md) |
| page_eval | 放大版 Toast 逐次确认 + 同源短窗口 + 返回值默认脱敏 | [0008](./adr/0008-page-eval-confirmation-channel.md) |
| host 鉴权 | allowed_origins 写死扩展 ID | [0002](./adr/0002-three-process-architecture-localhost-tcp.md) |
| 桥接 socket | per-run secret + 用户目录锁文件(Unix mode 0600) | [0002](./adr/0002-three-process-architecture-localhost-tcp.md) |
| 脱敏 | page_text 遮罩 password + 长数字;page_fill 密码脱敏回显 | — |
| 协议安全 | NM 1MB 出上限;单线程写 + flush;stderr panic hook | — |
| 配置管理 | 独立 Options 页集中管理安全开关/超时/工具启用/白名单/allowAllSites | [0011](./adr/0011-options-page-for-settings.md) |

## 7. 关键约束(实现时已踩坑并处理)

### 7.1 MV3 Service Worker 5 分钟重启(Chromium #40733525)
**约束**:Chrome 每 5 分钟强制重启 SW,所有内存状态丢失;Port 关闭,native host 收到 stdin EOF 退出。
**应对**:
- 白名单存 `chrome.storage.local`(不存内存)
- SW 启动时自动 `connectNative()` 重连
- 会话状态(当前 tab、ref map)放在 MCP server 进程,不放 SW
- ref 标记打在 DOM 元素的 `data-zcb-ref` 属性上,SW 重启后 content script 能从 DOM 重建 refMap

### 7.2 chrome.debugger 强制 infobar
**约束**:任何 `chrome.debugger.attach` 都会在所有标签页顶部强制显示"Started debugging this browser"横幅,无法关闭(除非 `--silent-debugger-extension-api` 启动参数,又回到特殊启动)。
**应对**:默认 snapshot 走 content script 近似,不调 debugger;需要权威 a11y 树时显式调用 `page_snapshot_precise`,临时 attach 后立即 detach。详见 [ADR-0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md) 和 [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md)。

### 7.3 Native Messaging manifest 无 args 字段
**约束**:manifest 的 `path` 必须是可执行文件,不能带参数。
**应对**:用 `run-host.sh` wrapper(shebang 脚本)`exec browser-bridge --native-host`。

### 7.4 chrome.permissions.request 必须用户手势
**约束**:`permissions.request`(申请 host 权限)必须在 popup/action 点击等用户手势上下文调用,不能在 service worker 后台调。
**应对**:白名单授权流程通过 popup 完成——用户点 popup 的 Allow 时,同时申请 host 权限 + 记录白名单。

### 7.5 content_scripts 静态 matches 与 optional 权限冲突
**约束**:MV3 里 content_scripts 的 `matches` 声明也需要 host 权限才能注入。如果初始 `host_permissions: []`,content script 根本不注入。
**应对**:**不用 manifest content_scripts**,全部改用 `chrome.scripting.executeScript` 动态注入。权限跟着 `optional_host_permissions` 走——授权哪个域就注入哪个域。

### 7.6 Rust panic 污染 stdout
**约束**:panic 默认消息打到 stdout,会破坏 NM 帧和 MCP NDJSON,导致连接断开。
**应对**:
- Cargo release profile 设 `panic = "abort"`
- `install_stderr_panic_hook()` 把 panic 消息重定向到 stderr
- 双保险

### 7.7 page_eval 用 Function 构造器而非 eval()
**约束**:`page_eval` 要在页面全局作用域执行任意 JS,但 content.js 自身跑在 strict mode 闭包里,直接 `eval(code)` 看不到页面全局变量,且 strict mode 下 eval 有独立作用域。
**应对**:用 `new Function('"use strict"; return (async () => { <code> })()')()` —— Function 构造器在全局作用域执行,支持 `return`/`await`(包装成 async IIFE)。
**已知限制**:难以可靠设置执行超时(JS 单线程无法外部中断);靠 session 层 120s 超时兜底,死循环会导致页面卡住。返回值在送出页面前用 `serializeResult` 安全处理(循环引用/DOM/Error/BigInt/exotic 类型)再经 `maskSensitive` 脱敏。详见 [ADR-0008](./adr/0008-page-eval-confirmation-channel.md)。

### 7.8 chrome.debugger 的 infobar / 限制 / SW-only
**约束**(page_snapshot_precise):
- `chrome.debugger.attach` 会在**所有标签页**顶部强制显示"Started debugging this browser"横幅,attach 期间持续,无法关闭;`detach` 后消失。
- `chrome.debugger` API 只能在 **extension 上下文(SW/popup)** 调用,content script 是页面上下文调不到。
- 无法 attach 到 `chrome://`、`chrome-extension://`、Chrome Web Store、`view-source:`、`about:` 页面。
- 一个 tab 同时只能有一个 debugger(若已开 DevTools 则 attach 失败:"Another debugger is already attached")。

**应对**:
- 执行全在 background.js(SW),只有"弹提示 Toast"委托 content script(Toast 要在页面显示)
- 一次 handler 内 attach → `getFullAXTree` → `resolveNode` + `callFunctionOn` 打 ref → `detach`,infobar 只闪现约 1 秒
- attach 前用 content script 弹**信息性 Toast**(蓝色,默认继续,可取消)告知用户
- **`detach` 必须在 finally 路径**——任何错误都要 detach,否则 infobar 永驻
- 前置 URL scheme 检查,过滤不可 debug 的页面
- ref 用 `p` 前缀(precise)隔离 content-script 的 `e` 前缀,避免撞号;content.js 的 `resolveTarget` 按 DOM 属性值查,前缀无关

**关键链路**:`Accessibility.getFullAXTree`(每个 AXNode 带 `backendDOMNodeId`)→ `DOM.resolveNode({backendNodeId})` → `RemoteObjectId` → `Runtime.callFunctionOn` 打 `data-zcb-ref`。详见 [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md)。

### 7.9 chrome.cookies 受 host 约束 / localStorage 同源 / httpOnly 可读
**约束**(cookie_get / storage_get):
- `chrome.cookies` API **受 host_permissions 约束**:`getAll({})` 只返回已授权域名的 Cookie,**不是**全部浏览器 Cookie。blast radius 与现有工具一致,复用白名单。
- `chrome.cookies` 只在 **SW/extension 上下文**可用 → cookie_get 在 background.js。
- 页面的 `localStorage`/`sessionStorage` 只在 **content script(页面上下文,同源)** 可读;`chrome.storage` 是扩展自己的、不是页面的——两者不同。→ storage_get 在 content.js。
- `chrome.cookies` **能读 httpOnly Cookie**(这是相对 `document.cookie` 的核心价值,session token 常存这里)。
- `cookies` 权限**无额外安装警告**(debugger 已触发最大 host 警告)。
- 未授权域名:getAll 返回**空数组而非错误**,无法区分"未授权"和"真没数据",只能友好提示。

**应对**:
- cookie_get 在 background,storage_get 在 content(各自数据源决定)
- **只读**:不做 set/remove——cookie_set 能伪造 httpOnly+Secure Cookie(会话固定攻击,连 XSS 都做不到)
- 脱敏:cookie value 用精简 maskCookieValue;storage 值用 maskString。**storage_get 始终脱敏**(不受 evalMask 开关控制,因静默读取泄露 token 风险与 eval 等价)
- value 脱敏但 name/domain/httpOnly 等结构字段保留(诊断价值)

详见 [ADR-0010](./adr/0010-cookie-storage-readonly.md)。

## 8. 技术选型

| 维度 | 选择 | 理由 |
|------|------|------|
| 后端语言 | Rust | 单二进制分发稳;host manifest 写绝对路径无 PATH 依赖;性能/内存优。详见 [ADR-0001](./adr/0001-use-rust-single-binary.md) |
| 二进制拆分 | 单二进制 + 子命令 | 一份代码、一次编译、升级替换一个文件。详见 [ADR-0001](./adr/0001-use-rust-single-binary.md) |
| IPC | localhost TCP + 锁文件 | 跨进程简单;调试方便;per-run secret 鉴权。详见 [ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md) |
| Rust 依赖 | serde/serde_json + libc + thiserror | 协议仍手写、tokio 仍不用;在 serde 之外加 `libc`(信号/底层交互)与 `thiserror`(工具路径类型化错误)。这修订了 ADR-0001"唯一依赖 serde"的旧表述,最小依赖原则不变。详见 [ADR-0014](./adr/0014-leveled-logging.md) |
| 扩展工具链 | TypeScript + esbuild → dist/ | strict 类型 + 单依赖打包成 IIFE;load-unpacked 目标 `extension/dist/`。详见 [ADR-0012](./adr/0012-typescript-esbuild-extension-build.md) |
| 工程门禁 | Makefile + GitHub Actions | 统一任务入口 + CI(fmt/clippy -D warnings/eslint/prettier + 测试);Cargo 为版本单源。详见 [ADR-0013](./adr/0013-ci-and-toolchain.md) |
| 扩展版本 | MV3 | Chrome 强制;Service Worker 模型 |
| snapshot 实现 | content script 近似 a11y 树 | 无 infobar;覆盖率约 90%,debugger 回退兜底。详见 [ADR-0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md) |
| MCP 版本 | 2025-06-18 | 当前稳定版;MCP 客户端普遍实现的就是这个版本。详见 [ADR-0007](./adr/0007-mcp-protocol-version-2025-06-18.md) |

## 9. 已知限制

1. **snapshot 准确度约 90%**:content script 重新计算 a11y name 会漏 shadow DOM、复杂 ARIA;阶段二加 debugger 回退
2. **跨域 iframe**:content script 受同源限制,跨域 iframe 内容读不到
3. **单用户机器**:桥接 socket 虽有 secret 鉴权,但设计前提是单用户
4. **Chrome 平台范围**:支持 macOS/Windows/Linux Google Chrome 和 Linux Chromium;Edge 理论可工作但未测
5. **Windows 强制接管**:Windows 用 `TerminateProcess` 接管旧 server,无法让旧进程自行清理;新 server 会显式删除并替换陈旧锁文件

## 10. 演进路线

见 [requirements.md §7 阶段划分](./requirements.md#7-阶段划分)。架构上预留的扩展点:
- **加新工具**:在 `tools.rs` 加 Tool 定义 + dispatch 分支,扩展 background/content 加对应 op 处理
- **page_eval**:需新增高危确认通道(区别于 Toast 的更强确认)
- **debugger 回退**:新增 `page_snapshot_precise` 工具,SW 临时 attach/detach
- **Skill 层**:不动架构,纯新增 skill 文件教 AI 组合现有工具

### 10.1 工程标准化整改

一轮工程标准化整改重塑了构建、测试与可观测性基线,不改变工具的运行时行为,相关决策见:
- **[ADR-0012](./adr/0012-typescript-esbuild-extension-build.md)**:扩展改用 TypeScript,esbuild 打包到 `extension/dist/`(新的 load-unpacked 目标)。
- **[ADR-0013](./adr/0013-ci-and-toolchain.md)**:Makefile 任务入口 + GitHub Actions CI + rustfmt/clippy/eslint/prettier 门禁 + Cargo 为源的版本同步。
- **[ADR-0014](./adr/0014-leveled-logging.md)**:`BB_LOG` 分级 stderr 日志 + thiserror 类型化错误(新增 `libc`、`thiserror` 依赖)。

## 11. 协议边界:错误分类与握手

跨进程契约集中在 [`contracts/`](../contracts/README.md)(单一信源),运行时行为对着它验证。
本节把三个与协议边界相关的契约串起来。

### 11.1 错误分类(errors.json)

工具调用边界上,Rust 的类型化错误 `CallError`(见 §4.1 `error.rs`)映射到
[`contracts/errors.json`](../contracts/errors.json) 里的稳定 `code`;`cargo test` 对着该文件校验
映射,扩展侧把自己的失败归一到同一批 `code`。`code` 供程序判定(含 `category` 与
`retryable`),模型/用户看到的是 `message`。这样"连接层三种失败"
(`NOT_CONNECTED` / `EXTENSION_NOT_READY` / `CONNECTION_LOST`)在三个进程里有统一语义,
不各说各话。

### 11.2 能力 / 版本握手(capabilities.json + protocol-version.json)

在 §3.3 的内部桥接协议之上,连接建立时除了 §3.3 的 `hello` secret 鉴权,还**意图**再做一步
能力 + 版本协商:

- native host / 扩展上报自己支持的 [`protocol-version.json`](../contracts/protocol-version.json)
  内部协议版本(当前 `1`)与可用的能力集(见 [`capabilities.json`](../contracts/capabilities.json),
  能力由 `tools.json` 的 `permission`/`scope` 概念性推导而来)。
- 版本不兼容 → **快速失败**,回 `PROTOCOL_MISMATCH`(见 errors.json)并给清晰消息,
  而不是接受连接、等某次 `tools/call` 才以"unknown op"晚爆。
- 某工具所需能力未被 advertise → 前置拒绝该工具调用,而非派发一个扩展处理不了的 op。

注意区分三个"版本":MCP JSON-RPC 版本 `2025-06-18`(§3.2 / [ADR-0007](./adr/0007-mcp-protocol-version-2025-06-18.md))、
内部桥接协议版本(整数,protocol-version.json)、扩展发布版本(以 Cargo 为源),互不相同。

### 11.3 相关设计提案(RFC)

以下两篇 RFC 是**设计提案**(尚未实现),细化连接与工具分发的演进方向:

- **[RFC-0001:显式化连接状态机](./rfc/0001-connection-state-machine.md)**——把 §5.2 隐式的连接/
  重连处理收敛为显式状态机(Disconnected→Connecting→Ready→Reconnecting→Failed)+ 每连接
  generation id,并挂上 §11.2 的握手。
- **[RFC-0002:工具注册表 / Command 模式](./rfc/0002-tool-registry.md)**——让 `tools.rs` 从一个大
  match 演进为 `ToolHandler` trait + 注册表,能力门(§11.2)在此自然归位。
