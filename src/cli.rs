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

pub fn print_help() {
    eprintln!(
        "browser-bridge {version}\n\
         Bridge an MCP client to a real Chrome via an extension + native host.\n\n\
         USAGE:\n    \
         browser-bridge              Run as MCP server (for your MCP client)\n    \
         browser-bridge tools [--json]      List the available tools + arguments\n    \
         browser-bridge call <tool> [json]  Run one tool and print its result (no MCP)\n    \
         browser-bridge doctor       Print a read-only health report (alias: status)\n    \
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
                    let ty = spec.get("type").and_then(Value::as_str).unwrap_or("any");
                    let desc = spec.get("description").and_then(Value::as_str).unwrap_or("");
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
    use super::{is_native_host_mode, tools_catalogue_json};

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
