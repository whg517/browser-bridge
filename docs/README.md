# browser-bridge 文档

本目录是 browser-bridge 项目的**单一信源**。代码注释回答"这段代码做什么",
本目录回答"为什么这么做、要做什么、约束是什么"。

## 文档地图

| 文档 | 内容 | 读者 |
|------|------|------|
| [requirements.md](./requirements.md) | 需求:目标、用户故事、功能/非功能需求、范围边界、阶段划分 | 所有人(先读这个) |
| [architecture.md](./architecture.md) | 架构:组件、数据流、协议、安全模型、关键约束、技术选型 | 实现者、评审者 |
| [adr/](./adr/) | 架构决策记录(ADR):每一个"为什么这么选"的可追溯记录 | 评审者、未来改动者 |

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

## ADR 写作约定

新增 ADR 时:
- 文件名:`NNNN-kebab-case-title.md`,编号接续最大值
- 状态:Accepted / Superseded by #NNNN / Deprecated
- 必备小节:背景、决策、考虑过的替代方案、后果
- 一条决策一篇,不混合

被推翻的 ADR **不删除**,改状态为 `Superseded by #NNNN` 并加链接,保留历史。
