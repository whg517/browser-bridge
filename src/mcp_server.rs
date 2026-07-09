//! MCP server mode: the default (no args) mode. Speaks JSON-RPC 2.0 over
//! stdio with ZCode, and accepts inbound bridge connections from the native
//! host over a localhost TCP socket.

use std::io::{self, BufReader, BufWriter};
use std::thread;

use serde_json::{json, Value};

use crate::ipc;
use crate::protocol::{install_stderr_panic_hook, mcp_read, mcp_write, JsonRpc};
use crate::session::Session;
use crate::tools;

pub fn run() -> i32 {
    install_stderr_panic_hook();
    crate::protocol::ignore_sigpipe();

    // Handle termination signals gracefully so we always remove the lock file
    // on the way out (a stale lock is harmless but confuses diagnostics, and a
    // supplanted server should clean up after itself). This must run BEFORE we
    // spawn any worker threads: it blocks SIGTERM/SIGINT process-wide, and only
    // threads created afterwards inherit that blocked mask — otherwise the
    // kernel could deliver the signal to an unmasked worker and terminate us
    // before the handler thread runs.
    install_signal_cleanup(|| {
        ipc::LockFile::remove();
    });

    // 1. Bind the bridge socket and publish the lock file.
    let (listener, lock) = match ipc::listen() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("[mcp] failed to bind bridge socket: {e}");
            return 1;
        }
    };
    // Take over from any prior MCP server instance. ZCode may spawn a fresh
    // server per session; if the previous one is still alive, the native host
    // will keep talking to IT (it doesn't follow lock-file changes), so the
    // new server's tool calls report "extension not connected". Kill the old
    // instance first so the native host's TCP connection drops, forcing the
    // extension to reconnect against our new lock.
    if let Ok(Some(prev)) = ipc::LockFile::read() {
        if prev.pid != lock.pid && pid_is_alive(prev.pid) {
            eprintln!("[mcp] supplanting prior MCP server pid {}", prev.pid);
            // SIGTERM → old server's stdin loop ends → it removes the lock and
            // exits → its TCP listener closes → native host gets EOF → SW
            // onDisconnect → reconnect spawns a fresh host → reads OUR lock.
            unsafe {
                libc_kill(prev.pid, libc::SIGTERM);
            }
            // Give it a moment to die and clean up its lock.
            for _ in 0..50 {
                if !pid_is_alive(prev.pid) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            // Remove any stale lock the old instance didn't clean up.
            ipc::LockFile::remove();
        }
    }
    if let Err(e) = lock.write() {
        eprintln!("[mcp] failed to write lock file: {e}");
        return 1;
    }
    eprintln!(
        "[mcp] bridge listening on 127.0.0.1:{} (pid {}) lock at {}",
        lock.port,
        lock.pid,
        ipc::LockFile::path().display()
    );

    let session = Session::new();

    // 2. Background thread: accept the native host's connection(s).
    {
        let session = session.clone();
        thread::spawn(move || loop {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    if let Err(e) = session.attach_connection(stream) {
                        eprintln!("[mcp] accept handler error: {e}");
                    }
                }
                Err(e) => {
                    eprintln!("[mcp] accept failed: {e}");
                    break;
                }
            }
        });
    }

    // 3. Main loop: read NDJSON JSON-RPC from stdin, respond on stdout.
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    loop {
        let msg = match mcp_read(&mut reader) {
            Ok(Some(m)) => m,
            Ok(None) => break, // stdin EOF
            Err(e) => {
                eprintln!("[mcp] stdin parse error: {e}");
                // Send a parse-error with null id; keep going if possible.
                let err = JsonRpc::err(Value::Null, -32700, format!("parse error: {e}"));
                let _ = mcp_write(&mut writer, &err);
                continue;
            }
        };
        let resp = handle(&session, &msg);
        if let Some(r) = resp {
            if let Err(e) = mcp_write(&mut writer, &r) {
                eprintln!("[mcp] stdout write failed: {e}");
                break;
            }
        }
        // None means notification (no response).
    }

    // stdin EOF: ZCode disconnected. Remove lock file.
    ipc::LockFile::remove();
    0
}

fn handle(session: &Session, msg: &JsonRpc) -> Option<JsonRpc> {
    // Notifications have no id and expect no response.
    let id = match &msg.id {
        Some(i) => i.clone(),
        None => {
            // Notification: the only one we care about is
            // notifications/initialized — no reply needed. Swallow the rest.
            return None;
        }
    };

    let method = msg.method.as_deref().unwrap_or("");
    match method {
        "initialize" => Some(JsonRpc::ok(
            id,
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "browser-bridge",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        )),
        "notifications/initialized" => {
            // Client signals ready; no reply.
            None
        }
        "ping" => Some(JsonRpc::ok(id, json!({}))),
        "tools/list" => {
            let list: Vec<Value> = tools::all()
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": t.input_schema,
                    })
                })
                .collect();
            Some(JsonRpc::ok(id, json!({ "tools": list })))
        }
        "tools/call" => {
            let params = msg.params.clone().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            // Tool errors are returned as a *successful* RPC with isError=true
            // in the result (per MCP spec); only protocol errors use the
            // error field.
            let (content, is_error) = tools::dispatch(session, name, &args);
            let result = json!({ "content": content, "isError": is_error });
            Some(JsonRpc::ok(id, result))
        }
        // Unknown method → JSON-RPC method-not-found.
        _ => Some(JsonRpc::err(
            id,
            -32601,
            format!("method not found: {method}"),
        )),
    }
}

/// Block SIGTERM/SIGINT process-wide and run `f` on a dedicated thread when
/// one arrives, then exit. Blocking the signals here (and letting a single
/// thread `sigwait` for them) sidesteps async-signal-safety limits: the
/// cleanup runs in ordinary thread context, so it may touch the filesystem
/// freely. Callers MUST invoke this before spawning worker threads so those
/// threads inherit the blocked mask.
fn install_signal_cleanup<F: Fn() + Send + 'static>(f: F) {
    #[cfg(unix)]
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        // Block in the current (main) thread; threads spawned later inherit it.
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());

        thread::spawn(move || {
            let mut sig: std::os::raw::c_int = 0;
            // Wait until one of the blocked signals is delivered.
            let _ = libc::sigwait(&set, &mut sig);
            eprintln!("[mcp] received signal {sig}, cleaning up and exiting");
            f();
            std::process::exit(0);
        });
    }
    #[cfg(not(unix))]
    {
        let _ = f;
    }
}

/// Whether a process with the given pid is alive. Used by the takeover logic.
/// `kill(pid, 0)` checks existence without delivering a signal.
fn pid_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Send SIGTERM to a pid (Unix). Used to supplant a stale MCP server instance.
#[cfg(unix)]
unsafe fn libc_kill(pid: u32, sig: i32) {
    libc::kill(pid as i32, sig);
}
