//! Per-op payload builders and argument helpers.
//!
//! Each `build_*` fn maps the (schema-shaped) MCP args into the bridge op's
//! argument object. [`call`] forwards the built payload to the session, and
//! the small `sarg`/`iarg`/`opt_*`/`ref_or_selector` helpers coerce individual
//! args.

use serde_json::{json, Value};

use crate::error::CallError;
use crate::session::{ClientCtx, Session};

pub(super) fn build_empty(_args: &Value) -> Value {
    json!({})
}

pub(super) fn build_tab_focus(args: &Value) -> Value {
    json!({ "tabId": iarg(args, "tabId") })
}

pub(super) fn build_tab_open(args: &Value) -> Value {
    json!({ "url": sarg(args, "url") })
}

pub(super) fn build_tab_close(args: &Value) -> Value {
    json!({ "tabId": iarg(args, "tabId") })
}

pub(super) fn build_page_eval(args: &Value) -> Value {
    json!({ "code": sarg(args, "code") })
}

pub(super) fn build_page_fill(args: &Value) -> Value {
    let mut payload = ref_or_selector(args);
    payload["value"] = json!(sarg(args, "value"));
    payload
}

pub(super) fn build_page_scroll(args: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    opt_str(&mut payload, args, "direction");
    opt_i64(&mut payload, args, "pixels");
    Value::Object(payload)
}

pub(super) fn build_page_text(args: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    opt_str(&mut payload, args, "mode");
    Value::Object(payload)
}

pub(super) fn build_page_links(args: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    opt_str(&mut payload, args, "type");
    Value::Object(payload)
}

pub(super) fn build_page_wait_for(args: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    opt_str(&mut payload, args, "selector");
    opt_i64(&mut payload, args, "minCount");
    opt_str(&mut payload, args, "text");
    opt_bool(&mut payload, args, "nav");
    opt_str(&mut payload, args, "until");
    opt_bool(&mut payload, args, "settled");
    payload.insert(
        "timeoutMs".into(),
        json!(args
            .get("timeoutMs")
            .and_then(|v| v.as_i64())
            .unwrap_or(30000)),
    );
    Value::Object(payload)
}

pub(super) fn build_page_snapshot_precise(args: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    opt_str(&mut payload, args, "frameId");
    Value::Object(payload)
}

pub(super) fn build_cookie_get(args: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    opt_str(&mut payload, args, "url");
    opt_str(&mut payload, args, "domain");
    opt_str(&mut payload, args, "name");
    Value::Object(payload)
}

pub(super) fn build_storage_get(args: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    opt_str(&mut payload, args, "type");
    opt_str(&mut payload, args, "key");
    Value::Object(payload)
}

pub(super) fn call(
    session: &Session,
    client: Option<&ClientCtx>,
    op: &str,
    tab_id: Option<i64>,
    args: Value,
) -> Result<(Value, Option<i64>), CallError> {
    session.call(op, tab_id, args, client)
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

/// Copy an optional string field from `args` into `payload` — but only when
/// present, and only when it really is a string.
///
/// Absent and wrong-typed fields are omitted rather than defaulted: the schema
/// checks in `tools` (`check_required` / `check_arg_types`) own rejection, so
/// by the time a builder runs through [`dispatch`](super::dispatch) every field
/// it names is either absent by choice or valid. The builders stay dumb shapers
/// of what survived them.
fn opt_str(payload: &mut serde_json::Map<String, Value>, args: &Value, key: &str) {
    if let Some(v) = args.get(key).and_then(Value::as_str) {
        payload.insert(key.into(), json!(v));
    }
}

/// [`opt_str`], for optional integer fields.
fn opt_i64(payload: &mut serde_json::Map<String, Value>, args: &Value, key: &str) {
    if let Some(v) = args.get(key).and_then(Value::as_i64) {
        payload.insert(key.into(), json!(v));
    }
}

/// [`opt_str`], for optional boolean fields.
fn opt_bool(payload: &mut serde_json::Map<String, Value>, args: &Value, key: &str) {
    if let Some(v) = args.get(key).and_then(Value::as_bool) {
        payload.insert(key.into(), json!(v));
    }
}

/// The shared ref-or-selector addressing pair used by the DOM-acting tools.
pub(super) fn ref_or_selector(args: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    opt_str(&mut payload, args, "ref");
    opt_str(&mut payload, args, "selector");
    Value::Object(payload)
}
