//! Minimal leveled logging to stderr, gated by the `BB_LOG` env var.
//!
//! Both binary modes speak framed / NDJSON protocols over *stdout*, so every
//! diagnostic must go to *stderr* (Chrome captures the native host's stderr in
//! its internal logs; the MCP client surfaces the MCP server's stderr). Levels let a
//! user raise verbosity with `BB_LOG=debug` at launch without recompiling. The
//! default threshold is `info`, so `debug` lines stay hidden unless requested.
//!
//! Prefer the `log_error!` / `log_warn!` / `log_info!` / `log_debug!` macros
//! over calling [`emit`] directly.

use std::sync::OnceLock;

/// Severity, ordered least-verbose (`Error`) to most-verbose (`Debug`).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
        }
    }
}

/// The active threshold, parsed once from `BB_LOG` (error|warn|info|debug).
/// Unrecognized or unset values fall back to `info`.
pub fn threshold() -> Level {
    static T: OnceLock<Level> = OnceLock::new();
    *T.get_or_init(|| match std::env::var("BB_LOG").ok().as_deref() {
        Some("error") | Some("ERROR") => Level::Error,
        Some("warn") | Some("WARN") => Level::Warn,
        Some("debug") | Some("DEBUG") => Level::Debug,
        _ => Level::Info,
    })
}

/// Whether a line at `level` would be printed under the current threshold.
pub fn enabled(level: Level) -> bool {
    level <= threshold()
}

/// Emit one stderr log line if `level` passes the threshold.
pub fn emit(level: Level, tag: &str, args: std::fmt::Arguments) {
    if enabled(level) {
        eprintln!("[{}] [{}] {}", level.label(), tag, args);
    }
}

#[macro_export]
macro_rules! log_error {
    ($tag:expr, $($a:tt)*) => {
        $crate::log::emit($crate::log::Level::Error, $tag, format_args!($($a)*))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($tag:expr, $($a:tt)*) => {
        $crate::log::emit($crate::log::Level::Warn, $tag, format_args!($($a)*))
    };
}

#[macro_export]
macro_rules! log_info {
    ($tag:expr, $($a:tt)*) => {
        $crate::log::emit($crate::log::Level::Info, $tag, format_args!($($a)*))
    };
}

#[macro_export]
macro_rules! log_debug {
    ($tag:expr, $($a:tt)*) => {
        $crate::log::emit($crate::log::Level::Debug, $tag, format_args!($($a)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_ordering() {
        assert!(Level::Error < Level::Warn);
        assert!(Level::Warn < Level::Info);
        assert!(Level::Info < Level::Debug);
    }

    #[test]
    fn info_threshold_hides_debug_only() {
        // `enabled` compares against the process-wide threshold; assert the
        // ordering rule it relies on (default threshold is Info).
        assert!(Level::Error <= Level::Info);
        assert!(Level::Info <= Level::Info);
        assert!(Level::Debug > Level::Info);
    }
}
