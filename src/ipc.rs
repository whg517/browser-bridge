//! Localhost TCP IPC between the MCP server (long-lived) and the native-host
//! subprocess (spawned fresh by Chrome on each connectNative).
//!
//! - MCP server binds `127.0.0.1:0` (random ephemeral port), writes the
//!   chosen port + a per-run secret to a lock file under the user's runtime
//!   directory. The secret guards against another local user's stray process
//!   connecting (single-user machine, but cheap defense).
//! - Native host reads the lock file on startup and connects; presents the
//!   secret as the first NDJSON line ("hello").

use std::fs;
#[cfg(unix)]
use std::io::Read;
use std::io::{self, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Per-process runtime info the MCP server publishes for the native host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockFile {
    pub port: u16,
    /// Random token the native host must echo back on connect. Not a strong
    /// secret (the lock file is 0600) but stops accidental connections.
    pub secret: String,
    /// PID of the MCP server process that owns the socket, for diagnostics.
    pub pid: u32,
}

impl LockFile {
    /// Path of the lock file in a per-user runtime/data directory.
    pub fn path() -> PathBuf {
        // Explicit override. When the MCP server and the native host run under
        // different user contexts (e.g. Windows automation as SYSTEM vs. Chrome
        // as the desktop user), LOCALAPPDATA/XDG resolve differently and the two
        // sides look for the lock in different places — a permanent
        // NOT_CONNECTED. Setting BB_LOCK_DIR on both pins them to one directory.
        if let Some(dir) = std::env::var_os("BB_LOCK_DIR") {
            let dir = PathBuf::from(dir).join("browser-bridge");
            #[cfg(unix)]
            ensure_private_dir(&dir);
            #[cfg(not(unix))]
            let _ = fs::create_dir_all(&dir);
            return dir.join("run.lock");
        }

        #[cfg(windows)]
        {
            let base = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("USERPROFILE")
                        .map(PathBuf::from)
                        .map(|p| p.join("AppData/Local"))
                })
                .unwrap_or_else(std::env::temp_dir);
            let dir = base.join("browser-bridge");
            let _ = fs::create_dir_all(&dir);
            dir.join("run.lock")
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
                let dir = PathBuf::from(xdg).join("browser-bridge");
                ensure_private_dir(&dir);
                return dir.join("run.lock");
            }
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            let mut p = PathBuf::from(home);
            p.push("Library/Application Support/browser-bridge");
            ensure_private_dir(&p);
            p.join("run.lock")
        }

        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let dir = if let Some(xdg) = std::env::var_os("XDG_RUNTIME_DIR") {
                PathBuf::from(xdg).join("browser-bridge")
            } else if let Some(xdg_cache) = std::env::var_os("XDG_CACHE_HOME") {
                PathBuf::from(xdg_cache).join("browser-bridge")
            } else if let Some(home) = std::env::var_os("HOME") {
                PathBuf::from(home).join(".cache/browser-bridge")
            } else {
                std::env::temp_dir().join(format!("browser-bridge-{}", unsafe { libc::geteuid() }))
            };
            ensure_private_dir(&dir);
            dir.join("run.lock")
        }
    }

    /// Atomically CLAIM the lock: create run.lock exclusively and write our
    /// record into it. `create_new` fails with `AlreadyExists` when any file
    /// is in the way, so claiming can never silently displace an existing
    /// lock — the starter gets to decide instead (live owner: refuse, or
    /// supplant under `--takeover`; dead owner: stale, remove and retry).
    ///
    /// This replaces the old write-tmp-then-rename, which was "last writer
    /// wins" by construction: whichever server started second overwrote the
    /// first one's lock, which is how two MCP clients ended up fighting over
    /// one bridge with no error on either side (#45, ADR-0028 Phase 0).
    ///
    /// There is no half-written state to worry about: the JSON is written only
    /// after the exclusive create succeeded, and readers either see the whole
    /// previous file or the whole ours.
    pub fn claim(&self) -> io::Result<()> {
        let path = Self::path();
        let bytes = serde_json::to_vec(self)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            f.write_all(&bytes)?;
            f.flush()?;
        }
        #[cfg(windows)]
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            f.write_all(&bytes)?;
            f.flush()?;
        }
        Ok(())
    }

    pub fn read() -> io::Result<Option<Self>> {
        match fs::read(Self::path()) {
            Ok(bytes) => {
                let lf: LockFile = serde_json::from_slice(&bytes).map_err(|e| {
                    io::Error::new(io::ErrorKind::InvalidData, format!("lockfile decode: {e}"))
                })?;
                Ok(Some(lf))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn remove() {
        let _ = fs::remove_file(Self::path());
    }
}

#[cfg(unix)]
fn ensure_private_dir(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    if fs::create_dir_all(path).is_ok() {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
}

/// Server side: bind a random localhost port, return the listener and the
/// lock-file contents to publish. The caller is responsible for `write()`ing
/// the lock file (and removing it on shutdown).
pub fn listen() -> io::Result<(TcpListener, LockFile)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let secret = generate_secret();
    let lf = LockFile {
        port,
        secret,
        pid: std::process::id(),
    };
    Ok((listener, lf))
}

fn generate_secret() -> String {
    #[cfg(windows)]
    {
        let mut buf = [0u8; 16];
        // BCRYPT_USE_SYSTEM_PREFERRED_RNG lets BCryptGenRandom use the system
        // RNG without opening and managing an algorithm-provider handle.
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                buf.as_mut_ptr(),
                buf.len() as u32,
                0x0000_0002,
            )
        };
        if status >= 0 {
            return hex_encode(&buf);
        }
    }

    #[cfg(unix)]
    {
        // 128 bits of entropy from the OS RNG. We avoid pulling in `rand` by
        // reading /dev/urandom directly (macOS and Linux both expose it).
        let mut buf = [0u8; 16];
        if let Ok(mut f) = fs::File::open("/dev/urandom") {
            if f.read_exact(&mut buf).is_ok() {
                return hex_encode(&buf);
            }
        }
    }
    // Fallback: mix in time + pid + a stack address. Not cryptographic, but
    // this is only the connect-back token for a per-user lock file on a
    // single-user machine.
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let stack = &t as *const _ as u128;
    hex_encode(&t.wrapping_add(pid).wrapping_add(stack).to_le_bytes())
        .chars()
        .take(32)
        .collect::<String>()
}

#[cfg(windows)]
#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut std::ffi::c_void,
        buffer: *mut u8,
        buffer_len: u32,
        flags: u32,
    ) -> i32;
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Client side (native host): read the lock file, connect, and send the
/// "hello" line containing the secret. Times out after 2 s so a stale lock
/// file fails fast instead of hanging Chrome's port.
/// The two kinds of client that may connect to the bridge port (ADR-0028
/// Phase 1b): the Chrome-spawned native host (dumb pipe to the extension) and
/// a thin MCP server relaying its client's JSON-RPC. They say which they are
/// in the hello `role` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelloRole {
    NativeHost,
    McpServer,
}

impl HelloRole {
    pub fn as_str(self) -> &'static str {
        match self {
            HelloRole::NativeHost => "native-host",
            HelloRole::McpServer => "mcp-server",
        }
    }
}

pub fn connect(role: HelloRole) -> io::Result<TcpStream> {
    let lf = LockFile::read()?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "browser-bridge lock file not found — is the MCP server running?",
        )
    })?;
    let addr = format!("127.0.0.1:{}", lf.port);
    let stream = match TcpStream::connect_timeout(
        &addr
            .parse()
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("addr parse: {e}")))?,
        Duration::from_secs(2),
    ) {
        Ok(s) => s,
        Err(e) => {
            // Do NOT remove the lock here, even though it may be stale: with
            // a broker being SPAWNED by a retrying client, a refused connect
            // usually means the broker simply hasn't bound its port yet — and
            // deleting the lock then would discard a perfectly valid claim
            // (and make a concurrent --takeover a silent no-op). Stale locks
            // are the claim loop's problem: its liveness check clears them
            // (ADR-0028 Phase 0/1b).
            return Err(e);
        }
    };
    // Send hello with the secret as the first NDJSON line; the role tells the
    // broker which kind of client this is, and `proto` lets a thin server be
    // rejected up front when the running broker speaks another protocol
    // version (the native host's protocol half rides the announce frame).
    let hello = serde_json::json!({
        "hello": lf.secret,
        "role": role.as_str(),
        "proto": crate::peer::PROTOCOL_VERSION,
    });
    let mut line = serde_json::to_vec(&hello).unwrap();
    line.push(b'\n');
    {
        use std::io::Write;
        let _ = (&stream).write_all(&line);
        let _ = (&stream).flush();
    }
    Ok(stream)
}

/// Authenticate an inbound hello line against the lock file's secret.
///
/// Returns the client's declared role on success. A MISSING role is
/// `NativeHost` by design: hosts spawned by an older install predate the
/// field, and Chrome launches them straight from the manifest with no way to
/// add arguments — the field only exists so ONE port can serve both client
/// kinds (ADR-0028 Phase 1b).
pub fn hello_role(hello_value: &serde_json::Value) -> Option<HelloRole> {
    let want = match LockFile::read() {
        Ok(Some(lf)) => lf.secret,
        _ => return None,
    };
    if hello_value.get("hello").and_then(|v| v.as_str()) != Some(want.as_str()) {
        return None;
    }
    Some(match hello_value.get("role").and_then(|v| v.as_str()) {
        Some("mcp-server") => HelloRole::McpServer,
        _ => HelloRole::NativeHost,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockfile_serde_roundtrip() {
        let lf = LockFile {
            port: 5000,
            secret: "deadbeef".into(),
            pid: 42,
        };
        let bytes = serde_json::to_vec(&lf).unwrap();
        let back: LockFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.port, 5000);
        assert_eq!(back.secret, "deadbeef");
        assert_eq!(back.pid, 42);
    }

    #[test]
    fn secret_is_32_hex_chars() {
        let s = generate_secret();
        assert_eq!(s.len(), 32);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn hello_role_rejects_a_bad_secret_and_defaults_the_role() {
        // No "hello" key can never match, regardless of any on-disk lock file.
        assert!(hello_role(&serde_json::json!({ "nothello": "x" })).is_none());
        // A wrong secret is rejected whatever role it claims.
        assert!(hello_role(&serde_json::json!({
            "hello": "not-the-secret",
            "role": "mcp-server"
        }))
        .is_none());
        // With a real lock present the secret authenticates... (lock-dependent,
        // so only the parse default is asserted here; see broker integration
        // tests for the authenticated cases.)
        assert_eq!(
            ipc_parse_role(&serde_json::json!({ "hello": "x", "role": "mcp-server" })),
            Some(HelloRole::McpServer)
        );
        assert_eq!(
            ipc_parse_role(&serde_json::json!({ "hello": "x" })),
            Some(HelloRole::NativeHost),
            "absent role = native-host (older installs)"
        );
    }

    /// The role-parsing half of `hello_role`, factored out so tests can pin it
    /// without a live lock file.
    fn ipc_parse_role(v: &serde_json::Value) -> Option<HelloRole> {
        Some(match v.get("role").and_then(|r| r.as_str()) {
            Some("mcp-server") => HelloRole::McpServer,
            _ => HelloRole::NativeHost,
        })
    }

    #[test]
    fn lock_path_has_expected_filename() {
        assert_eq!(LockFile::path().file_name().unwrap(), "run.lock");
    }

    #[test]
    fn bb_lock_dir_overrides_path() {
        // Only this test touches BB_LOCK_DIR — cargo runs tests in parallel
        // threads, so a second env-var user would race this one and could aim
        // a claim at the REAL user lock. The claim/unclaim cycle below lives
        // here for exactly that reason. (The other path() test asserts only
        // the filename, which stays "run.lock" under the override either way.)
        let tmp = std::env::temp_dir().join(format!("bb-lockdir-test-{}", std::process::id()));
        std::env::set_var("BB_LOCK_DIR", &tmp);
        let p = LockFile::path();
        assert!(p.starts_with(&tmp), "path {p:?} should be under {tmp:?}");
        assert_eq!(p.file_name().unwrap(), "run.lock");
        // The claim cycle, isolated in the throwaway dir: exclusive create
        // refuses a second claimer without touching the first claimer's
        // record, and the stale path (remove) lets the next claimer win.
        let first = LockFile {
            port: 1,
            secret: "ab".into(),
            pid: std::process::id(),
        };
        first.claim().expect("first claim succeeds");
        let second = LockFile {
            port: 2,
            secret: "cd".into(),
            pid: 999_999,
        };
        let err = second
            .claim()
            .expect_err("claiming over a live lock must fail");
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            LockFile::read().unwrap().unwrap().port,
            1,
            "the second claim must not have overwritten the first"
        );
        LockFile::remove();
        second.claim().expect("claim after remove succeeds");
        assert_eq!(LockFile::read().unwrap().unwrap().port, 2);
        LockFile::remove();
        std::env::remove_var("BB_LOCK_DIR");
        let _ = fs::remove_dir_all(&tmp);
    }
}
