//! MCP tool definitions and their handlers.
//!
//! Each tool has:
//!   - a `name` and human-readable `description` (shown to the model),
//!   - an `inputSchema` (JSON Schema describing arguments),
//!   - a handler that converts the arguments into a `BridgeReq` op + args
//!     and calls the session.
//!
//! The extension side (background.js / content.js) recognizes the same `op`
//! strings — keep them in sync when editing.

use serde_json::{json, Value};

use crate::error::CallError;
use crate::session::Session;

/// A tool exposed over MCP.
pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}

pub fn all() -> Vec<Tool> {
    vec![
        Tool {
            name: "tab_list",
            description: "List all open browser tabs. Returns id, title, url, and which is active.",
            input_schema: schema(&[], &[]),
        },
        Tool {
            name: "tab_focus",
            description: "Bring a tab to the foreground (make it active).",
            input_schema: schema(&["tabId"], &[("tabId", "integer", "Tab id from tab_list")]),
        },
        Tool {
            name: "tab_open",
            description:
                "Open a URL in a new tab. The host domain must be in the user's allowlist.",
            input_schema: schema(&["url"], &[("url", "string", "Absolute URL to open")]),
        },
        Tool {
            name: "tab_close",
            description:
                "Close an http(s) tab after showing a user-confirmation prompt in that page.",
            input_schema: schema(&["tabId"], &[("tabId", "integer", "Tab id from tab_list")]),
        },
        Tool {
            name: "page_snapshot",
            description:
                "Capture the active tab's interactive elements as an accessibility-style tree. \
                 Each node has a stable `ref` (e.g. \"e3\"), a role, an accessible name, and a \
                 fallback CSS selector. Use the `ref` in page_click/page_fill when possible.",
            input_schema: schema(&[], &[]),
        },
        Tool {
            name: "page_click",
            description:
                "Click an element on the active tab. Prefer passing `ref` (from page_snapshot); \
                 fall back to `selector`. Clicking a submit button or a link triggers a \
                 user-confirmation prompt.",
            input_schema: schema(
                &[],
                &[
                    (
                        "ref",
                        "string",
                        "Element ref from page_snapshot, e.g. \"e3\"",
                    ),
                    ("selector", "string", "CSS selector fallback"),
                ],
            ),
        },
        Tool {
            name: "page_fill",
            description:
                "Type a value into a form field on the active tab. Prefer `ref`; fall back to \
                 `selector`. Password fields are masked in logs/history.",
            input_schema: schema(
                &["value"],
                &[
                    ("ref", "string", "Element ref from page_snapshot"),
                    ("selector", "string", "CSS selector fallback"),
                    ("value", "string", "Text to type into the field"),
                ],
            ),
        },
        Tool {
            name: "page_text",
            description:
                "Return the visible text content of the active tab (sensitive fields masked).",
            input_schema: schema(&[], &[]),
        },
        Tool {
            name: "page_screenshot",
            description: "Capture the visible viewport of the active tab as a PNG (base64).",
            input_schema: schema(&[], &[]),
        },
        Tool {
            name: "page_scroll",
            description:
                "Scroll the active tab. Pass `direction` (up|down|top|bottom) or `pixels`.",
            input_schema: schema(
                &[],
                &[
                    ("direction", "string", "One of: up, down, top, bottom"),
                    (
                        "pixels",
                        "integer",
                        "Number of pixels to scroll (positive = down)",
                    ),
                ],
            ),
        },
        Tool {
            name: "page_wait_for",
            description:
                "Wait until a condition is met on the active tab, or until timeout. One of: \
                 `selector` exists, `text` appears, or `nav` waits for page load completion.",
            input_schema: schema(
                &[],
                &[
                    (
                        "selector",
                        "string",
                        "Wait for this selector to match an element",
                    ),
                    ("text", "string", "Wait for this text to appear in the page"),
                    ("nav", "boolean", "Wait for a navigation event"),
                    ("timeoutMs", "integer", "Max wait in ms (default 30000)"),
                ],
            ),
        },
        Tool {
            name: "page_eval",
            description:
                "HIGH RISK — execute arbitrary JavaScript on the active tab. EVERY call shows the \
                 user the full code in a confirmation prompt and waits for approval; within 60s of \
                 an approval, same-origin evals run without re-prompting. The return value is \
                 masked (JWT / long hex / long numbers / token-like strings) by default. This is \
                 the most powerful tool: prefer page_click / page_fill / page_snapshot whenever \
                 possible, and only use page_eval when those cannot achieve the goal (custom \
                 events, reading framework state, SPA routing, canvas/WebGL, etc.). Code runs in \
                 the page's global scope, wrapped as `async`, so you can `await` and `return` a \
                 value. Async results are awaited. Errors are returned as {name, message}.",
            input_schema: schema(
                &["code"],
                &[("code", "string", "JavaScript code to execute")],
            ),
        },
        Tool {
            name: "page_snapshot_precise",
            description:
                "Like page_snapshot, but uses Chrome's debugger (CDP Accessibility.getFullAXTree) \
                 to capture the AUTHORITATIVE accessibility tree — accurate for shadow DOM and \
                 complex ARIA where the content-script approximation misses. The user is warned \
                 first (a brief on-page notice); Chrome then shows a 'Started debugging this \
                 browser' banner on all tabs for ~1 second while the snapshot is taken, then it \
                 disappears. Cannot run on chrome:// / web store pages, or tabs with DevTools \
                 open. Refs use a 'p' prefix (p1, p2...) and work with page_click / page_fill \
                 unchanged. Use this when page_snapshot misses elements or roles look wrong.",
            input_schema: schema(
                &[],
                &[(
                    "frameId",
                    "string",
                    "Optional: limit to a specific frame's tree",
                )],
            ),
        },
        Tool {
            name: "cookie_get",
            description:
                "Read cookies for the active tab (or a url/domain you specify). Includes httpOnly \
                 cookies (the main reason to use this over document.cookie). Scoped to hosts in \
                 the user's allowlist — unauthorized hosts silently return nothing. Read-only; \
                 there is no cookie_set (writing httpOnly cookies is a session-fixation risk). \
                 Values are masked (JWT / long hex / long numbers) before being returned. If you \
                 omit url/domain/name, cookies for the active tab's URL are returned.",
            input_schema: schema(
                &[],
                &[
                    (
                        "url",
                        "string",
                        "Return cookies that would be sent to this URL",
                    ),
                    ("domain", "string", "Match this domain and its subdomains"),
                    ("name", "string", "Exact cookie name to match"),
                ],
            ),
        },
        Tool {
            name: "storage_get",
            description:
                "Read the page's localStorage or sessionStorage (where frameworks like Auth0 / \
                 NextAuth / Firebase store tokens). Must run on the active tab; same-origin \
                 only (cross-origin iframes are not readable). Pass `key` to fetch one entry, \
                 or omit it to dump all entries (capped at 500). Values are ALWAYS masked \
                 (JWT / long hex / long numbers) — this masking is not toggleable. Read-only.",
            input_schema: schema(
                &[],
                &[
                    ("type", "string", "\"local\" (default) or \"session\""),
                    (
                        "key",
                        "string",
                        "Specific key to read; omit for all entries",
                    ),
                ],
            ),
        },
    ]
}

/// Helper to build a minimal JSON-Schema object schema with required + props.
fn schema(required: &[&str], props: &[(&str, &str, &str)]) -> Value {
    let properties: serde_json::Map<String, Value> = props
        .iter()
        .map(|(name, ty, desc)| {
            (
                (*name).to_string(),
                json!({ "type": *ty, "description": *desc }),
            )
        })
        .collect();
    json!({
        "type": "object",
        "properties": Value::Object(properties),
        "required": required.iter().map(|s| (*s).to_string()).collect::<Vec<_>>(),
    })
}

/// Dispatch a tool call. Returns the MCP result `content` value (an array)
/// and the isError flag. Errors are tool-level (isError=true), not RPC-level.
pub fn dispatch(session: &Session, name: &str, args: &Value) -> (Value, bool) {
    let result = match name {
        "tab_list" => call(session, "tab_list", None, json!({})),
        "tab_focus" => {
            let tab_id = iarg(args, "tabId");
            call(session, "tab_focus", None, json!({ "tabId": tab_id }))
        }
        "tab_open" => {
            let url = sarg(args, "url");
            call(session, "tab_open", None, json!({ "url": url }))
        }
        "tab_close" => {
            let tab_id = iarg(args, "tabId");
            call(session, "tab_close", None, json!({ "tabId": tab_id }))
        }
        "page_snapshot" => call(session, "page_snapshot", None, json!({})),
        "page_click" => {
            let payload = ref_or_selector(args);
            call(session, "page_click", None, payload)
        }
        "page_fill" => {
            let value = sarg(args, "value");
            let mut payload = ref_or_selector(args);
            payload["value"] = json!(value);
            call(session, "page_fill", None, payload)
        }
        "page_text" => call(session, "page_text", None, json!({})),
        "page_screenshot" => call(session, "page_screenshot", None, json!({})),
        "page_scroll" => {
            let mut payload = serde_json::Map::new();
            if let Some(d) = args.get("direction").and_then(|v| v.as_str()) {
                payload.insert("direction".into(), json!(d));
            }
            if let Some(p) = args.get("pixels").and_then(|v| v.as_i64()) {
                payload.insert("pixels".into(), json!(p));
            }
            call(session, "page_scroll", None, Value::Object(payload))
        }
        "page_wait_for" => {
            let mut payload = serde_json::Map::new();
            if let Some(s) = args.get("selector").and_then(|v| v.as_str()) {
                payload.insert("selector".into(), json!(s));
            }
            if let Some(t) = args.get("text").and_then(|v| v.as_str()) {
                payload.insert("text".into(), json!(t));
            }
            if let Some(n) = args.get("nav").and_then(|v| v.as_bool()) {
                payload.insert("nav".into(), json!(n));
            }
            payload.insert(
                "timeoutMs".into(),
                json!(args
                    .get("timeoutMs")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(30000)),
            );
            call(session, "page_wait_for", None, Value::Object(payload))
        }
        "page_eval" => {
            let code = sarg(args, "code");
            call(session, "page_eval", None, json!({ "code": code }))
        }
        "page_snapshot_precise" => {
            let mut payload = serde_json::Map::new();
            if let Some(f) = args.get("frameId").and_then(|v| v.as_str()) {
                payload.insert("frameId".into(), json!(f));
            }
            call(
                session,
                "page_snapshot_precise",
                None,
                Value::Object(payload),
            )
        }
        "cookie_get" => {
            let mut payload = serde_json::Map::new();
            if let Some(u) = args.get("url").and_then(|v| v.as_str()) {
                payload.insert("url".into(), json!(u));
            }
            if let Some(d) = args.get("domain").and_then(|v| v.as_str()) {
                payload.insert("domain".into(), json!(d));
            }
            if let Some(n) = args.get("name").and_then(|v| v.as_str()) {
                payload.insert("name".into(), json!(n));
            }
            call(session, "cookie_get", None, Value::Object(payload))
        }
        "storage_get" => {
            let mut payload = serde_json::Map::new();
            if let Some(t) = args.get("type").and_then(|v| v.as_str()) {
                payload.insert("type".into(), json!(t));
            }
            if let Some(k) = args.get("key").and_then(|v| v.as_str()) {
                payload.insert("key".into(), json!(k));
            }
            call(session, "storage_get", None, Value::Object(payload))
        }
        unknown => Err(CallError::UnknownTool(unknown.to_string())),
    };

    match result {
        Ok(data) => {
            // Screenshots come back as base64 PNG; expose as an image content
            // block so the model sees the picture directly.
            if name == "page_screenshot" {
                if let Some(png_b64) = data.get("image").and_then(|v| v.as_str()) {
                    return (
                        json!([{
                            "type": "image",
                            "data": png_b64,
                            "mimeType": "image/png"
                        }]),
                        false,
                    );
                }
            }
            (json!([{ "type": "text", "text": data.to_string() }]), false)
        }
        Err(e) => (
            json!([{ "type": "text", "text": format!("Error: {e}") }]),
            true,
        ),
    }
}

fn call(session: &Session, op: &str, tab_id: Option<i64>, args: Value) -> Result<Value, CallError> {
    session.call(op, tab_id, args)
}

fn sarg(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn iarg(args: &Value, key: &str) -> i64 {
    args.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn ref_or_selector(args: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    if let Some(r) = args.get("ref").and_then(|v| v.as_str()) {
        payload.insert("ref".into(), json!(r));
    }
    if let Some(s) = args.get("selector").and_then(|v| v.as_str()) {
        payload.insert("selector".into(), json!(s));
    }
    Value::Object(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_are_unique() {
        let tools = all();
        let mut names: Vec<&str> = tools.iter().map(|t| t.name).collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), total, "duplicate tool names present");
    }

    #[test]
    fn tool_count_is_pinned() {
        // Bump deliberately when adding/removing a tool (keeps docs honest).
        assert_eq!(all().len(), 15);
    }

    // contracts/tools.json is the single source of truth for the catalogue.
    // tools.rs is verified against it here; the TS ops.ts is generated from it.
    #[test]
    fn matches_contract() {
        let contract: Value =
            serde_json::from_str(include_str!("../contracts/tools.json")).unwrap();
        let ctools = contract["tools"].as_array().unwrap();
        let cnames: Vec<&str> = ctools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        let tools = all();
        let names: Vec<&str> = tools.iter().map(|t| t.name).collect();
        assert_eq!(
            names, cnames,
            "tools.rs names/order must match contracts/tools.json (run `make gen`)"
        );
        for t in &tools {
            let c = ctools.iter().find(|c| c["name"] == t.name).unwrap();
            assert_eq!(
                c["description"].as_str().unwrap(),
                t.description,
                "description mismatch for {} vs contract",
                t.name
            );
            assert_eq!(
                &t.input_schema, &c["inputSchema"],
                "inputSchema mismatch for {} vs contract",
                t.name
            );
        }
    }

    #[test]
    fn every_tool_has_object_schema() {
        for t in all() {
            assert_eq!(t.input_schema["type"], "object", "tool {}", t.name);
            assert!(t.input_schema["properties"].is_object(), "tool {}", t.name);
            assert!(t.input_schema["required"].is_array(), "tool {}", t.name);
        }
    }

    #[test]
    fn schema_builder_shape() {
        let s = schema(&["url"], &[("url", "string", "the url")]);
        assert_eq!(s["type"], "object");
        assert_eq!(s["required"][0], "url");
        assert_eq!(s["properties"]["url"]["type"], "string");
        assert_eq!(s["properties"]["url"]["description"], "the url");
    }
}
