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
    let code = if is_native_host_mode(&args) {
        native_host::run()
    } else if args.len() > 1 && (args[1] == "-h" || args[1] == "--help") {
        print_help();
        0
    } else {
        mcp_server::run()
    };
    std::process::exit(code);
}

/// Chrome launches a Windows native-messaging host directly and appends the
/// calling extension origin (plus a parent-window handle) to its command
/// line. Native-host manifests have no `args` field, so the Windows installer
/// points straight at browser-bridge.exe and this origin selects host mode.
/// Unix installs keep using the explicit `--native-host` wrapper argument.
fn is_native_host_mode(args: &[String]) -> bool {
    if args.get(1).map(String::as_str) == Some("--native-host") {
        return true;
    }
    cfg!(windows)
        && args
            .get(1)
            .is_some_and(|arg| arg.starts_with("chrome-extension://"))
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

#[cfg(test)]
mod tests {
    use super::is_native_host_mode;

    #[test]
    fn explicit_native_host_flag_is_recognized() {
        assert!(is_native_host_mode(&[
            "browser-bridge".into(),
            "--native-host".into()
        ]));
    }

    #[cfg(windows)]
    #[test]
    fn chrome_windows_origin_is_recognized() {
        assert!(is_native_host_mode(&[
            "browser-bridge.exe".into(),
            "chrome-extension://mkjjlmjbcljpcfkfadfmhblmmddkdihf/".into(),
            "--parent-window=123".into(),
        ]));
    }
}
