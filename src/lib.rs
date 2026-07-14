//! browser-bridge — bridge an MCP client (Claude Code, Codex, …) to your real
//! Chrome.
//!
//! One binary, two modes selected by argv:
//! - (no args): MCP server (default). Run under your MCP client's server config.
//! - --native-host: Chrome-spawned bridge subprocess. Chrome launches this
//!   via the native messaging host manifest; it should never be invoked by hand.
//!
//! This crate is structured as a library (`src/lib.rs`) plus a thin binary
//! (`src/main.rs`). The library exposes every module so the modules are
//! reachable from integration tests and future consumers.

// Exporting the modules as public API surfaces `clippy::new_without_default`
// on constructors like `Session::new()` that were previously crate-internal
// to the binary. This is a purely structural side effect of the lib/bin split
// (no behavior changed), so allow it crate-wide rather than touch module code.
#![allow(clippy::new_without_default)]

#[macro_use]
pub mod log;
pub mod cli;
pub mod doctor;
pub mod error;
pub mod ipc;
pub mod mcp_server;
pub mod native_host;
pub mod protocol;
pub mod session;
pub mod tools;
