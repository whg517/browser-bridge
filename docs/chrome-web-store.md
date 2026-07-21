# 上架 Chrome Web Store:决策清单

> **现状(2026-07-19):已上架并发布。** 决策记录见
> [ADR-0019](./adr/0019-chrome-web-store-distribution.md);商店条目
> [Browser Bridge](https://chromewebstore.google.com/detail/browser-bridge/dgccjfjjilfpkbdllclmkiicajndkfcd)。
> 下文保留为当初的**决策清单**存档;发布方式见末尾「手动发布」。

> 本文是**决策清单**,不是"已经决定要做"。上架能移除当前最大的使用门槛(手动加载
> unpacked 扩展),但它是一次**产品承诺**:开发者账号、隐私政策、审核风险、以及一处
> 会影响现有"钉死扩展 ID"设计的迁移工作。是否上架属于 GOVERNANCE 里 RFC/ADR 级别的
> 决策(涉及分发方式与安全边界),建议先开 issue/ADR 定夺,而非直接 PR。

## ⚠️ 首要坑:上架会改变钉死的扩展 ID

整个安装流程都依赖一个**固定** ID —— `mkjjlmjbcljpcfkfadfmhblmmddkdihf`(由
[`extension/manifest.json`](../extension/manifest.json) 的 `key` 派生),
[`install.sh`](../install/install.sh) / [`install.ps1`](../install/install.ps1)
会把它写进 native host manifest 的 `allowed_origins`。

**但 Chrome Web Store 在首次上传时会分配一个由商店掌控的 ID,商店会忽略 manifest 里的
`key`。** 因此上架后的扩展**几乎必然拿到一个不同的 ID**,Chrome 会因 `allowed_origins`
不匹配而**拒绝 native messaging 连接**——即安装了二进制,扩展也连不上。

**必须规划的缓解措施:**

- 首次上传后拿到商店分配的 ID,把它加入 `allowed_origins`——最好**同时信任两个 ID**:
  商店 ID(商店用户)+ 当前钉死 ID(unpacked / 开发者)。
- 同步更新 [`install.sh`](../install/install.sh) 的 `PINNED_EXTENSION_ID`、
  [`install.ps1`](../install/install.ps1)、以及
  [`scripts/check-extension-id.mjs`](../scripts/check-extension-id.mjs) 使其信任两个 ID。
- 可选:把商店条目的公钥回填到 manifest `key`,让 unpacked 加载也得到商店 ID——但这会
  改变今天的钉死 ID,需权衡。

## 能解决什么、不能解决什么

- ✅ **移除"墙 1"**:不再需要开发者模式 "Load unpacked",一键 "Add to Chrome",
  重启 Chrome 后仍在,对受管控/企业 Chrome 也友好得多。
- ❌ **不移除安装器**:商店只分发**扩展**。用户仍需运行 `install.sh` / `install.ps1`
  安装 **native host 二进制 + manifest**。所以这是"拆掉一堵墙,不是全部"。

## 前置条件

- [ ] Chrome Web Store **开发者账号**(一次性 **$5**;须由你注册,我无法创建账号)。
- [ ] **隐私政策 URL**(本项目**必需**——扩展会读取页面内容、cookie、web storage)。
      可放在 `docs/` 下。
- [ ] 商店 listing 素材:1–5 张截图(1280×800 或 640×400)、128px 图标
      (已有 `extension/icons/icon128.png`)、简短 + 详细描述、类目、支持/主页 URL。

## 与本扩展相关的审核风险项

Google 审核会重点看以下几项,提前准备书面理由:

- [ ] **`page_eval`(执行任意 JS)**——最高被拒风险。理由:每次调用都需用户确认的开发者
      工具;可考虑商店版本**默认禁用**该工具。
- [ ] **`chrome.debugger`**(`page_snapshot_precise` 使用)——敏感权限,需说明。
- [ ] **较宽的 host / optional 权限 + native messaging**——说明 localhost-only、
      per-run secret 的桥接与逐站点授权模型,链接[威胁模型](./security/threat-model.md)。
- [ ] **是否"使用远程代码"**——如实回答:`page_eval` 执行的是**用户提供**的 JS,不是
      远程拉取的代码;表单里措辞要精确。

## 打包与提交

- [x] 商店 zip:发布流水线产出的 **`browser-bridge-extension-<tag>-store.zip`**(注意 `-store`
      后缀)已是可直接上传的形状(`manifest.json` 在 zip 根、**去掉 `key`**)。另一份
      `browser-bridge-extension-<tag>.zip`(**保留 `key`**)是给 "Load unpacked" 开发者用的,
      **不能**上传到商店。
- [ ] 确认 `manifest.json` 版本与 Cargo 一致(`scripts/check-version.sh` 已强制)。
- [x] `key` 字段:**去掉**——已发布条目的 manifest **不含 `key`**(商店自己掌管派生商店 ID 的
      签名密钥),更新上传若携带 `key` 会被拒:「清单中 key 字段的值与当前内容不符」(见「手动发布」)。
- [ ] 上传,填写数据使用披露 + 隐私政策,提交。审核延迟**数天到数周**,且**失去即时更新
      控制**(每次更新都走审核)。

## 上架之后

- [ ] 把商店 ID 接入 `allowed_origins` + 两个安装器(见首要坑)。
- [ ] 改写 README "Load the extension" → "从 Chrome Web Store 添加",unpacked 保留为
      开发者/进阶路径。
- [ ] 更新 `docs/`,并补一条 **ADR** 记录该决策(按 GOVERNANCE,分发方式属重大变更)。
- [ ] 可选:用 CI 步骤(`chrome-webstore-upload` 之类)自动化发布,或保持手动。

## 结论 / 建议

上架是**单点收益最大**的可用性改进,但它是一次产品承诺:$5 账号、隐私政策、
`page_eval`/`chrome.debugger` 的审核风险、持续的审核延迟,以及上面的 ID 迁移工作。
因为它触及分发方式与安全姿态,按本项目 [GOVERNANCE](../GOVERNANCE.md) 属 **RFC/ADR 级**
决策——建议先开 issue 讨论定夺,再动手,而不是一个快速 PR。

## 手动发布(不做自动化)

评估过用 CWS API 做 CI 自动发布,但 OAuth refresh-token 维护成本、`release: published`
触发器对 `GITHUB_TOKEN` 所建 release 不生效等问题,收益不抵复杂度,**改为手动上传**:

1. **拿到 zip**:下载 release 里的 **`browser-bridge-extension-<tag>-store.zip`**(带 `-store`
   后缀)—— 它已经是商店要的形状(`manifest.json` 在 zip **根目录**、**去掉 `key`**)。也可本地打包:
   ```sh
   cp -r extension/dist store-pkg
   node -e 'const fs=require("fs");const f="store-pkg/manifest.json";const m=JSON.parse(fs.readFileSync(f,"utf8"));delete m.key;fs.writeFileSync(f,JSON.stringify(m,null,2));'
   (cd store-pkg && zip -rX ../browser-bridge-extension-store.zip . -x ".*")
   ```
   ⚠️ **必须去掉 `key`**——已发布条目的 manifest **不含 `key`**(商店掌管派生商店 ID 的签名密钥),
   更新上传若携带 `key` 会被拒:「清单中 key 字段的值与当前内容不符」。不含 `-store` 后缀的那份
   zip 保留了 `key`(供开发者 "Load unpacked"),**不要**上传它。
2. **上传**:[开发者后台](https://chrome.google.com/webstore/devconsole) → Browser Bridge
   → **Package → Upload new package** → 选该 zip → **Submit for review**。
3. **注意**:商店拒绝重复版本,发新版前先 bump(`scripts/check-version.sh` 保证
   Cargo/manifest 一致);审核数天到数周,不可跳过。

## 相关

- 决策记录:[ADR-0019](./adr/0019-chrome-web-store-distribution.md)。
- 安全边界与威胁模型:[SECURITY.md](../SECURITY.md) ·
  [security/threat-model.md](./security/threat-model.md) ·
  [security/trust-boundaries.md](./security/trust-boundaries.md)。
- 钉死 ID 与安装产物:[architecture.md §4.3](./architecture.md#43-安装产物)。
- 发布流水线与扩展 zip:[release.md](./release.md)。
