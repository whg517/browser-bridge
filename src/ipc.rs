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

        #[cfg(not(windows))]
        {
            if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
                return PathBuf::from(xdg).join("browser-bridge.lock");
            }
            // macOS: use ~/Library/Application Support/browser-bridge/run.lock
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            let mut p = PathBuf::from(home);
            p.push("Library/Application Support/browser-bridge");
            let _ = fs::create_dir_all(&p);
            p.join("run.lock")
        }
    }

    pub fn write(&self) -> io::Result<()> {
        let path = Self::path();
        let mut tmp = path.clone();
        tmp.set_extension("lock.tmp");
        let bytes = serde_json::to_vec(self)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)?;
            f.write_all(&bytes)?;
            f.flush()?;
        }
        #[cfg(windows)]
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp)?;
            f.write_all(&bytes)?;
            f.flush()?;
        }
        // Unix rename atomically replaces an existing destination. Windows'
        // std::fs::rename does not, so remove a stale destination first. That
        // creates a tiny not-found window, but the extension's reconnect loop
        // retries after 2 seconds and can never observe a half-written JSON
        // file because all bytes were flushed to the temporary file first.
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(&path)?;
        }
        fs::rename(&tmp, &path)?;
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
pub fn connect() -> io::Result<TcpStream> {
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
            // The lock file may be stale (server crashed). Remove it so the
            // next server start wins cleanly; then surface the error.
            LockFile::remove();
            return Err(e);
        }
    };
    // Send hello with the secret as the first NDJSON line.
    let hello = serde_json::json!({ "hello": lf.secret });
    let mut line = serde_json::to_vec(&hello).unwrap();
    line.push(b'\n');
    {
        use std::io::Write;
        let _ = (&stream).write_all(&line);
        let _ = (&stream).flush();
    }
    Ok(stream)
}

/// Validate an inbound hello line received on a freshly-accepted server
/// connection. Returns true if the secret matches the lock file.
pub fn validate_hello(hello_value: &serde_json::Value) -> bool {
    let want = match LockFile::read() {
        Ok(Some(lf)) => lf.secret,
        _ => return false,
    };
    hello_value
        .get("hello")
        .and_then(|v| v.as_str())
        .map(|s| s == want)
        .unwrap_or(false)
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
    fn validate_hello_rejects_missing_key() {
        // No "hello" key can never match, regardless of any on-disk lock file.
        assert!(!validate_hello(&serde_json::json!({ "nothello": "x" })));
    }

    #[test]
    fn lock_path_has_expected_filename() {
        assert_eq!(LockFile::path().file_name().unwrap(), "run.lock");
    }
}
