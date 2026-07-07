# ADR-0005:page_eval 默认禁用

- **状态**:Superseded by [ADR-0008](./0008-page-eval-confirmation-channel.md)
- **日期**:2026-07-07

> **已 superseded**:本 ADR 决定"v0.1 不实现 page_eval"。v0.1 交付后进入阶段二,
> [ADR-0008](./0008-page-eval-confirmation-channel.md) 实现了 page_eval 的高危确认通道。
> 本文档保留作为历史记录,记录当时的取舍与攻击面分析(仍有效)。

## 背景

`page_eval`——在页面上下文执行任意 JavaScript——是浏览器自动化里**权力最大也最危险**的能力。

强大的原因:几乎能干任何事(读 JS 变量、触发自定义事件、调用页面 API、绕过 UI 直接操作)。

危险的原因:**只要 AI 的指令被诱导(提示注入),就能在用户已登录的页面里**:
- 窃取 `localStorage` / `sessionStorage` 里的 token
- 读 `document.cookie`(扩展有 host 权限就能拿到)
- 调用页面的 fetch/XHR 以用户身份发请求(转账、删数据)
- 读 DOM 里任何敏感信息(信用卡号、私信内容)

这比 `page_click`/`page_fill` 危险得多——后两者至少在 UI 层面可观测(用户能看到点击/输入发生),而 `eval` 是无声的。

## 决策

**v0.1 完全不实现 `page_eval` 工具。**

阶段二再加,且必须满足:
1. 走**单独的高危确认通道**(区别于 [ADR-0006](./0006-toast-confirmation-for-high-risk.md) 的页面 Toast,可能需要更强的确认,如弹独立窗口显示完整 JS 代码)
2. 默认对返回值脱敏(遮罩疑似 token/长字符串)
3. 在工具描述里强制 AI 解释为什么需要 eval(让模型显式 acknowledge 风险)

## 考虑过的替代方案

### 方案 A:实现 eval,高危确认(用户在决策时的"默认禁用,需高危确认"选项)
- **机制**:工具存在但每次调用走确认通道
- **优点**:能力完整,需要时能用
- **缺点**:v0.1 就引入最大攻击面
- **v0.1 处理**:用户选了这个方向,但**v0.1 实施时干脆不实现**,把"高危确认通道"的设计推到阶段二。理由是 v0.1 的 11 个工具已覆盖 90% 场景,eval 不是必需;先把基础架构和安全模型跑稳

### 方案 B:完全禁用,永不实现
- **优点**:永久消除最大攻击面
- **缺点**:遇到复杂交互(触发自定义事件、读 JS 变量、SPA 路由)无能为力
- **未被选**:用户选了"默认禁用 + 高危确认",意味着认可有条件开放

### 方案 C:开放 eval,无特殊确认
- **优点**:能力最强,实现最简
- **缺点**:攻击面最大,违背安全第一原则
- **排除**:用户明确不选

## 后果

### 正面(v0.1)
- **攻击面最小**:v0.1 的工具都是"可观测的 UI 动作",没有静默代码执行
- **审计简单**:不用设计 eval 的脱敏/确认/沙箱
- **安全模型清晰**:click/fill 受 Toast 约束,snapshot/text 是只读且脱敏

### 负面
- **复杂交互搞不定**:需要触发 `CustomEvent`、读取框架状态、操作 canvas/WebGL 的场景无能为力
- **阶段二要补**:设计高危确认通道是一笔工作量

### 中性
- v0.1 的 `page_click`/`page_fill` 用 native setter + dispatchEvent 已经能覆盖 React/Vue 等主流框架的表单,大多数自动化场景不需要 eval

## 阶段二的设计草案(未实施)

如果实现 `page_eval`,设计大致是:
- 新工具 `page_eval(code)`,默认对当前 tab 执行
- 调用时 content script 弹**独立确认窗口**(不是 Toast),显示:
  - 完整 JS 代码(可滚动)
  - 目标域名 + tab 标题
  - "执行" / "拒绝" 按钮,30 秒超时拒绝
- 返回值在送回 MCP 前脱敏(正则遮罩疑似 JWT、长 hex、长数字)
- 工具描述强制要求 AI 说明"为什么需要 eval 而不是 click/fill"

这个设计**不是承诺**,阶段二实施时可能调整。

## 与其他 ADR 的关系

- 配合 [ADR-0004](./0004-allowlist-with-optional-host-permissions.md)(白名单):白名单防陌生站点,eval 禁用防已授权站点的代码执行
- 配合 [ADR-0006](./0006-toast-confirmation-for-high-risk.md)(Toast):Toast 管 UI 动作,eval(若实现)需要更强确认
