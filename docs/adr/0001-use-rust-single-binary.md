# ADR-0001:用 Rust 单二进制 + 子命令分发

- **状态**:Accepted(依赖清单部分由 [ADR-0014](./0014-leveled-logging.md) 修订)
- **日期**:2026-07-07
- **决策者**:用户 + AI 助手

> **修订note**:本 ADR 原文称唯一依赖是 `serde`/`serde_json`。工程化整改后另加了
> `libc`(信号处理)与 `thiserror`(类型化错误),见 [ADR-0014](./0014-leveled-logging.md)。
> 单二进制、手写协议、不用 tokio 的核心决策不变。

## 背景

browser-bridge 的后端需要同时承担两个角色:

1. **MCP server**:由 MCP 客户端通过其 MCP server 配置 spawn,讲 JSON-RPC over stdio
2. **Native Messaging host**:由 Chrome 通过 host manifest spawn,讲 4 字节长度前缀帧 over stdio

这两个角色都需要长期运行、都需要处理 stdin/stdout 的二进制协议、都需要可靠。

最初的设计稿(基于"环境只有 Python 3.9.6"的错误探测,后已纠正)用 Python 标准库实现。在核实环境时发现用户机器实际有 Homebrew Rust 1.96,且 Rust 对这个场景有显著优势。

## 决策

**用 Rust 写后端,编译成单个二进制,通过子命令分发模式:**

- 默认调用(无参数)= MCP server 模式
- `--native-host` = native host 模式
- `--help` = 帮助

两个模式共享同一个 crate、同一份协议代码(`protocol.rs`),只是入口分发不同。

## 考虑过的替代方案

### 方案 A:Python 标准库(最初设计)
- **优点**:零编译;跨平台;标准库够用
- **缺点**:
  - 运行时依赖 Python 环境(用户机器虽有,但是 Homebrew 装的,PATH 不一定有)
  - host manifest 的 `path` 要指向 Python 解释器 + 脚本,wrapper 更复杂
  - 性能/内存不如编译型语言(常驻进程)
  - **决定性问题**:用户的实际 Python 环境是 Homebrew 装的多版本,系统 `python3` 是 3.9.6,host 启动时用哪个不确定,易碎

### 方案 B:两个独立 Rust crate(host 一个、mcp-server 一个)
- **优点**:职责边界清晰;各自依赖最小
- **缺点**:
  - 两个编译产物要同步分发
  - 共享协议代码要提成 workspace 内的子 crate,增加结构复杂度
  - 升级要替换两个文件

### 方案 C:Go
- **优点**:单二进制;交叉编译方便;GC 但对这个场景无所谓
- **缺点**:用户机器没装 Go(已核实 `which go` not found);需要先装工具链
- **排除**:Rust 已在用户环境(Homebrew),Go 还要装

### 方案 D:Rust + tokio(异步)
- **优点**:并发模型成熟;生态丰富
- **缺点**:
  - 请求是串行的(一次工具调用一个往返),没有高并发需求
  - tokio 徒增二进制体积(几 MB)、编译时间(几十秒)、复杂度
  - std 的线程 + mpsc channel 完全够用

## 后果

### 正面
- **单二进制分发**:升级 = 拷贝一个文件;host manifest `path` 写绝对路径,与 PATH 无关(契合用户 PATH 不含 homebrew 的现实约束)
- **产物小**:release + opt-level z + lto,608KB
- **零运行时依赖**:用户机器不需要任何运行时(对比 Python 方案)
- **共享代码**:两个模式共用 `protocol.rs` 里的 NM 帧、MCP JSON-RPC、桥接协议定义
- **panic 安全**:Rust 的 `panic = "abort"` + stderr hook 比 Python 异常更容易保证不污染 stdout

### 负面
- **编译需要 Rust 工具链**:用户机器有(Homebrew 1.96),但首次开发环境配置比 Python 略重
- **`install.sh` 要处理 PATH**:`cargo` 子进程依赖 PATH 里的 `rustc`,而用户 PATH 不含 `/opt/homebrew/bin`。已在 install.sh 里加 `export PATH="$(dirname $CARGO):$PATH"` 处理
- **改代码要重新编译**:开发迭代比 Python 慢(release ~45s,dev ~5s)

### 中性
- `serde`/`serde_json` 是唯一第三方依赖,几乎是 Rust 生态的"零争议"选择,审计算 1 个 crate

## 实施

- `Cargo.toml` 单 crate,profile.release 设 `opt-level="z"` + `lto=true` + `panic="abort"`
- `src/main.rs` 根据 `args[1]` 分发到 `mcp_server::run()` 或 `native_host::run()`
- `install.sh` 编译后拷贝到 `~/.browser-bridge/browser-bridge`,用 `run-host.sh` wrapper 加 `--native-host` 参数(绕过 NM manifest 无 args 字段的限制)

## 参考

- 用户环境核实:`/opt/homebrew/bin/cargo` 1.96.1(Homebrew);`~/.cargo` 无 cargo/rustc(非 rustup)
- 现有同类 host(Claude/Codex/AutoClaw)都是编译型二进制,印证了这个选择
