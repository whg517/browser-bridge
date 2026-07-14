>《browser-bridge 工程治理分析与实施方案》——本轮治理的分析与路线图来源。
>
>**执行状态**:P0 治理底座已完成;P1(契约单源、错误码、Tool Registry + `tools.rs` 目录拆分、
>Policy 层、连接 generation 绑定)大部分已落地,少量待办(BridgeReq 判别联合、握手 wiring、
>完整状态机、集成测试);P2(tag 驱动发布、SBOM、provenance、`doctor`/`status`、
>结构化日志/审计与 request/connection id、nightly)大部分已落地,少量待办(扩展 zip、`upgrade`、
>macOS release gate)。逐项状态见 §12 的标注、提交历史与 `GOVERNANCE.md`。
>
>**状态图例**:✅ 已落地 / ⚠ 部分 / ⬜ 未做。

---

# browser-bridge 工程治理分析与实施方案

## 一、治理结论

`browser-bridge` 已经完成了第一轮工程化建设，并不是一个需要重写的“失控项目”。

当前已经具备：

* Rust、TypeScript、Python、Shell 的职责划分
* Rust 格式检查、Clippy、单元测试和 release build
* TypeScript 类型检查、ESLint、Prettier、单元测试和构建
* 协议 E2E、DOM 测试、扩展 Smoke 测试
* Makefile 统一开发命令
* ADR、架构文档、需求文档、开发指南和 CHANGELOG

CI 目前已经拆分为 Rust、Extension、版本一致性、协议 E2E、浏览器测试等多个任务，说明项目已经从“功能原型”进入了“工程型 Alpha”阶段。

但当前仍有大量正确性依赖于：

> 作者记得哪些文件需要同步、哪些字符串不能改错、哪些安全边界不能绕过、哪个组件应该处理哪种错误。

这正是本轮治理需要解决的问题。

治理目标不是引入更多框架，而是做到：

1. **协议和配置只有一个事实来源。**
2. **跨进程边界有明确契约。**
3. **安全要求可以通过代码和 CI 自动验证。**
4. **发布、升级和兼容性不依赖人工记忆。**
5. **新开发者可以根据结构找到正确的修改位置。**
6. **故障可以被定位，而不是只能看零散日志猜测。**

综合判断，当前工程成熟度约为：

| 领域     | 当前成熟度 |  治理目标 |
| ------ | ----: | ----: |
| 代码规范   | 3.5/5 | 4.5/5 |
| 架构边界   | 3.5/5 | 4.5/5 |
| 协议契约   | 2.5/5 | 4.5/5 |
| 测试体系   | 3.5/5 | 4.5/5 |
| 安全治理   | 2.5/5 |   4/5 |
| 发布治理   | 1.5/5 |   4/5 |
| 可观测性   |   2/5 |   4/5 |
| 团队协作治理 |   2/5 |   4/5 |

---

# 二、技术栈治理

## 1. Rust：保留，并明确它的边界

Rust 当前负责：

* MCP stdio/JSON-RPC
* Native Messaging 帧处理
* localhost TCP IPC
* 会话和请求关联
* 工具定义和分发
* 单二进制分发

这个技术选型是合理的。项目希望后端以一个二进制交付，且需要处理本地 IPC、二进制帧、进程生命周期和协议安全，Rust 与这个目标匹配。当前 Rust 依赖也相对克制，主要是 `serde`、`serde_json`、`thiserror` 和 `libc`。

### 治理建议

继续保留单 crate、单二进制，但将代码从“文件模块”逐步治理为“分层模块化单体”：

```text
src/
├── main.rs                  # 仅参数解析和进程启动
├── lib.rs                   # 可测试的应用入口
├── application/
│   ├── mcp_service.rs       # MCP 用例编排
│   ├── tool_service.rs
│   └── session_service.rs
├── domain/
│   ├── request.rs
│   ├── response.rs
│   ├── capability.rs
│   ├── risk.rs
│   └── error.rs
├── tools/
│   ├── mod.rs
│   ├── tabs.rs
│   ├── page.rs
│   └── storage.rs
├── transport/
│   ├── mcp_stdio.rs
│   ├── bridge_tcp.rs
│   └── native_messaging.rs
├── session/
│   ├── mod.rs
│   └── state.rs
└── protocol/
    ├── mcp.rs
    ├── bridge.rs
    └── native_message.rs
```

不要现在拆成多个微服务，也不建议为了“架构先进”立即迁移到 Tokio。

目前主要是单客户端、单 Native Host 连接，标准线程、Mutex 和 channel 尚可支撑。只有明确要支持多 MCP 客户端、请求取消、并发确认、背压控制后，再通过 ADR 决定是否引入异步运行时。

### Rust 代码规则

建立以下硬规则：

* 生产路径原则上禁止无说明的 `unwrap()` 和 `expect()`。
* 所有外部输入必须先解析为类型，再进入应用层。
* 协议错误、连接错误、用户拒绝和页面执行错误必须是不同错误类型。
* `main.rs` 不包含业务逻辑。
* Transport 层不得决定权限策略。
* Tool handler 不直接操作 TCP、stdio 或锁文件。
* 所有进程级全局状态必须有明确所有者。
* 设置 Rust MSRV，并增加 `rust-toolchain.toml`。

当前 CI 使用浮动的 `stable` Rust 工具链，适合早期开发，但不利于构建复现。

建议固定：

```toml
# rust-toolchain.toml
[toolchain]
channel = "1.xx.x"
components = ["rustfmt", "clippy"]
profile = "minimal"
```

每季度或每月集中升级，而不是让 CI 在未知时间自动切换编译器行为。

---

## 2. TypeScript：保留，但增强领域类型

扩展当前已启用：

* `strict`
* `noImplicitAny`
* `noUnusedLocals`
* `isolatedModules`
* ES2022
* ESLint 和 Prettier

这部分基础配置较好。

问题在于：虽然 TypeScript 开启了严格模式，但核心协议类型仍然非常宽。

目前：

```typescript
interface BridgeReq {
  id: number | string;
  op: string;
  tabId?: number;
  args: OpArgs;
}

interface OpArgs {
  ref?: string;
  selector?: string;
  value?: string;
  code?: string;
  // 所有工具参数都放在一起并全部可选
}
```

这意味着以下对象在 TypeScript 看来都是合法的：

```typescript
{ op: "page_fill", args: {} }

{ op: "tab_focus", args: { code: "..." } }

{ op: "page_click", args: { domain: "example.com" } }
```

当前主要依赖 Rust Schema 和运行时 handler 保证正确性。

### 目标类型

改为可辨识联合类型：

```typescript
type BridgeRequest =
  | {
      id: RequestId;
      op: "tab_focus";
      args: { tabId: number };
    }
  | {
      id: RequestId;
      op: "page_click";
      args:
        | { ref: string; selector?: never }
        | { selector: string; ref?: never };
    }
  | {
      id: RequestId;
      op: "page_fill";
      args: {
        value: string;
        ref?: string;
        selector?: string;
      };
    }
  | {
      id: RequestId;
      op: "page_eval";
      args: { code: string };
    };
```

对应 Rust 侧使用 tagged enum：

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "op", content = "args")]
enum BridgeCommand {
    #[serde(rename = "tab_focus")]
    TabFocus(TabFocusArgs),

    #[serde(rename = "page_click")]
    PageClick(PageClickArgs),

    #[serde(rename = "page_eval")]
    PageEval(PageEvalArgs),
}
```

目标是让“不合法状态尽量无法被构造”，而不是在每个 handler 中重复判断。

### `any` 治理

当前 ESLint 明确关闭了 `no-explicit-any`，注释说明部分 DOM helper 仍依赖显式 `any`。

不要一次性消灭全部 `any`，建议采用增量规则：

1. 新增文件禁止 `any`。
2. 对现有 `any` 增加技术债标记。
3. 先治理协议、设置、安全策略和跨进程消息。
4. DOM 遍历中的复杂类型最后处理。
5. 允许通过局部 eslint-disable，并要求解释原因。

---

## 3. Python：继续作为独立黑盒测试语言

Python E2E 不是技术栈冗余，而是有价值的独立协议实现。

当前 Python 测试直接启动真实 release binary，从外部实现 Native Messaging framing、MCP JSON-RPC 和 TCP bridge，从而避免 Rust 实现与 Rust 测试共享同一个错误假设。

治理原则：

* Python 仅用于协议黑盒和安装验证。
* 不承载正式业务逻辑。
* 尽量保持标准库实现。
* 不复制完整领域模型。
* 测试数据和协议样例放入统一 fixtures。

---

## 4. Node/npm 与 Bun：建议统一

当前扩展使用 Node/npm 构建，而浏览器测试使用 Bun，开发者需要同时准备 Rust、Node、npm、Python、Bun 和 Chrome；CI 也同时安装 Node 和 Bun。

对小团队而言，工具链数量本身就是维护成本。

推荐方案是统一到：

```text
Node LTS + npm
```

浏览器测试可迁移到：

* Node 自带 test runner，或
* Vitest
* Puppeteer Core

如果继续保留 Bun，则必须：

* 增加版本锁定。
* 在开发文档说明为什么必须使用 Bun。
* 通过 ADR 记录选择理由。
* 确保 Node 和 Bun 的模块解析差异有测试覆盖。

默认建议是统一 Node，而不是同时维护两套 TypeScript 运行环境。

---

## 5. Shell 和 Makefile：只做编排

当前 Makefile 已经统一了构建、格式化、测试、安装、版本同步和 release gate，是正确方向。

治理规则：

* Makefile 只调用具体脚本和工具，不承载复杂业务逻辑。
* Shell 函数超过约 50 行时考虑迁移到 Rust CLI 子命令。
* 安装、升级、卸载、诊断最终由二进制承担。
* Shell 保留为跨环境入口。

长期建议支持：

```bash
browser-bridge install
browser-bridge upgrade
browser-bridge doctor
browser-bridge status
browser-bridge uninstall
```

而不是持续扩大 `install.sh`。

---

# 三、架构与设计模式治理

## 1. 总体模式：模块化单体 + Ports and Adapters

当前系统天然存在三个边界：

```text
MCP Client
    │
    │ MCP / stdio
    ▼
Rust Application
    │
    │ TCP bridge
    ▼
Native Host
    │
    │ Native Messaging
    ▼
Chrome Extension
    │
    │ Chrome API / Content Script
    ▼
Web Page
```

项目文档已经清晰描述了三个进程和三种协议。

建议正式采用 **Ports and Adapters（端口与适配器）**：

### 核心层

负责：

* 工具用例
* 权限决策
* 风险等级
* 请求生命周期
* 错误模型
* 状态迁移

### 适配器层

负责：

* MCP stdio
* JSON-RPC
* TCP
* Native Messaging
* Chrome API
* chrome.storage
* DOM

核心层不应该知道数据是从 stdio、TCP 还是 Chrome Port 进入的。

---

## 2. Tool 使用 Command Pattern

当前 Rust `tools.rs` 同时承担：

* 工具描述
* JSON Schema
* 参数提取
* Tool → op 转换
* 调用 Session
* MCP 结果转换

并通过一个大 `match` 分发。扩展端又分别在 `dispatch.ts` 和 `handle.ts` 维护 switch。

建议引入轻量 Command/Registry 模式：

```rust
trait ToolHandler {
    fn metadata(&self) -> &'static ToolMetadata;

    fn validate(
        &self,
        input: serde_json::Value,
    ) -> Result<ToolCommand, ValidationError>;

    fn execute(
        &self,
        context: &ToolContext,
        command: ToolCommand,
    ) -> Result<ToolResult, ToolError>;
}
```

工具注册表：

```rust
struct ToolMetadata {
    name: &'static str,
    description: &'static str,
    risk: RiskLevel,
    scope: ToolScope,
    requires_user_confirmation: bool,
    input_schema: &'static str,
}
```

不需要为每个工具建立复杂对象层次，但应把“工具元数据、参数类型和执行逻辑”从一个巨大文件中拆开。

---

## 3. 连接管理使用显式 State Machine

当前 Session 和 Extension Port 都隐含维护了连接状态：

* 未连接
* 正在连接
* 已连接
* 已断开
* 等待重连

但这些状态目前主要由 `Option<Writer>`、布尔变量、timer 和线程生命周期表达。

建议定义显式状态机：

```text
Disconnected
    ↓ connect
Connecting
    ↓ authenticated
Ready
    ↓ port lost
Reconnecting
    ↓ authenticated
Ready
    ↓ permanent error
Failed
```

每个连接实例增加：

```text
connection_id / generation
connected_at
last_activity_at
protocol_version
extension_version
capabilities
```

所有 reader 清理、pending 请求和响应都绑定 `connection_generation`，避免旧连接影响新连接。

需要增加的状态机测试：

* 连接建立后立即断开。
* 新连接替代旧连接。
* 旧 reader 晚于新连接退出。
* 请求发送中发生断连。
* 响应超时后迟到。
* 重复响应。
* 未知 request ID。
* Native Host 重启。
* MV3 Service Worker 重启。
* MCP client 退出。

---

## 4. 权限与确认使用 Policy Pattern

目前权限逻辑散落在：

* allowlist store
* tab open
* dispatch
* content action
* Toast
* options 设置

建议形成统一策略入口：

```typescript
interface ActionContext {
  tool: ToolName;
  origin?: string;
  tabId?: number;
  requestedCapability: Capability;
  argsSummary: unknown;
}

interface PolicyDecision {
  allowed: boolean;
  risk: "low" | "medium" | "high" | "critical";
  requiresSitePermission: boolean;
  requiresConfirmation: boolean;
  confirmationChannel?: "page-toast" | "extension-ui";
  reason: string;
}
```

所有工具在执行前统一经过：

```text
解析请求
  → 工具开关检查
  → 站点权限检查
  → 风险策略
  → 用户确认
  → 实际执行
  → 输出脱敏
  → 审计事件
```

这样可以避免每个工具自行决定安全逻辑。

---

## 5. 存储使用 Repository Pattern

适用于：

* allowlist
* settings
* permission state
* schema version
* audit preferences

例如：

```typescript
interface AllowlistRepository {
  list(): Promise<AllowedOrigin[]>;
  add(origin: AllowedOrigin): Promise<void>;
  remove(origin: AllowedOrigin): Promise<void>;
  reconcilePermissions(): Promise<PermissionDrift[]>;
}
```

Repository 的目的不是抽象 Chrome，而是把“存储格式”和“业务规则”分开，方便：

* 数据迁移
* 单元测试
* 权限漂移检查
* 后续企业策略覆盖

---

# 四、协议和契约治理——本轮最优先事项

## 1. 当前问题

工具信息当前至少存在于：

* Rust `tools.rs`
* TypeScript `ops.ts`
* background dispatch
* content dispatch
* Options 工具列表
* Python E2E
* DOM 测试
* README 工具文档

项目已经通过测试读取 Rust 源文件并使用正则提取工具名，检查 TypeScript 工具列表是否一致。这是一个很好的临时防线，但它仍然是“解析代码文本验证另一份代码文本”，扩展性有限。

## 2. 建立协议单一信源

建议新增：

```text
contracts/
├── tools.json
├── bridge-request.schema.json
├── bridge-response.schema.json
├── errors.json
├── capabilities.json
└── protocol-version.json
```

`tools.json` 示例：

```json
{
  "name": "page_eval",
  "description": "Execute JavaScript in the active page",
  "risk": "critical",
  "scope": "page",
  "permission": "host",
  "confirmation": "every-call",
  "input": {
    "type": "object",
    "additionalProperties": false,
    "required": ["code"],
    "properties": {
      "code": {
        "type": "string",
        "minLength": 1,
        "maxLength": 50000
      }
    }
  }
}
```

通过代码生成产生：

```text
generated/
├── rust/tool_metadata.rs
├── rust/bridge_types.rs
├── ts/tool-metadata.ts
├── ts/bridge-types.ts
└── docs/tools.md
```

Handler 仍然手写，但以下内容必须生成：

* 工具名称
* 参数类型
* JSON Schema
* 风险级别
* 权限要求
* Options 工具列表
* 工具文档
* Rust/TS operation union
* 基础契约测试

## 3. 增加兼容性握手

当前 MCP 侧返回自己的版本，但 Native Host、扩展与 MCP Server 之间缺少完整的能力协商。

连接 hello 建议改为：

```json
{
  "type": "hello",
  "secret": "...",
  "protocolVersion": 2,
  "hostVersion": "0.2.0",
  "extensionVersion": "0.2.0",
  "capabilities": [
    "page_snapshot",
    "page_eval",
    "cookie_read"
  ]
}
```

不兼容时必须快速失败，并给出明确提示：

```text
Extension 0.1.0 is incompatible with server 0.3.0.
Please reload or upgrade the extension.
```

不能等到具体工具调用后再出现“unknown op”。

## 4. 统一错误协议

建议跨进程统一：

```json
{
  "id": 123,
  "ok": false,
  "error": {
    "code": "USER_DENIED",
    "message": "The user rejected this action",
    "retryable": false,
    "userAction": null,
    "details": {}
  }
}
```

错误分类至少包括：

```text
INVALID_ARGUMENT
NOT_CONNECTED
PROTOCOL_MISMATCH
EXTENSION_NOT_READY
SITE_NOT_ALLOWED
HOST_PERMISSION_MISSING
TOOL_DISABLED
USER_DENIED
CONFIRMATION_TIMEOUT
TAB_NOT_FOUND
UNSUPPORTED_PAGE
EXECUTION_FAILED
PAYLOAD_TOO_LARGE
RESPONSE_TIMEOUT
CONNECTION_LOST
INTERNAL_ERROR
```

错误码用于程序处理，message 用于模型和用户理解。

---

# 五、安全治理

## 1. 安全必须成为独立治理领域

项目会操作用户真实登录态浏览器，读取 Cookie、Storage，并可执行 JavaScript，因此不能只依赖一般代码评审。

当前贡献文档已经明确提出安全模型变更需要 ADR，这是正确方向。

但仓库目前 `.github` 下只有 workflows，根目录也未看到独立的 `SECURITY.md`、安全报告流程、威胁模型或 CODEOWNERS。

建议新增：

```text
SECURITY.md
docs/security/
├── threat-model.md
├── trust-boundaries.md
├── tool-risk-matrix.md
├── secure-development.md
└── incident-response.md
```

## 2. 建立工具风险矩阵

| 级别       | 典型工具                             | 默认策略           |
| -------- | -------------------------------- | -------------- |
| Low      | snapshot、scroll、wait             | allowlist 后执行  |
| Medium   | text、screenshot、storage metadata | allowlist、输出脱敏 |
| High     | fill、link click、close tab        | 用户确认或策略确认      |
| Critical | eval、提交订单、Cookie value           | 每次独立确认、强审计     |

每个工具必须声明：

* 读取什么
* 修改什么
* 是否访问凭证
* 是否触发网络请求
* 是否产生不可逆后果
* 需要哪个 Chrome permission
* 使用哪个确认通道
* 返回数据如何脱敏
* 是否允许免确认窗口

## 3. 安全变更门禁

以下变更必须增加 Security Review 标签并更新威胁模型：

* 新增 Chrome permission
* 新增 host permission
* 增加 Cookie 或 Storage 能力
* 修改用户确认逻辑
* 修改 allowlist
* 增加网络请求能力
* 扩大 `page_eval`
* 改变脱敏逻辑
* 增加外部通信
* 修改 Native Messaging 鉴权
* 修改锁文件或 secret 生命周期

PR 模板中必须出现：

```text
[ ] 是否改变权限范围
[ ] 是否改变信任边界
[ ] 是否读取新的敏感数据
[ ] 是否执行新的写操作
[ ] 是否需要更新 ADR
[ ] 是否需要更新 threat model
[ ] 是否已增加负向安全测试
```

## 4. 依赖与供应链治理

建议增加：

* Dependabot 或 Renovate — ✅ 已落地(`.github/dependabot.yml`)
* `cargo audit` — ✅ 已落地(`.github/workflows/security.yml`)
* `cargo deny` — ✅ 已落地(`deny.toml` + CI)
* npm dependency audit — ✅ 已落地(`security.yml` 的 `npm audit --audit-level=high`)
* license allowlist — ✅ 由 `cargo deny` 的 licenses 段覆盖
* SBOM — ✅ 已落地:`.github/workflows/sbom.yml` 在 release 发布后,由 syft 从提交的
  锁文件(`Cargo.lock` + `extension/package-lock.json`)生成 CycloneDX JSON
  (`browser-bridge.cdx.json`)并作为资产附加到 GitHub Release。该工作流与 `release.yml`
  解耦(触发于 `release: published`),因此 SBOM 工具异常不会阻塞二进制发布。
* GitHub Actions 固定到 commit SHA — ✅ 已落地(所有 Action 固定到 SHA)
* release artifact checksum — ✅ 已落地(`.tar.gz.sha256`)
* release provenance/attestation — ✅ 已落地(`release.yml` 的 `actions/attest-build-provenance`
  步骤,已 SHA 固定);至此 checksum + SBOM + provenance 三项发布产物完备

治理后 Actions 已固定到 commit SHA(见各 workflow),Dependabot 负责自动更新这些 SHA。

治理后应类似：

```yaml
uses: actions/checkout@<full-commit-sha>
```

Dependabot 再负责自动更新 Action SHA。

## 5. 协议 Fuzzing

优先 fuzz 的对象：

* Native Messaging 长度头
* NDJSON 行解析
* 超大 JSON
* 非 UTF-8 数据
* 深度嵌套 JSON
* 缺字段 BridgeReq
* 错误类型字段
* 重复 ID
* 超大截图和 eval 返回结果
* 锁文件内容
* hello/auth 消息

Rust 可以使用：

* `cargo-fuzz`
* `proptest`

协议解析是边界代码，比普通 UI helper 更值得做 fuzz。

---

# 六、配置治理

## 1. 做得好的地方

当前 `settings.ts` 已经声明自己是配置及默认值的单一事实来源，background、content 和 options 可以直接 import。

但文档和部分注释仍然声称多个 DEFAULTS 需要人工同步。

这说明已经出现了典型的**文档漂移**：

```text
代码已经治理
但贡献文档和注释没有同步
```

因此不能只治理代码，还需要治理文档更新机制。

## 2. 配置分层

将配置分为三类：

### 用户偏好

* Toast 超时时间
* 是否开启某工具
* 日志级别
* 默认 snapshot 模式

### 安全策略

* 是否允许 eval
* 是否允许所有站点
* 确认窗口
* Cookie 返回级别
* 高风险动作确认通道

### 系统状态

* 配置 schema version
* 已安装版本
* 权限同步状态
* 最近成功连接时间

安全策略不应与一般 UI 偏好混在一起处理。

## 3. 配置版本和迁移

```typescript
interface PersistedConfig {
  schemaVersion: 2;
  preferences: Preferences;
  policy: SecurityPolicy;
}
```

扩展升级时执行 migration：

```text
v1 → v2
v2 → v3
```

不能假定用户 storage 永远符合当前接口。

---

# 七、测试与质量治理

## 1. 当前测试基础较好

现有体系包括：

* Rust unit tests
* TypeScript shared module tests
* Python protocol E2E
* DOM tests
* MV3 service worker Smoke tests
* 可选真实集成测试

这是项目非常值得保留的优势。

## 2. 目标测试分层

```text
        少量真实浏览器端到端测试
             集成与故障恢复测试
              协议契约测试
          Rust / TypeScript 单元测试
```

### 单元测试

覆盖：

* 参数验证
* 风险决策
* allowlist 规则
* URL 规范化
* 脱敏
* 配置迁移
* 状态迁移
* 错误映射

### 契约测试

从 `contracts/` 自动产生：

* Rust 序列化结果能被 TS 解码
* TS 序列化结果能被 Rust 解码
* 所有 Tool Schema 合法
* 所有工具都有风险等级
* 所有工具都有 handler
* Options 中不存在未知工具
* README 工具表由生成器产生

### 集成测试

重点补齐：

* Session 重连
* 旧连接与新连接竞争
* 请求发送时断线
* 用户确认超时
* Chrome permission 漂移
* Service Worker 重启
* Native Host 崩溃
* MCP Client 重启
* Extension 版本不兼容

### 真实浏览器测试

真实 Native Messaging 集成测试不一定每个 PR 都运行，可以采用：

* PR：Ubuntu headless/虚拟显示测试
* main：macOS 真实集成
* nightly：Chrome stable/beta
* release：完整 macOS 集成门禁

## 3. 多平台矩阵

项目需求当前明确聚焦 macOS Chrome，但 CI 主要在 Ubuntu 上执行。

建议：

| 平台            | CI 内容                                           |
| ------------- | ----------------------------------------------- |
| Ubuntu        | lint、unit、protocol、DOM                          |
| macOS         | build、install test、Native Messaging integration |
| Windows       | 暂只 compile，正式支持后再开放                             |
| Chrome stable | 必测                                              |
| Chrome beta   | nightly 提前发现兼容问题                                |

## 4. 覆盖率策略

不要把 100% 覆盖率作为目标。

建议按模块设置：

* 协议解析：90%+
* 安全策略：90%+
* 状态机：90%+
* Tool 参数验证：90%+
* 普通 DOM helper：60%～80%
* UI 渲染：以关键路径 E2E 为主

更重要的是覆盖失败路径，而不是只提高行覆盖率。

---

# 八、可观测性治理

当前已经有基于 `BB_LOG` 的分级 stderr 日志，这是正确起点。

下一步应从“打印日志”升级为“可关联事件”。

## 1. 全链路 request ID

每次工具请求应保留：

```text
MCP request id
bridge request id
connection generation
tool name
tab id
origin
confirmation id
```

全链路统一字段：

```json
{
  "timestamp": "...",
  "level": "info",
  "component": "session",
  "event": "tool.completed",
  "requestId": "req-123",
  "connectionId": "conn-8",
  "tool": "page_snapshot",
  "durationMs": 83,
  "result": "success"
}
```

## 2. Debug 日志与审计日志分离

### Debug 日志

用于排障：

* 连接建立
* 重连
* 帧大小
* 请求耗时
* Chrome API 错误

### 审计事件

用于回答：

* 哪个客户端请求了什么工具
* 目标 origin 是什么
* 风险级别是什么
* 用户是否确认
* 是否读取敏感数据
* 是否成功

审计中不能记录：

* 页面全文
* Cookie value
* Storage value
* eval 完整返回值
* 表单填写值
* 用户凭证

## 3. 诊断命令

建议实现：

```bash
browser-bridge doctor
```

输出：

```text
Binary version                 OK 0.2.0
Extension expected version     OK 0.2.0
Native host manifest           OK
Extension ID                   OK
Lock file permissions          OK 0600
Current MCP server             OK pid=...
Native host connection         OK
Chrome host permissions        WARNING 1 drift detected
Protocol compatibility         OK v2
Last successful request        12s ago
```

这会显著减少安装和支持成本。

---

# 九、研发流程治理

## 1. 分支策略

使用简单的 trunk-based development：

```text
main
 ├── feature/...
 ├── fix/...
 └── refactor/...
```

不建议引入长期 `develop` 分支。

`main` 规则：

* 禁止直接 push
* 必须 PR
* 必须 CI 全绿
* 必须解决 review conversation
* 禁止 force push
* 安全类 PR 需要额外审查
* 合并后自动删除分支

即使目前只有一名主要开发者，也建议通过 PR 自审和自动门禁，避免绕过测试。

## 2. PR 模板

```text
## 变更目的

## 方案说明

## 影响范围
- [ ] Rust MCP server
- [ ] Native Host
- [ ] Extension background
- [ ] Content script
- [ ] Protocol
- [ ] Permission/security
- [ ] Installer/release

## 测试
- [ ] Unit
- [ ] Contract
- [ ] Protocol E2E
- [ ] Browser
- [ ] Manual Chrome verification

## 契约和文档
- [ ] Tool contract 已更新
- [ ] CHANGELOG 已更新
- [ ] ADR 不需要 / 已增加
- [ ] Threat model 不需要 / 已更新
```

## 3. ADR 与 RFC 的区别

继续保留 ADR，但增加轻量 RFC：

### ADR

记录已经作出的架构决策：

* 为什么选择单二进制
* 为什么选择 localhost TCP
* 为什么确认使用某种 UI

### RFC

用于改动前讨论：

* 多客户端 Broker
* 新的写 Cookie 能力
* 引入 Tokio
* 新协议版本
* 支持 Edge/Firefox
* 企业集中策略

流程：

```text
RFC Proposed
  → Discussion
  → Accepted / Rejected
  → 实施
  → ADR 记录最终决定
```

## 4. Definition of Done

每个功能完成必须满足：

* 参数有类型和 Schema。
* 工具有风险等级。
* 权限路径已明确。
* 正向和负向测试存在。
* 错误码已定义。
* 日志不包含敏感数据。
* 文档或生成文件已更新。
* CHANGELOG 已处理。
* CI 全绿。
* 不引入未解释的 `any`、`unwrap` 或新 permission。

## 5. 技术债登记

技术债不要散落在注释和个人记忆中。

GitHub Issues 使用标签：

```text
type:feature
type:bug
type:refactor
type:security
type:docs
type:technical-debt

area:rust
area:extension
area:protocol
area:installer
area:testing
area:release

priority:P0
priority:P1
priority:P2
priority:P3
```

每个技术债 Issue 应写：

* 当前问题
* 风险
* 暂时方案
* 目标方案
* 触发处理的条件
* 预计影响模块

---

# 十、发布与版本治理

## 1. 当前问题

当前 `make release` 主要执行版本检查和 CI，然后提示开发者手动打 tag；GitHub 仓库当前也尚未发布 Release。

这意味着：

* 构建环境不可完全追溯
* 发布包由谁构建不确定
* 没有标准 extension zip
* 没有 checksum
* 没有自动 release notes
* 缺少升级路径
* 二进制和扩展版本兼容依赖人工控制

## 2. 目标发布流水线

Tag：

```text
v0.2.0
```

自动触发：

```text
检查版本一致性
  → 完整 CI
  → macOS arm64 build
  → macOS x64 build
  → Extension build
  → Extension zip
  → 生成 SHA256SUMS
  → 生成 SBOM
  → 生成 provenance
  → 创建 GitHub Release
  → 发布 release notes
```

Release 内容：

```text
browser-bridge-v0.2.0-darwin-arm64.tar.gz
browser-bridge-v0.2.0-darwin-x64.tar.gz
browser-bridge-extension-v0.2.0.zip
install.sh
uninstall.sh
SHA256SUMS
sbom.spdx.json
```

## 3. SemVer 规则

### Patch

* Bug 修复
* 内部重构
* 日志改进
* 不改变工具参数和安全语义

### Minor

* 新增工具
* 新增可选字段
* 新增 capability
* 新增配置
* 向后兼容协议能力

### Major

* 删除或改名工具
* 修改字段含义
* 更改默认权限
* 放宽安全边界
* 不兼容 Bridge protocol
* 不兼容扩展版本

在 1.0 之前也要建立兼容纪律，不能把 `0.x` 当作任意破坏兼容的理由。

---

# 十一、文档治理

项目已经把 `docs/` 定义为需求、架构和 ADR 的单一信源，这是很好的治理意识。

下一步需要解决：

* 文档与代码漂移
* README 工具列表手工维护
* 注释描述旧架构
* ADR 状态和实际代码不一致
* 文档中承诺的行为没有自动验证

## 治理措施

1. 工具表从 contract 自动生成。
2. 配置表从 Settings Schema 自动生成。
3. CI 检查生成文件无差异。
4. ADR 增加状态：

   * Proposed
   * Accepted
   * Superseded
   * Deprecated
5. 每个 ADR 增加：

   * Decision date
   * Owners
   * Consequences
   * Validation tests
6. 对过期注释建立专项清理。
7. 文档中的命令必须在 CI 中运行验证。
8. 支持矩阵必须写清楚：

   * macOS 版本
   * Chrome 版本
   * CPU 架构
   * MCP 协议版本
   * Extension/Binary 兼容范围

---

# 十二、分阶段治理路线图

## P0：建立治理底座

建议周期：第一轮治理迭代。

### 任务

1. ✅ 已落地 暂缓新增底层工具(本轮无新增底层工具)。
2. ✅ 已落地 建立 `GOVERNANCE.md`。
3. ✅ 已落地 建立 `SECURITY.md` 和 Threat Model(`docs/security/threat-model.md`)。
4. ✅ 已落地 增加 PR 模板、Issue 模板和标签体系(`.github/pull_request_template.md`、`.github/ISSUE_TEMPLATE/`)。
5. ✅ 已落地 保护 `main` 分支并设置 required checks(现已生效)。
6. ✅ 已落地 增加 `rust-toolchain.toml`。
7. ✅ 已落地 增加 Dependabot(`.github/dependabot.yml`)。
8. ✅ 已落地 增加 `cargo audit`、`cargo deny`(`.github/workflows/security.yml` + `deny.toml`)。
9. ✅ 已落地 GitHub Actions 固定 SHA(所有 Action 固定到 commit SHA)。
10. ✅ 已落地 清理过期注释和贡献文档(配置改为 `settings.ts` 单源,DEFAULTS 同步描述已订正)。
11. ✅ 已落地 定义工具风险矩阵(`docs/security/tool-risk-matrix.md`)。
12. ✅ 已落地 给现有 15 个工具补齐风险、权限、敏感数据属性(`tools.json` 的 `risk`/`scope`/`permission`)。

### 验收标准

* 每个工具都有风险等级。
* 所有安全变更都有明确门禁。
* 开发环境版本可复现。
* 仓库有明确的漏洞报告渠道。
* 文档不存在已知的 DEFAULTS 同步错误描述。
* main 不能绕过 CI 合并。

---

## P1：协议和代码结构治理

### 任务

1. ✅ 已落地 建立 `contracts/`(`tools.json`/`errors.json`/`capabilities.json`/`protocol-version.json` + 本轮新增两份 envelope schema)。
2. ✅ 已落地 从契约生成 Rust/TS 工具名称和类型(`scripts/gen-ops.mjs` → `ops.ts`;Rust `matches_contract` 校验)。
3. ⬜ 未做 `BridgeReq` 改为 typed/discriminated union(仍是宽 `op:string` + 扁平 `args`;本轮 schema 描述的是现状)。
4. ✅ 已落地 统一跨进程错误码(`errors.json` + `CallError.code`,`cargo test` 校验映射)。
5. ⚠ 部分 增加协议和能力版本握手(`protocol-version.json` + `capabilities.json` 契约已定义,代码侧 wiring 待接线,见 [compatibility.md](./compatibility.md))。
6. ✅ 已落地 Rust 新增 `lib.rs`(本轮 `src/lib.rs` 拆分)。
7. ✅ 已落地 拆分 `tools.rs`(Tool Registry + 目录模块拆分:`src/tools/mod.rs` / `catalogue.rs` / `handlers.rs`)。
8. ✅ 已落地 建立 Tool Registry(`src/tools/mod.rs` 的 `HANDLERS`,见 [RFC-0002](./rfc/0002-tool-registry.md))。
9. ⚠ 部分 将 Session 改为显式连接状态机(仅 RFC-0001 首阶段的 generation-guard;完整 5 态机待办)。
10. ✅ 已落地 Pending request 绑定 connection generation(generation-guarded 重连,RFC-0001 首阶段)。
11. ⬜ 未做 增加重连、超时和迟到响应**集成**测试(需真实浏览器,browser-gated;单元层已有 generation 相关覆盖)。
12. ✅ 已落地 Policy 层统一处理权限和确认(`policy.ts`,已接入 dispatch)。

### 验收标准

* 工具名不再跨语言手工复制。
* TS 无法构造明显非法的 Tool 请求。
* 扩展和二进制版本不匹配时快速失败。
* 所有错误都有稳定 error code。
* 旧连接无法清除或影响新连接。
* 新增工具只需要修改契约、一个 handler 和对应测试。

---

## P2：发布与运维治理

### 任务

1. ✅ 已落地 Tag 驱动 Release workflow(`release.yml`,见 [release.md](./release.md))。
2. ⚠ 部分 生成预编译二进制和 Extension zip(预编译 tarball 内含二进制 + `extension/dist`;未单独产出扩展 zip)。
3. ✅ 已落地 生成 checksum、SBOM 和 provenance(checksum ✅ `.tar.gz.sha256`;SBOM ✅ `sbom.yml`/CycloneDX;provenance ✅ `release.yml` 的 `attest-build-provenance`,已 SHA 固定)。
4. ⚠ 部分 实现 install、upgrade、uninstall(install ✅ 双模式 `install.sh`;uninstall ✅ 本轮新增;upgrade ⬜)。
5. ✅ 已落地 实现 `doctor` 和 `status`(见 [cli.md](./cli.md)、[operations.md](./operations.md))。
6. ✅ 已落地 增加结构化日志(`BB_LOG_FORMAT=json`,见 [ADR-0014](./adr/0014-leveled-logging.md))。
7. ✅ 已落地 增加 request ID 和 connection ID(request id ✅;日志/审计行的 connection id ✅,`mcp_server.rs` 的 `conn` 字段,由 `Session::current_generation()` 提供)。
8. ✅ 已落地 增加脱敏审计事件(`tools/call` 审计行,见 [operations.md](./operations.md))。
9. ⬜ 未做 macOS 真实集成测试进入 release gate(需真实浏览器,browser-gated)。
10. ✅ 已落地 增加 Chrome stable/beta nightly 测试(本轮新增 `nightly.yml`)。

### 验收标准

* 发布不需要开发者本机手工构建。
* 用户可以诊断安装和版本问题。
* 每个失败请求可以通过 request ID 定位。
* 二进制和扩展发布包来源可验证。
* 新版本可以明确判断兼容与否。

---

## P3：产品化扩展

只有在出现明确需求后再进行：

* ⬜ 未做 多 MCP 客户端 Broker
* ⬜ 未做 多 Agent 并发和 tab lease
* ⬜ 未做 企业集中策略
* ⬜ 未做 扩展自有高风险确认窗口
* ⬜ 未做 组织级 allowlist
* ⬜ 未做 集中审计
* ⬜ 未做 Edge 支持
* ✅ 已落地 Windows 支持(见 [ADR-0015](./adr/0015-windows-support.md);另有 Linux/WSL,[ADR-0016](./adr/0016-linux-wsl-support.md))
* ⬜ 未做 Skill 层
* ⬜ 未做 操作录制与回放

不要在 P0/P1 阶段提前引入这些复杂度。

---

# 十三、建议建立的治理文件

状态图例:✅ 已落地 / ⚠ 部分 / ⬜ 未做(「本轮」= 本次治理迭代新增)。

```text
browser-bridge/
├── GOVERNANCE.md                          # ✅
├── SECURITY.md                            # ✅
├── rust-toolchain.toml                    # ✅
├── deny.toml                              # ✅
├── contracts/
│   ├── tools.json                         # ✅
│   ├── bridge-request.schema.json         # ✅ 本轮
│   ├── bridge-response.schema.json        # ✅ 本轮
│   ├── capabilities.json                  # ✅(此列表原稿未列出)
│   ├── protocol-version.json              # ✅(此列表原稿未列出)
│   └── errors.json                        # ✅
├── docs/
│   ├── compatibility.md                   # ✅ 本轮
│   ├── release.md                         # ✅ 本轮
│   ├── operations.md                      # ✅ 本轮
│   └── security/
│       ├── threat-model.md                # ✅
│       ├── trust-boundaries.md            # ✅
│       ├── tool-risk-matrix.md            # ✅
│       └── incident-response.md           # ✅ 本轮
└── .github/
    ├── CODEOWNERS                         # ✅
    ├── dependabot.yml                     # ✅
    ├── pull_request_template.md           # ✅
    ├── ISSUE_TEMPLATE/
    │   ├── bug.yml                         # ✅
    │   ├── feature.yml                     # ✅
    │   └── security-change.yml             # ✅
    └── workflows/
        ├── ci.yml                          # ✅
        ├── security.yml                    # ✅
        ├── nightly.yml                     # ✅ 本轮
        └── release.yml                     # ✅
```

---

# 十四、不要做的事情

本轮治理应避免：

1. 不要整体重写。
2. 不要为了“统一语言”把扩展逻辑迁移到 Rust/WASM。
3. 不要现在拆微服务。
4. 不要未经需求驱动就引入 Tokio。
5. 不要为了模式而模式，建立大量空接口。
6. 不要追求所有代码 100% 测试覆盖率。
7. 不要继续通过注释要求开发者“记得同步”。
8. 不要让新增工具继续复制到五六个列表中。
9. 不要先增加更多高权限工具，再补安全治理。
10. 不要同时进行架构重构、协议破坏性修改和大量新功能。

---

# 十五、最终优先级

最值得立即投入的五项治理工作是：

## 1. 契约单一信源

消灭 Rust、TS、Options、测试和文档之间的工具定义重复。

## 2. 显式连接状态机

治理重连、旧连接、pending 请求、超时和版本兼容问题。

## 3. 安全治理制度

建立 Threat Model、工具风险矩阵、Security Review 和漏洞报告流程。

## 4. 自动化发布

从“本地 make release + 手工打 tag”升级为可验证的标准发布流水线。

## 5. 可观测与诊断

建立结构化日志、request ID、审计事件和 `doctor` 命令。

完成这五项后，`browser-bridge` 会从一个“由作者本人能够正确维护的优秀项目”，升级为一个“其他工程师也可以安全理解、修改、测试和发布的产品工程”。
