//! The tool catalogue: the [`Tool`] struct, the [`all`] catalogue, and the
//! [`schema`] helper used to build each tool's JSON-Schema `inputSchema`.

use serde_json::{json, Value};

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
            description: "Open a URL in a new tab.",
            input_schema: schema(&["url"], &[("url", "string", "Absolute URL to open")]),
        },
        Tool {
            name: "tab_close",
            description: "Close a browser tab by `tabId`.",
            input_schema: schema(&["tabId"], &[("tabId", "integer", "Tab id from tab_list")]),
        },
        Tool {
            name: "page_snapshot",
            description:
                "Capture the target tab's interactive elements as an accessibility-style tree. Each node has a stable `ref` (e.g. \"e3\"), a role, an accessible name, and a fallback CSS selector. Use the `ref` in page_click/page_fill when possible. Same-origin sub-frames are included automatically; a sub-frame node's `ref` is prefixed `f<frameId>:` (e.g. \"f2:e3\") and page_click/page_fill route it back to that frame.",
            input_schema: schema(&[], &[("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab.")]),
        },
        Tool {
            name: "page_click",
            description:
                "Click an element on the target tab. Prefer passing `ref` (from page_snapshot); \
                 fall back to `selector`.",
            input_schema: schema(
                &[],
                &[
                    (
                        "ref",
                        "string",
                        "Element ref from page_snapshot, e.g. \"e3\"",
                    ),
                    ("selector", "string", "CSS selector fallback"),
                        ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab."),
                    ],
            )
        },
        Tool {
            name: "page_fill",
            description:
                "Type a value into a form field on the target tab. Prefer `ref`; fall back to \
                 `selector`. Password fields are masked in logs/history.",
            input_schema: schema(
                &["value"],
                &[
                    ("ref", "string", "Element ref from page_snapshot"),
                    ("selector", "string", "CSS selector fallback"),
                    ("value", "string", "Text to type into the field"),
                        ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab."),
                    ],
            )
        },
        Tool {
            name: "page_text",
            description:
                "Return the text content of the target tab (sensitive fields masked). `mode` \"visible\" (default) returns only rendered text — it excludes display:none / hidden inactive-tab panels; `mode` \"full\" also includes that hidden/inactive-tab text (script/style/noscript stripped). Use \"full\" when content is split across tabs/accordions. Same-origin sub-frames are appended under a frame marker.",
            input_schema: schema(
                &[],
                &[(
                    "mode",
                    "string",
                    "\"visible\" (default, rendered text only) or \"full\" (include hidden / inactive-tab content)",
                ), ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab.")],
            )
        },
        Tool {
            name: "page_links",
            description:
                "Return the links on the target tab as an array of {text, href, type}, where type is one of mailto | tel | external | internal | anchor. Surfaces contact links (mailto:/tel:) and href targets that page_text only shows as anchor labels, and works even when page_snapshot is empty. hrefs are masked (token-like query strings redacted; emails / phone numbers preserved). Optional `type` filters to one kind; result is capped at 500. Includes links from same-origin sub-frames.",
            input_schema: schema(
                &[],
                &[(
                    "type",
                    "string",
                    "Optional filter: one of mailto | tel | external | internal | anchor",
                ), ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab.")],
            )
        },
        Tool {
            name: "page_screenshot",
            description: "Capture the visible viewport of the target tab as a PNG (base64).",
            input_schema: schema(&[], &[("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab.")]),
        },
        Tool {
            name: "page_scroll",
            description:
                "Scroll the target tab. Pass `direction` (up|down|top|bottom) or `pixels`.",
            input_schema: schema(
                &[],
                &[
                    ("direction", "string", "One of: up, down, top, bottom"),
                    (
                        "pixels",
                        "integer",
                        "Number of pixels to scroll (positive = down)",
                    ),
                        ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab."),
                    ],
            )
        },
        Tool {
            name: "page_wait_for",
            description:
                "Wait until a condition is met on the target tab, or until timeout. One of: `selector` exists (optionally at least `minCount` matches), `text` appears, `nav` waits for the page to load (`until`: \"load\" default, or \"domcontentloaded\"), or `settled` waits for the DOM to stop mutating. SPA hash-route changes fire no navigation event — use `settled`, `selector`, or `text` for those.",
            input_schema: schema(
                &[],
                &[
                    (
                        "selector",
                        "string",
                        "Wait for this selector to match an element",
                    ),
                    (
                        "minCount",
                        "integer",
                        "With `selector`: wait until at least this many elements match (default 1)",
                    ),
                    ("text", "string", "Wait for this text to appear in the page"),
                    ("nav", "boolean", "Wait for a navigation event"),
                    (
                        "until",
                        "string",
                        "For `nav`: readiness level, \"load\" (default, full page load) or \"domcontentloaded\" (DOM parsed)",
                    ),
                    (
                        "settled",
                        "boolean",
                        "Wait until the DOM stops mutating for ~500ms (SPA/lazy-content friendly)",
                    ),
                    ("timeoutMs", "integer", "Max wait in ms (default 30000)"),
                        ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab."),
                    ],
            )
        },
        Tool {
            name: "page_eval",
            description:
                "HIGH RISK — execute arbitrary JavaScript on the target tab. The return value is \
                 masked (JWT / long hex / long numbers / token-like strings). This is \
                 the most powerful tool: prefer page_click / page_fill / page_snapshot whenever \
                 possible, and only use page_eval when those cannot achieve the goal (custom \
                 events, reading framework state, SPA routing, canvas/WebGL, etc.). Code runs in \
                 the page's global scope, wrapped as `async`, so you can `await` and `return` a \
                 value. Async results are awaited. Errors are returned as {name, message}. \
                 REQUIRES the extension's \"CDP mode\" setting: Chrome forbids the extension from \
                 evaluating code in the page on every site, so with CDP mode off this tool always \
                 fails — the error says so, and you should relay it to the user (they enable it \
                 in the extension's Options page) rather than retrying or working around it. \
                 Every other tool works without it.",
            input_schema: schema(
                &["code"],
                &[("code", "string", "JavaScript code to execute"), ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab.")],
            )
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
                 open. Reads EVERY same-process frame, so iframe content is included; a \
                 cross-origin (out-of-process) frame cannot be read from a tab-level attach and \
                 is reported in a `note` instead of being silently dropped. Refs use a 'p' \
                 prefix (p1, p2...), are unique across frames, and work with page_click / \
                 page_fill unchanged wherever the element lives. Use this when page_snapshot \
                 misses elements or roles look wrong.",
            input_schema: schema(
                &[],
                &[(
                    "frameId",
                    "string",
                    "Optional: limit to a specific frame's tree",
                ), ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab.")],
            )
        },
        Tool {
            name: "cookie_get",
            description:
                "Read cookies for the target tab (or a url/domain you specify). Includes httpOnly \
                 cookies (the main reason to use this over document.cookie). Read-only; \
                 there is no cookie_set (writing httpOnly cookies is a session-fixation risk). \
                 Values are masked before being returned — by pattern (JWT / long hex / long \
                 digit runs / provider API keys) and by name, so a cookie called e.g. \
                 `csrftoken` or `sessionid` is redacted whatever its value looks like. If you \
                 omit url/domain/name, cookies for the target tab's URL are returned.",
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
                        ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab."),
                    ],
            )
        },
        Tool {
            name: "storage_get",
            description:
                "Read the page's localStorage or sessionStorage (where frameworks like Auth0 / \
                 NextAuth / Firebase store tokens). Must run on the target tab; same-origin \
                 only (cross-origin iframes are not readable). Pass `key` to fetch one entry, \
                 or omit it to dump all entries (capped at 500). Values are ALWAYS masked — by \
                 pattern (JWT / long hex / long digit runs / provider API keys) and by key name, \
                 so an entry called e.g. `apiKey` or `authToken` is redacted whatever its value \
                 looks like. This masking is not toggleable. Read-only.",
            input_schema: schema(
                &[],
                &[
                    ("type", "string", "\"local\" (default) or \"session\""),
                    (
                        "key",
                        "string",
                        "Specific key to read; omit for all entries",
                    ),
                        ("tabId", "integer", "Tab id from tab_list to act on instead of the session's current tab. Targeting a tab (here, or via tab_focus / tab_open) makes it the session's current tab."),
                    ],
            )
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
        assert_eq!(all().len(), 16);
    }

    // contracts/tools.json is the single source of truth for the catalogue.
    // tools.rs is verified against it here; the TS ops.ts is generated from it.
    #[test]
    fn matches_contract() {
        let contract: Value =
            serde_json::from_str(include_str!("../../contracts/tools.json")).unwrap();
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
