# browser-bridge 文档

本目录是 browser-bridge 项目的**单一信源**。代码注释回答"这段代码做什么",
本目录回答"为什么这么做、要做什么、约束是什么"。

## 文档地图

| 文档 | 内容 | 读者 |
|------|------|------|
| [requirements.md](./requirements.md) | 需求:目标、用户故事、功能/非功能需求、范围边界、阶段划分 | 所有人(先读这个) |
| [architecture.md](./architecture.md) | 架构:组件、数据流、协议、安全模型、关键约束、技术选型 | 实现者、评审者 |
| [cli.md](./cli.md) | CLI 子命令与故障排查:`doctor`/`status` 只读自检、"server not reachable" 解读 | 使用者、排查者 |
| [operations.md](./operations.md) | 运维:两种二进制模式、`doctor`/`status`、`BB_LOG`/审计、锁文件、native host 重连 | 使用者、运维者 |
| [compatibility.md](./compatibility.md) | 兼容性:三种版本、内部协议版本、能力/版本握手(契约现状) | 实现者、评审者 |
| [release.md](./release.md) | 发布:tag 驱动流水线、预编译 tarball + 校验和、双模式 `install.sh`、SBOM | 发布者、评审者 |
| [security/incident-response.md](./security/incident-response.md) | 安全事件响应 Runbook:报告、分级、缓解(禁用工具/收回白名单/总开关)、披露 | 维护者、报告者 |
| [adr/](./adr/) | 架构决策记录(ADR):每一个"为什么这么选"的可追溯记录 | 评审者、未来改动者 |

> 跨进程契约(工具目录、错误分类、能力、协议版本)的单一信源在
> [`contracts/`](../contracts/README.md)。

> **开发流程**(分支/提交/同步/合并规范)见根目录 [`CONTRIBUTING.md`](../CONTRIBUTING.md);
> 智能体速查入口见 [`AGENTS.md`](../AGENTS.md)。构建/测试工具链见 [development.md](./development.md)。

## 怎么读

- **第一次了解项目** → `requirements.md` → `architecture.md`
- **要改一个设计决策** → 先读对应的 ADR,看当时的取舍,再判断要不要推翻
- **要加新功能** → `requirements.md` 的"范围边界"先确认在不在 v0.1 范围

## ADR 索引

ADR(Architecture Decision Record)记录的是**有多个合理选项、最终选了一个**的决策。
没有争议的常规选择不写 ADR。

| # | 标题 | 状态 |
|---|------|------|
| [0001](./adr/0001-use-rust-single-binary.md) | 用 Rust 单二进制 + 子命令分发 | Accepted |
| [0002](./adr/0002-three-process-architecture-localhost-tcp.md) | 三进程架构 + localhost TCP 桥接 | Accepted |
| [0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md) | snapshot 走 content script 而非 chrome.debugger | Accepted |
| [0004](./adr/0004-allowlist-with-optional-host-permissions.md) | 白名单 + optional host permissions 按需授权 | Accepted |
| [0005](./adr/0005-page-eval-disabled-by-default.md) | page_eval 默认禁用 | Superseded by #0008 |
| [0006](./adr/0006-toast-confirmation-for-high-risk.md) | 高危动作用页面 Toast + 短时免确认 | Accepted |
| [0007](./adr/0007-mcp-protocol-version-2025-06-18.md) | 锁定 MCP 协议版本 2025-06-18 | Accepted |
| [0008](./adr/0008-page-eval-confirmation-channel.md) | page_eval 高危确认通道 | Accepted |
| [0009](./adr/0009-page-snapshot-precise-debugger.md) | page_snapshot_precise 用 chrome.debugger 取权威 a11y 树 | Accepted |
| [0010](./adr/0010-cookie-storage-readonly.md) | Cookie/Storage 只读访问 | Accepted |
| [0011](./adr/0011-options-page-for-settings.md) | 配置通过独立 Options 页管理 | Accepted |

## ADR 写作约定

新增 ADR 时:
- 文件名:`NNNN-kebab-case-title.md`,编号接续最大值
- 状态:Accepted / Superseded by #NNNN / Deprecated
- 必备小节:背景、决策、考虑过的替代方案、后果
- 一条决策一篇,不混合

被推翻的 ADR **不删除**,改状态为 `Superseded by #NNNN` 并加链接,保留历史。
