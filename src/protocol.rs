//! Wire protocols for browser-bridge.
//!
//! Three protocols live here:
//! 1. Chrome Native Messaging framing (4-byte LE length prefix + UTF-8 JSON)
//!    — used between the native-host subprocess and the Chrome extension.
//! 2. MCP JSON-RPC 2.0 messages (NDJSON over stdio) — used between the MCP
//!    server and the MCP client.
//! 3. The internal "bridge" envelope — request/response exchanged between the
//!    MCP server and the native-host subprocess over a localhost TCP socket
//!    (newline-delimited JSON).

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ----------------------------------------------------------------------------
// 1. Chrome Native Messaging framing
// ----------------------------------------------------------------------------

/// Hard cap on a single native-messaging message sent *to* Chrome. Chrome
/// closes the port if a message exceeds 1 MB. (Inbound from Chrome the limit
/// is 64 MB, which we don't need to enforce.)
pub const NM_MAX_OUTGOING: usize = 1024 * 1024;

/// Read one native-messaging frame from `r`: a 4-byte LE length prefix
/// followed by that many bytes of UTF-8 JSON. Returns `Ok(None)` on EOF
/// (Chrome's canonical shutdown signal).
pub fn nm_read_frame<R: Read>(r: &mut R) -> io::Result<Option<Value>> {
    let mut header = [0u8; 4];
    match r.read_exact(&mut header) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(header) as usize;
    // Defensive bound: a corrupted prefix yielding a huge value would OOM us.
    // Inbound limit is 64 MB per the spec; clamp well above any legitimate use.
    if len > 64 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("native-messaging frame too large: {len} bytes"),
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    let value = serde_json::from_slice(&buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("nm json decode: {e}")))?;
    Ok(Some(value))
}

/// Write one native-messaging frame to `w`: 4-byte LE length prefix + JSON.
/// Aborts (panic→abort via Cargo profile) if the payload exceeds 1 MB; caller
/// should check size before serializing large data. Flushes after writing.
pub fn nm_write_frame<W: Write>(w: &mut W, value: &Value) -> io::Result<()> {
    let json = serde_json::to_vec(value)?;
    if json.len() > NM_MAX_OUTGOING {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "native-messaging outgoing frame {} bytes exceeds 1 MB cap",
                json.len()
            ),
        ));
    }
    let len = (json.len() as u32).to_le_bytes();
    w.write_all(&len)?;
    w.write_all(&json)?;
    w.flush()?;
    Ok(())
}

// ----------------------------------------------------------------------------
// 2. MCP JSON-RPC 2.0 (over stdio, NDJSON)
// ----------------------------------------------------------------------------

/// A parsed inbound JSON-RPC message. Distinguishes request (has `id`),
/// notification (no `id`), and their shapes.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JsonRpc {
    pub jsonrpc: Option<String>,
    /// `id` is present for requests/responses, absent for notifications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    // For responses only:
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpc {
    #[allow(dead_code)]
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }

    /// Build a successful response echoing the request id.
    pub fn ok(id: Value, result: Value) -> Self {
        JsonRpc {
            jsonrpc: Some("2.0".into()),
            id: Some(id),
            method: None,
            params: None,
            result: Some(result),
            error: None,
        }
    }

    /// Build an error response echoing the request id.
    pub fn err(id: Value, code: i32, message: impl Into<String>) -> Self {
        JsonRpc {
            jsonrpc: Some("2.0".into()),
            id: Some(id),
            method: None,
            params: None,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }

    /// Build a notification (no id, no response expected).
    #[allow(dead_code)]
    pub fn notification(method: impl Into<String>, params: Value) -> Self {
        JsonRpc {
            jsonrpc: Some("2.0".into()),
            id: None,
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }
}

/// Read one NDJSON line from `r` and parse it as JSON-RPC. Returns `Ok(None)`
/// on EOF (client gone → shut down).
pub fn mcp_read<R: io::BufRead>(r: &mut R) -> io::Result<Option<JsonRpc>> {
    let mut line = Vec::new();
    let n = r.read_until(b'\n', &mut line)?;
    if n == 0 {
        return Ok(None);
    }
    // Trim a trailing newline; tolerate CRLF.
    while line.last() == Some(&b'\n') || line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.is_empty() {
        // Blank line: treat as no-op, signal "retry" via None-with-flag.
        // Simplest: return an empty-payload parse attempt that will fail.
        // Instead we recurse once to skip.
        return mcp_read(r);
    }
    let msg: JsonRpc = serde_json::from_slice(&line)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("mcp json decode: {e}")))?;
    Ok(Some(msg))
}

/// Write one JSON-RPC message as a single NDJSON line (LF-terminated).
pub fn mcp_write<W: Write>(w: &mut W, msg: &JsonRpc) -> io::Result<()> {
    // serde_json escapes embedded newlines inside strings as \n, so the
    // serialized object is guaranteed to contain no raw newline.
    let bytes = serde_json::to_vec(msg)?;
    w.write_all(&bytes)?;
    w.write_all(b"\n")?;
    w.flush()?;
    Ok(())
}

// ----------------------------------------------------------------------------
// 3. Internal bridge envelope (MCP server <-> native host <-> extension)
// ----------------------------------------------------------------------------

/// A request from the MCP server to the extension, exchanged over the
/// localhost TCP socket as newline-delimited JSON. Carries an `id` the
/// extension echoes back so we can correlate (the socket is one-shot per
/// request/response today, but the id future-proofs multiplexing).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeReq {
    pub id: u64,
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub args: Value,
}

/// A response from the extension back to the MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeResp {
    pub id: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BridgeResp {
    #[allow(dead_code)]
    pub fn ok(id: u64, data: Value) -> Self {
        BridgeResp {
            id,
            ok: true,
            data: Some(data),
            error: None,
        }
    }
    #[allow(dead_code)]
    pub fn err(id: u64, msg: impl Into<String>) -> Self {
        BridgeResp {
            id,
            ok: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

/// Read/write bridge messages as NDJSON lines over a TCP stream.
pub fn bridge_read<R: io::BufRead, T: for<'de> Deserialize<'de>>(
    r: &mut R,
) -> io::Result<Option<T>> {
    let mut line = Vec::new();
    let n = r.read_until(b'\n', &mut line)?;
    if n == 0 {
        return Ok(None);
    }
    while line.last() == Some(&b'\n') || line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.is_empty() {
        return bridge_read(r);
    }
    let msg = serde_json::from_slice(&line).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("bridge json decode: {e}"),
        )
    })?;
    Ok(Some(msg))
}

pub fn bridge_write<W: Write, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(msg)?;
    w.write_all(&bytes)?;
    w.write_all(b"\n")?;
    w.flush()?;
    Ok(())
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

/// Install a panic hook that writes to stderr instead of stdout. Critical:
/// the MCP server and native host both speak binary protocols over stdout,
/// and a default panic message (printed to stdout) would corrupt the stream
/// and tear down the connection. Combined with `panic = "abort"` in the
/// release profile this is belt-and-braces.
pub fn install_stderr_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = writeln!(io::stderr(), "[browser-bridge] panic: {info}");
        default(info);
    }));
}

/// SIGPIPE protection. On Unix, writing to a closed stdout/socket raises
/// SIGPIPE by default and kills the process. Rust disables SIGPIPE for its
/// own I/O but not for the inherited disposition everywhere; ignore it so we
/// get EPIPE errors instead of dying. Safe to call once at startup.
pub fn ignore_sigpipe() {
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn nm_frame_roundtrip() {
        let v = json!({ "op": "tab_list", "id": 1 });
        let mut buf = Vec::new();
        nm_write_frame(&mut buf, &v).unwrap();
        // 4-byte LE length prefix precedes the JSON body.
        let body_len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        assert_eq!(body_len, buf.len() - 4);
        let mut cur = Cursor::new(buf);
        assert_eq!(nm_read_frame(&mut cur).unwrap().unwrap(), v);
    }

    #[test]
    fn nm_read_eof_is_none() {
        let mut cur = Cursor::new(Vec::<u8>::new());
        assert!(nm_read_frame(&mut cur).unwrap().is_none());
    }

    #[test]
    fn nm_write_rejects_oversize() {
        let v = json!({ "s": "x".repeat(NM_MAX_OUTGOING + 10) });
        let err = nm_write_frame(&mut Vec::new(), &v).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn nm_read_rejects_huge_prefix() {
        // 0xFFFFFFFF length (~4 GB) exceeds the 64 MB inbound clamp.
        let mut cur = Cursor::new(vec![0xFF, 0xFF, 0xFF, 0xFF]);
        let err = nm_read_frame(&mut cur).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn mcp_ndjson_single_line_roundtrip() {
        // Embedded newline must be escaped so the frame stays one NDJSON line.
        let msg = JsonRpc::ok(json!(1), json!({ "text": "a\nb" }));
        let mut buf = Vec::new();
        mcp_write(&mut buf, &msg).unwrap();
        assert_eq!(buf.iter().filter(|&&b| b == b'\n').count(), 1);
        assert!(buf.ends_with(b"\n"));
        let got = mcp_read(&mut Cursor::new(buf)).unwrap().unwrap();
        assert_eq!(got.id, Some(json!(1)));
    }

    #[test]
    fn mcp_read_skips_blank_lines() {
        let msg = JsonRpc::ok(json!(2), json!({}));
        let mut buf = b"\n\n".to_vec();
        mcp_write(&mut buf, &msg).unwrap();
        let got = mcp_read(&mut Cursor::new(buf)).unwrap().unwrap();
        assert_eq!(got.id, Some(json!(2)));
    }

    #[test]
    fn bridge_envelope_roundtrip() {
        let req = BridgeReq {
            id: 7,
            op: "page_click".into(),
            tab_id: Some(3),
            args: json!({ "ref": "e3" }),
        };
        let mut buf = Vec::new();
        bridge_write(&mut buf, &req).unwrap();
        let got: BridgeReq = bridge_read(&mut Cursor::new(buf)).unwrap().unwrap();
        assert_eq!(got.id, 7);
        assert_eq!(got.op, "page_click");
        assert_eq!(got.tab_id, Some(3));
        assert_eq!(got.args, json!({ "ref": "e3" }));
    }
}

/// Property-based (`proptest`) coverage of the parsing boundary. Three
/// families, matching the fuzzing item on the roadmap:
///   1. Roundtrip — `write` then `read` recovers the original payload.
///   2. Never-panics — arbitrary bytes fed to a reader return `Ok`/`Err` but
///      never panic (the key robustness guarantee for a security boundary).
///   3. Size guard — any length prefix above the cap is always rejected,
///      before any unbounded allocation or read.
#[cfg(test)]
mod proptests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::Map;
    use std::io::Cursor;

    /// A bounded, arbitrary JSON string built from arbitrary Unicode scalar
    /// values (control chars included — serde escapes them). Avoids the
    /// `regex-syntax` proptest feature so the dependency tree stays lean.
    fn arb_string() -> impl Strategy<Value = String> {
        prop::collection::vec(any::<char>(), 0..12).prop_map(|cs| cs.into_iter().collect())
    }

    /// A bounded, arbitrary JSON value. Numbers are integers only: JSON cannot
    /// represent NaN/Infinity, and `serde_json::Number` rejects them, so a
    /// float strategy would generate unserializable values. Depth and breadth
    /// are capped to keep each case small and fast.
    fn arb_json() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<i64>().prop_map(|n| Value::Number(n.into())),
            arb_string().prop_map(Value::String),
        ];
        leaf.prop_recursive(4, 48, 8, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
                prop::collection::vec((arb_string(), inner), 0..6)
                    .prop_map(|kvs| Value::Object(kvs.into_iter().collect::<Map<String, Value>>())),
            ]
        })
    }

    /// Like [`arb_json`] but never `null` at the top level. For `Option<Value>`
    /// fields, `Some(Value::Null)` serializes as `null` and deserializes back
    /// as `None` — an intentional serde asymmetry that would make an exact
    /// roundtrip comparison spuriously fail. Nested nulls are still allowed.
    fn arb_json_non_null() -> impl Strategy<Value = Value> {
        arb_json().prop_filter("non-null at top level", |v| !v.is_null())
    }

    proptest! {
        // --- 1. Roundtrip ---------------------------------------------------

        /// Native-messaging framing carries arbitrary byte payloads faithfully
        /// (bytes modelled as a JSON array of integers, the shape the frame
        /// body actually transports).
        #[test]
        fn nm_frame_carries_bytes(bytes in prop::collection::vec(any::<u8>(), 0..8192)) {
            let payload = Value::Array(
                bytes.iter().map(|b| Value::Number((*b as u64).into())).collect(),
            );
            let mut buf = Vec::new();
            nm_write_frame(&mut buf, &payload).unwrap();
            // 4-byte LE length prefix precedes the body.
            let body_len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
            prop_assert_eq!(body_len, buf.len() - 4);
            let got = nm_read_frame(&mut Cursor::new(buf)).unwrap().unwrap();
            prop_assert_eq!(got, payload);
        }

        /// Any bounded JSON value survives a native-messaging frame roundtrip.
        #[test]
        fn nm_frame_value_roundtrip(v in arb_json()) {
            let mut buf = Vec::new();
            nm_write_frame(&mut buf, &v).unwrap();
            let got = nm_read_frame(&mut Cursor::new(buf)).unwrap().unwrap();
            prop_assert_eq!(got, v);
        }

        /// A JSON-RPC message survives an MCP NDJSON roundtrip, and always
        /// serializes to exactly one line.
        #[test]
        fn mcp_roundtrip(
            jsonrpc in prop::option::of(arb_string()),
            id in prop::option::of(arb_json_non_null()),
            method in prop::option::of(arb_string()),
            params in prop::option::of(arb_json_non_null()),
        ) {
            let msg = JsonRpc {
                jsonrpc,
                id,
                method,
                params,
                result: None,
                error: None,
            };
            let mut buf = Vec::new();
            mcp_write(&mut buf, &msg).unwrap();
            // NDJSON invariant: exactly one newline, the frame terminator.
            prop_assert_eq!(buf.iter().filter(|&&b| b == b'\n').count(), 1);
            let got = mcp_read(&mut Cursor::new(buf)).unwrap().unwrap();
            prop_assert_eq!(
                serde_json::to_value(&got).unwrap(),
                serde_json::to_value(&msg).unwrap(),
            );
        }

        /// A bridge request survives an NDJSON roundtrip over the envelope.
        #[test]
        fn bridge_req_roundtrip(
            id in any::<u64>(),
            op in arb_string(),
            tab_id in prop::option::of(any::<i64>()),
            args in arb_json(),
        ) {
            let req = BridgeReq { id, op, tab_id, args };
            let mut buf = Vec::new();
            bridge_write(&mut buf, &req).unwrap();
            let got: BridgeReq = bridge_read(&mut Cursor::new(buf)).unwrap().unwrap();
            prop_assert_eq!(
                serde_json::to_value(&got).unwrap(),
                serde_json::to_value(&req).unwrap(),
            );
        }

        /// A bridge response survives an NDJSON roundtrip over the envelope.
        #[test]
        fn bridge_resp_roundtrip(
            id in any::<u64>(),
            ok in any::<bool>(),
            data in prop::option::of(arb_json_non_null()),
            error in prop::option::of(arb_string()),
        ) {
            let resp = BridgeResp { id, ok, data, error };
            let mut buf = Vec::new();
            bridge_write(&mut buf, &resp).unwrap();
            let got: BridgeResp = bridge_read(&mut Cursor::new(buf)).unwrap().unwrap();
            prop_assert_eq!(
                serde_json::to_value(&got).unwrap(),
                serde_json::to_value(&resp).unwrap(),
            );
        }

        // --- 2. Never panics on arbitrary input (the fuzz property) ---------

        /// `nm_read_frame` on arbitrary bytes yields `Ok`/`Err`, never a panic.
        #[test]
        fn nm_read_never_panics(data in prop::collection::vec(any::<u8>(), 0..1024)) {
            let _ = nm_read_frame(&mut Cursor::new(data));
        }

        /// `mcp_read` on arbitrary bytes yields `Ok`/`Err`, never a panic.
        #[test]
        fn mcp_read_never_panics(data in prop::collection::vec(any::<u8>(), 0..1024)) {
            let _ = mcp_read(&mut Cursor::new(data));
        }

        /// `bridge_read` on arbitrary bytes yields `Ok`/`Err`, never a panic.
        #[test]
        fn bridge_read_never_panics(data in prop::collection::vec(any::<u8>(), 0..1024)) {
            let _: io::Result<Option<Value>> = bridge_read(&mut Cursor::new(data));
        }

        // --- 3. Size guard --------------------------------------------------

        /// Any length prefix above the 64 MB inbound clamp is rejected with
        /// `InvalidData`, before allocating or reading the claimed body.
        #[test]
        fn nm_oversize_prefix_always_rejected(len in (64u32 * 1024 * 1024 + 1)..=u32::MAX) {
            let mut framed = len.to_le_bytes().to_vec();
            // Trailing bytes the guard must refuse to read past.
            framed.extend_from_slice(&[0u8; 8]);
            let err = nm_read_frame(&mut Cursor::new(framed)).unwrap_err();
            prop_assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        }
    }
}
