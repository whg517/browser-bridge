# ADR-0014: Leveled Logging (BB_LOG) and Typed Errors with thiserror

- **Status**: Accepted
- **Date**: 2026-07-10
- **Deciders**: User + AI assistant

## Background

Before this rework, the Rust backend's diagnostic output was scattered `eprintln!` calls, and error handling was largely "stringly-typed" — whenever something went wrong on a tool-call path, a `String` was assembled on the spot, with no type distinction, so callers could not route by error kind, and the `Display` text was scattered everywhere and hard to unify. Two specific pain points:

- **Logging had no levels and no switch**: every `eprintln!` was either always printed or deleted, so verbosity could not be temporarily raised during troubleshooting; and being scattered around, the formatting was inconsistent.
- **Errors were stringly-typed**: errors at the session/tool boundary (not connected, write failed, timeout, connection dropped, unknown tool, the extension itself reporting an error) all relied on ad-hoc strings, which could neither be enumerated nor matched on, and the `isError` content text was disorganized.

At the same time, a hard constraint runs throughout: **stdout for both binary modes is a protocol stream** — the native host uses 4-byte-prefixed NM frames, and the MCP server uses NDJSON JSON-RPC (see the architecture doc §3). Any non-protocol bytes written to stdout would corrupt frames and drop the connection. So all diagnostic output **must go to stderr only**.

## Decision

**Introduce a minimal, `BB_LOG`-controlled leveled stderr logger (`src/log.rs`) to replace the scattered `eprintln!`; and define typed errors with thiserror on the tool-call path (`src/error.rs`).**

### 1. Leveled logging (`src/log.rs`)
- Four-level `Level`: `Error < Warn < Info < Debug`.
- The threshold is parsed once at process startup from `BB_LOG` (`error|warn|info|debug`) via `OnceLock`; **if unset or unrecognized, it always falls back to `info`**.
- Writes to stderr only: `eprintln!("[{LEVEL}] [{tag}] {msg}")`, printing only above the threshold.
- Provides `log_error!` / `log_warn!` / `log_info!` / `log_debug!` macros with a unified tag + format.
- Defaults to `info`; `debug` lines are hidden by default, and during troubleshooting you can just start with `BB_LOG=debug` to open them up, with no recompile.

### 2. Typed errors (`src/error.rs`)
- The `CallError` enum derives `Error` + `Display` via `thiserror`, covering the error kinds at the tool-call boundary: `NotConnected` / `Write(io::Error)` / `Timeout(Duration)` / `Disconnected` / `UnknownTool(String)` / `Extension(String)`.
- Each variant's `Display` text **is exactly the error content the model ultimately sees** (surfaced by `tools::dispatch` as `isError`), worded to be readable and actionable for the model.
- The IO/wire layer (`protocol`, `ipc`) continues to use `std::io::Result` — `io::Error` is the right currency at that layer, so we don't force `CallError` onto it; typing only covers the higher-level session/tool boundary.

## Alternatives Considered

### Logging: the `log` + `env_logger` crates
- **Pros**: the de facto standard in the Rust ecosystem, facade + backend decoupling, full formatting/filtering features.
- **Cons**:
  - Two crates (plus their transitive dependencies: `env_logger` pulls in a string of things like `regex`/`termcolor`/time formatting), significantly expanding the dependency tree and binary size.
  - This project's needs are minimal: four levels, an env-based threshold, stderr-only, a fixed format. The vast majority of `env_logger`'s capabilities (module-level filtering, color, timestamps, multiple backends) go unused.
  - Conflicts with the project's "minimal dependencies, auditable artifact, 608KB" orientation (see ADR-0001).
- **Not chosen**: a hand-written logger is only about a hundred lines with zero transitive dependencies and fully covers the needs.

### Logging: keep bare `eprintln!`
- **Pros**: zero abstraction.
- **Cons**: no levels, no switch, inconsistent formatting; during troubleshooting you either drown in output or have no way to turn things up.
- **Not chosen**: the whole point of the rework is to add levels and a switch to diagnostic output.

### Errors: keep stringly-typed / introduce `anyhow`
- **Bare String**: cannot be enumerated, cannot be matched on, `Display` is scattered.
- **anyhow**: well suited to the "application top-level, casual `?` + context" scenario, but it is **type-erased**, so callers cannot obtain a specific variant to route on — whereas here we specifically want the session/tool boundary errors to be distinguishable (e.g. `NotConnected` vs `Timeout` vs `Extension`).
- **thiserror (adopted)**: built for defining **named, matchable, Display-controllable** error enums for libraries/boundaries, which exactly matches the need for "the tool path must distinguish error kinds, and the Display text must be precisely model-facing".

## Consequences

### Positive
- **Controllable diagnostics**: levels + `BB_LOG` let troubleshooting raise verbosity on demand without recompiling; stderr-only guarantees the protocol stdout is not polluted.
- **Routable errors**: each `CallError` variant can be matched on, `Display` is model-facing, and the `isError` content is uniformly organized.
- **Dependencies still restrained**: the logger is hand-written with zero transitive dependencies; errors only bring in thiserror (a compile-time derive macro, zero-cost at runtime).

### Negative
- **Two new dependencies**: `libc` (related to signal handling, see below) and `thiserror`. This **revisits ADR-0001's minimal-dependency stance that "the only third-party dependencies are serde/serde_json"** — that statement is now outdated. Accepted after weighing the trade-offs:
  - `thiserror` is a compile-time derive macro that does not enter the runtime, has negligible size impact, and is the "uncontroversial" choice for defining error types in the Rust ecosystem;
  - `libc` is used for low-level interactions such as stdout/signals (replacing some manual unsafe/platform details) and is a reasonable dependency for a system-level host.
  - Both are low-risk, widely audited foundational crates in the Rust ecosystem, consistent with ADR-0001's "easy to audit" spirit; it merely expands "just two dependencies" to "a handful of foundational dependencies".
- **The hand-written logger must be self-maintained**: though small in scope, correctness must be ensured by hand (unit tests already cover level ordering and threshold semantics).

### Neutral
- The log threshold is parsed only once per process via `OnceLock` — changing `BB_LOG` at runtime has no effect and requires restarting the process; acceptable for long-running processes like the host/server.

## Implementation

- `src/log.rs`: the `Level` enum, `threshold()` (`OnceLock` parsing of `BB_LOG`, defaulting to `info`), `emit`, and the `log_*!` macros; includes unit tests for level ordering / thresholds.
- `src/error.rs`: `CallError` (thiserror-derived), with `Display` being the model-visible text; includes `Display` text unit tests.
- `Cargo.toml`: adds `libc` and `thiserror` to `[dependencies]` (beyond serde/serde_json).
- The tool-call path switches to `CallError`; scattered `eprintln!` calls are migrated to `log_*!`.

## Relationship to Other ADRs

- **[ADR-0001](./0001-use-rust-single-binary.md)**: this ADR revises that ADR's statement that "the only third-party dependencies are serde/serde_json" — there are now also `libc` and `thiserror`. The minimal-dependency principle is unchanged; only the boundary is relaxed from "two" to "a handful of audited foundational crates"; architecture doc §8 has been updated accordingly.
- **[ADR-0013](./0013-ci-and-toolchain.md)**: the correctness of the logger and error types is guarded by CI's rust job (clippy + `cargo test`).
