# ADR-0011:配置通过独立 Options 页管理

- **状态**:Accepted
- **日期**:2026-07-09

## 背景

随着阶段二、三逐步落地,方案里散落了大量可配置的安全策略与行为开关:

- **ADR-0008** 的 `page_eval` 返回值脱敏开关(`evalMask`)——v0.2 时塞在 popup 里
- **ADR-0006** 的高危点击确认、60 秒免确认宽限期、Toast 30s 超时——全部硬编码在 content.js
- **ADR-0009** 的精确 snapshot 前提示——每次都弹,不可关
- **ADR-0004** 的白名单——只能撤回不能手动添加(popup.js 注释明说 v0.1 没做手动加)
- 各工具是否启用——无总开关

这些值最初以"安全默认值"的形式硬编码,理由是 v0.1/v0.2 阶段优先跑稳基础架构。但累积下来,用户**没有任何途径**调整这些行为——既不能关闭某个他觉得烦的确认,也不能按场景调超时,更不能关掉 page_eval 这个攻击面最大的工具。安全策略被"焊死"了。

同时,原 popup 宽度仅 320px,已经开始拥挤(连接状态 + 待授权弹窗 + 白名单列表 + evalMask 开关),继续往 popup 里堆开关不可持续。

需要一个统一的配置管理入口。

## 决策

**通过 manifest `options_ui` 注册一个独立的整页 Options 配置页(`options.html`,新标签页打开),集中管理所有可配置项;popup 顶部加"⚙ 设置"按钮跳转过去,原 popup 里的 `evalMask` 开关迁出。**

配置项全部存 `chrome.storage.local`,沿用现有扁平 key 的约定(与 `evalMask` / `allowlist` 一致),`change` 即时持久化(无需"保存"按钮,与 popup 行为一致)。

### 配置项清单

| key | 类型 | 默认 | 关联 | 作用 |
|-----|------|------|------|------|
| `pageEvalEnabled` | bool | true | ADR-0008 | page_eval 总开关,关闭后直接拒绝执行任意 JS |
| `evalMask` | bool | true | ADR-0008 | page_eval 返回值脱敏 |
| `confirmHighRiskClick` | bool | true | ADR-0006 | 高危点击(提交/链接)确认开关 |
| `warnPreciseSnapshot` | bool | true | ADR-0009 | 精确 snapshot 前的信息提示 |
| `confirmGraceMs` | int | 60000 | ADR-0006 | 确认后同源同类免重复的宽限期(0=每次确认) |
| `clickToastTimeoutMs` | int | 30000 | ADR-0006 | 点击确认 Toast 自动拒绝超时 |
| `evalToastTimeoutMs` | int | 45000 | ADR-0008 | eval 确认 Toast 自动拒绝超时 |
| `disabledTools` | string[] | [] | — | 被禁用的工具(op)名集合 |
| `allowAllSites` | bool | false | ADR-0004 | 跳过逐站点审批,允许所有站点 |

## 考虑过的替代方案

### 方案 A:全部塞进 popup
- **优点**:实现最简,无需新文件;用户点扩展图标即见所有配置
- **缺点**:popup 宽 320px、不可滚动太多;开关一多极拥挤;popup 定位是"连接状态 + 授权快捷操作",混入大堆配置职责不清
- **未被选**:扩展已接近 popup 容量上限

### 方案 B:独立 Options 页(用户选择)
- **优点**:空间充足、可分组、可扩展;符合 Chrome 扩展惯例(详情页有"扩展程序选项"入口);popup 保持轻量
- **缺点**:多一次跳转(点扩展图标→点设置);options 页与 popup 是两个上下文,状态需通过 storage 同步
- **实现**

### 方案 C:全屏 tab,取消 popup 配置入口
- **优点**:最干净
- **缺点**:每次配置要点"扩展详情→选项",发现性差
- **排除**:popup 加跳转按钮成本极低,保留更友好

## 关键设计决策

### 1. 工具禁用在扩展 dispatch 层拦截,不在 Rust tools/list 过滤

`disabledTools` 在 `background.js` 的 `dispatch()` 入口检查:命中则 `throw new Error("tool disabled in settings: <op>")`。

**为什么不改 `src/tools.rs` 的 `tools/list`**:配置的唯一数据源在扩展(`chrome.storage.local`),Rust host 读不到。若要让 AI 直接"看不到"被禁工具,需要扩展把配置同步给 host(改 IPC 协议),工程量大且引入跨进程一致性维护。

**代价**:AI 仍会在 `tools/list` 里看到被禁工具,调用时才收到清晰错误。权衡后接受——被禁工具至少无法执行,且错误信息明确,符合"安全靠拦截而非靠隐藏"的原则。

### 2. allowAllSites 开关需同步申请 <all_urls> 权限

开启"允许所有站点"后,`ensureAllowed` 直接放行,不再逐站点审批。但扩展仍需 `<all_urls>` host permission 才能给任意页面注入 content script——否则跳过授权判断后注入静默失败。

`optional_host_permissions: ["<all_urls>"]` 已声明,开启开关时在 options 页的 change 事件里(合法 user gesture)调 `chrome.permissions.request({ origins: ["<all_urls>"] })`;用户拒绝则 checkbox 回滚。加载时用 `chrome.permissions.contains` 校正存储值与实际权限,防漂移。

### 3. options 页加站点不主动申请 host 权限

手动添加白名单时只写 `chrome.storage.local`。理由:MV3 下 `chrome.permissions.request` 必须在用户手势(popup/action)上下文,options 页虽是扩展页面但申请权限受限。真实访问该站点时,`ensureAllowed` 会触发正常的权限申请流程(走 popup 授权弹窗)。

### 4. DEFAULTS 常量三处镜像

配置项的默认值在 `options.js` / `background.js` / `content.js` 各自定义 `DEFAULTS` 对象(content.js 为页内行为子集),注释标明 KEEP IN SYNC。这沿用了项目现有的跨文件同步约定(如 `op` 字符串在 background.js / content.js / tools.rs 三处镜像)。

## 后果

### 正面
- **安全策略可调**:用户能按场景关闭烦人的确认、调超时、关 page_eval,不再被焊死
- **职责清晰**:popup 专注连接状态 + 授权快捷操作;配置归 options 页
- **可扩展**:新增配置项只需加 storage key + DEFAULTS + UI 控件,模式统一
- **符合惯例**:`options_ui` 是 Chrome 扩展管理配置的标准做法

### 负面
- **DEFAULTS 三处镜像**:加配置项要同步改三个文件的 DEFAULTS,易漏。受限于扩展各脚本独立加载,无共享模块的轻量方案(项目一贯用注释约定同步)
- **工具禁用非隐藏**:AI 仍看到被禁工具,靠调用时报错拦截——非"真正从工具集移除"
- **allowAllSites 风险**:开启后任意站点(含银行/邮箱/内网)无需授权即可操作,UI 有醒目警告但最终依赖用户判断

### 中性
- 配置即时生效(改即存 storage,下次动作读取新值),但 content.js 已注入页面的 `_maskCache` 等内存缓存需下次 eval 才刷新

## 实施细节

- `extension/manifest.json`:加 `options_ui: { page: "options.html", open_in_tab: true }`
- `extension/options.html`:整页布局,分组(安全 / 确认超时与宽限期 / 工具启用 / 允许的站点),危险开关有黄色警告卡片
- `extension/options.js`:读写 storage、表单即时持久化、allowlist 增删、allowAllSites 权限申请/移除/校正
- `extension/popup.html` / `popup.js`:加"⚙ 设置"按钮(`openOptionsPage`),移除 evalMask 区
- `extension/background.js`:DEFAULTS + `getSetting`、`dispatch` 入口 disabledTools 拦截、`add_allow` 消息、`snapshotPrecise` 读 warnPreciseSnapshot、`ensureAllowed`/`ensureDomainAllowed` 读 allowAllSites
- `extension/content.js`:DEFAULTS + `getSetting`、runEval 读 pageEvalEnabled、click 读 confirmHighRiskClick、宽限期/超时读 storage

## 与其他 ADR 的关系

- **[ADR-0004](./0004-allowlist-with-optional-host-permissions.md)**:allowAllSites 是白名单的"总开关"变体——跳过逐站点审批,但底层仍依赖同一套 optional host permissions 机制。手动加白名单补齐了 v0.1 缺失的 add 能力
- **[ADR-0006](./0006-toast-confirmation-for-high-risk.md)**:confirmHighRiskClick / confirmGraceMs / clickToastTimeoutMs 把该 ADR 的硬编码值(60s 宽限、30s 超时、确认开/关)可配置化,默认值与原决策一致
- **[ADR-0008](./0008-page-eval-confirmation-channel.md)**:pageEvalEnabled(总开关)、evalMask(迁自 popup)、evalToastTimeoutMs 把该 ADR 的策略可配置化
- **[ADR-0009](./0009-page-snapshot-precise-debugger.md)**:warnPreciseSnapshot 让精确 snapshot 前的提示可关
