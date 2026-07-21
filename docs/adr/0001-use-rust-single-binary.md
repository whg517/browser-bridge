# ADR-0001: Rust Single Binary + Subcommand Dispatch

- **Status**: Accepted (dependency list partially revised by [ADR-0014](./0014-leveled-logging.md))
- **Date**: 2026-07-07
- **Deciders**: User + AI assistant

> **Revision note**: This ADR originally stated that the only dependencies were `serde`/`serde_json`. After engineering cleanup,
> `libc` (signal handling) and `thiserror` (typed errors) were added as well; see [ADR-0014](./0014-leveled-logging.md).
> The core decisions — single binary, hand-written protocol, no tokio — remain unchanged.

## Context

The browser-bridge backend needs to play two roles simultaneously:

1. **MCP server**: spawned by the MCP client through its MCP server configuration, speaking JSON-RPC over stdio
2. **Native Messaging host**: spawned by Chrome through the host manifest, speaking 4-byte length-prefixed frames over stdio

Both roles need to run long-term, both need to handle binary protocols over stdin/stdout, and both need to be reliable.

The initial design draft (based on the mistaken detection that "the environment only had Python 3.9.6," later corrected) was implemented with the Python standard library. When verifying the environment, we found that the user's machine actually had Homebrew Rust 1.96, and that Rust offers significant advantages for this scenario.

## Decision

**Write the backend in Rust, compile it into a single binary, and dispatch via a subcommand pattern:**

- Default invocation (no arguments) = MCP server mode
- `--native-host` = native host mode
- `--help` = help

The two modes share the same crate and the same protocol code (`protocol.rs`); only the entry-point dispatch differs.

## Alternatives Considered

### Option A: Python standard library (initial design)
- **Pros**: no compilation; cross-platform; the standard library is sufficient
- **Cons**:
  - Runtime dependency on a Python environment (the user's machine has one, but it is installed via Homebrew and may not be on PATH)
  - The host manifest's `path` would have to point to the Python interpreter plus the script, making the wrapper more complex
  - Performance/memory are worse than a compiled language (long-running process)
  - **Decisive issue**: the user's actual Python environment is a multi-version Homebrew install, the system `python3` is 3.9.6, and which one the host uses at startup is uncertain and fragile

### Option B: two separate Rust crates (one for the host, one for mcp-server)
- **Pros**: clear separation of responsibilities; minimal dependencies for each
- **Cons**:
  - Two compiled artifacts must be distributed in sync
  - Shared protocol code would have to be extracted into a sub-crate within the workspace, increasing structural complexity
  - Upgrades require replacing two files

### Option C: Go
- **Pros**: single binary; convenient cross-compilation; GC, but it doesn't matter for this scenario
- **Cons**: Go is not installed on the user's machine (verified: `which go` not found); the toolchain would need to be installed first
- **Excluded**: Rust is already in the user's environment (Homebrew), whereas Go would still need to be installed

### Option D: Rust + tokio (async)
- **Pros**: mature concurrency model; rich ecosystem
- **Cons**:
  - Requests are serial (one round-trip per tool call), so there is no need for high concurrency
  - tokio only adds binary size (several MB), compile time (tens of seconds), and complexity
  - std's threads + mpsc channel are entirely sufficient

## Consequences

### Positive
- **Single-binary distribution**: upgrading = copying one file; the host manifest `path` uses an absolute path, independent of PATH (fitting the real-world constraint that the user's PATH does not include homebrew)
- **Small artifact**: release + opt-level z + lto, 608KB
- **Zero runtime dependencies**: the user's machine needs no runtime at all (compared to the Python option)
- **Shared code**: both modes reuse the NM framing, MCP JSON-RPC, and bridge protocol definitions in `protocol.rs`
- **Panic safety**: Rust's `panic = "abort"` + stderr hook makes it easier than Python exceptions to guarantee that stdout is not polluted

### Negative / Trade-offs
- **Compilation requires the Rust toolchain**: the user's machine has it (Homebrew 1.96), but first-time development environment setup is slightly heavier than Python
- **`install.sh` must handle PATH**: the `cargo` subprocess depends on `rustc` being on PATH, but the user's PATH does not include `/opt/homebrew/bin`. This is handled by adding `export PATH="$(dirname $CARGO):$PATH"` in install.sh
- **Code changes require recompilation**: development iteration is slower than Python (release ~45s, dev ~5s)

### Neutral
- `serde`/`serde_json` is the only third-party dependency, an almost "zero-controversy" choice in the Rust ecosystem, counting as 1 crate for auditing purposes

## Implementation

- `Cargo.toml` is a single crate, with profile.release set to `opt-level="z"` + `lto=true` + `panic="abort"`
- `src/main.rs` dispatches to `mcp_server::run()` or `native_host::run()` based on `args[1]`
- `install.sh` compiles and then copies the binary to `~/.browser-bridge/browser-bridge`, using the `run-host.sh` wrapper to add the `--native-host` argument (working around the limitation that the NM manifest has no args field)

## See Also

- User environment verification: `/opt/homebrew/bin/cargo` 1.96.1 (Homebrew); `~/.cargo` has no cargo/rustc (not rustup)
- Existing hosts of the same kind (Claude/Codex/AutoClaw) are all compiled binaries, confirming this choice
