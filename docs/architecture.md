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
│  ZCode(或任何 MCP 客户端)  │              │  Chrome(自己 spawn host)│
│  /mcp 菜单管理连接          │              │                          │
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
| **MCP server** | ZCode(通过 `mcp.servers` 配置) | 持有会话状态、监听 TCP、工具逻辑分发 | 随 ZCode 会话 |
| **native host** | Chrome(通过 host manifest) | stdin/stdout NM 帧 ↔ TCP NDJSON 的薄桥接 | 随 Chrome 扩展的 Port |
| **Chrome 扩展(SW + content)** | Chrome | 实际页面操作、白名单、Toast | SW 每 5 分钟重启;扩展随浏览器 |

**为什么是三个进程而不是一个**:Chrome 自己 spawn native host(通过 manifest),ZCode 自己 spawn MCP server,两者**不是父子关系**,无法共享 stdin/stdout,必须有一条 IPC。详见 [ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md)。

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

### 3.2 MCP JSON-RPC(MCP server ↔ ZCode)

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
| `ipc.rs` | localhost TCP listener + 锁文件(0600)+ hello 鉴权 + /dev/urandom secret |
| `native_host.rs` | `--native-host` 模式:两个线程(stdin→TCP、TCP→stdout),EOF 优雅退出 |
| `mcp_server.rs` | 默认模式:TCP accept 线程 + stdin JSON-RPC 主循环 + 消息分发 |
| `tools.rs` | 11 个工具的 schema 定义 + dispatch 到 session.call |
| `session.rs` | 连接管理 + 请求/响应按 id 配对(mpsc channel per id)+ 120s 超时 |

### 4.2 Chrome 扩展(`extension/`)

| 文件 | 职责 |
|------|------|
| `manifest.json` | MV3;permissions=[tabs,scripting,storage,nativeMessaging];**无静态 host_permissions**(全走 optional 按需申请) |
| `background.js` | SW:native port 管理 + 自动重连 + 请求分发到 content script + 白名单 + screenshot 代理 + **page_snapshot_precise**(chrome.debugger + CDP 链路) + **cookie_get**(chrome.cookies API) |
| `content.js` | DOM 遍历(snapshot)/click/fill/scroll/wait + Toast UI + 脱敏;**page_eval**(Function 构造器执行 + 序列化 + 脱敏 + 放大版 Toast);**storage_get**(页面 localStorage/sessionStorage);**动态注入**(非 manifest content_scripts) |
| `popup.html/js` | 授权 UI:显示连接状态、白名单(可撤销)、待授权请求的 Allow/Deny |
| `toast.css` | 高危确认 Toast 样式 |

### 4.3 安装产物(`~/.browser-bridge/` + Chrome 目录)

```
~/.browser-bridge/
├── browser-bridge       # release 二进制(608KB)
└── run-host.sh          # wrapper:exec browser-bridge --native-host
                         # (绕过 NM manifest 无 args 字段的限制)

~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
└── com.zcode.browser_bridge.json   # host manifest,path 指向 run-host.sh
```

## 5. 关键数据流

### 5.1 一次工具调用的完整往返(`page_click(ref="e3")`)

```
1. ZCode → MCP server(stdin NDJSON):
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
   → mcp_server 返回 tools/call result → ZCode
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
| page_eval | v0.1 不实现 | [0005](./adr/0005-page-eval-disabled-by-default.md) |
| host 鉴权 | allowed_origins 写死扩展 ID | [0002](./adr/0002-three-process-architecture-localhost-tcp.md) |
| 桥接 socket | per-run secret + 0600 锁文件 | [0002](./adr/0002-three-process-architecture-localhost-tcp.md) |
| 脱敏 | page_text 遮罩 password + 长数字;page_fill 密码脱敏回显 | — |
| 协议安全 | NM 1MB 出上限;单线程写 + flush;stderr panic hook | — |

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
**应对**:v0.1 snapshot 走 content script 近似,不调 debugger。精确 snapshot 留到阶段二且只在定位失败时临时 attach。详见 [ADR-0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md)。

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
| Rust 依赖 | 只 serde/serde_json | 协议手写,产物最小,易审计;tokio 对此场景过度 |
| 扩展版本 | MV3 | Chrome 强制;Service Worker 模型 |
| snapshot 实现 | content script 近似 a11y 树 | 无 infobar;覆盖率约 90%,debugger 回退兜底。详见 [ADR-0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md) |
| MCP 版本 | 2025-06-18 | 当前稳定版;ZCode 实现的就是这个版本。详见 [ADR-0007](./adr/0007-mcp-protocol-version-2025-06-18.md) |

## 9. 已知限制

1. **snapshot 准确度约 90%**:content script 重新计算 a11y name 会漏 shadow DOM、复杂 ARIA;阶段二加 debugger 回退
2. **跨域 iframe**:content script 受同源限制,跨域 iframe 内容读不到
3. **单用户机器**:桥接 socket 虽有 secret 鉴权,但设计前提是单用户
4. **仅 macOS + Chrome**:Linux/Windows 路径不同;Edge 理论可工作但未测
5. **无信号处理**:依赖 stdin EOF 退出,SIGTERM 处理留作后续(锁文件有清理路径兜底)

## 10. 演进路线

见 [requirements.md §7 阶段划分](./requirements.md#7-阶段划分)。架构上预留的扩展点:
- **加新工具**:在 `tools.rs` 加 Tool 定义 + dispatch 分支,扩展 background/content 加对应 op 处理
- **page_eval**:需新增高危确认通道(区别于 Toast 的更强确认)
- **debugger 回退**:新增 `page_snapshot_precise` 工具,SW 临时 attach/detach
- **Skill 层**:不动架构,纯新增 skill 文件教 AI 组合现有工具
