# ADR-0012:扩展用 TypeScript 编写,esbuild 打包到 dist/

- **状态**:Accepted
- **日期**:2026-07-10
- **决策者**:用户 + AI 助手

## 背景

v0.1/v0.2 的 MV3 扩展是四个手写的原生 `.js`(`background.js` / `content.js` / `options.js` / `popup.js`),直接 load-unpacked 加载 `extension/` 目录。这在原型期够快,但随着 ADR-0008(page_eval)、ADR-0009(page_snapshot_precise)、ADR-0010(cookie/storage)、ADR-0011(Options 页)陆续落地,扩展侧代码量和复杂度都上来了,几个问题开始显现:

- **无类型**:`chrome.*` API、桥接消息的 `op`/`args`/响应结构全靠记忆和注释约定,重构和加工具时容易漏字段、传错类型,只能靠运行时报错发现。
- **无静态检查**:未用变量、拼错的分支、隐式 `any` 无人拦截。
- **跨文件同步全靠人肉**:`op` 字符串、`DEFAULTS` 常量在 background/content/options 多处镜像(见 ADR-0011),没有任何编译期保障。
- **可维护性**:文件越堆越大,没有模块化和类型约束,新贡献者上手门槛高。

工程标准化整改需要给扩展补上类型、lint 和一条可复现的构建管线。引入类型意味着源码不再是浏览器能直接吃的 `.js`,必须有一个构建步骤把类型剥掉、把源码打成扩展可加载的产物。

## 决策

**扩展源码改用 TypeScript(`extension/src/*.ts`,strict 模式),用 esbuild 打包成 IIFE 到 `extension/dist/`,dist/ 成为新的 load-unpacked 目标。**

- 四个入口 `src/{background,content,options,popup}.ts` 各自 bundle 成 `dist/*.js`。
- 静态资源(`manifest.json`、`popup.html`、`options.html`、`toast.css`、`icons/`)由构建脚本(`build.mjs`)原样拷进 dist/。
- 输出 **IIFE 格式、不压缩(`minify: false`)**,unpacked 扩展保持可读可调试;`target: chrome116`。
- 类型检查(`tsc --noEmit`)、lint(ESLint)、格式(Prettier)与打包解耦——esbuild 只管剥类型 + bundle,不做类型校验(见 ADR-0013 的 CI 门禁)。

## 考虑过的替代方案

### 方案 A:继续手写原生 JS(现状)
- **优点**:零构建、零依赖,改完直接 reload。
- **缺点**:无类型、无静态检查、跨文件同步全靠注释;扩展复杂度已到需要类型兜底的临界点。
- **未被选**:整改的核心目标就是补类型和检查。

### 方案 B:tsc 直接编译(不用 bundler)
- **优点**:官方工具链,零额外打包器依赖。
- **缺点**:`tsc` 只做逐文件转译,不 bundle;若将来拆共享模块(如统一 `DEFAULTS`/类型定义),ESM/import 在 MV3 各上下文的加载方式各异(SW、content script、页面脚本规则不同),tsc 输出难直接跑;还要自己写资源拷贝脚本。
- **未被选**:要么放弃模块化,要么额外补打包逻辑,不如直接上 bundler。

### 方案 C:webpack
- **优点**:生态成熟,MV3 插件丰富。
- **缺点**:配置繁重(loader/plugin/mode 一大套),依赖树庞大,冷启动慢;对"四个入口 + 拷几个静态文件"这种规模是杀鸡用牛刀。
- **排除**:与项目"依赖最小、产物可审计"的一贯取向冲突。

### 方案 D:rollup
- **优点**:输出干净,tree-shaking 好。
- **缺点**:TS 支持要挂插件(`@rollup/plugin-typescript` 等),配置分散;速度不及 esbuild。
- **未被选**:esbuild 单依赖就覆盖了 TS + bundle,更省。

### 方案 E:esbuild(采用)
- **优点**:**单个快依赖**即覆盖"剥 TS 类型 + bundle";配置就是一个 `build.mjs`,没有 config 蔓延;`format: "iife"` 直接产出各上下文能加载的自包含脚本;`--watch` 开发迭代快。
- **缺点**:esbuild 本身不做类型检查(这正是把 `tsc --noEmit` 拆成独立门禁的原因);tree-shaking/优化不如 rollup 极致,但本项目不压缩、不追求最小体积,无所谓。
- **采用**。

## 迁移的行为中立性验证

改造分两步走,先建管线、再补类型(见 git 历史 Phase 2a/2b/2c),关键是证明"引入构建步骤"本身不改变运行时行为:

- **Phase 2a** 只建管线:`background.js → src/background.ts` 等用 git rename 原样搬过去(保留历史),**不加任何类型注解**。此时 esbuild 对这些"只是改了后缀的纯 JS"所做的只有"零类型可剥 + IIFE 包裹",产出的 `dist/*.js` 与原文件语义等价——可视作近似字节级一致的搬运,以此隔离"构建管线"与"类型改造"两个变量。
- 用现有测试套件锁行为:`dom_test` 77/77(不变)、smoke 4/4、协议 e2e 45/45,全绿,证明构建步骤 behavior-neutral。
- **Phase 2b/2c** 才在已验证的管线上逐文件补 strict 类型、加 ESLint/Prettier、删死代码。

`tests/dom_test.ts` 直接读**构建产物** `extension/dist/content.js`(而非源 `.ts`)跑 DOM 层断言——测的是浏览器实际加载的那份代码,顺带把"esbuild 输出可用"纳入测试保护。

## 后果

### 正面
- **类型安全**:`chrome.*`(`@types/chrome`)、桥接消息、DEFAULTS 都有编译期约束,加工具/重构不再靠运行时试错。
- **静态检查**:strict + ESLint 拦住隐式 any、未用变量、拼错分支。
- **可维护**:源码在 `src/` 下,可模块化、可扩展。
- **管线简单**:一个 `build.mjs` + esbuild 单依赖,无 config 蔓延。

### 负面
- **安装/加载流程变了**:load-unpacked 目标从 `extension/` 改成 **`extension/dist/`**,dist/ 是构建产物(已 gitignore)。**改完代码必须先 `npm run build`(或 `just ext-build`)再 reload 扩展**,不能像以前那样直接改 `.js` 就生效。`install.sh` 也改为先构建再从 dist/ 加载。
- **多一层构建依赖**:开发扩展需要 Node + `npm ci`;esbuild/typescript/eslint 等进 devDependencies。
- **产物不入库**:dist/ 不提交,克隆后必须构建才能加载。

### 中性
- esbuild 不做类型检查,类型/lint/格式作为独立 CI 门禁存在(见 ADR-0013),职责清晰但要分别运行。

## 实施

- `extension/src/{background,content,options,popup}.ts`:strict TypeScript 源码。
- `extension/build.mjs`:esbuild driver,四入口 bundle 成 IIFE 到 dist/,拷贝静态资源;`--watch` 支持增量。
- `extension/tsconfig.json`:`strict`、`noEmit`、`types: ["chrome"]`、`moduleResolution: bundler`。
- `extension/package.json`:`build` / `watch` / `typecheck` / `lint` / `format` 脚本;devDependencies 含 esbuild、typescript、@types/chrome、eslint、prettier、typescript-eslint。
- `.gitignore`:排除 `extension/dist` 与 `extension/node_modules`。
- `tests/dom_test.ts`:读 `extension/dist/content.js`(构建产物)。
- `install.sh` / `README`:构建扩展并从 dist/ load-unpacked。

## 与其他 ADR 的关系

- **[ADR-0001](./0001-use-rust-single-binary.md)**:该 ADR 只覆盖 Rust 后端的"单二进制、零运行时依赖";扩展侧引入构建步骤是并行的另一条产物链,不影响后端的分发方式。
- **[ADR-0013](./0013-ci-and-toolchain.md)**:本 ADR 建立的 typecheck/lint/format/build 由 CI 的 extension job 统一把关。
