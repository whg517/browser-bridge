# 需求文档:browser-bridge

> 让 MCP 客户端(如 Claude Code、Codex)操作**用户正在使用的真实 Chrome**——
> 真实的标签页、真实的登录态、真实的 Cookie——而不是启动一个空白模拟浏览器。

## 1. 背景与问题

### 1.1 现状
用户希望让 AI(通过 MCP 客户端)直接操作自己的浏览器:抓取登录后的页面、自动填表、跨标签处理信息。但 AI 默认没有这个能力——它能发起 HTTP 请求,但**看不到也不接管用户已打开、已登录的浏览器会话**。

### 1.2 已有方案的不足

| 方案 | 问题 |
|------|------|
| CDP(`--remote-debugging-port=9222` 特殊启动 Chrome) | 必须**重启浏览器**,违背日常使用习惯;端口一开,本机任何进程都能控制,无权限边界 |
| Playwright/Puppeteer 启动新实例 | 不是用户的浏览器,没有登录态、Cookie、扩展;每次要重新登录 |
| `chrome-devtools-mcp`(微软) | 走 CDP,仍需特殊启动 Chrome 或暴露调试端口 |
| 纯 HTTP 抓取 | 看不到登录态,JS 渲染的页面拿不到 |

### 1.3 我们要解决的核心问题
**在不重启 Chrome、不暴露调试端口的前提下,让 AI 安全地操作用户真实浏览器的页面。**

## 2. 目标与非目标

### 2.1 目标(v0.1)
- **G1 真实浏览器**:操作用户当前正在用的 Chrome,保留所有登录态、扩展、Cookie
- **G2 零特殊启动**:扩展一次安装长期生效,不需要每次 `--remote-debugging-port` 启动
- **G3 安全可控**:新站点需用户授权;高危动作(提交、跳转)实时弹窗确认
- **G4 MCP 集成**:作为标准 MCP server 接入 MCP 客户端,工具集稳定可组合
- **G5 单二进制分发**:整个后端编译成一个 Rust 二进制,部署 = 拷贝一个文件

### 2.2 非目标 / 已延后能力
- ✅ **`page_eval` 已补齐**:早期 v0.1 不实现任意 JS 执行;阶段二已补,带高危确认通道 + 返回值脱敏。详见 [ADR-0008](./adr/0008-page-eval-confirmation-channel.md)(取代早期的 [ADR-0005](./adr/0005-page-eval-disabled-by-default.md))
- ✅ **Cookie/Storage 只读已补齐**:阶段三补了 `cookie_get` / `storage_get`,严格只读且输出脱敏。详见 [ADR-0010](./adr/0010-cookie-storage-readonly.md)
- ✅ **精确 snapshot 已补齐**:`page_snapshot_precise` 显式使用 chrome.debugger,调用前提示用户,调用期间会短暂显示 infobar。默认 `page_snapshot` 仍用 content script 近似。详见 [ADR-0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md) 和 [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md)
- ❌ **不做录制/回放、批量任务编排**。这是阶段三的玩法层
- ❌ **不支持非 Chrome 浏览器**。当前针对 macOS/Windows 上的 Google Chrome

## 3. 用户故事

### US-1:抓取登录后页面
> 作为开发者,我想让 AI 读取我**已登录**的内部系统页面内容,这样它能基于真实数据帮我分析。

验收:AI 调 `page_snapshot` + `page_text`,首次访问时扩展弹授权 popup,我点 Allow;之后能读到脱敏后的页面文本。

### US-2:自动填表
> 作为日常用户,我想让 AI 帮我在网页表单里填写一长串字段(地址、订单信息),减少手动输入。

验收:AI 调 `page_snapshot` 拿到字段 ref,调 `page_fill` 逐个填入;密码字段在日志里脱敏。

### US-3:多标签页处理
> 作为研究者,我想让 AI 列出我所有打开的标签页,定位到某个,基于其内容回答问题。

验收:AI 调 `tab_list` → `tab_focus` → `page_snapshot`,跨标签工作。

### US-4:安全确认
> 作为用户,当 AI 要点击"提交订单"或跳转链接时,我必须有机会拒绝,避免误操作。

验收:点击 submit 类按钮或链接时,页面右上角弹 Toast,30 秒不响应自动拒绝;批准后 60 秒同源同类动作免确认。

### US-5:开发者扩展集成
> 作为 MCP 客户端用户,我想把 browser-bridge 作为 MCP server 接入,在对话里直接说"列出我的标签页"就能用。

验收:在客户端的 MCP server 配置中加入 browser-bridge 后,客户端的连接管理界面能看到 `browser-bridge` 已连接,工具可调用。

## 4. 功能需求

### FR-1 标签页管理
- `tab_list` — 列出所有标签页(id/title/url/active)
- `tab_focus` — 激活指定标签页
- `tab_open(url)` — 打开新标签(域名受白名单约束)
- `tab_close(tabId)` — 关闭 http(s) 标签前在页面内弹 Toast 确认

### FR-2 页面读取
- `page_snapshot` — 返回交互元素的 a11y 风格树,每个节点有稳定 `ref`、role、accessible name、兜底 selector
- `page_snapshot_precise` — **精确版**:用 chrome.debugger + CDP 取 Chrome 权威 a11y 树,覆盖 shadow DOM/复杂 ARIA;attach 前弹提示 Toast,期间 Chrome 顶部闪现调试横幅(~1秒);refs 用 `p` 前缀,page_click/fill 无需改动。详见 [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md)
- `page_text` — 返回正文文本(密码字段、疑似卡号脱敏)
- `page_screenshot` — 返回可见视口 PNG(base64)

### FR-3 页面操作
- `page_click(ref|selector)` — 点击;submit/链接类触发 Toast 确认
- `page_fill(ref|selector, value)` — 填表;用 native setter 触发框架(React/Vue)的 change 检测;密码字段脱敏记录
- `page_scroll(direction|pixels)` — 滚动
- `page_wait_for(selector|text|nav, timeoutMs)` — 等待 selector/text,或等待页面 load 完成
- `page_eval(code)` — **高危**:执行任意 JS。每次调用弹放大版 Toast 显示完整代码;同源 60s 免确认;返回值默认脱敏(JWT/长hex/长数字/敏感关键字),可在 popup 关闭。用 `new Function` 在全局作用域执行,支持 await/return。详见 [ADR-0008](./adr/0008-page-eval-confirmation-channel.md)

### FR-4 安全控制
- **FR-4.1 域名白名单**:新 origin 首次操作时,扩展弹 popup 请求授权;授权同时通过 `chrome.permissions.request` 申请该域名的 host 权限。白名单存 `chrome.storage.local`,可在 popup 撤销。详见 [ADR-0004](./adr/0004-allowlist-with-optional-host-permissions.md)
- **FR-4.2 高危 Toast**:submit 点击、链接跳转触发页面 Toast,30 秒超时拒绝,批准后 60 秒同源同类免确认。详见 [ADR-0006](./adr/0006-toast-confirmation-for-high-risk.md)
- **FR-4.3 host 鉴权**:native messaging manifest 的 `allowed_origins` 写死扩展 ID;桥接 socket 用 per-run secret + 用户目录锁文件鉴权(Unix mode 0600)
- **FR-4.4 脱敏**:`page_text` 遮罩 `<input type=password>` 和长数字串;`page_fill` 密码字段值在参数回显中脱敏

### FR-5 Cookie/Storage 只读(阶段三)
- **FR-5.1 `cookie_get`**:读 Cookie(含 httpOnly),受 host_permissions 自然约束(复用白名单);输出 value 脱敏,结构字段(name/domain/httpOnly)保留
- **FR-5.2 `storage_get`**:读页面 localStorage/sessionStorage(content script,同源);输出始终脱敏(不受 evalMask 开关控制,因 token 泄露风险与 eval 等价)
- **FR-5.3 不做写入**:无 cookie_set / cookie_remove / storage_set——cookie_set 能伪造 httpOnly Cookie(会话固定攻击),连 XSS 都做不到。详见 [ADR-0010](./adr/0010-cookie-storage-readonly.md)

## 5. 非功能需求

| 维度 | 要求 |
|------|------|
| **NFR-1 性能** | 单次工具调用往返(不含用户确认)< 500ms(本地链路) |
| **NFR-2 资源** | release 二进制 < 1MB;常驻 MCP server 内存 < 20MB |
| **NFR-3 零运行时依赖** | 用户机器只需 Rust 编译期;运行时不依赖 Python/Node/任何运行时;不引入 libc 之外的 native 依赖 |
| **NFR-4 健壮性** | SW 5 分钟重启、native host 崩溃、Chrome 重启后能自动恢复连接 |
| **NFR-5 可审计** | 所有安全相关决策(授权、确认、拒绝)有 ADR 记录;扩展权限声明最小化 |
| **NFR-6 跨 PATH 独立** | host manifest 用绝对路径;不依赖用户 shell 的 PATH 配置(已知约束:用户 PATH 不含 `/opt/homebrew/bin`) |

## 6. 范围边界

### 6.1 v0.1 包含
- 11 个工具(见 FR-1~FR-3);**阶段二追加 `page_eval` + `page_snapshot_precise`**(共 13 个);**阶段三追加 `cookie_get` + `storage_get`**(共 15 个)
- 白名单 + Toast 双层安全
- content script 风格 snapshot
- macOS/Windows + Chrome

### 6.2 v0.1 不包含,后续阶段
- **阶段二**:
  - `page_snapshot_precise` — debugger 回退精确 snapshot(会闪现 infobar,需告知用户)
  - ✅ `page_eval` — 高危确认通道(放大版 Toast + 同源 60s 免确认 + 可配脱敏)。**已完成**,详见 [ADR-0008](./adr/0008-page-eval-confirmation-channel.md)
  - ✅ `page_snapshot_precise` — debugger 精确 snapshot(提示 Toast + infobar 闪现 + p 前缀 ref)。**已完成**,详见 [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md)
- **阶段三**:
  - ✅ `cookie_get` / `storage_get`(只读,限白名单域名,输出脱敏)。**已完成**,详见 [ADR-0010](./adr/0010-cookie-storage-readonly.md)
  - Skill 层(把高频玩法:抓列表页、表单填写、跨标签操作沉淀成 skill)
  - 录制/回放、批量任务编排

### 6.3 明确排除
- 不做浏览器历史/书签/下载管理
- 不做网络请求拦截/修改
- 不做多浏览器同步支持

## 7. 阶段划分

| 阶段 | 范围 | 状态 |
|------|------|------|
| **阶段一:v0.1 最小可用** | FR-1~FR-4 + NFR-1~6 | ✅ 代码完成,协议层 e2e 测试 PASS,待用户加载扩展验收 |
| **阶段二:精确化** | debugger 回退 snapshot、page_eval 高危通道 | ✅ 完成(page_eval + page_snapshot_precise) |
| **阶段三:扩展能力** | cookie/storage、skill 层、编排 | 🔄 cookie/storage 已完成;skill 层/编排未开始 |

## 8. 验收标准(v0.1)

1. `install.sh`(macOS)或 `install.ps1`(Windows)跑通,扩展加载成功,host manifest 注册
2. MCP 客户端能看到 `browser-bridge` 已连接
3. AI 在对话里说"列出标签页" → 看到真实标签页列表
4. AI 说"截当前页" → AI 能分析到截图
5. AI 说"在搜索框填 XXX 并点搜索" → 真在用户浏览器执行;提交时弹 Toast 确认
6. 访问未授权域名 → 扩展弹授权 popup
7. 协议层端到端测试 PASS(NM 帧、MCP JSON-RPC、TCP 桥接)

## 9. 术语

| 术语 | 含义 |
|------|------|
| **MCP** | Model Context Protocol,AI 与工具之间的标准协议,基于 JSON-RPC 2.0 |
| **Native Messaging** | Chrome 扩展与本地进程通信的官方机制,帧格式 = 4字节小端长度 + JSON |
| **MV3** | Manifest V3,Chrome 扩展的最新标准,background 改用 Service Worker |
| **SW** | Service Worker,MV3 的后台脚本,会被 Chrome 每 5 分钟强制重启 |
| **CDP** | Chrome DevTools Protocol,通过调试端口控制 Chrome 的协议 |
| **ref** | snapshot 给每个交互元素分配的稳定标识(如 `e3`),AI 用它定位元素 |
| **a11y** | accessibility,可访问性树——页面元素的语义化结构 |
