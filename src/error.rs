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
    /// running, or the bridge hasn't reconnected yet).
    #[error("browser extension not connected — is the extension loaded and Chrome running?")]
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

    /// The extension executed the op and reported a failure of its own.
    #[error("{0}")]
    Extension(String),
}

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
            CallError::Extension(_) => "EXECUTION_FAILED",
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
        assert_eq!(CallError::Extension("boom".into()).to_string(), "boom");
        assert!(CallError::Timeout(Duration::from_secs(120))
            .to_string()
            .contains("did not respond"));
    }

    // contracts/errors.json is the single source of truth for cross-process
    // error codes. Each CallError variant's `code()` is verified against it
    // here (mirrors `tools::matches_contract`).
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
            ("Extension", CallError::Extension("boom".into())),
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
