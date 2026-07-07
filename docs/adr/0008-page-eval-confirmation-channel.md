# ADR-0008:page_eval 高危确认通道

- **状态**:Accepted
- **日期**:2026-07-07
- **取代**:[ADR-0005](./0005-page-eval-disabled-by-default.md)(v0.1 不实现的决定)

## 背景

[ADR-0005](./0005-page-eval-disabled-by-default.md) 决定 v0.1 完全不实现 `page_eval`。理由是攻击面太大——任意 JS 执行能窃取 token、Cookie、以用户身份发请求。v0.1 先把基础架构和安全模型跑稳。

v0.1 已交付并验证(协议层 e2e PASS),进入阶段二。现在要补 `page_eval`,但必须满足 ADR-0005 当时设的前提条件:**高危确认通道 + 返回值脱敏**。

## 决策

**实现 `page_eval`,采用页面内放大版 Toast 确认 + 同源 60s 免确认 + 可配置返回值脱敏(默认开):**

| 维度 | 实现 |
|------|------|
| **确认 UI** | 页面内放大版 Toast(区别于普通 Toast 的警告色调),显示完整代码(`<pre>` 可滚动)+ 目标域名 + tab 标题 + Allow/Deny,30s 超时拒绝 |
| **免确认窗口** | 复用现有 `lastConfirmed` 机制,key = `${origin}:eval`,批准后 60 秒同源 eval 不再弹 |
| **执行方式** | `new Function('"use strict"; return (async () => { <code> })()')()`——全局作用域,支持 await/return |
| **返回值脱敏** | content.js 在结果离开页面上下文**前**就脱敏(避免原始 token 走 IPC 链路)。正则覆盖 JWT/长hex/长数字/敏感关键字,递归处理。开关存 `chrome.storage.local`(`evalMask`),默认 true,popup 可关 |

## 考虑过的替代方案

### 方案 A:专用扩展窗口(chrome.windows.create)
- **优点**:不被页面 CSS 干扰;代码长也能完整看
- **缺点**:实现复杂(SW ↔ window 通信);多一个窗口打断流程;窗口可能被遮挡
- **未被选**:用户选了页面内 Toast,复用现有机制更轻

### 方案 B:每次 eval 都确认(无免确认窗口)
- **优点**:最安全
- **缺点**:连续 eval 烦人;eval 不该高频但调试场景可能连续执行
- **未被选**:用户选了同源 60s 免确认,与现有 Toast 机制一致

### 方案 C:popup 预授权开关(勾选后所有 eval 静默)
- **排除**:攻击面回到"全开放"水平,违背高危确认初衷

### 返回值脱敏的替代
- **不脱敏**:实现最简,但 token/cookie/密钥可能进 AI 上下文和日志,泄露风险大
- **强制脱敏**:最安全,但偶尔误伤正常数据
- **可配置(默认开)**:用户选这个,平衡灵活与安全

## 执行方式的技术选择:Function 构造器

**为什么不用 `eval(code)`**:
- eval 受调用点作用域限制(在 content script 闭包里调 eval,看不到页面全局变量)
- strict mode 下 eval 有自己的作用域,赋值不外泄

**为什么用 `new Function`**:
- 在全局作用域执行,能访问页面全局(window 上的变量、框架的 API)
- 支持 `return` 和 `await`(包装成 async IIFE)
- 封装:`new Function('"use strict"; return (async () => { ' + code + ' })()')()`

**已知限制**:
- 难以可靠设置执行超时(Function 构造器跑起来后,JS 单线程无法外部中断)。留作未来
- 代码语法错误会在调用时抛 `SyntaxError`,需 try/catch 并把错误信息返回

## 返回值序列化的边缘情况

eval 可能返回任意类型,需要 `serializeResult` 安全处理:

| 类型 | 处理 |
|------|------|
| 循环引用对象 | WeakSet 跟踪,遇已访问则替换为 `"[Circular]"` |
| DOM 节点 | 替换为 `"<Element tag#id>"` |
| Error | 序列化为 `{name, message, stack?}` |
| Symbol / BigInt / function | `.toString()` |
| Promise | 自动 await(已是 async 包装) |
| 超长(>10KB) | 截断 + `"[truncated]"` |

## ⚠️ 风险标注:免确认窗口对 eval 的风险高于 click

**同源 60s 免确认意味着**:用户批准第一次 eval 后,60 秒内**完全不同的第二次 eval 会静默执行**。

对比 click 场景:click 的"同类动作"(比如连续点 5 个链接)至少是相似操作;eval 的两次调用**毫无关联**——第一次可能是 `document.title`,第二次可能是 `fetch('/transfer', {...})`。

**接受这个风险的理由**:
1. eval 不该高频使用(工具描述强制 AI 优先尝试 page_click/page_fill)
2. 用户批准第一次时已经在看完整代码,有知情
3. 真正担心可在 popup 关闭整个 eval 能力(留作未来开关,本方案不做)

这个风险会在工具描述里向 AI 说明,也在 README 的安全模型表里标注。

## 后果

### 正面
- **能力补全**:复杂交互(CustomEvent、SPA 路由、读 JS 变量、canvas)能搞定
- **脱敏防泄露**:返回值离开页面前就处理,token 不走 IPC 链路
- **复用现有机制**:Toast + lastConfirmed + storage 开关,代码增量可控

### 负面
- **攻击面增大**:任意 JS 执行能力引入,即使有确认,用户误批一次就泄
- **免确认窗口风险**:如上所述,比 click 场景高
- **脱敏可能误伤**:长数字 ID、正常的长 hex(如哈希值)会被遮罩,用户可关开关
- **无执行超时**:死循环 eval 会挂住工具调用(120s session 超时会兜底,但页面卡住)

### 中性
- page_eval 不在 `tools/list` 默认排序靠前,描述强制 AI 谨慎使用

## 实施

- `src/tools.rs`:加 Tool 定义 + dispatch 分支
- `extension/content.js`:`runEval()` + `confirmWithEvalToast()` + `serializeResult()` + `maskSensitive()` + `getMaskSetting()`
- `extension/toast.css`:`.zcb-eval-card` / `.zcb-eval-code` / `.zcb-eval-meta` 警告色调
- `extension/popup.html/js`:脱敏开关
- 文档:requirements FR-3 加 page_eval;architecture §7 补 Function 选择

## 与其他 ADR 的关系

- **取代 [ADR-0005](./0005-page-eval-disabled-by-default.md)**:ADR-0005 的"v0.1 不实现"决定被本 ADR 推翻;ADR-0005 改状态为 Superseded by #0008
- **配合 [ADR-0006](./0006-toast-confirmation-for-high-risk.md)**:复用 Toast 机制,但 eval 的 Toast 更大、显示代码、警告色调
- **配合 [ADR-0004](./0004-allowlist-with-optional-host-permissions.md)**:白名单仍是第一层(站点级),eval Toast 是动作级第二层
