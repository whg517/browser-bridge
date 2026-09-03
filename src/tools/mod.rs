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
//!   - this root — [`dispatch`], [`Outcome`], and the `HANDLERS` registry.

mod catalogue;
mod handlers;

use serde_json::{json, Value};

use crate::error::CallError;
use crate::session::{ClientCtx, Session};

pub use catalogue::{all, Tool};

use handlers::{
    build_cookie_get, build_empty, build_page_eval, build_page_fill, build_page_links,
    build_page_scroll, build_page_snapshot_precise, build_page_text, build_page_wait_for,
    build_storage_get, build_tab_close, build_tab_focus, build_tab_open, call, ref_or_selector,
};

/// Maps the (schema-shaped) MCP args of one tool into the op's argument
/// object. Responses are formatted centrally in [`dispatch`].
type PayloadFn = fn(&Value) -> Value;

/// The single dispatch registry — `(tool name, payload builder)` pairs, where
/// the bridge `op` name equals the tool `name`. `registry_covers_catalogue`
/// (tests) asserts it stays in lockstep with [`all`], so a new tool can't be
/// added to the catalogue without a handler (or vice versa).
const HANDLERS: &[(&str, PayloadFn)] = &[
    ("tab_list", build_empty),
    ("tab_focus", build_tab_focus),
    ("tab_open", build_tab_open),
    ("tab_close", build_tab_close),
    ("page_snapshot", build_empty),
    ("page_click", ref_or_selector),
    ("page_fill", build_page_fill),
    ("page_text", build_page_text),
    ("page_links", build_page_links),
    ("page_screenshot", build_empty),
    ("page_scroll", build_page_scroll),
    ("page_wait_for", build_page_wait_for),
    ("page_eval", build_page_eval),
    ("page_snapshot_precise", build_page_snapshot_precise),
    ("cookie_get", build_cookie_get),
    ("storage_get", build_storage_get),
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

/// Reject arguments whose JSON type contradicts the tool's published schema.
///
/// The `build_*` helpers read through `as_str` / `as_i64` and fall back to
/// `""` / `0`, so a wrong-typed argument was not rejected — it was silently
/// replaced. `tab_open {"url": 123}` reached the extension as an empty url, and
/// `tab_focus {"tabId": "123"}` as tab 0. Both look like the tool misbehaving
/// rather than the call being malformed.
///
/// Only types the schema actually declares are enforced, and only for arguments
/// that are present; absence is `check_required`'s job.
fn check_arg_types(name: &str, args: &Value) -> Result<(), CallError> {
    let Some(tool) = all().into_iter().find(|t| t.name == name) else {
        return Ok(());
    };
    let Some(props) = tool
        .input_schema
        .get("properties")
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    let Some(given) = args.as_object() else {
        return Ok(());
    };
    for (key, value) in given {
        let Some(expected) = props
            .get(key)
            .and_then(|s| s.get("type"))
            .and_then(Value::as_str)
        else {
            continue; // not in the schema, or untyped — nothing to check against
        };
        // Null reads as "not supplied"; check_required decides whether that is
        // allowed, so it must not be rejected here as a type error too.
        if value.is_null() {
            continue;
        }
        let ok = match expected {
            "string" => value.is_string(),
            "integer" => value.is_i64() || value.is_u64(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "object" => value.is_object(),
            "array" => value.is_array(),
            _ => true,
        };
        if !ok {
            return Err(CallError::InvalidArgument(format!(
                "{name}: `{key}` must be {expected}, got {}",
                json_type_name(value)
            )));
        }
    }
    Ok(())
}

fn json_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(n) if n.is_f64() => "number",
        Value::Number(_) => "integer",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
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
    /// The tab the extension resolved the op to (ADR-0028 Phase 2), when the
    /// call got that far — the broker keys per-tab scheduling and audit on it.
    pub resolved_tab: Option<i64>,
}

/// The explicit tab target an op-level `tabId` argument asks for, if the
/// tool's schema declares one.
///
/// Page-level tools address a tab with an OPTIONAL `tabId` (tab_list is where
/// ids come from); when given, it becomes the BridgeReq's TOP-LEVEL tab target
/// and is stripped from the op args — the extension resolves it through
/// `resolveTargetTab` (and makes it the session's current tab, ADR-0028
/// Phase 1a). Declared-in-schema is the gate on purpose: tab-level tools own
/// `tabId` as a required op argument (tab_focus / tab_close) or don't take one
/// (tab_open / tab_list), and for them this must stay `None` so their args are
/// forwarded untouched.
fn request_tab_id(tool: &Tool, args: &Value) -> Option<i64> {
    let declares = tool
        .input_schema
        .get("properties")
        .and_then(|p| p.get("tabId"))
        .is_some();
    // tab_focus / tab_close own `tabId` as a REQUIRED op argument — theirs is
    // addressing WITHIN the op, not an envelope target, and must not be lifted.
    let required = tool
        .input_schema
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|r| r.iter().any(|k| k == "tabId"));
    if !declares || required {
        return None;
    }
    args.get("tabId").and_then(Value::as_i64)
}

/// Dispatch a tool call. Returns the MCP result `content` value (an array)
/// and the isError flag. Errors are tool-level (isError=true), not RPC-level.
pub fn dispatch(session: &Session, name: &str, args: &Value) -> Outcome {
    dispatch_for(session, None, name, args)
}

/// [`dispatch`], naming the brokered client the call came from (ADR-0028
/// Phase 1b). `None` on the single-process paths (`call` mode, tests); the
/// broker passes the identity it assigned to the thin server's TCP connection —
/// it travels onto the BridgeReq envelope and into the audit trail, so the
/// client's identity is granted, never self-reported.
pub fn dispatch_for(
    session: &Session,
    client: Option<&ClientCtx>,
    name: &str,
    args: &Value,
) -> Outcome {
    let result = match HANDLERS.iter().find(|(op, _)| *op == name) {
        Some((op, build_payload)) => {
            let payload = build_payload(args);
            // The builders whitelist their own fields, so an op-level `tabId`
            // never leaks into the op args — when a tool declares one, it is
            // lifted onto the BridgeReq envelope instead.
            let tab_id = all()
                .iter()
                .find(|t| t.name == name)
                .and_then(|tool| request_tab_id(tool, args));
            check_required(name, args)
                .and_then(|()| check_arg_types(name, args))
                .and_then(|()| check_absolute_url(name, args))
                .and_then(|()| call(session, client, op, tab_id, payload))
        }
        None => Err(CallError::UnknownTool(name.to_string())),
    };

    match result {
        Ok((data, resolved_tab)) => {
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
                        resolved_tab,
                    };
                }
            }
            Outcome {
                content: json!([{ "type": "text", "text": data.to_string() }]),
                is_error: false,
                error_code: None,
                resolved_tab,
            }
        }
        Err(e) => Outcome {
            // Prefix the stable cross-process code (contracts/errors.json) so
            // clients can branch programmatically, while the text stays
            // human-readable. isError stays true.
            content: json!([{ "type": "text", "text": format!("Error [{}]: {e}", e.code()) }]),
            is_error: true,
            error_code: Some(e.code()),
            resolved_tab: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The dispatch registry must stay in lockstep with the catalogue: every
    // tool has exactly one handler and every handler names a real tool. This
    // closes the only drift the catalogue tests can't see.
    // ADR-0028 Phase 1a: the optional op-level tabId on page-level tools lifts
    // onto the BridgeReq envelope. tab-level tools keep their own tabId args.
    #[test]
    fn request_tab_id_lifts_only_declared_optional_tab_ids() {
        use super::request_tab_id;
        let tool = |name: &str| all().into_iter().find(|t| t.name == name).unwrap();
        // Declared + present → lifted.
        assert_eq!(
            request_tab_id(&tool("page_fill"), &json!({ "tabId": 7, "value": "x" })),
            Some(7)
        );
        // Declared + absent → no explicit target (session current tab wins).
        assert_eq!(
            request_tab_id(&tool("page_fill"), &json!({ "value": "x" })),
            None
        );
        // Wrong-typed tabId is check_arg_types' business, not lifting's.
        assert_eq!(
            request_tab_id(&tool("page_fill"), &json!({ "tabId": "7" })),
            None
        );
        // Required-arg tools (tab_focus/tab_close) keep theirs in the op args.
        assert_eq!(
            request_tab_id(&tool("tab_focus"), &json!({ "tabId": 7 })),
            None
        );
        assert_eq!(
            request_tab_id(&tool("tab_close"), &json!({ "tabId": 7 })),
            None
        );
        // No tabId anywhere in the schema (tab_list/tab_open).
        assert_eq!(
            request_tab_id(&tool("tab_open"), &json!({ "tabId": 7 })),
            None
        );
        assert_eq!(
            request_tab_id(&tool("tab_list"), &json!({ "tabId": 7 })),
            None
        );
    }

    #[test]
    fn registry_covers_catalogue() {
        use std::collections::BTreeSet;
        let catalogue: BTreeSet<&str> = all().iter().map(|t| t.name).collect();
        let registry: BTreeSet<&str> = HANDLERS.iter().map(|(name, _)| *name).collect();
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
            let (_, build_payload) = HANDLERS.iter().find(|(op, _)| *op == name).unwrap();
            build_payload(&args)
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

    // The build_* helpers coerce through as_str/as_i64 with ""/0 fallbacks, so a
    // wrong-typed argument used to be silently replaced rather than rejected —
    // and the resulting empty url or tab 0 looked like the tool misbehaving.
    #[test]
    fn wrong_typed_args_are_invalid_arguments() {
        let cases = [
            ("tab_open", json!({ "url": 123 }), "url"),
            ("tab_focus", json!({ "tabId": "123" }), "tabId"),
            ("tab_close", json!({ "tabId": 1.5 }), "tabId"),
            ("page_eval", json!({ "code": ["1+1"] }), "code"),
            ("page_fill", json!({ "value": true }), "value"),
            ("page_wait_for", json!({ "settled": "yes" }), "settled"),
            ("page_scroll", json!({ "pixels": "500" }), "pixels"),
        ];
        for (tool, args, field) in cases {
            let err = check_arg_types(tool, &args)
                .expect_err(&format!("{tool}.{field} should be rejected"));
            assert_eq!(err.code(), "INVALID_ARGUMENT", "{tool}.{field}");
            assert!(
                err.to_string().contains(field),
                "the message names the field: {err}"
            );
        }
    }

    #[test]
    fn correctly_typed_args_pass_the_type_check() {
        assert!(check_arg_types("tab_open", &json!({ "url": "https://x.test" })).is_ok());
        assert!(check_arg_types("tab_focus", &json!({ "tabId": 42 })).is_ok());
        assert!(check_arg_types("page_wait_for", &json!({ "settled": true })).is_ok());
        assert!(check_arg_types("page_scroll", &json!({ "pixels": -200 })).is_ok());
        // Null is "not supplied" — check_required owns that decision, so the
        // type check must not also reject it.
        assert!(check_arg_types("tab_open", &json!({ "url": null })).is_ok());
        // Unknown keys are not the type check's business.
        assert!(check_arg_types("page_snapshot", &json!({ "junk": 1 })).is_ok());
        assert!(check_arg_types("does_not_exist", &json!({ "x": 1 })).is_ok());
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
