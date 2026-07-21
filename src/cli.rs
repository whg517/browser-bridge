//! Command-line entry helpers: argv-based mode selection and the `--help`
//! text. Kept in the library so they are unit-testable and reusable.

/// Chrome launches a Windows native-messaging host directly and appends the
/// calling extension origin (plus a parent-window handle) to its command
/// line. Native-host manifests have no `args` field, so the Windows installer
/// points straight at browser-bridge.exe and this origin selects host mode.
/// Unix installs keep using the explicit `--native-host` wrapper argument.
pub fn is_native_host_mode(args: &[String]) -> bool {
    if args.get(1).map(String::as_str) == Some("--native-host") {
        return true;
    }
    cfg!(windows)
        && args
            .get(1)
            .is_some_and(|arg| arg.starts_with("chrome-extension://"))
}

pub fn print_help() {
    eprintln!(
        "browser-bridge {version}\n\
         Bridge an MCP client to a real Chrome via an extension + native host.\n\n\
         USAGE:\n    \
         browser-bridge              Run as MCP server (for your MCP client)\n    \
         browser-bridge call <tool> [json]  Run one tool and print its result (no MCP)\n    \
         browser-bridge doctor       Print a read-only health report (alias: status)\n    \
         browser-bridge --native-host  Run as the Chrome native messaging host\n\n\
         Configure your MCP client (Claude Code, Codex, …) to launch this \
         binary with no arguments as an MCP server; Chrome launches it with \
         --native-host via the host manifest. `call` is a convenience for shells \
         and non-MCP agents: e.g. `browser-bridge call tab_list` or \
         `browser-bridge call tab_open '{{\"url\":\"https://example.com\"}}'`. It \
         won't run while your MCP client is active (they share one bridge).",
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
