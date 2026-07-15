# ADR-0017:CDP 模式 —— 所有页面操作可选走 chrome.debugger

- **状态**:Accepted
- **日期**:2026-07-15
- **关联**:[ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md)(默认走 content script)、[ADR-0009](./0009-page-snapshot-precise-debugger.md)(precise 单点用 CDP)、[ADR-0008](./0008-page-eval-confirmation-channel.md)(page_eval 确认通道)

## 背景

默认路径下,页面级操作(snapshot / click / fill / text / screenshot / scroll / wait_for / eval / storage_get)由 background 注入 content script,再经 `chrome.tabs.sendMessage` 执行(ADR-0003 的决定:避免 chrome.debugger 的「正在调试此浏览器」横幅)。

这个路径有一个硬限制:**严格 CSP 站点**(如 Bing、GitHub 等设置了 `script-src` 且不含 `unsafe-eval` 的站点)会阻止 content script 里的 `new Function` / `eval`,导致 `page_eval` 直接失败。ADR-0009 已经证明:`chrome.debugger` 的 `Runtime.evaluate` 在页面 **MAIN world** 执行,不受页面 CSP 约束(因为不是页面自己在 eval,而是调试器在求值)。ADR-0009 只把 CDP 用在 `page_snapshot_precise` 一个工具上(attach→取树→detach,横幅只闪现)。

需求:提供一个**全局开关**,让**所有**页面操作都改走 CDP,从而:

- 在严格 CSP 站点也能执行 `page_eval`;
- 与「Started debugging this browser」横幅行为一致的深度控制(统一走 MAIN world)。

## 决策

**新增用户设置 `cdpMode`(默认 `false`)。开启后,dispatch 把所有页面级操作路由到 CDP 后端;关闭时行为与今天逐字节一致(仍走 content script)。**

用三个模式组织实现(`extension/src/background/`):

| 角色 | 模块 | 职责 |
|------|------|------|
| **Strategy** | `page-backend.ts` | `PageBackend` 接口 + `selectBackend(cdpMode)`;两个实现:`ContentScriptBackend`(现有路径,原样抽取)与 `CdpBackend` |
| **Facade** | `cdp/session.ts` | `CdpSession` 封装单个 tab 的 `chrome.debugger`;`attach/detach/send/evaluate/screenshot`;并导出 `dbgAttach/dbgDetach/dbgSend/isDebuggable` 供 precise.ts 复用(DRY) |
| **Registry** | `cdp/registry.ts` | `CdpSessionRegistry` 单例,`Map<tabId, CdpSession>`;懒加载 attach 并**持久保持**(横幅在 CDP 模式期间常驻,by design);tab 关闭 / onDetach / `cdpMode` 关闭时 teardown |
| **可移植页面函数** | `cdp/page-fns.ts` | 自包含函数(无 import、不闭包模块作用域),被 `toString()` 后经 `Runtime.evaluate` 在页面执行,逐一忠实移植 content 各 op 的 DOM 逻辑 |

关键设计点:

- **统一 ref**:CDP 的 `page_snapshot` 跑与 `content/snapshot.ts` **相同的 DOM 遍历算法**(不是 AX 树 —— 那是 `page_snapshot_precise`),打**相同的 `data-zcb-ref="eN"`** 属性。因此 CDP 与 content 两条路径的 ref 完全互通,`page_click`/`page_fill` 通过 DOM 属性查找即可解析。
- **无 content script 的确认**:高危 click 与 `page_eval` 的确认 Toast 通过 `Runtime.evaluate`(`awaitPromise:true`)在页面里构建并 resolve 用户选择;因为 CDP 模式下不注入 `toast.css`,Toast 样式内联。设置门槛(`confirmHighRiskClick`/`pageEvalEnabled`/`evalMask`)、60s 同源免确认宽限期(`confirmGraceMs`)、`isHighRiskClick` 判定,全部与 content 路径一致,宽限期状态保存在 SW。
- **序列化/脱敏**:`page_eval` 用 CDP `returnByValue` 拿回值,再在 SW 复用 `shared/masking.ts` 脱敏;`storage_get` 在页面读原始值、在 SW 脱敏(始终开启,ADR-0010)。
- **screenshot**:CDP 下优先用 `Page.captureScreenshot`,不走页面函数。
- **DRY**:`precise.ts` 改为从 `cdp/session.ts` import `dbgAttach/dbgDetach/dbgSend/isDebuggable`,删除私有副本,行为不变。
- **contracts 不变**:这是执行路径开关,不是工具契约变更,`contracts/` 与工具定义均无改动。

## 考虑过的替代方案

### 方案 A:只让 `page_eval` 在 CSP 站点走 CDP(其余不变)
- **优点**:改动最小,横幅只在 eval 时闪现
- **缺点**:snapshot/click/fill 仍在 content world,ref 体系要在两条路径间来回;「CSP 站点」检测不可靠(需先失败再回退);用户对「什么时候走哪条路」不可预期
- **未被选**:需求是**统一**的深控开关,而非单工具补丁

### 方案 B:默认就走 CDP(去掉 content script 路径)
- **优点**:实现单一,无双路径
- **缺点**:横幅**永久常驻**,访问面变大,违背 ADR-0003 的默认取舍;绝大多数站点并不需要 CSP 绕过
- **未被选**:默认必须保持 content script、无横幅

### 方案 C:把页面逻辑打包成一个大字符串手工维护
- **缺点**:与 content 源码漂移风险高
- **未被选**:改用「导出真实 TS 函数 + `toString()`」,由 tsc/eslint/prettier 校验,构建期验证自包含

## 后果

### 正面
- **CSP 绕过**:严格 CSP 站点(Bing 等)也能 `page_eval`
- **统一深控**:所有页面 op 走 MAIN world;ref 与 content 路径互通
- **DRY**:`chrome.debugger` 原语单点(`cdp/session.ts`),precise 复用
- **默认零回归**:`cdpMode` 关闭时,dispatch 走原 `ContentScriptBackend`,逐字节等价

### 负面(安全权衡)
- **横幅常驻**:CDP 模式期间,session 持久 attach,「正在调试此浏览器」横幅一直显示(所有标签页可见)——这是刻意的知情信号
- **访问面更大**:调试器全程附加,理论攻击面比「用完即走」的 precise 大
- **CSP 被绕过**:page_eval 在严格 CSP 站点也能运行(这正是目的,但意味着少了一层纵深防御)
- **序列化差异**:CDP `returnByValue` 的序列化与 content 的 `serializeResult` 不完全一致(见「风险」),但均经同一 `maskSensitive` 脱敏
- **性能**:多次 `Runtime.evaluate` 往返比 content 的一次 `sendMessage` 略慢

### 中性
- 默认关闭;仅在需要 CSP 绕过或统一深控时由用户在 Options 页显式开启
- DevTools 已打开的 tab 无法 attach(与 precise 相同限制)

## 实施

- `extension/src/background/page-backend.ts`、`backends/content-script.ts`、`backends/cdp.ts`
- `extension/src/background/cdp/{session,registry,page-fns,click-risk}.ts`
- `extension/src/background/dispatch.ts`:页面块改为 `selectBackend(cdpMode).run(op, args, tab)`
- `extension/src/background/precise.ts`:复用 `cdp/session.ts` 原语
- `extension/src/background.ts`:启动时 `installCdpLifecycleListeners()`
- `extension/src/shared/{types,settings}.ts`:新增 `cdpMode`(默认 false)
- `extension/options.html` + `options.ts`:新增「执行模式」设置卡
- 单元测试:`selectBackend`、`isHighRiskClick`/`describeAction`/`describeForToast`、`isDebuggable`、`buildEvaluateExpression`、page-fn 自包含
