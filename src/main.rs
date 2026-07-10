//! browser-bridge — bridge an MCP client (Claude Code, Codex, …) to your real
//! Chrome.
//!
//! One binary, two modes selected by argv:
//! - (no args): MCP server (default). Run under your MCP client's server config.
//! - --native-host: Chrome-spawned bridge subprocess. Chrome launches this
//!   via the native messaging host manifest; it should never be invoked by hand.

#[macro_use]
mod log;
mod error;
mod ipc;
mod mcp_server;
mod native_host;
mod protocol;
mod session;
mod tools;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = if args.len() > 1 && args[1] == "--native-host" {
        native_host::run()
    } else if args.len() > 1 && (args[1] == "-h" || args[1] == "--help") {
        print_help();
        0
    } else {
        mcp_server::run()
    };
    std::process::exit(code);
}

fn print_help() {
    eprintln!(
        "browser-bridge {version}\n\
         Bridge an MCP client to a real Chrome via an extension + native host.\n\n\
         USAGE:\n    \
         browser-bridge              Run as MCP server (for your MCP client)\n    \
         browser-bridge --native-host  Run as the Chrome native messaging host\n\n\
         Configure your MCP client (Claude Code, Codex, …) to launch this \
         binary with no arguments as an MCP server; Chrome launches it with \
         --native-host via the host manifest. You normally never invoke either \
         mode by hand.",
        version = env!("CARGO_PKG_VERSION")
    );
}
