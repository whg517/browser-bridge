//! MCP server mode: the default (no args) mode. Speaks JSON-RPC 2.0 over
//! stdio with the MCP client, and accepts inbound bridge connections from the
//! native host over a localhost TCP socket.

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

    // Bind the bridge, take over from any prior *live* MCP server (a fresh MCP
    // client session legitimately replaces the old one), and start accepting the
    // native host. See `start_bridge`.
    let session = match start_bridge(true) {
        Some(s) => s,
        None => return 1,
    };

    // Main loop: read NDJSON JSON-RPC from stdin, respond on stdout.
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    loop {
        let msg = match mcp_read(&mut reader) {
            Ok(Some(m)) => m,
            Ok(None) => break, // stdin EOF
            Err(e) => {
                log_warn!("mcp", "stdin parse error: {e}");
                // Send a parse-error with null id; keep going if possible.
                let err = JsonRpc::err(Value::Null, -32700, format!("parse error: {e}"));
                let _ = mcp_write(&mut writer, &err);
                continue;
            }
        };
        let resp = handle(&session, &msg);
        if let Some(r) = resp {
            if let Err(e) = mcp_write(&mut writer, &r) {
                log_error!("mcp", "stdout write failed: {e}");
                break;
            }
        }
        // None means notification (no response).
    }

    // stdin EOF: the MCP client disconnected. Remove lock file.
    ipc::LockFile::remove();
    0
}

/// Bind the bridge socket, publish the lock file, and spawn the accept loop that
/// attaches native-host connections to a [`Session`]. Returns the session, or
/// `None` on a fatal bind/lock error.
///
/// `supplant_live`: when a *live* prior server owns the lock, kill it and take
/// over (MCP server mode — a fresh client session replaces the old). `call` mode
/// passes `false`: it refuses up front rather than interrupting a running client,
/// so here it only ever overwrites a stale (dead-pid) lock.
fn start_bridge(supplant_live: bool) -> Option<Session> {
    let (listener, lock) = match ipc::listen() {
        Ok(x) => x,
        Err(e) => {
            log_error!("mcp", "failed to bind bridge socket: {e}");
            return None;
        }
    };
    if supplant_live {
        // The native host keeps talking to whichever server it's connected to (it
        // doesn't follow lock-file changes), so kill the old one to force the
        // extension to reconnect against our new lock.
        if let Ok(Some(prev)) = ipc::LockFile::read() {
            if prev.pid != lock.pid && pid_is_alive(prev.pid) {
                log_info!("mcp", "supplanting prior MCP server pid {}", prev.pid);
                terminate_process(prev.pid);
                for _ in 0..50 {
                    if !pid_is_alive(prev.pid) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                ipc::LockFile::remove();
            }
        }
    }
    if let Err(e) = lock.write() {
        log_error!("mcp", "failed to write lock file: {e}");
        return None;
    }
    log_info!(
        "mcp",
        "bridge listening on 127.0.0.1:{} (pid {}) lock at {}",
        lock.port,
        lock.pid,
        ipc::LockFile::path().display()
    );

    let session = Session::new();
    {
        let session = session.clone();
        thread::spawn(move || loop {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    if let Err(e) = session.attach_connection(stream) {
                        log_warn!("mcp", "accept handler error: {e}");
                    }
                }
                Err(e) => {
                    log_error!("mcp", "accept failed: {e}");
                    break;
                }
            }
        });
    }
    Some(session)
}

/// Validate a `call` invocation: parse the optional JSON args and confirm the
/// tool exists. Pure, so it's unit-testable without a bridge. On failure returns
/// `(exit_code, message)`.
fn parse_call_args(tool: &str, args_json: Option<&str>) -> Result<Value, (i32, String)> {
    let args = match args_json {
        None => Value::Null,
        Some(s) => {
            serde_json::from_str(s).map_err(|e| (2, format!("invalid JSON arguments: {e}")))?
        }
    };
    if !tools::all().iter().any(|t| t.name == tool) {
        let names: Vec<&str> = tools::all().iter().map(|t| t.name).collect();
        let msg = format!("unknown tool: {tool}\navailable: {}", names.join(", "));
        return Err((2, msg));
    }
    Ok(args)
}

/// One-shot CLI: run a single tool against the extension and print its result,
/// for callers that don't want to speak MCP. `browser-bridge call <tool> [json]`.
///
/// Prints the tool's raw JSON result to stdout (no MCP `{content:[{text}]}`
/// wrapping). Exit codes: 0 ok · 1 tool error · 2 bad args/unknown tool ·
/// 3 timed out waiting for the extension · 4 a live MCP server owns the bridge.
pub fn run_call(tool: &str, args_json: Option<&str>) -> i32 {
    install_stderr_panic_hook();
    crate::protocol::ignore_sigpipe();

    let args = match parse_call_args(tool, args_json) {
        Ok(a) => a,
        Err((code, msg)) => {
            eprintln!("{msg}");
            return code;
        }
    };

    // Never interrupt a live MCP client: the bridge is a single connection, so
    // taking over would drop that client. Refuse instead (only stale locks pass).
    if let Ok(Some(prev)) = ipc::LockFile::read() {
        if prev.pid != std::process::id() && pid_is_alive(prev.pid) {
            eprintln!(
                "a browser-bridge server is already running (pid {}). `call` shares the single\n\
                 bridge connection and won't interrupt it — stop your MCP client first, or make\n\
                 the call through that client.",
                prev.pid
            );
            return 4;
        }
    }

    // Own the bridge from here on, so clean up the lock on signals too.
    install_signal_cleanup(ipc::LockFile::remove);
    let session = match start_bridge(false) {
        Some(s) => s,
        None => return 1,
    };

    // Wait for the extension (native host) to attach before dispatching, else the
    // call returns NOT_CONNECTED immediately. The extension's reconnect loop
    // connects within a couple of seconds once our lock is published.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while session.current_generation().is_none() {
        if std::time::Instant::now() >= deadline {
            eprintln!(
                "timed out waiting for the Chrome extension to connect. Is it loaded and is\n\
                 Chrome running? Click the Browser Bridge toolbar icon to wake it, then retry."
            );
            ipc::LockFile::remove();
            return 3;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    let out = tools::dispatch(&session, tool, &args);
    print_outcome(&out);
    ipc::LockFile::remove();
    if out.is_error {
        1
    } else {
        0
    }
}

/// Print a dispatched tool result for `call`: text blocks (the raw tool JSON) and
/// image blocks (base64) go to stdout; an error's text goes to stderr.
fn print_outcome(out: &tools::Outcome) {
    let blocks = out.content.as_array().into_iter().flatten();
    for block in blocks {
        if let Some(text) = block.get("text").and_then(Value::as_str) {
            if out.is_error {
                eprintln!("{text}");
            } else {
                println!("{text}");
            }
        } else if let Some(data) = block.get("data").and_then(Value::as_str) {
            println!("{data}"); // e.g. page_screenshot base64 PNG
        }
    }
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
                },
                // A short kickstart prompt the MCP client hands to the model so
                // an agent knows how to drive the browser safely. The same text
                // is a copy-paste block in the README. docs/agent-prompt.md is
                // the single source; embedded into the binary at build time.
                "instructions": include_str!("../docs/agent-prompt.md"),
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
            // Correlate every invocation with a per-call request id and record a
            // structured audit event (tool, outcome, taxonomy code, duration).
            let req_id = next_request_id();
            let started = std::time::Instant::now();
            // Capture the connection generation this call will run over, so the
            // audit line can be correlated with a specific native-host
            // connection across reconnects. `"-"` when no host is attached.
            let conn_gen = session.current_generation();
            let conn_s = conn_gen.map_or_else(|| "-".to_string(), |g| g.to_string());
            // Tool errors are returned as a *successful* RPC with isError=true
            // in the result (per MCP spec); only protocol errors use the
            // error field.
            let out = tools::dispatch(session, name, &args);
            let req_s = req_id.to_string();
            let dur_s = started.elapsed().as_millis().to_string();
            crate::log::audit(&[
                ("req", req_s.as_str()),
                ("conn", conn_s.as_str()),
                ("tool", name),
                ("outcome", if out.is_error { "error" } else { "ok" }),
                ("code", out.error_code.unwrap_or("-")),
                ("dur_ms", dur_s.as_str()),
            ]);
            let result = json!({ "content": out.content, "isError": out.is_error });
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
            log_info!("mcp", "received signal {sig}, cleaning up and exiting");
            f();
            std::process::exit(0);
        });
    }
    #[cfg(not(unix))]
    {
        let _ = f;
    }
}

/// A monotonic per-call request id, used to correlate audit lines with the
/// tool invocation they describe. Process-wide; starts at 1.
fn next_request_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Whether a process with the given pid is alive. Used by the takeover logic.
/// `kill(pid, 0)` checks existence without delivering a signal.
fn pid_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Some(pid) = unix_pid(pid) else {
            return false;
        };
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        windows_process::is_alive(pid)
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = pid;
        false
    }
}

#[cfg(unix)]
fn unix_pid(pid: u32) -> Option<libc::pid_t> {
    // POSIX reserves zero and negative values for process groups or broadcast
    // signalling. Reject values that cannot be represented as pid_t instead
    // of truncating (u32::MAX would otherwise become -1 and signal every
    // process the current user is allowed to terminate).
    libc::pid_t::try_from(pid).ok().filter(|pid| *pid > 0)
}

fn terminate_process(pid: u32) {
    #[cfg(unix)]
    if let Some(pid) = unix_pid(pid) {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    windows_process::terminate(pid);
    #[cfg(all(not(unix), not(windows)))]
    let _ = pid;
}

#[cfg(test)]
mod call_tests {
    use super::parse_call_args;
    use serde_json::{json, Value};

    #[test]
    fn no_args_parse_to_null() {
        assert_eq!(parse_call_args("tab_list", None).unwrap(), Value::Null);
    }

    #[test]
    fn json_args_parse_through() {
        assert_eq!(
            parse_call_args("tab_open", Some(r#"{"url":"https://x"}"#)).unwrap(),
            json!({ "url": "https://x" })
        );
    }

    #[test]
    fn invalid_json_is_rejected_with_code_2() {
        let (code, _msg) = parse_call_args("tab_open", Some("{not json")).unwrap_err();
        assert_eq!(code, 2);
    }

    #[test]
    fn unknown_tool_is_rejected_with_code_2() {
        let (code, msg) = parse_call_args("bogus_tool", None).unwrap_err();
        assert_eq!(code, 2);
        assert!(msg.contains("unknown tool"));
    }
}

#[cfg(test)]
mod initialize_tests {
    use super::JsonRpc;
    use crate::session::Session;
    use serde_json::json;

    fn request(method: &str) -> JsonRpc {
        JsonRpc {
            jsonrpc: Some("2.0".into()),
            id: Some(json!(1)),
            method: Some(method.into()),
            params: None,
            result: None,
            error: None,
        }
    }

    #[test]
    fn initialize_serves_the_embedded_agent_prompt() {
        let resp = super::handle(&Session::new(), &request("initialize"))
            .expect("initialize returns a response");
        let result = resp.result.expect("initialize response has a result");

        // serverInfo is unchanged...
        assert_eq!(result["serverInfo"]["name"], "browser-bridge");
        // ...and the kickstart prompt is handed to the client via `instructions`,
        // anchored to stable content of docs/agent-prompt.md so the wiring can't
        // silently drop the embedded prompt.
        let instructions = result["instructions"]
            .as_str()
            .expect("instructions must be a string");
        assert!(
            !instructions.trim().is_empty(),
            "instructions must not be empty"
        );
        assert!(instructions.contains("Browser Bridge"));
        assert!(instructions.contains("page_eval"));
    }
}

#[cfg(all(test, unix))]
mod unix_process_tests {
    use super::unix_pid;

    #[test]
    fn rejects_group_and_overflow_pid_values() {
        assert_eq!(unix_pid(0), None);
        assert_eq!(unix_pid(u32::MAX), None);
    }

    #[test]
    fn accepts_current_process_pid() {
        assert_eq!(
            unix_pid(std::process::id()),
            Some(std::process::id() as libc::pid_t)
        );
    }
}

#[cfg(windows)]
mod windows_process {
    use std::ffi::c_void;

    type Handle = *mut c_void;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        fn CloseHandle(object: Handle) -> i32;
    }

    pub fn is_alive(pid: u32) -> bool {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut exit_code = 0;
            let ok = GetExitCodeProcess(handle, &mut exit_code) != 0;
            CloseHandle(handle);
            ok && exit_code == STILL_ACTIVE
        }
    }

    pub fn terminate(pid: u32) {
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !handle.is_null() {
                let _ = TerminateProcess(handle, 0);
                CloseHandle(handle);
            }
        }
    }
}
