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
    build_cookie_get, build_empty, build_page_eval, build_page_fill, build_page_links,
    build_page_scroll, build_page_snapshot_precise, build_page_text, build_page_wait_for,
    build_storage_get, build_tab_close, build_tab_focus, build_tab_open, call, ref_or_selector,
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
        build_payload: build_page_text,
    },
    Handler {
        name: "page_links",
        build_payload: build_page_links,
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

/// Reject a call whose arguments don't satisfy the tool's own `inputSchema`
/// `required` list, before it reaches the extension.
///
/// The `build_*` helpers coerce a missing field to `""` / `0`, so
/// `page_eval {}` used to travel all the way to the page and come back as
/// EXECUTION_FAILED ("needs non-empty `code`") — a page-execution code for what
/// is really a malformed call. Checking the published schema keeps the contract
/// the model is shown and the contract enforced in one place.
fn check_required(name: &str, args: &Value) -> Result<(), CallError> {
    let Some(tool) = all().into_iter().find(|t| t.name == name) else {
        return Ok(());
    };
    let Some(required) = tool.input_schema.get("required").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for key in required.iter().filter_map(|k| k.as_str()) {
        let present = args.get(key).is_some_and(|v| match v {
            Value::Null => false,
            // A blank string is as unusable as an absent one for every
            // currently-required field (code / url / value).
            Value::String(s) => !s.trim().is_empty(),
            _ => true,
        });
        if !present {
            return Err(CallError::InvalidArgument(format!(
                "{name}: missing required argument `{key}`"
            )));
        }
    }
    Ok(())
}

/// Does `s` carry a URI scheme — `scheme:` before any `/`, `?` or `#`?
///
/// RFC 3986's definition, hand-rolled: the dependency set is deliberately tiny
/// and a whole URL crate to answer one question is not worth the supply-chain
/// surface. Deliberately permissive about what the scheme IS (`file:`, `about:`,
/// `chrome:` are all legitimate targets); the only question here is whether the
/// caller supplied one at all.
fn has_uri_scheme(s: &str) -> bool {
    let Some(colon) = s.find(':') else {
        return false;
    };
    // A `/`, `?` or `#` before the colon means the colon is inside a path or
    // query, not a scheme delimiter — e.g. "/a:b".
    let scheme = &s[..colon];
    if scheme.is_empty() || scheme.contains(['/', '?', '#']) {
        return false;
    }
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// Reject a `tab_open` whose `url` is not absolute.
///
/// `chrome.tabs.create` resolves a relative URL against the CALLER's base, and
/// the caller is the extension's service worker — so `tab_open {"url": "/admin"}`
/// silently opened `chrome-extension://<id>/admin` instead of failing, landing
/// the tab inside the extension's own privileged origin. The schema has always
/// said "Absolute URL to open"; nothing enforced it.
///
/// Enforced here rather than in the extension so it comes back as
/// INVALID_ARGUMENT — a malformed call, which is what it is — instead of an
/// extension-side failure, and so it never reaches the browser at all.
fn check_absolute_url(name: &str, args: &Value) -> Result<(), CallError> {
    if name != "tab_open" {
        return Ok(());
    }
    // Absence is already `check_required`'s job; only shape is checked here.
    let Some(url) = args.get("url").and_then(Value::as_str) else {
        return Ok(());
    };
    if has_uri_scheme(url.trim()) {
        return Ok(());
    }
    Err(CallError::InvalidArgument(format!(
        "tab_open: `url` must be absolute and include a scheme (e.g. https://example.com), \
         got `{url}`. A relative path would resolve against the extension's own origin, \
         not the site you meant."
    )))
}

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
        Some(h) => check_required(name, args)
            .and_then(|()| check_absolute_url(name, args))
            .and_then(|()| call(session, name, None, (h.build_payload)(args))),
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

    // A malformed call must be rejected here, with the argument code — not
    // coerced to a default, sent to the page, and reported as EXECUTION_FAILED.
    #[test]
    fn missing_required_args_are_invalid_arguments() {
        let err = check_required("page_eval", &json!({})).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(
            err.to_string().contains("`code`"),
            "the message names the missing field: {err}"
        );
        // A blank or null value is as unusable as an absent one.
        assert!(check_required("page_eval", &json!({ "code": "   " })).is_err());
        assert!(check_required("page_eval", &json!({ "code": null })).is_err());
        // The old failure mode: `expression` instead of `code`.
        assert!(check_required("page_eval", &json!({ "expression": "1+1" })).is_err());
        // Satisfied calls pass through.
        assert!(check_required("page_eval", &json!({ "code": "1+1" })).is_ok());
    }

    // A relative url is not a harmless typo: chrome.tabs.create resolves it
    // against the service worker's base, so it opened a tab on the extension's
    // own origin and reported success.
    #[test]
    fn relative_tab_open_urls_are_invalid_arguments() {
        for bad in ["notaurl", "/admin", "example.com/path", "./x", "?q=1"] {
            let err = check_absolute_url("tab_open", &json!({ "url": bad })).unwrap_err();
            assert_eq!(err.code(), "INVALID_ARGUMENT", "{bad}");
            assert!(
                err.to_string().contains("absolute"),
                "the message says what is wrong: {err}"
            );
        }
    }

    #[test]
    fn absolute_tab_open_urls_pass_through() {
        for ok in [
            "https://example.com",
            "http://localhost:18099/page.html",
            "file:///tmp/x.html",
            "about:blank",
            "chrome://extensions",
            "  https://example.com/padded  ",
        ] {
            assert!(
                check_absolute_url("tab_open", &json!({ "url": ok })).is_ok(),
                "{ok} is absolute"
            );
        }
    }

    #[test]
    fn the_url_check_is_scoped_to_tab_open() {
        // page_fill's `value` and page_eval's `code` are free text; nothing here
        // may start rejecting them for looking un-URL-like.
        assert!(check_absolute_url("page_fill", &json!({ "value": "notaurl" })).is_ok());
        assert!(check_absolute_url("page_eval", &json!({ "code": "1+1" })).is_ok());
        // Absence stays check_required's job, not this one's.
        assert!(check_absolute_url("tab_open", &json!({})).is_ok());
    }

    #[test]
    fn tools_without_required_args_are_unaffected() {
        // Every tool whose schema requires nothing accepts an empty object.
        for tool in all() {
            let required = tool
                .input_schema
                .get("required")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            if required == 0 {
                assert!(
                    check_required(tool.name, &json!({})).is_ok(),
                    "{} requires nothing but was rejected",
                    tool.name
                );
            }
        }
        // …and an unknown name is left to the UnknownTool path.
        assert!(check_required("does_not_exist", &json!({})).is_ok());
    }
}
