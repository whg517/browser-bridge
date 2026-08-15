//! Typed errors for the tool-call path.
//!
//! The IO/wire layers (`protocol`, `ipc`) keep using `std::io::Result` because
//! `io::Error` is already the right currency there. This module covers the
//! higher-level session/tool boundary, where errors were previously stringly
//! typed. Each variant's `Display` text is what the model ultimately sees when
//! a tool call fails (surfaced through `tools::dispatch` as `isError` content).

use std::time::Duration;

/// An error from invoking a tool op over the bridge to the extension.
#[derive(Debug, thiserror::Error)]
pub enum CallError {
    /// No native host is currently connected (extension not loaded, Chrome not
    /// running, or — most often — its service worker is asleep).
    ///
    /// The old text asked whether the extension was loaded and Chrome running.
    /// In the common case both are true and the message sends the user looking
    /// in the wrong place: MV3 recycles an idle service worker after ~30s, and
    /// only a browser-side event can wake it. Name that first, and name the
    /// remedies, since an agent relays this text verbatim.
    #[error(
        "browser extension not connected. Most likely its service worker is asleep — Chrome \
         stops it after ~30s idle. Retry this call once (the extension re-checks every 30s); \
         if it still fails, ask the user to click the Browser Bridge toolbar icon, and to \
         confirm the extension is loaded and enabled."
    )]
    NotConnected,

    /// Failed to write the request onto the bridge socket.
    #[error("write to extension failed: {0}")]
    Write(#[source] std::io::Error),

    /// The extension accepted the request but produced no response in time.
    #[error("extension did not respond within {0:?}")]
    Timeout(Duration),

    /// The bridge connection dropped while we were awaiting the response.
    #[error("extension connection lost while waiting for response")]
    Disconnected,

    /// The requested tool name is not recognized by the dispatcher.
    #[error("unknown tool: {0}")]
    UnknownTool(String),

    /// The call's arguments don't satisfy the tool's own `inputSchema`.
    /// Rejected here rather than coerced to a default and sent on, so a
    /// malformed call doesn't come back looking like a page failure.
    #[error("{0}")]
    InvalidArgument(String),

    /// The request would not fit in one native-messaging message.
    ///
    /// Chrome closes the port outright if a message to it exceeds 1 MB, so the
    /// framing layer refuses to write one — but that refusal reaches the native
    /// host as an ordinary write error, which it treats as fatal and tears the
    /// connection down for. Catching the size here instead fails the one call
    /// that is too big, with a code that says so, and never touches the bridge.
    #[error(
        "request is {bytes} bytes, over the 1 MB limit for a single message to Chrome. \
         Send less data: fill a long value in pieces, or have page_eval read what it needs \
         from the page instead of receiving it as an argument."
    )]
    PayloadTooLarge { bytes: usize },

    /// The extension executed the op and reported a failure of its own.
    ///
    /// `code` is the extension's own classification when it had one. Before it
    /// existed every extension-side failure — a missing tab, a page whose scheme
    /// cannot be driven, a tab that has not navigated yet — arrived here
    /// indistinguishable from a genuine page-execution error, and all of them
    /// were reported as EXECUTION_FAILED. That made `retryable` in
    /// contracts/errors.json meaningless for this whole half of the taxonomy.
    #[error("{message}")]
    Extension {
        code: Option<String>,
        message: String,
    },
}

/// Codes the extension is allowed to put on the wire.
///
/// Kept as an allowlist rather than passed through: the code ends up in the
/// audit trail and in client-side retry decisions, so an unknown or misspelled
/// one must degrade to the honest generic answer instead of inventing taxonomy.
const EXTENSION_CODES: &[&str] = &[
    "TAB_NOT_FOUND",
    "UNSUPPORTED_PAGE",
    "EXTENSION_NOT_READY",
    "TOOL_DISABLED",
];

impl CallError {
    /// The stable, cross-process error code for this variant.
    ///
    /// These strings are the contract between the Rust server and the
    /// extension: they are the `code` values in `contracts/errors.json`
    /// (verified by the `codes_match_contract` test below) and are meant for
    /// programmatic handling by clients, while `Display` stays human-facing.
    pub fn code(&self) -> &'static str {
        match self {
            CallError::NotConnected => "NOT_CONNECTED",
            CallError::Write(_) => "CONNECTION_LOST",
            CallError::Timeout(_) => "RESPONSE_TIMEOUT",
            CallError::Disconnected => "CONNECTION_LOST",
            CallError::UnknownTool(_) => "INVALID_ARGUMENT",
            CallError::InvalidArgument(_) => "INVALID_ARGUMENT",
            CallError::PayloadTooLarge { .. } => "PAYLOAD_TOO_LARGE",
            CallError::Extension { code, .. } => code
                .as_deref()
                .and_then(|c| EXTENSION_CODES.iter().copied().find(|known| *known == c))
                .unwrap_or("EXECUTION_FAILED"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_text_is_model_facing() {
        assert!(CallError::NotConnected
            .to_string()
            .contains("not connected"));
        assert_eq!(
            CallError::UnknownTool("foo".into()).to_string(),
            "unknown tool: foo"
        );
        // The extension's own error text passes through verbatim.
        assert_eq!(
            CallError::Extension {
                code: None,
                message: "boom".into()
            }
            .to_string(),
            "boom"
        );
        assert!(CallError::Timeout(Duration::from_secs(120))
            .to_string()
            .contains("did not respond"));
    }

    // contracts/errors.json is the single source of truth for cross-process
    // error codes. Each CallError variant's `code()` is verified against it
    // here (mirrors `tools::matches_contract`).
    // The gap that made contracts/errors.json a document rather than a contract:
    // `codes_match_contract` only checks that codes the server EMITS exist in the
    // file. It says nothing about codes in the file nobody emits — and five of
    // them had no producer anywhere, including the one retryable code a transient
    // extension-side failure needed. Clients act on `retryable`, so a code that
    // cannot be produced is not harmless documentation (#134).
    #[test]
    fn every_code_has_a_producer() {
        let path = format!("{}/contracts/errors.json", env!("CARGO_MANIFEST_DIR"));
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let contract: serde_json::Value = serde_json::from_str(&raw).unwrap();

        for entry in contract["errors"].as_array().expect("errors array") {
            let code = entry["code"].as_str().expect("code");
            let producer = entry["producer"].as_str().unwrap_or_else(|| {
                panic!(
                    "{code} has no `producer`. Every code must say who emits it: \
                     \"rust\", \"extension\", or \"reserved\" with a reason."
                )
            });
            match producer {
                // Emitted by the server: it must have a `rust` array, which
                // codes_match_contract then holds to the actual mapping.
                "rust" => assert!(
                    entry["rust"].as_array().is_some_and(|a| !a.is_empty()),
                    "{code} is produced by rust but lists no CallError variants"
                ),
                // Travels on BridgeResp.code, so the server must be willing to
                // accept it — an extension code outside EXTENSION_CODES is
                // silently downgraded to EXECUTION_FAILED and never seen.
                "extension" => assert!(
                    EXTENSION_CODES.contains(&code),
                    "{code} is produced by the extension but is not in EXTENSION_CODES, \
                     so the server would downgrade it to EXECUTION_FAILED"
                ),
                // Deliberately unimplemented — allowed, but it has to say why,
                // so the next reader can tell intent from oversight.
                "reserved" => assert!(
                    entry["reserved"]
                        .as_str()
                        .is_some_and(|r| !r.trim().is_empty()),
                    "{code} is reserved but does not say why"
                ),
                other => panic!("{code} has unknown producer {other:?}"),
            }
        }
    }

    // …and the reverse: nothing may be allowlisted on the server that the
    // contract does not describe, or the audit trail gains codes with no
    // documented meaning or retry semantics.
    #[test]
    fn extension_codes_are_all_in_the_contract() {
        let path = format!("{}/contracts/errors.json", env!("CARGO_MANIFEST_DIR"));
        let raw = std::fs::read_to_string(&path).unwrap();
        let contract: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let errors = contract["errors"].as_array().unwrap();

        for code in EXTENSION_CODES {
            let entry = errors
                .iter()
                .find(|e| e["code"].as_str() == Some(code))
                .unwrap_or_else(|| panic!("EXTENSION_CODES has {code}, errors.json does not"));
            assert_eq!(
                entry["producer"].as_str(),
                Some("extension"),
                "{code} is accepted from the extension but the contract calls it \
                 {:?}",
                entry["producer"]
            );
        }
    }

    #[test]
    fn codes_match_contract() {
        use std::io;

        // One real instance of every CallError variant, paired with its name.
        // (The compiler forces this list to stay exhaustive: adding a variant
        // without a code() arm won't compile, and this test then fails if the
        // contract mapping is missing.)
        let cases: &[(&str, CallError)] = &[
            ("NotConnected", CallError::NotConnected),
            (
                "Write",
                CallError::Write(io::Error::new(io::ErrorKind::BrokenPipe, "x")),
            ),
            ("Timeout", CallError::Timeout(Duration::from_secs(1))),
            ("Disconnected", CallError::Disconnected),
            ("UnknownTool", CallError::UnknownTool("t".into())),
            (
                "InvalidArgument",
                CallError::InvalidArgument("bad args".into()),
            ),
            (
                "PayloadTooLarge",
                CallError::PayloadTooLarge { bytes: 2_000_000 },
            ),
            (
                "Extension",
                CallError::Extension {
                    code: None,
                    message: "boom".into(),
                },
            ),
        ];

        let path = format!("{}/contracts/errors.json", env!("CARGO_MANIFEST_DIR"));
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let contract: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let errors = contract["errors"].as_array().expect("errors array");

        // (a) every code() maps to a code that exists in errors.json.
        let known: Vec<&str> = errors.iter().map(|e| e["code"].as_str().unwrap()).collect();
        for (name, err) in cases {
            assert!(
                known.contains(&err.code()),
                "code {} for variant {name} not found in contracts/errors.json",
                err.code()
            );
        }

        // (b) the mapping agrees with the `rust` arrays: a variant maps to a
        // code iff that code's `rust` array lists the variant.
        for (name, err) in cases {
            let entry = errors
                .iter()
                .find(|e| e["code"].as_str() == Some(err.code()))
                .unwrap_or_else(|| panic!("no entry for code {}", err.code()));
            let rust = entry["rust"]
                .as_array()
                .unwrap_or_else(|| panic!("code {} has no `rust` array", err.code()));
            let listed: Vec<&str> = rust.iter().map(|v| v.as_str().unwrap()).collect();
            assert!(
                listed.contains(name),
                "variant {name} maps to {} but that code's `rust` array is {listed:?}",
                err.code()
            );
        }

        // …and the reverse: every variant named in a `rust` array is covered
        // by exactly one of our cases with the matching code.
        for entry in errors {
            let Some(rust) = entry["rust"].as_array() else {
                continue;
            };
            let code = entry["code"].as_str().unwrap();
            for v in rust {
                let vname = v.as_str().unwrap();
                let matched = cases
                    .iter()
                    .find(|(name, _)| *name == vname)
                    .unwrap_or_else(|| panic!("errors.json lists unknown rust variant {vname}"));
                assert_eq!(
                    matched.1.code(),
                    code,
                    "variant {vname} should map to {code}"
                );
            }
        }
    }
}
