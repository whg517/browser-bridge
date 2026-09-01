//! Command-line entry helpers: argv-based mode selection, the `--help` text,
//! and the `tools` self-describe output. Kept in the library so they are
//! unit-testable and reusable.

use serde_json::Value;

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

/// Every argv[1] this binary accepts — flags and subcommands alike.
///
/// `--native-host` is listed because Chrome's Unix launch really does pass it:
/// the host manifest points at a wrapper that execs `<binary> --native-host`
/// without forwarding its own arguments. Chrome's WINDOWS launch is the one
/// that arrives as an origin instead of a flag, and it is recognized earlier by
/// `is_native_host_mode`, so it never reaches this list.
const KNOWN_ARGS: &[&str] = &[
    "-h",
    "--help",
    "-V",
    "--version",
    "--native-host",
    "--takeover",
    "doctor",
    "status",
    "tools",
    "call",
];

/// An unrecognized argv[1], if there is one.
///
/// Without this the mode dispatch has no unknown-argument branch: anything
/// unmatched falls through to the default, which starts an MCP server and
/// claims the bridge. (Before ADR-0028 Phase 0 that claim was a silent
/// takeover — `browser-bridge --version` printed no error and killed the
/// running agent session; the default now refuses, but a typo should never
/// get as far as starting a server at all.)
///
/// Matching against the full accepted set rather than only `-`-prefixed input
/// is deliberate: a mistyped subcommand is exactly as destructive as a mistyped
/// flag, and there is no open-ended subcommand space this would wrongly claim —
/// the list above IS the surface. Bare invocation stays untouched, since that is
/// how every MCP client launches the server.
pub fn unrecognized_arg(args: &[String]) -> Option<&str> {
    // Defer to the native-host check rather than relying on the caller running
    // it first. The dispatch does run it first, but a guard that can reject a
    // legitimate Chrome launch if someone reorders the branches is a trap worth
    // not leaving lying around.
    if is_native_host_mode(args) {
        return None;
    }
    let first = args.get(1)?.as_str();
    if KNOWN_ARGS.contains(&first) {
        return None;
    }
    Some(first)
}

/// Print the version to stdout and nothing else.
///
/// stdout is the protocol stream in both binary modes, but this path runs
/// instead of either of them, never alongside — same as the `tools` subcommand.
/// Version output goes to stdout so it stays pipeable; `print_help` writes to
/// stderr because it accompanies errors.
pub fn print_version() {
    println!("browser-bridge {}", env!("CARGO_PKG_VERSION"));
}

pub fn print_help() {
    eprintln!(
        "browser-bridge {version}\n\
         Bridge an MCP client to a real Chrome via an extension + native host.\n\n\
         USAGE:\n    \
         browser-bridge              Run as MCP server (for your MCP client)\n    \
         browser-bridge --takeover   Run as MCP server, taking over a live bridge\n    \
         browser-bridge tools [--json]      List the available tools + arguments\n    \
         browser-bridge call <tool> [json]  Run one tool and print its result (no MCP)\n    \
         browser-bridge doctor       Print a read-only health report (alias: status)\n    \
         browser-bridge --version    Print the version (alias: -V)\n    \
         browser-bridge --native-host  Run as the Chrome native messaging host\n\n\
         Configure your MCP client (Claude Code, Codex, …) to launch this \
         binary with no arguments as an MCP server; Chrome launches it with \
         --native-host via the host manifest.\n\n\
         Non-MCP agents/scripts: run `browser-bridge tools --json` to discover \
         capabilities (same shape as MCP tools/list), then \
         `browser-bridge call <tool> '<json-args>'` to invoke one — \
         e.g. `browser-bridge call tab_list`. `call` shares the single bridge, \
         so it won't run while your MCP client is active.",
        version = env!("CARGO_PKG_VERSION")
    );
}

/// The tool catalogue as a JSON document `{ "tools": [...] }`, with the same
/// per-tool shape (`name`, `description`, `inputSchema`) an MCP client gets from
/// `tools/list`. Lets a non-MCP agent discover capabilities without a handshake.
pub fn tools_catalogue_json() -> Value {
    let list: Vec<Value> = crate::tools::all()
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input_schema,
            })
        })
        .collect();
    serde_json::json!({ "tools": list })
}

/// Print the tool catalogue for the `tools` subcommand. `--json` emits the
/// machine-readable form (equal to MCP `tools/list`); otherwise a human summary
/// of each tool's name, description, and arguments. Neither needs the extension.
pub fn print_tools(as_json: bool) {
    if as_json {
        let doc = tools_catalogue_json();
        println!(
            "{}",
            serde_json::to_string_pretty(&doc).unwrap_or_else(|_| doc.to_string())
        );
        return;
    }

    let tools = crate::tools::all();
    println!(
        "browser-bridge — {} tools. Invoke one without MCP:\n  \
         browser-bridge call <tool> '<json-args>'\n",
        tools.len()
    );
    for t in &tools {
        println!("{}", t.name);
        for line in t.description.lines() {
            println!("    {line}");
        }
        let required: std::collections::BTreeSet<&str> = t
            .input_schema
            .get("required")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        match t.input_schema.get("properties").and_then(Value::as_object) {
            Some(props) if !props.is_empty() => {
                println!("    args:");
                for (name, spec) in props {
                    let field = |k: &str| spec.get(k).and_then(Value::as_str);
                    let ty = field("type").unwrap_or("any");
                    let desc = field("description").unwrap_or("");
                    let req = if required.contains(name.as_str()) {
                        "required"
                    } else {
                        "optional"
                    };
                    if desc.is_empty() {
                        println!("      {name} ({ty}, {req})");
                    } else {
                        println!("      {name} ({ty}, {req}) — {desc}");
                    }
                }
            }
            _ => println!("    args: (none)"),
        }
        println!();
    }
    println!("Machine-readable (same shape as MCP tools/list): browser-bridge tools --json");
}

#[cfg(test)]
mod tests {
    use super::{is_native_host_mode, tools_catalogue_json, unrecognized_arg};

    fn argv(rest: &[&str]) -> Vec<String> {
        std::iter::once("browser-bridge")
            .chain(rest.iter().copied())
            .map(String::from)
            .collect()
    }

    // The bug this guards: an unmatched argv[1] fell through to the default
    // branch, which starts an MCP server — which (before ADR-0028 Phase 0)
    // terminated whichever server held the lock. So a typo ended somebody's
    // session instead of erroring.
    #[test]
    fn unrecognized_args_are_rejected_not_run_as_a_server() {
        // Mistyped flags...
        for bad in ["--hepl", "--foo", "-x", "--verison"] {
            assert_eq!(
                unrecognized_arg(&argv(&[bad])),
                Some(bad),
                "{bad} must not reach the server branch"
            );
        }
        // ...and mistyped subcommands, which are exactly as destructive.
        for bad in ["doctro", "statuss", "tool", "cal", "serve"] {
            assert_eq!(
                unrecognized_arg(&argv(&[bad])),
                Some(bad),
                "{bad} must not reach the server branch"
            );
        }
    }

    #[test]
    fn known_flags_and_subcommands_pass_through() {
        // Handled by their own branches before the guard runs. --version is the
        // flag that motivated all this: it used to be unrecognized and is now a
        // mode of its own, so the guard must let it through, not reject it.
        for ok in ["-h", "--help", "-V", "--version", "--native-host"] {
            assert_eq!(unrecognized_arg(&argv(&[ok])), None);
        }
        // Every real subcommand, each dispatched by its own branch below.
        for ok in ["doctor", "status", "tools", "call"] {
            assert_eq!(unrecognized_arg(&argv(&[ok])), None);
        }
    }

    #[test]
    fn no_args_still_selects_the_server() {
        // How every MCP client launches it — must never be treated as a typo.
        assert_eq!(unrecognized_arg(&argv(&[])), None);
    }

    // The Unix native-host launch, which is what the wrapper script produces:
    // `exec <binary> --native-host`, with Chrome's own arguments not forwarded.
    #[test]
    fn unix_native_host_launch_is_not_a_typo() {
        assert_eq!(unrecognized_arg(&argv(&["--native-host"])), None);
    }

    // The Windows launch arrives as an origin instead of a flag, so the guard
    // has to defer to is_native_host_mode rather than pattern-match argv[1].
    // Gated on the platform because that check is `cfg!(windows)`; on Unix the
    // wrapper above means Chrome never hands the binary an origin.
    #[cfg(windows)]
    #[test]
    fn windows_native_host_launch_is_not_a_typo() {
        let chrome = argv(&[
            "chrome-extension://mkjjlmjbcljpcfkfadfmhblmmddkdihf/",
            "--parent-window=0",
        ]);
        assert_eq!(unrecognized_arg(&chrome), None);
    }

    #[test]
    fn explicit_native_host_flag_is_recognized() {
        assert!(is_native_host_mode(&[
            "browser-bridge".into(),
            "--native-host".into()
        ]));
    }

    #[test]
    fn tools_catalogue_matches_all_and_carries_schema_fields() {
        let doc = tools_catalogue_json();
        let list = doc.get("tools").and_then(|v| v.as_array()).expect("tools");
        assert_eq!(list.len(), crate::tools::all().len());
        assert!(!list.is_empty());
        for t in list {
            assert!(t.get("name").and_then(|v| v.as_str()).is_some());
            assert!(t.get("description").and_then(|v| v.as_str()).is_some());
            assert!(t.get("inputSchema").is_some());
        }
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
