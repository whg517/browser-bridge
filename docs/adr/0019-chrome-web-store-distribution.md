# ADR-0019:通过 Chrome Web Store 分发扩展(双 ID)

- **状态**:Accepted
- **日期**:2026-07-19

## 背景

在此之前,唯一的扩展安装方式是「Load unpacked」——用户必须开启 `chrome://extensions`
的开发者模式,手动选择 `extension/dist/`。这是最大的使用门槛:开发者模式对普通用户
陌生、在受管控/企业 Chrome 上常被禁用、重启后还可能提示。

整个安装链路依赖一个**固定扩展 ID** `mkjjlmjbcljpcfkfadfmhblmmddkdihf`(由
[`extension/manifest.json`](../../extension/manifest.json) 的 `key` 派生),安装器把它
写进 native messaging host 的 `allowed_origins`。

**但 Chrome Web Store 上架时会分配一个由商店掌控的 ID**(忽略 manifest 的 `key`),
本项目拿到的是 `dgccjfjjilfpkbdllclmkiicajndkfcd`——与钉死 ID 不同。若 host 只信任其中
一个,另一条安装路径就会在 `connectNative` 处被 Chrome 拒绝,扩展装了也连不上。

上架属**分发方式与安全边界**变更,按 [GOVERNANCE](../../GOVERNANCE.md) 为 ADR 级决策。

## 决策

**上架 Chrome Web Store,作为推荐安装方式;unpacked 保留为开发者路径。**

1. **双 ID 信任(核心)**:native host 的 `allowed_origins` **默认同时信任**商店 ID +
   钉死 ID,任一安装路径都能连接。`install.sh` / `install.ps1` 默认写两个 origin;
   `--extension-id` / `-ExtensionId` 可收窄为单个。三处 ID 副本(两个安装器 +
   [`extension-id.ts`](../../extension/src/shared/extension-id.ts))由
   [`scripts/check-extension-id.mjs`](../../scripts/check-extension-id.mjs) 这个 CI
   门禁保持一致,并校验商店 ID ≠ 钉死(key 派生)ID。

2. **商店上传包去掉 `key`**:已发布条目的 manifest **不含 `key`**(经下载线上 CRX 核实)——商店在
   首次上传时分配并掌管派生商店 ID 的签名密钥,不保存 manifest 里的 `key`。因此后续更新上传也
   **必须不带 `key`**,否则报「清单中 key 字段的值与当前内容不符」。商店 zip = 源 `extension/dist`
   去掉 `manifest.key`、`manifest.json` 置于 zip **根目录**、`description` ≤ 132 字符。发布流水线
   产出**两份** zip:`browser-bridge-extension-<tag>-store.zip`(**去 `key`**,上传商店用)与
   `browser-bridge-extension-<tag>.zip`(**保留 `key`**,供开发者 "Load unpacked" 得到钉死 ID)。
   两条路径对 `key` 的需求相反,**不能合成一份**。

3. **隐私政策**:因扩展读取页面内容、cookie、web storage,商店要求隐私政策 URL——
   见 [`docs/privacy-policy.md`](../privacy-policy.md)。

4. **发布方式:手动上传**。商店后台上传 `browser-bridge-extension-<tag>-store.zip`(**去 `key`**、
   manifest 在根)、走审核上线,**不做自动化**。
   (评估过用 CWS API 做 CI 自动发布,但 OAuth refresh-token 维护成本、`release: published`
   触发器对 `GITHUB_TOKEN` 所建 release 不生效等问题,收益不抵复杂度,故选择手动。)

## 考虑过的替代方案

### 方案 A:把商店公钥回填到 manifest `key`,让两条路径同一个 ID
- **优点**:只需信任一个 ID,`allowed_origins` 更简单
- **缺点**:会改变当前钉死 ID,所有已装 unpacked 的开发者环境要重装
- **未被选**:双 ID 信任成本更低,对现有用户零破坏

### 方案 B:开启「Verified CRX uploads」
- **优点**:只接受用自有私钥签名的上传,多一层账号安全
- **缺点**:每次更新都要签 `.crx`;私钥丢失需联系客服(最长一周);对单/少维护者是净负担
- **未被选**:默认**不开**;将来多维护者担心账号被盗时再评估

### 方案 C:引第三方 Action(如 `chrome-webstore-upload-action`)做发布
- **缺点**:又一个需固定 SHA 的第三方供应链依赖
- **未被选**:CWS API 用 `curl` + `jq` 即可覆盖,零新增依赖,符合本项目最小依赖姿态

## 后果

### 正面
- 移除最大门槛「开发者模式 Load unpacked」;一键 Add to Chrome,对受管控 Chrome 友好
- 双 ID 信任让商店用户与开发者共用同一套安装器,零破坏

### 负面 / 权衡
- **不移除安装器**:商店只分发**扩展**;用户仍需运行 `install.sh` / `install.ps1` 装
  native host 二进制 + manifest
- **失去即时更新控制**:每次商店更新都要走审核(数天到数周)
- 权限/工具变更(如 `page_eval`、`chrome.debugger`、`tabGroups`)会触发商店重新审核与
  用户重新授权
- 多一个由商店掌控、无法自行派生的 ID,需靠 CI 门禁维持一致

## 与其他 ADR 的关系

- 与 [ADR-0004](./0004-allowlist-with-optional-host-permissions.md) 正交:分发方式不改
  白名单/授权模型
- 与 [ADR-0005](./0005-page-eval-disabled-by-default.md)、[ADR-0009](./0009-page-snapshot-precise-debugger.md)
  相关:`page_eval`、`chrome.debugger` 是商店审核的重点风险项
- 发布流水线细节见 [release.md](../release.md);上架决策清单见
  [chrome-web-store.md](../chrome-web-store.md)
