# ADR-0014:分级日志(BB_LOG)与 thiserror 类型化错误

- **状态**:Accepted
- **日期**:2026-07-10
- **决策者**:用户 + AI 助手

## 背景

整改前,Rust 后端的诊断输出是散落的 `eprintln!`,错误处理则大量是"字符串化"的——工具调用路径上出错就地拼一个 `String`,没有类型区分,调用方无法按错误种类分流,`Display` 文本也四散在各处不好统一。两个具体痛点:

- **日志无分级、无开关**:所有 `eprintln!` 要么永远打、要么被删,无法在排障时临时调高 verbosity;而且散落各处,格式不统一。
- **错误 stringly-typed**:session/tool 边界的错误(未连接、写失败、超时、连接断开、未知工具、扩展自身报错)全靠临时字符串,既不能穷举也不能 match,`isError` 内容文本组织混乱。

同时有个硬约束贯穿始终:**两个二进制模式的 stdout 都是协议流**——native host 走 4 字节前缀 NM 帧,MCP server 走 NDJSON JSON-RPC(见架构文档 §3)。任何非协议字节写进 stdout 都会损坏帧、断开连接。所以一切诊断输出**只能走 stderr**。

## 决策

**引入一个最小的、由 `BB_LOG` 环境变量控制的分级 stderr 日志器(`src/log.rs`),取代散落的 `eprintln!`;并在工具调用路径上用 thiserror 定义类型化错误(`src/error.rs`)。**

### 1. 分级日志(`src/log.rs`)
- 四级 `Level`:`Error < Warn < Info < Debug`。
- 阈值由 `BB_LOG`(`error|warn|info|debug`)在进程启动时经 `OnceLock` 解析一次;**未设或无法识别一律回退 `info`**。
- 只写 stderr:`eprintln!("[{LEVEL}] [{tag}] {msg}")`,过阈值才打。
- 提供 `log_error!` / `log_warn!` / `log_info!` / `log_debug!` 宏,统一 tag + 格式。
- 默认 `info`,`debug` 行默认隐藏,排障时启动加 `BB_LOG=debug` 即可放开,无需重编译。

### 2. 类型化错误(`src/error.rs`)
- `CallError` 枚举用 `thiserror` 派生 `Error` + `Display`,覆盖工具调用边界的错误种类:`NotConnected` / `Write(io::Error)` / `Timeout(Duration)` / `Disconnected` / `UnknownTool(String)` / `Extension(String)`。
- 每个变体的 `Display` 文本**就是模型最终看到的错误内容**(经 `tools::dispatch` 以 `isError` 呈现),措辞面向模型可读、可反应。
- IO/wire 层(`protocol`、`ipc`)继续用 `std::io::Result`——`io::Error` 在那一层本就是对的货币,不强行套 `CallError`;类型化只覆盖更高层的 session/tool 边界。

## 考虑过的替代方案

### 日志:`log` + `env_logger` crate
- **优点**:Rust 生态事实标准,facade + 后端解耦,格式/过滤功能齐全。
- **缺点**:
  - 两个 crate(外加它们的传递依赖:`env_logger` 拉 `regex`/`termcolor`/时间格式等一串),显著扩大依赖树和二进制体积。
  - 本项目的需求极小:四级、按 env 阈值、只写 stderr、固定格式。`env_logger` 的绝大多数能力(模块级过滤、彩色、时间戳、多后端)用不上。
  - 与项目"依赖最小、产物可审计、608KB"的取向冲突(见 ADR-0001)。
- **未被选**:手写日志器仅约百行、零传递依赖,完全覆盖需求。

### 日志:继续裸 `eprintln!`
- **优点**:零抽象。
- **缺点**:无分级、无开关、格式不统一,排障时要么信息淹没要么无从加档。
- **未被选**:整改就是要给诊断输出补分级和开关。

### 错误:继续 stringly-typed / 引入 `anyhow`
- **裸 String**:无法穷举、无法 match、`Display` 分散。
- **anyhow**:适合"应用顶层随手 `?` + context"的场景,但它是**擦除类型**的,调用方拿不到具体变体分流——而这里恰恰想让 session/tool 边界的错误可区分(如 `NotConnected` vs `Timeout` vs `Extension`)。
- **thiserror(采用)**:为库/边界定义**有名字、可 match、Display 可控**的错误枚举而生,正好匹配"工具路径要区分错误种类、且 Display 文本要精确面向模型"的需求。

## 后果

### 正面
- **可控诊断**:分级 + `BB_LOG` 让排障能按需放开 verbosity,不重编译;stderr-only 保证不污染协议 stdout。
- **错误可分流**:`CallError` 各变体可 match、Display 面向模型,`isError` 内容组织统一。
- **依赖仍克制**:日志器手写、零传递依赖;错误仅引入 thiserror(编译期派生宏,运行时零成本)。

### 负面
- **新增两个依赖**:`libc`(信号处理相关,见下)与 `thiserror`。这**回访了 ADR-0001 "唯一第三方依赖是 serde/serde_json" 的最小依赖立场**——那条现已过时。权衡后接受:
  - `thiserror` 是编译期 derive 宏,不进运行时、体积影响极小,是 Rust 生态定义错误类型的"零争议"选择;
  - `libc` 用于 stdout/信号等底层交互(取代部分手动 unsafe/平台细节),是系统级 host 的合理依赖。
  - 二者都在 Rust 生态里属低风险、广泛审计过的基础 crate,与 ADR-0001"易审计"的精神一致,只是把"唯二依赖"扩成"少数几个基础依赖"。
- **手写日志器需自维护**:功能虽小但要自己保证正确(已有单测覆盖分级 ordering 与阈值语义)。

### 中性
- 日志阈值 `OnceLock` 进程内只解析一次——运行中改 `BB_LOG` 不生效,须重启进程;对 host/server 这类常驻进程可接受。

## 实施

- `src/log.rs`:`Level` 枚举、`threshold()`(OnceLock 解析 `BB_LOG`,默认 `info`)、`emit`、`log_*!` 宏;含分级 ordering / 阈值单测。
- `src/error.rs`:`CallError`(thiserror 派生),Display 即模型可见文本;含 Display 文本单测。
- `Cargo.toml`:`[dependencies]` 增 `libc`、`thiserror`(在 serde/serde_json 之外)。
- 工具调用路径改用 `CallError`;散落 `eprintln!` 迁移到 `log_*!`。

## 与其他 ADR 的关系

- **[ADR-0001](./0001-use-rust-single-binary.md)**:本 ADR 修订该 ADR"唯一第三方依赖是 serde/serde_json"的表述——现在还有 `libc` 与 `thiserror`。最小依赖的原则不变,只是边界从"两个"放宽到"少数几个经审计的基础 crate";架构文档 §8 已同步更新。
- **[ADR-0013](./0013-ci-and-toolchain.md)**:日志器与错误类型的正确性由 CI 的 rust job(clippy + `cargo test`)守护。
