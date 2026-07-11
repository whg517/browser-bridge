# ADR-0013:统一工具链与 CI(justfile + GitHub Actions + 版本单源)

- **状态**:Accepted
- **日期**:2026-07-10
- **决策者**:用户 + AI 助手

## 背景

项目跨两条技术栈(Rust 后端 + TypeScript 扩展)和多种测试(Rust 单测、协议 e2e、DOM 层、smoke),但在整改前没有统一的开发者入口和自动化门禁:

- **命令散乱**:构建、测试、lint 各是一串要记的命令(`cargo ...`、`npm --prefix extension run ...`、`python3 tests/e2e.py`、`bun ...`),散在 README 和记忆里,新贡献者难以复现"什么算通过"。
- **无 CI**:没有任何自动检查,格式、lint、测试全靠提交者自觉,回归容易溜进 main。
- **版本会漂**:同一个版本号存在三处——`Cargo.toml`、`extension/manifest.json`、`extension/package.json`。手动改极易漏改其一,导致后端与扩展版本不一致。

整改要给项目补上"一条命令跑全套 + CI 挡回归 + 版本不漂"的工程基线。

## 决策

**采用 justfile 作为统一任务入口 + GitHub Actions CI + rustfmt/clippy/eslint/prettier 门禁 + 以 Cargo.toml 为单一真相源的版本同步机制。**

### 1. justfile 任务入口
`justfile` 把所有开发者动作收敛成命名 recipe:`build` / `fmt` / `lint` / `test-rust` / `test-e2e` / `ext-build` / `ext-typecheck` / `ext-lint` / `ext-format-check` / `test-browser` / `install` / `sync-version` / `check-version`,以及聚合 recipe **`just ci`**(= fmt-check + clippy + rust 单测 + 扩展 typecheck/lint/format-check/build + e2e)。贡献者提交前跑 `just ci` 就能本地复现 CI 大部分门禁(浏览器测试因需 Chrome 单列 `test-browser`)。

### 2. GitHub Actions CI(`.github/workflows/ci.yml`)
push 到 main / PR / 手动触发,含并发取消,分五个 job:

| job | 内容 |
|-----|------|
| **rust** | `cargo fmt --check` → `clippy --all-targets -D warnings` → `cargo test` → `cargo build --release` |
| **extension** | `npm ci` → `typecheck` → `lint` → `format:check` → `build`(在 `extension/`) |
| **version-consistency** | `./scripts/check-version.sh` |
| **e2e** | 构建 release 二进制后 `python3 tests/e2e.py`(驱动真实二进制) |
| **browser** | 装 Chrome + bun,构建扩展后跑 `dom_test.ts` + `ext_test.ts` |

### 3. 质量门禁
- **Rust**:`rustfmt`(`--check`)+ `clippy` 以 **`-D warnings`** 把所有 lint 警告升级为错误。
- **扩展**:`tsc --noEmit`(strict 类型)+ **ESLint**(flat config,聚焦正确性)+ **Prettier**(`--check`,格式唯一裁判)。Prettier 管格式、ESLint 管正确性,职责不重叠。

### 4. 版本单一真相源
**`Cargo.toml` 是版本的唯一真相源**,两个脚本维持一致性:
- `scripts/check-version.sh`:校验 `extension/manifest.json`、`extension/package.json` 与 `Cargo.toml` 一致,不一致 exit 1(CI 的 version-consistency job 跑它)。
- `scripts/sync-version.sh`:把 Cargo 版本号传播到 manifest(sed 就地替换,避开 `manifest_version` 键)和 package.json(+ package-lock.json,走 `npm version`),末尾自动 check。

版本升级流程:改 `Cargo.toml` → `just sync-version` → 提交。

## 考虑过的替代方案

### 任务入口:Makefile vs npm scripts vs justfile
- **Makefile**:通用但语法陷阱多(tab 敏感、`.PHONY`、变量转义),对"就是跑一串命令"偏重。
- **npm scripts**:天然只属 Node 世界,把 Rust/Python 任务塞进 `package.json` 别扭,且要求根目录有 Node 工程。
- **justfile(采用)**:专为"命名任务运行器"而生,语法直白、无 tab 陷阱、recipe 可依赖(`test-e2e: build`),同时统领 Rust/Node/Python 三栈命令,中立于语言。

### CI 平台:GitHub Actions
项目托管在 GitHub,Actions 零额外接入成本,`dtolnay/rust-toolchain` / `Swatinem/rust-cache` / `browser-actions/setup-chrome` 等现成 action 覆盖了全部需求。未考虑外部 CI。

### 版本源:Cargo 为源 vs 独立 VERSION 文件
- **独立 VERSION 文件**:多一个需要各处读取的中间源,反而增加同步点。
- **Cargo.toml 为源(采用)**:后端是项目主体,crate 版本天然是发布版本;扩展 manifest/package 是下游,单向传播即可,方向清晰。

## 后果

### 正面
- **一条命令复现**:`just ci` 让"什么算通过"可执行、可复现,贡献者本地即可自检。
- **回归被挡在门外**:格式、lint(clippy `-D warnings`)、类型、单测、e2e、DOM/smoke 全部自动化,main 保持绿。
- **版本不漂**:CI 强制三处一致,升级有明确单向流程(改 Cargo → sync)。
- **职责清晰**:Prettier 管格式、ESLint/clippy 管正确性,各司其职。

### 负面
- **贡献者需装工具链**:本地完整自检要有 `just`、Rust(rustfmt/clippy)、Node、Python,浏览器测试还需 bun + Chrome。门槛比"随手改"高。
- **版本升级须走 sync**:不能只改某一处版本号;漏跑 `sync-version` 会被 version-consistency job 拦下(这正是设计意图,但对不熟悉流程者是一次学习成本)。
- **`-D warnings` 偏严**:任何新 clippy 警告都会红 CI,好处是不留技术债,代价是偶尔要为无害告警做处理或显式 allow。

### 中性
- 浏览器测试(需 Chrome)未进 `just ci` 聚合,单列为 `test-browser` / CI 的 browser job——因其环境依赖重,与纯逻辑门禁分层。

## 实施

- `justfile`:全部 recipe + `ci` / `test` 聚合。
- `.github/workflows/ci.yml`:rust / extension / version-consistency / e2e / browser 五 job。
- `scripts/check-version.sh` + `scripts/sync-version.sh`:Cargo 为源的版本校验与传播。
- Rust:`cargo fmt` / `clippy -D warnings`;扩展:`eslint.config.js`(flat)+ Prettier。

## 与其他 ADR 的关系

- **[ADR-0012](./0012-typescript-esbuild-extension-build.md)**:extension job 的 typecheck/lint/format/build 门禁正是为该 ADR 引入的 TS + esbuild 管线服务。
- **[ADR-0014](./0014-leveled-logging.md)**:Rust 新增的日志/错误模块由 rust job 的 clippy + `cargo test` 覆盖。
