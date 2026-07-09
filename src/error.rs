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
}
