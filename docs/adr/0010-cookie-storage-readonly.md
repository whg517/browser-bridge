# ADR-0010:Cookie/Storage 只读访问

- **状态**:Accepted
- **日期**:2026-07-08
- **实现**:阶段三第一批

## 背景

用户场景:"让 AI 读取我已登录站点的 session token,用于别处(本地脚本、跨工具调用、调试 API)。"

这个需求的核心价值在于 **httpOnly Cookie**——很多站点(尤其生产环境)把 session/JWT/refresh token 存在 httpOnly Cookie 里,**页面 JS 的 `document.cookie` 读不到**(这正是 httpOnly 的安全设计)。只有 `chrome.cookies` API 能读。

同时,很多前端框架(Auth0/NextAuth/Firebase)把 token 存在 `localStorage`/`sessionStorage`,这部分 content script 能读。

## 决策

**新增 `cookie_get` + `storage_get` 两个只读工具,不做任何写入:**

| 维度 | 实现 |
|------|------|
| 范围 | **只读** — `cookie_get` + `storage_get`;**不做** cookie_set/cookie_remove/storage_set |
| 确认 | 静默执行(同 page_snapshot/page_text),不弹 Toast |
| host 约束 | 复用现有白名单;Cookie 受 host_permissions 自然约束,storage 受同源约束 |
| 输出脱敏 | 复用 [ADR-0008](./0008-page-eval-confirmation-channel.md) 的 `maskSensitive`(JWT/长hex/长数字/敏感 key) |
| httpOnly | 读取包含 httpOnly Cookie(核心价值) |

## 关键调研结论(决定设计的事实)

1. **`chrome.cookies` API 受 host_permissions 约束**:`getAll({})` 只返回已授权域名的 Cookie,**不是**全部浏览器 Cookie。blast radius 与现有工具一致,复用现有白名单([ADR-0004](./0004-allowlist-with-optional-host-permissions.md))。
2. **能读 httpOnly Cookie**:API 暴露 `httpOnly` 字段并正常返回 httpOnly Cookie——这是相对 `document.cookie` 的核心价值。
3. **页面 localStorage 必须从 content script 读**(同源限制);`chrome.storage` 是扩展自己的,与页面无关——两者不同。所以 `storage_get` 在 content.js,`cookie_get` 在 background.js。
4. **`cookies` 权限无额外安装警告**(我们已有 debugger 触发了最大 host 警告,加 `cookies` 零成本)。
5. **`cookie_set` 能伪造 httpOnly+Secure Cookie**(会话固定攻击向量,连页面 XSS 都做不到)→ **不做**。

## 工具设计

### `cookie_get(details)` — background.js 执行
- 参数(全部可选,至少一个用于定位):
  - `url`(string)— 返回会发给该 URL 的 Cookie
  - `domain`(string)— 匹配该域及子域
  - `name`(string)— 精确匹配 Cookie 名
- 实现:调 `chrome.cookies.getAll({url, domain, name})` → 脱敏 value(保留 name/domain/httpOnly 结构)→ 返回
- 返回:`[{name, value(脱敏), domain, path, httpOnly, secure, sameSite, session, expirationDate?}]`
- 友好提示:空结果时检查"域名是否已授权"(Chrome 未授权返回空数组,不报错)

### `storage_get(details)` — content.js 执行
- 参数:
  - `type`("local" | "session",默认 "local")
  - `key`(string,可选)— 指定 key;不传则返回全部(脱敏)
- 实现:从 `window.localStorage` / `window.sessionStorage` 读 → 脱敏 → 返回
- 返回:单 key `{key, value(脱敏)}`;全部 `{type, entries: {k:v(脱敏)}, count}`

## 为什么不做 cookie_set(风险复述)

`chrome.cookies.set` 能伪造 **httpOnly+Secure** Cookie——这是连页面 XSS 都做不到的事(页面 JS 不能设 httpOnly Cookie)。

后果:如果 AI 被诱导(提示注入),可以在用户已登录的站点植入**攻击者控制的 session ID**(会话固定攻击)。即使有确认 UI,一次误批就植入成功,且用户很难察觉——Cookie 不像点击/填表那样可见。

读取覆盖 90% 场景(取登录态用于别处),写入极少必要。**不做 = 最小攻击面**,符合安全第一原则。

## 不做 cookie_remove 的理由
- 比 set 安全(只能登出/清除),但实际用途窄(清除登录态重试)
- 加了 remove 就要加确认(用户会问"为什么删我的 Cookie"),增加复杂度
- v0.1 不做,留作未来(若真有需求,remove 比 set 安全,可后加)

## 考虑过的替代方案

### 方案 A:读写都做(cookie_set 走高危确认)
- **优点**:能力最全
- **缺点**:cookie_set 能伪造 httpOnly Cookie(会话固定攻击),即使有确认 UI,一次误批就植入恶意 session
- **排除**:用户选了只读,攻击面最小

### 方案 B:读取 + cookie_remove(不做 set)
- **优点**:比全读写安全;remove 只能清除不能伪造
- **缺点**:用途窄;要加确认 UI
- **未被选**:用户选了纯只读

### 方案 C:读取每次确认
- **优点**:最安全
- **缺点**:读取动作频繁(取 token、查状态),每次确认打断流程
- **排除**:用户选了静默(同 page_snapshot/page_text 一致)

## 后果

### 正面
- **补齐核心场景**:读 httpOnly Cookie / localStorage token,用于跨工具调用
- **零新增攻击面**:只读 + 脱敏 + 受现有白名单约束,blast radius 等价于 page_text
- **无安装警告成本**:cookies 权限静默,debugger 已触发最大警告
- **复用脱敏**:不写新代码,直接用 page_eval 的 maskSensitive

### 负面
- **空结果歧义**:未授权 vs 真没数据,Chrome 不区分,只能提示
- **脱敏可能误伤**:base64 配置等正常长值会被遮罩(共用 evalMask 开关,后续可细化)
- **不支持 IndexedDB**:部分框架(Airbnb LiteSet 等)用 IndexedDB 存 token,本方案不覆盖

### 中性
- 工具数 13 → 15

## 已知限制

1. **localStorage 受同源限制**:content script 只能读当前注入页面的源;跨域 iframe 读不到
2. **空结果歧义**:Chrome cookies API 未授权返回空数组而非错误
3. **脱敏开关粒度**:当前 `evalMask` 同时影响 page_eval 和 cookie/storage;未来可拆成独立开关

## 与其他 ADR 的关系

- **复用 [ADR-0004](./0004-allowlist-with-optional-host-permissions.md)**:白名单是站点级第一层防御;Cookie/Storage 自动受其约束
- **复用 [ADR-0008](./0008-page-eval-confirmation-channel.md)**:`maskSensitive` 脱敏函数,JWT/hex/数字/敏感 key 模式库
- **区别于 [ADR-0008](./0008-page-eval-confirmation-channel.md)**:eval 是执行(需高危确认),Cookie/Storage 是只读(静默)。两者都用脱敏,但确认强度不同
- **补充 [ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md) 的能力边界**:content script 读 localStorage(同源),chrome.debugger 也能读但太重;此处用 content script 足够
