# ADR-0009:page_snapshot_precise 用 chrome.debugger 取权威 a11y 树

- **状态**:Accepted
- **日期**:2026-07-08
- **补充**:[ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md)(v0.1 默认走 content script 的决定)

## 背景

[ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md) 决定 v0.1 的 `page_snapshot` 默认走 content script 近似,不调 `chrome.debugger`,以避免 infobar 横幅。当时规划"阶段二加 `page_snapshot_precise` 工具,定位失败时临时 attach"。

v0.1 的 content-script snapshot 覆盖约 90% 场景,但在以下边缘 case 不准:
- **closed shadow DOM**:content script 完全不可达
- **复杂 ARIA**:简化版 accessible-name 计算会偏(`aria-hidden` 子树、presentational role、`aria-describedby`)
- **computedRole/computedName**:Chrome 内部的 AOM 计算结果不暴露给 JS,content script 只能重算
- **跨域 iframe**:同源限制读不到

这些场景需要 Chrome **权威的** a11y 树。唯一获取途径是 CDP 的 `Accessibility.getFullAXTree`。

## 决策

**新增独立工具 `page_snapshot_precise`,用 `chrome.debugger` + CDP 取权威 a11y 树:**

| 维度 | 实现 |
|------|------|
| 触发 | AI 显式调用(不做失败自动回退,失败检测不可靠) |
| infobar 处理 | attach 前通过 content script 弹提示 Toast(蓝色调),告知"Chrome 会显示调试横幅,稍后自动消失",用户可取消,30s 超时自动继续 |
| ref 体系 | 复用 `data-zcb-ref` 属性,前缀用 `p`(precise)区分 content-script 的 `e` |
| 执行位置 | background.js(SW)——`chrome.debugger` 只能在 extension 上下文调 |

## 核心技术链路(已通过协议调研确认)

```
chrome.debugger.attach({tabId}, "1.3")
  → Accessibility.getFullAXTree()               // 每个 AXNode 带 backendDOMNodeId
  → for each interactive node:
      DOM.resolveNode({backendNodeId})          // → RemoteObjectId
      Runtime.callFunctionOn({                  // 给元素打 data-zcb-ref
        objectId,
        functionDeclaration: "function(ref){this.setAttribute('data-zcb-ref',ref); return {role:..., name:...}; }",
        arguments: [{value: ref}]
      })
  → chrome.debugger.detach({tabId})             // infobar 消失(必须在 finally)
```

**关键事实(调研确认)**:
- 每个 AXNode 带 `backendDOMNodeId`——这是通往 DOM 的桥梁
- `DOM.resolveNode({backendNodeId})` 返回 `RemoteObjectId`
- `Runtime.callFunctionOn` 能在该节点上执行 JS(打属性、读信息)
- `getFullAXTree` **不需要** `Accessibility.enable()`(enable 只为 AXNodeId 跨调用稳定,我们用 backendDOMNodeId 已稳定)
- AXNode 的 `role`/`name` 是 Chrome 权威计算,直接用,不用重算

## 关键优势:统一 ref 抽象

精确 snapshot 打的 `data-zcb-ref` 属性,与 content-script snapshot 用**完全相同的机制**。content.js 的 `resolveTarget` 已有 DOM 属性回退路径:

```javascript
function resolveTarget(args) {
  if (args.ref) {
    let el = refMap.get(args.ref);                    // 内存 map(同页 content snapshot)
    if (!el) {
      el = document.querySelector(`[${REF_ATTR}="${args.ref}"]`);  // DOM 属性回退(precise snapshot)
    }
    ...
  }
}
```

所以 `page_click`/`page_fill` **零改动**就能操作精确 snapshot 拿到的节点。统一的 ref 抽象把两种 snapshot 实现完全解耦。

## ref 命名空间隔离

两套计数器会撞号(content-script 的 `e3` 和 precise 的 `e3` 指向不同元素)。解决:
- content-script snapshot:`e1`/`e2`/`e3`...
- precise snapshot:`p1`/`p2`/`p3`...

前缀不同,content.js 按属性值查,无需改动。

## 考虑过的替代方案

### 方案 A:page_snapshot 加 `precise: true` 参数(不新增工具)
- **优点**:工具数不增
- **缺点**:AI 可能记不住加参数;返回结构要兼容两种来源
- **未被选**:用户选了独立工具,边界更清晰

### 方案 B:失败自动回退(content snapshot 失败后自动 attach)
- **优点**:AI 无感,失败自愈
- **缺点**:失败检测不可靠(content snapshot 成功但 click 因别的原因失败也会误触发);debugger 闪现不可预测
- **排除**:用户明确不选

### 方案 C:不弹提示 Toast,直接 attach
- **优点**:最快
- **缺点**:用户看到陌生"调试"横幅会困惑或担心;没有知情同意
- **未被选**:用户选了 attach 前提示

## infobar 行为(已确认)

- **attach 期间持续显示**:Chrome 顶部"Started debugging this browser"横幅,所有标签页都显示
- **detach 后消失**
- **无法关闭**:除非 `--silent-debugger-extension-api` 启动参数(违背项目初衷 G2)
- 一次 handler 内 attach → 取树 → 打标 → detach,infobar 只闪现一下(通常 < 1 秒)
- **提示 Toast 提前告知**,用户不慌

## 错误处理矩阵

| 情况 | 处理 |
|------|------|
| `chrome://`/`chrome-extension://`/webstore/`view-source:`/`about:` | 前置拦截,返回错误(debugger 无法 attach) |
| "Another debugger already attached" | 返回错误"请关闭该标签的 DevTools" |
| 用户点取消(提示 Toast) | 不 attach,返回 "cancelled" |
| 取树过程中 onDetach(用户关 tab/导航) | 返回错误,清理状态 |
| 任何错误 | **finally 路径 detach**,防止 infobar 永驻 |

**关键:`detach` 必须在 finally 路径**——任何错误都要 detach,否则 infobar 永远显示,用户体验灾难。

## 后果

### 正面
- **权威准确**:Chrome 内部 a11y 树,shadow DOM/复杂 ARIA 全覆盖
- **role/name 不用重算**:直接取 AXNode 字段
- **统一 ref**:page_click/fill 零改动
- **知情同意**:提示 Toast 让用户预知 infobar

### 负面
- **infobar 必现**:即使闪现,所有标签页都看得到
- **与 DevTools 冲突**:tab 已开 DevTools 时失败
- **chrome:// 等页面不可用**:内置限制
- **CDP 链路复杂**:多步异步回调,任一步失败都要可靠 detach
- **执行稍慢**:多步 CDP 命令,content-script 的 < 50ms 对比 precise 可能 200-500ms

### 中性
- precise snapshot 用 `p` 前缀 ref,与 content 的 `e` 前缀隔离

## 实施

- `extension/manifest.json`:加 `debugger` 权限
- `extension/background.js`:`snapshotPrecise(tabId)` 函数,完整 CDP 链路 + 错误处理
- `extension/content.js`:`showInfoToast` + `page_snapshot_precise_info` case
- `extension/toast.css`:`.zcb-info-card` 蓝色调
- `src/tools.rs`:工具定义 + dispatch

## 与其他 ADR 的关系

- **补充 [ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md)**:ADR-0003 决定默认走 content script(避免 infobar),本 ADR 提供显式的精确回退路径。两者共存:日常用 `page_snapshot`(无 infobar),需要权威时用 `page_snapshot_precise`(infobar 闪现 + 提示)
- **区别于 [ADR-0008](./0008-page-eval-confirmation-channel.md)**:eval Toast 是高危确认(默认拒绝,要主动 Allow),precise 的 info Toast 是信息提示(默认继续,要主动取消)
