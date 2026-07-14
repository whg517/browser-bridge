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
//!
//! This module is split across:
//!   - [`catalogue`] — the [`Tool`] struct, [`all`] catalogue, and `schema` helper,
//!   - [`handlers`] — the per-op `build_*` payload fns and arg helpers,
//!   - this root — [`dispatch`], [`Outcome`], and the `Handler`/`HANDLERS` registry.

mod catalogue;
mod handlers;

use serde_json::{json, Value};

use crate::error::CallError;
use crate::session::Session;

pub use catalogue::{all, Tool};

use handlers::{
    build_cookie_get, build_empty, build_page_eval, build_page_fill, build_page_scroll,
    build_page_snapshot_precise, build_page_wait_for, build_storage_get, build_tab_close,
    build_tab_focus, build_tab_open, call, ref_or_selector,
};

/// A registered tool handler. The bridge `op` name equals the tool `name`;
/// `build_payload` maps the (schema-shaped) MCP args into the op's argument
/// object. Responses are formatted centrally in [`dispatch`]. `HANDLERS` is the
/// single dispatch registry — `registry_covers_catalogue` (tests) asserts it
/// stays in lockstep with [`all`], so a new tool can't be added to the
/// catalogue without a handler (or vice versa).
struct Handler {
    name: &'static str,
    build_payload: fn(&Value) -> Value,
}

const HANDLERS: &[Handler] = &[
    Handler {
        name: "tab_list",
        build_payload: build_empty,
    },
    Handler {
        name: "tab_focus",
        build_payload: build_tab_focus,
    },
    Handler {
        name: "tab_open",
        build_payload: build_tab_open,
    },
    Handler {
        name: "tab_close",
        build_payload: build_tab_close,
    },
    Handler {
        name: "page_snapshot",
        build_payload: build_empty,
    },
    Handler {
        name: "page_click",
        build_payload: ref_or_selector,
    },
    Handler {
        name: "page_fill",
        build_payload: build_page_fill,
    },
    Handler {
        name: "page_text",
        build_payload: build_empty,
    },
    Handler {
        name: "page_screenshot",
        build_payload: build_empty,
    },
    Handler {
        name: "page_scroll",
        build_payload: build_page_scroll,
    },
    Handler {
        name: "page_wait_for",
        build_payload: build_page_wait_for,
    },
    Handler {
        name: "page_eval",
        build_payload: build_page_eval,
    },
    Handler {
        name: "page_snapshot_precise",
        build_payload: build_page_snapshot_precise,
    },
    Handler {
        name: "cookie_get",
        build_payload: build_cookie_get,
    },
    Handler {
        name: "storage_get",
        build_payload: build_storage_get,
    },
];

/// The result of dispatching one tool call: the MCP content blocks, whether it
/// is an error, and — on error — the stable taxonomy code (contracts/errors.json)
/// so the caller can record it in the audit trail without re-parsing the text.
pub struct Outcome {
    pub content: Value,
    pub is_error: bool,
    pub error_code: Option<&'static str>,
}

/// Dispatch a tool call. Returns the MCP result `content` value (an array)
/// and the isError flag. Errors are tool-level (isError=true), not RPC-level.
pub fn dispatch(session: &Session, name: &str, args: &Value) -> Outcome {
    let result = match HANDLERS.iter().find(|h| h.name == name) {
        Some(h) => call(session, name, None, (h.build_payload)(args)),
        None => Err(CallError::UnknownTool(name.to_string())),
    };

    match result {
        Ok(data) => {
            // Screenshots come back as base64 PNG; expose as an image content
            // block so the model sees the picture directly.
            if name == "page_screenshot" {
                if let Some(png_b64) = data.get("image").and_then(|v| v.as_str()) {
                    return Outcome {
                        content: json!([{
                            "type": "image",
                            "data": png_b64,
                            "mimeType": "image/png"
                        }]),
                        is_error: false,
                        error_code: None,
                    };
                }
            }
            Outcome {
                content: json!([{ "type": "text", "text": data.to_string() }]),
                is_error: false,
                error_code: None,
            }
        }
        Err(e) => Outcome {
            // Prefix the stable cross-process code (contracts/errors.json) so
            // clients can branch programmatically, while the text stays
            // human-readable. isError stays true.
            content: json!([{ "type": "text", "text": format!("Error [{}]: {e}", e.code()) }]),
            is_error: true,
            error_code: Some(e.code()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The dispatch registry must stay in lockstep with the catalogue: every
    // tool has exactly one handler and every handler names a real tool. This
    // closes the only drift the catalogue tests can't see.
    #[test]
    fn registry_covers_catalogue() {
        use std::collections::BTreeSet;
        let catalogue: BTreeSet<&str> = all().iter().map(|t| t.name).collect();
        let registry: BTreeSet<&str> = HANDLERS.iter().map(|h| h.name).collect();
        assert_eq!(
            catalogue, registry,
            "every tool needs exactly one dispatch handler (and vice versa)"
        );
        assert_eq!(HANDLERS.len(), catalogue.len(), "duplicate handler name");
    }

    // Arg-shaping is pure, so verify the non-trivial builders here rather than
    // relying solely on the browser e2e (which the catalogue tests never cover).
    #[test]
    fn build_payload_shapes() {
        let build = |name: &str, args: Value| -> Value {
            let h = HANDLERS.iter().find(|h| h.name == name).unwrap();
            (h.build_payload)(&args)
        };
        // page_fill merges ref/selector with the value.
        assert_eq!(
            build("page_fill", json!({ "ref": "e5", "value": "hi" })),
            json!({ "ref": "e5", "value": "hi" })
        );
        // page_wait_for defaults timeoutMs and passes selector through.
        assert_eq!(
            build("page_wait_for", json!({ "selector": "#x" })),
            json!({ "selector": "#x", "timeoutMs": 30000 })
        );
        // tab_focus coerces tabId.
        assert_eq!(
            build("tab_focus", json!({ "tabId": 7 })),
            json!({ "tabId": 7 })
        );
        // Optional fields are omitted when absent.
        assert_eq!(
            build("cookie_get", json!({ "domain": "example.com" })),
            json!({ "domain": "example.com" })
        );
        // Empty builder ignores extraneous args.
        assert_eq!(build("page_snapshot", json!({ "junk": 1 })), json!({}));
    }
}
