//! Read-only `doctor` / `status` subcommand.
//!
//! Prints a health report about this install without touching the browser,
//! spawning processes, or killing anything. It only reads the lock file, does a
//! passive localhost TCP connect probe against our OWN server port (no bytes
//! sent), and checks whether the per-OS native-messaging manifest file exists.

use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use crate::ipc::LockFile;

/// Native-messaging host id, as written by the installers (`install.sh` /
/// `install.ps1`). The manifest file is `<HOST_NAME>.json`.
const HOST_NAME: &str = "com.browser_bridge.host";

/// Plain facts gathered for the report. Kept free of I/O so `render` is pure
/// and unit-testable.
#[derive(Debug, Clone)]
struct Report {
    version: &'static str,
    os: &'static str,
    arch: &'static str,
    lock_path: PathBuf,
    lock_present: bool,
    /// `Some(err)` when the lock file exists but could not be parsed.
    lock_error: Option<String>,
    port: Option<u16>,
    pid: Option<u32>,
    secret_len: Option<usize>,
    /// `None` when no probe was attempted (no lock file / no port).
    reachable: Option<bool>,
    manifest_path: PathBuf,
    manifest_present: bool,
}

/// Expected per-OS Chrome native-messaging manifest path for this platform.
///
/// Mirrors the installers: macOS/Windows are exactly what `install.sh` /
/// `install.ps1` write; Linux falls back to the conventional Chrome
/// `NativeMessagingHosts` directory under `~/.config`.
fn manifest_path() -> PathBuf {
    let file = format!("{HOST_NAME}.json");

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let mut p = PathBuf::from(home);
        p.push("Library/Application Support/Google/Chrome/NativeMessagingHosts");
        p.push(file);
        p
    }

    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("browser-bridge").join(file)
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .unwrap_or_else(|| PathBuf::from("/"));
        base.join("google-chrome/NativeMessagingHosts").join(file)
    }
}

/// Passive reachability probe: connect to our own localhost port and drop the
/// connection immediately. No command bytes are ever sent.
fn probe(port: u16) -> bool {
    let addr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

/// Gather the report by reading (never mutating) local state.
fn gather() -> Report {
    let lock_path = LockFile::path();
    let manifest_path = manifest_path();
    let manifest_present = manifest_path.exists();

    let mut report = Report {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        lock_path,
        lock_present: false,
        lock_error: None,
        port: None,
        pid: None,
        secret_len: None,
        reachable: None,
        manifest_path,
        manifest_present,
    };

    match LockFile::read() {
        Ok(Some(lf)) => {
            report.lock_present = true;
            report.port = Some(lf.port);
            report.pid = Some(lf.pid);
            report.secret_len = Some(lf.secret.len());
            report.reachable = Some(probe(lf.port));
        }
        Ok(None) => {
            // No lock file: server not running. Leave defaults.
        }
        Err(e) => {
            // File exists but did not read/parse. Treat as present-but-broken.
            report.lock_present = true;
            report.lock_error = Some(e.to_string());
        }
    }

    report
}

/// Pure rendering of a gathered report into the printed health text.
fn render(r: &Report) -> String {
    let mut out = String::new();
    out.push_str(&format!("browser-bridge doctor — v{}\n", r.version));
    out.push_str(&format!("platform:        {}/{}\n", r.os, r.arch));

    out.push_str(&format!("lock file:       {}\n", r.lock_path.display()));
    if let Some(err) = &r.lock_error {
        out.push_str(&format!("  present but unreadable: {err}\n"));
    } else if r.lock_present {
        out.push_str("  present: yes\n");
        if let Some(port) = r.port {
            out.push_str(&format!("  port:    {port}\n"));
        }
        if let Some(pid) = r.pid {
            out.push_str(&format!("  pid:     {pid}\n"));
        }
        if let Some(len) = r.secret_len {
            out.push_str(&format!("  secret:  <redacted, {len} chars>\n"));
        }
    } else {
        out.push_str("  present: no (MCP server not running?)\n");
    }

    out.push_str("mcp server:      ");
    match r.reachable {
        Some(true) => out.push_str("reachable (127.0.0.1 connect OK)\n"),
        Some(false) => out.push_str("not reachable\n"),
        None => out.push_str("not probed (no lock file)\n"),
    }

    out.push_str(&format!("native manifest: {}\n", r.manifest_path.display()));
    out.push_str(&format!(
        "  present: {}\n",
        if r.manifest_present { "yes" } else { "no" }
    ));

    // These probes only cover the MCP-server/bridge side. doctor cannot observe
    // whether the Chrome extension is loaded and connected without speaking the
    // native-host hello protocol on the bridge port, which would clobber the
    // live connection via the generation guard — so we tell the user how to
    // check it themselves instead of probing.
    out.push_str(
        "\nnote: the checks above cover the MCP server + native-host bridge only.\n\
         They do NOT confirm the Chrome extension is loaded and connected. Verify\n\
         that via the Browser Bridge toolbar icon (approve the target site) and\n\
         the extension's Service Worker console at chrome://extensions.\n",
    );

    out.push_str(&format!("\n{}\n", summary(r)));
    out
}

/// One-line status summary and the derived exit code hint.
fn summary(r: &Report) -> &'static str {
    if r.lock_error.is_some() {
        return "lock file present but unreadable — try restarting your MCP client";
    }
    if !r.lock_present {
        return "server not running — is your MCP client started?";
    }
    match r.reachable {
        Some(true) if r.manifest_present => "OK",
        Some(true) => "server reachable, but native host manifest not installed — run install.sh",
        _ => "server not reachable — is your MCP client running?",
    }
}

/// Exit code: 0 when healthy ("OK"), 1 otherwise.
fn exit_code(r: &Report) -> i32 {
    if summary(r) == "OK" {
        0
    } else {
        1
    }
}

/// Entry point for the `doctor` / `status` subcommand.
pub fn run() -> i32 {
    let report = gather();
    print!("{}", render(&report));
    exit_code(&report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn healthy_report() -> Report {
        Report {
            version: "1.2.3",
            os: "macos",
            arch: "aarch64",
            lock_path: PathBuf::from("/tmp/run.lock"),
            lock_present: true,
            lock_error: None,
            port: Some(5123),
            pid: Some(4242),
            secret_len: Some(32),
            reachable: Some(true),
            manifest_path: PathBuf::from("/tmp/com.browser_bridge.host.json"),
            manifest_present: true,
        }
    }

    #[test]
    fn render_healthy_is_ok() {
        let r = healthy_report();
        let text = render(&r);
        assert!(text.contains("v1.2.3"));
        assert!(text.contains("macos/aarch64"));
        assert!(text.contains("port:    5123"));
        assert!(text.contains("pid:     4242"));
        assert!(text.contains("<redacted, 32 chars>"));
        // The real secret value must never appear.
        assert!(!text.contains("deadbeef"));
        assert!(text.contains("reachable (127.0.0.1 connect OK)"));
        // Honest note: green checks still don't prove the extension connected.
        assert!(text.contains("do NOT confirm the Chrome extension"));
        assert!(text.trim_end().ends_with("OK"));
        assert_eq!(exit_code(&r), 0);
    }

    #[test]
    fn render_missing_lock_reports_not_running() {
        let r = Report {
            version: "1.2.3",
            os: "linux",
            arch: "x86_64",
            lock_path: PathBuf::from("/run/user/1000/browser-bridge.lock"),
            lock_present: false,
            lock_error: None,
            port: None,
            pid: None,
            secret_len: None,
            reachable: None,
            manifest_path: PathBuf::from(
                "/home/u/.config/google-chrome/NativeMessagingHosts/com.browser_bridge.host.json",
            ),
            manifest_present: false,
        };
        let text = render(&r);
        assert!(text.contains("present: no"));
        assert!(text.contains("not probed (no lock file)"));
        assert!(text.contains("server not running"));
        assert_eq!(exit_code(&r), 1);
    }

    #[test]
    fn probe_detects_open_and_closed_ports() {
        // A live local listener: probe must succeed.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe(port));

        // Close it, then probe the now-dead port: must fail.
        drop(listener);
        assert!(!probe(port));
    }
}
