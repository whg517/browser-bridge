//! browser-bridge — thin binary entry point.
//!
//! All logic lives in the `browser_bridge` library crate (`src/lib.rs`); this
//! binary only selects a mode from argv and forwards to the library:
//! - (no args): MCP server (default). Run under your MCP client's server config.
//! - --native-host: Chrome-spawned bridge subprocess. Chrome launches this
//!   via the native messaging host manifest; it should never be invoked by hand.

use browser_bridge::cli::{is_native_host_mode, print_help, print_tools};
use browser_bridge::{doctor, mcp_server, native_host};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = if is_native_host_mode(&args) {
        native_host::run()
    } else if args.len() > 1 && (args[1] == "-h" || args[1] == "--help") {
        print_help();
        0
    } else if args.len() > 1 && (args[1] == "doctor" || args[1] == "status") {
        doctor::run()
    } else if args.len() > 1 && args[1] == "tools" {
        // Self-describe: print the tool catalogue so a non-MCP caller can
        // discover what's available. `--json` = machine-readable (MCP tools/list).
        print_tools(args.iter().skip(2).any(|a| a == "--json"));
        0
    } else if args.len() > 1 && args[1] == "call" {
        // One-shot tool call for non-MCP callers: `call <tool> [json-args]`.
        match args.get(2) {
            Some(tool) => mcp_server::run_call(tool, args.get(3).map(String::as_str)),
            None => {
                eprintln!("usage: browser-bridge call <tool> [json-args]");
                2
            }
        }
    } else {
        mcp_server::run()
    };
    std::process::exit(code);
}
