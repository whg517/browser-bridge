//! MCP server mode: the default (no args) mode. Speaks JSON-RPC 2.0 over
//! stdio with the MCP client, and accepts inbound bridge connections from the
//! native host over a localhost TCP socket.

use std::collections::HashMap;
use std::io::{self, BufReader, BufWriter};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;

use serde_json::{json, Value};

use crate::ipc;
use crate::peer;
use crate::protocol::{
    bridge_read, bridge_write, install_stderr_panic_hook, mcp_read, mcp_write, JsonRpc,
};
use crate::scheduler::Scheduler;
use crate::session::{ClientCtx, Session};
use crate::tools;

/// MCP server mode (ADR-0028 Phase 1b): a THIN client. The broker — a
/// standalone `--broker` process — owns the lock and the extension
/// connection; this process joins it and relays its MCP client's JSON-RPC.
/// If no broker is running, one is spawned from this same binary.
///
/// `supplant_live` (`--takeover`) deliberately displaces whoever owns the
/// bridge first; the default refuses nothing here — joining is the whole
/// point — but a *stale* bridge (pre-broker binary) is detected at the
/// handshake and reported with the way out.
pub fn run(supplant_live: bool) -> i32 {
    install_stderr_panic_hook();
    crate::protocol::ignore_sigpipe();

    // The broker owns the lock, so this process has nothing to clean up on
    // exit — in particular it must NEVER remove the lock file (that would
    // orphan a bridge other clients are still using).
    match join_or_start_broker(supplant_live) {
        Some(stream) => relay_mcp_over_broker(stream),
        None => 1,
    }
}

/// Join the running broker, or — when nobody owns the bridge — spawn one from
/// this binary and join that. Returns the connected stream, already
/// handshaken (see [`relay_mcp_over_broker`] for the ack line).
fn join_or_start_broker(supplant_live: bool) -> Option<std::net::TcpStream> {
    if supplant_live {
        // Deliberate displacement (Phase 0 semantics). The lock owner is now
        // the BROKER, and killing it takes the bridge away from every client
        // using it — which is exactly what --takeover says: restart the
        // bridge under me.
        if let Ok(Some(prev)) = ipc::LockFile::read() {
            if pid_is_alive(prev.pid) {
                log_info!(
                    "mcp",
                    "supplanting prior bridge pid {} (--takeover)",
                    prev.pid
                );
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
    if let Ok(stream) = ipc::connect(ipc::HelloRole::McpServer) {
        return Some(stream);
    }
    // Nobody home (or a stale lock, which connect() clears). Spawn a broker
    // from THIS binary — the broker outlives this server on purpose (Unix
    // re-parents orphans; Windows children are not tied to the parent), so a
    // server restart never tears the browser session down.
    let exe = std::env::current_exe().ok()?;
    match std::process::Command::new(exe).arg("--broker").spawn() {
        Ok(mut child) => {
            // Reap the child when it eventually exits so it never sits in the
            // process table as this server's zombie.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => {
            log_error!("mcp", "failed to spawn broker: {e}");
            return None;
        }
    }
    for attempt in 1..=100 {
        match ipc::connect(ipc::HelloRole::McpServer) {
            Ok(stream) => return Some(stream),
            Err(e) => {
                // Visible at info: a fresh broker should be joinable within a
                // couple of attempts, so more than a handful of these means
                // something is wrong with the handoff.
                if attempt == 1 || attempt % 10 == 0 {
                    log_info!(
                        "mcp",
                        "waiting to join the spawned broker (attempt {attempt}): {e}"
                    );
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    log_error!("mcp", "spawned a broker but could not connect to it");
    None
}

/// Relay the MCP client's JSON-RPC to the broker and its answers back.
///
/// The broker's FIRST line is the handshake verdict — an ack naming the
/// granted client id, or a rejection — never a tool result, so it is safe to
/// read one line before the pumps start.
fn relay_mcp_over_broker(stream: std::net::TcpStream) -> i32 {
    let mut reader = match stream.try_clone() {
        Ok(r) => BufReader::new(r),
        Err(e) => {
            log_error!("mcp", "stream clone: {e}");
            return 1;
        }
    };
    let first: Option<Value> = bridge_read(&mut reader).ok().flatten();
    match first {
        Some(v) if v.get("broker").is_some() => {
            if v.get("protocol").and_then(Value::as_u64) != Some(peer::PROTOCOL_VERSION) {
                eprintln!(
                    "the running broker speaks bridge protocol {}, this build speaks {}. \
                     Stop your other browser-bridge MCP clients and start this one with \
                     --takeover to replace the stale broker.",
                    v.get("protocol").and_then(Value::as_u64).unwrap_or(0),
                    crate::peer::PROTOCOL_VERSION
                );
                return 1;
            }
            if let Some(id) = v.get("clientId").and_then(Value::as_str) {
                log_info!("mcp", "joined the bridge as client {id}");
            }
        }
        Some(v) if v.get("brokerRejected").is_some() => {
            eprintln!(
                "the broker refused this client: {}",
                v.get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown reason")
            );
            return 1;
        }
        _ => {
            eprintln!(
                "whatever owns the browser-bridge lock did not answer the broker handshake. \
                 It is probably a stale browser-bridge from before multi-client support: \
                 stop your other MCP clients, or start this one with --takeover."
            );
            return 1;
        }
    }

    // Two pumps, like the native host: stdin -> broker (spawned thread), and
    // broker -> stdout on this thread. Whichever direction dies ends the
    // process: an MCP client gone means stdin EOF (and dropping the TCP
    // connection drops our broker registration), a broker gone means this
    // server has nothing to relay to and the MCP client should restart us
    // against the fresh bridge.
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut r = BufReader::new(stdin.lock());
        let mut w = BufWriter::new(stream);
        loop {
            match mcp_read(&mut r) {
                Ok(Some(m)) => {
                    if let Err(e) = mcp_write(&mut w, &m) {
                        log_warn!("mcp", "broker write failed: {e}");
                        std::process::exit(1);
                    }
                }
                Ok(None) => {
                    log_info!("mcp", "stdin EOF — MCP client gone, leaving the bridge");
                    std::process::exit(0);
                }
                Err(e) => {
                    log_warn!("mcp", "stdin parse error: {e}");
                    std::process::exit(0);
                }
            }
        }
    });
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    loop {
        let msg = bridge_read(&mut reader);
        match msg {
            Ok(Some(m)) => {
                if let Err(e) = mcp_write(&mut out, &m) {
                    log_error!("mcp", "stdout write failed: {e}");
                    std::process::exit(1);
                }
            }
            Ok(None) => {
                log_error!("mcp", "broker went away — the bridge is gone");
                std::process::exit(1);
            }
            Err(e) => {
                log_warn!("mcp", "broker read error: {e}");
                std::process::exit(1);
            }
        }
    }
}

/// Broker mode (ADR-0028 Phase 1b): own the lock and the extension
/// connection; thin MCP servers connect and relay their clients' JSON-RPC.
/// One port, two client kinds, told apart by the hello `role`.
pub fn broker_run() -> i32 {
    install_stderr_panic_hook();
    crate::protocol::ignore_sigpipe();
    // The broker owns the lock: signals must remove it (Phase 0 hygiene) —
    // but only while it is still OURS. A supplanting successor claims the
    // lock the instant we die; a cleanup that fired late would delete THEIR
    // claim and orphan the new bridge.
    install_signal_cleanup(remove_lock_if_ours);

    let Some((listener, lock)) = claim_bridge_lock(false) else {
        return 1;
    };
    log_info!(
        "mcp",
        "broker listening on 127.0.0.1:{} (pid {}) lock at {}",
        lock.port,
        lock.pid,
        ipc::LockFile::path().display()
    );

    let session = Session::new();
    let clients = ClientState::new();
    {
        let session = session.clone();
        let clients = clients.clone();
        thread::spawn(move || loop {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    let session = session.clone();
                    let clients = clients.clone();
                    thread::spawn(move || accept_client(stream, session, clients));
                }
                Err(e) => {
                    log_error!("mcp", "accept failed: {e}");
                    break;
                }
            }
        });
    }
    // The broker has no stdio role; every exit path is the linger timer or a
    // signal. Park forever.
    loop {
        thread::park();
    }
}

/// Remove the lock file ONLY if it still names this process.
///
/// Every deferred cleanup (signal handler, linger timer) must go through
/// this: in a multi-broker world a delayed exit can race a successor that
/// already claimed the lock, and deleting THEIR claim orphans the new bridge
/// — which made `--takeover` a silent no-op in e2e until this guard existed.
fn remove_lock_if_ours() {
    if let Ok(Some(lf)) = ipc::LockFile::read() {
        if lf.pid == std::process::id() {
            ipc::LockFile::remove();
        }
    }
}

/// Per-broker state for the connected thin servers: id grant, live count,
/// display names learned from `initialize`, the mutation lock (scheduling
/// v1), and the linger guard.
struct ClientState {
    next_id: AtomicU64,
    count: Mutex<usize>,
    names: Mutex<HashMap<u64, String>>,
    /// Each client's LAST-KNOWN target tab, reported by the extension on
    /// every response (ADR-0028 Phase 2). The scheduler's key for the NEXT
    /// mutating op from that client.
    client_tabs: Mutex<HashMap<u64, i64>>,
    /// Mutation scheduling v2: same-tab serialized, different tabs concurrent,
    /// unknown-target conservative (see scheduler.rs).
    sched: Scheduler,
    linger_armed: AtomicBool,
}

impl ClientState {
    fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            next_id: AtomicU64::new(1),
            count: Mutex::new(0),
            names: Mutex::new(HashMap::new()),
            client_tabs: Mutex::new(HashMap::new()),
            sched: Scheduler::new(),
            linger_armed: AtomicBool::new(false),
        })
    }

    fn register(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn arrive(&self) -> usize {
        let mut c = self.count.lock().unwrap();
        *c += 1;
        *c
    }

    fn depart(&self) -> usize {
        let mut c = self.count.lock().unwrap();
        *c = c.saturating_sub(1);
        *c
    }

    fn count(&self) -> usize {
        *self.count.lock().unwrap()
    }

    /// Learn the client's display name from its MCP `initialize` clientInfo —
    /// the client's own identity claim is for LABELS only; authorization
    /// never depends on it (ids are granted, not self-reported).
    fn set_name(&self, id: u64, name: &str) {
        self.names.lock().unwrap().insert(id, name.to_string());
    }

    fn label(&self, id: u64) -> String {
        match self.names.lock().unwrap().get(&id) {
            Some(n) => format!("c{id}:{n}"),
            None => format!("c{id}"),
        }
    }

    /// The learned display name, if the client's `initialize` has landed.
    fn name_of(&self, id: u64) -> Option<String> {
        self.names.lock().unwrap().get(&id).cloned()
    }

    /// The client's last-known target tab (None until a response reported one).
    fn tab_of(&self, id: u64) -> Option<i64> {
        self.client_tabs.lock().unwrap().get(&id).copied()
    }

    fn set_tab(&self, id: u64, tab: i64) {
        self.client_tabs.lock().unwrap().insert(id, tab);
    }

    /// When the last client leaves, linger ~30s before exiting so a client
    /// restart (crash, reload) finds the bridge — and its extension
    /// connection — still warm instead of waking the service worker from
    /// cold. Arming twice is a no-op; a joining client simply makes the
    /// timer's final check see a non-zero count.
    fn arm_linger(self: &std::sync::Arc<Self>) {
        if self.linger_armed.swap(true, Ordering::SeqCst) {
            return;
        }
        let clients = self.clone();
        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_secs(30));
            if clients.count() == 0 {
                log_info!("mcp", "no mcp clients for 30s — broker exiting");
                remove_lock_if_ours();
                std::process::exit(0);
            }
        });
    }
}

/// Route one accepted connection by its hello role.
fn accept_client(
    stream: std::net::TcpStream,
    session: Session,
    clients: std::sync::Arc<ClientState>,
) {
    let Ok(writer_stream) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let hello: Value = match bridge_read(&mut reader) {
        Ok(Some(h)) => h,
        _ => {
            log_warn!("mcp", "connection closed before a valid hello");
            return;
        }
    };
    match ipc::hello_role(&hello) {
        Some(ipc::HelloRole::NativeHost) => {
            if let Err(e) = session.attach_connection(writer_stream, reader, hello) {
                log_warn!("mcp", "native host rejected: {e}");
            }
        }
        Some(ipc::HelloRole::McpServer) => {
            serve_mcp_client(writer_stream, reader, hello, session, clients)
        }
        None => {
            log_warn!(
                "mcp",
                "rejected inbound connection: bad/missing hello secret"
            );
        }
    }
}

/// The whole broker side of one thin server: ack its handshake, learn its
/// name, relay JSON-RPC through `handle` under the mutation lock, count it
/// out on disconnect.
fn serve_mcp_client(
    stream: std::net::TcpStream,
    mut reader: BufReader<std::net::TcpStream>,
    hello: Value,
    session: Session,
    clients: std::sync::Arc<ClientState>,
) {
    // Cross-version gate for CLIENTS (the extension's half of the handshake is
    // the announce frame): a client that speaks another protocol gets a
    // structured rejection it can show its user.
    if hello.get("proto").and_then(Value::as_u64) != Some(peer::PROTOCOL_VERSION) {
        let writer = &mut BufWriter::new(stream);
        let reject = serde_json::json!({
            "brokerRejected": true,
            "reason": format!(
                "client speaks bridge protocol {}, broker speaks {}",
                hello.get("proto").and_then(Value::as_u64).unwrap_or(0),
                peer::PROTOCOL_VERSION
            ),
        });
        let _ = bridge_write(writer, &reject);
        log_warn!("mcp", "rejected mcp client: protocol mismatch");
        return;
    }

    let id = clients.register();
    let n = clients.arrive();
    let label = clients.label(id);
    log_info!("mcp", "mcp client {label} connected ({n} client(s))");
    {
        let mut writer = BufWriter::new(stream.try_clone().expect("clone for ack"));
        let ack = serde_json::json!({
            "broker": true,
            "protocol": peer::PROTOCOL_VERSION,
            "version": peer::HOST_VERSION,
            "clientId": label,
        });
        if let Err(e) = bridge_write(&mut writer, &ack) {
            log_warn!("mcp", "broker ack failed: {e}");
            clients.depart();
            return;
        }
    }

    loop {
        let msg: JsonRpc = match bridge_read(&mut reader) {
            Ok(Some(m)) => m,
            Ok(None) => break,
            Err(e) => {
                log_warn!("mcp", "client {label} read error: {e}");
                break;
            }
        };
        if msg.method.as_deref() == Some("initialize") {
            if let Some(name) = msg
                .params
                .as_ref()
                .and_then(|p| p.get("clientInfo"))
                .and_then(|ci| ci.get("name"))
                .and_then(Value::as_str)
            {
                clients.set_name(id, name);
            }
        }
        let label = clients.label(id);
        let ctx = ClientCtx {
            id: format!("c{id}"),
            name: clients.name_of(id),
        };
        // Scheduling v2 (ADR-0028 Phase 2): mutations serialize per TAB —
        // keyed on the client's last-reported target — instead of globally.
        // An unknown target (usually a client's first op) is conservative and
        // excludes everything.
        let _guard = if is_mutating_tool_call(&msg) {
            Some(clients.sched.acquire(clients.tab_of(id)))
        } else {
            None
        };
        let (resp, resolved_tab) = handle(&session, Some(&ctx), &msg);
        drop(_guard);
        if let Some(tab) = resolved_tab {
            clients.set_tab(id, tab);
        }
        if let Some(r) = resp {
            let mut writer = BufWriter::new(stream.try_clone().expect("clone for reply"));
            if let Err(e) = mcp_write(&mut writer, &r) {
                log_warn!("mcp", "client {label} write failed: {e}");
                break;
            }
        }
    }

    let remaining = clients.depart();
    log_info!(
        "mcp",
        "mcp client {label} disconnected ({remaining} client(s))"
    );
    if remaining == 0 {
        clients.arm_linger();
    }
}

/// Ops whose effect another op could observe mid-flight (scheduling v1,
/// ADR-0028 Phase 1b): one mutation at a time, globally; reads and waits run
/// concurrently. `tab_open` and `page_snapshot_precise` join the ADR's core
/// list: opening moves the session's current-tab pointer (Phase 1a), and a
/// precise snapshot attaches the debugger, which excludes any concurrent CDP
/// op on the same tab.
fn is_mutating_tool_call(msg: &JsonRpc) -> bool {
    if msg.method.as_deref() != Some("tools/call") {
        return false;
    }
    const MUTATING_OPS: &[&str] = &[
        "page_click",
        "page_fill",
        "page_eval",
        "page_scroll",
        "page_screenshot",
        "tab_close",
        "tab_open",
        "page_snapshot_precise",
    ];
    let name = msg
        .params
        .as_ref()
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    MUTATING_OPS.contains(&name)
}

/// Bind the bridge socket, publish the lock file, and spawn the accept loop that
/// attaches native-host connections to a [`Session`]. Returns the session, or
/// `None` on a fatal bind/lock error.
///
/// `supplant_live`: when a *live* prior server owns the lock, kill it and take
/// over (MCP server mode — a fresh client session replaces the old). `call` mode
/// passes `false`: it refuses up front rather than interrupting a running client,
/// so here it only ever overwrites a stale (dead-pid) lock.
/// What a starter should do about an existing lock file (ADR-0028 Phase 0).
///
/// Pure, so the refuse / takeover / stale policy is unit-testable without
/// sockets or real processes.
#[derive(Debug, PartialEq)]
enum LockHeld {
    /// A live server owns the bridge: refuse by default, supplant it only
    /// under `--takeover`.
    Live(u32),
    /// No lock at all, a lock naming our own pid (crash leftover with pid
    /// reuse, or a same-pid restart), or a dead owner — safe to claim as-is
    /// after clearing.
    Claimable,
}

fn lock_conflict(prev: Option<ipc::LockFile>, my_pid: u32) -> LockHeld {
    match prev {
        Some(lf) if lf.pid == my_pid => LockHeld::Claimable,
        Some(lf) if pid_is_alive(lf.pid) => LockHeld::Live(lf.pid),
        _ => LockHeld::Claimable,
    }
}

/// Bind the bridge socket and CLAIM the lock — the exclusive-create decision
/// loop from ADR-0028 Phase 0, shared by every mode that owns a bridge
/// (one-shot `call`, and the broker). A LIVE owner is refused (naming the way
/// out) unless `supplant_live` made the displacement explicit; a STALE one
/// (crashed owner, leftover, corrupt file) is cleared and claimed.
fn claim_bridge_lock(supplant_live: bool) -> Option<(std::net::TcpListener, ipc::LockFile)> {
    let (listener, lock) = match ipc::listen() {
        Ok(x) => x,
        Err(e) => {
            log_error!("mcp", "failed to bind bridge socket: {e}");
            return None;
        }
    };
    // `claim` is create-new, so an existing lock is an obstacle we must decide
    // about — never something we silently overwrite.
    let mut attempts = 0u8;
    let lock = loop {
        attempts += 1;
        match lock.claim() {
            Ok(()) => break lock,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                match lock_conflict(ipc::LockFile::read().ok().flatten(), lock.pid) {
                    LockHeld::Claimable => {
                        if attempts > 5 {
                            log_error!(
                                "mcp",
                                "lock file at {} cannot be cleared (repeatedly present but not \
                                 owned by a live server)",
                                ipc::LockFile::path().display()
                            );
                            return None;
                        }
                        ipc::LockFile::remove();
                    }
                    LockHeld::Live(prev_pid) if supplant_live => {
                        // The native host keeps talking to whichever server it's
                        // connected to (it doesn't follow lock-file changes), so
                        // kill the old one to force the extension to reconnect
                        // against our new lock.
                        log_info!(
                            "mcp",
                            "supplanting prior bridge pid {prev_pid} (--takeover)"
                        );
                        terminate_process(prev_pid);
                        for _ in 0..50 {
                            if !pid_is_alive(prev_pid) {
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                        ipc::LockFile::remove();
                        if attempts > 5 {
                            log_error!(
                                "mcp",
                                "supplanted pid {prev_pid} but its lock file at {} still cannot \
                                 be re-claimed",
                                ipc::LockFile::path().display()
                            );
                            return None;
                        }
                    }
                    LockHeld::Live(prev_pid) => {
                        log_error!(
                            "mcp",
                            "another browser-bridge process is already running (pid {prev_pid}) \
                             and owns the bridge; refusing to start over it. Multiple MCP \
                             clients are served by the broker (ADR-0028): a second MCP server \
                             JOINS it instead of starting its own bridge. Pass --takeover to \
                             take the bridge over deliberately (the previous owner is \
                             terminated), or stop the other MCP client first."
                        );
                        return None;
                    }
                }
            }
            Err(e) => {
                log_error!("mcp", "failed to claim lock file: {e}");
                return None;
            }
        }
    };
    Some((listener, lock))
}

/// The bridge-owning bridge session used by one-shot `call` mode when no
/// broker is running: bind, claim, accept native-host connections.
fn start_bridge(supplant_live: bool) -> Option<Session> {
    let (listener, lock) = claim_bridge_lock(supplant_live)?;
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
                    // Read the hello here and hand it to attach: one shape for
                    // both bridge owners (the broker needs the role first).
                    let mut reader = match stream.try_clone() {
                        Ok(r) => BufReader::new(r),
                        Err(e) => {
                            log_warn!("mcp", "stream clone failed: {e}");
                            continue;
                        }
                    };
                    let hello: Value = match bridge_read(&mut reader) {
                        Ok(Some(h)) => h,
                        _ => {
                            log_warn!("mcp", "connection closed before a valid hello");
                            continue;
                        }
                    };
                    if let Err(e) = session.attach_connection(stream, reader, hello) {
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

/// Handle one MCP message. Returns the response (if any) plus the tab the op
/// resolved to, for the scheduler and audit (`None` for notifications).
fn handle(
    session: &Session,
    client: Option<&ClientCtx>,
    msg: &JsonRpc,
) -> (Option<JsonRpc>, Option<i64>) {
    // Notifications have no id and expect no response.
    let id = match &msg.id {
        Some(i) => i.clone(),
        None => {
            // Notification: the only one we care about is
            // notifications/initialized — no reply needed. Swallow the rest.
            return (None, None);
        }
    };

    let method = msg.method.as_deref().unwrap_or("");
    match method {
        "initialize" => {
            let result = JsonRpc::ok(
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
            );
            (Some(result), None)
        }
        "notifications/initialized" => {
            // Client signals ready; no reply.
            (None, None)
        }
        "ping" => (Some(JsonRpc::ok(id, json!({}))), None),
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
            (Some(JsonRpc::ok(id, json!({ "tools": list }))), None)
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
            let out = tools::dispatch_for(session, client, name, &args);
            let req_s = req_id.to_string();
            let dur_s = started.elapsed().as_millis().to_string();
            // Brokered calls carry which client acted (`client=c2:claude-code`);
            // the single-process path has nobody to name.
            let client_label = client.map(|c| c.label());
            let tab_s = out.resolved_tab.map(|t| t.to_string());
            let mut audit: Vec<(&str, &str)> = vec![
                ("req", req_s.as_str()),
                ("conn", conn_s.as_str()),
                ("tool", name),
            ];
            if let Some(l) = &client_label {
                audit.push(("client", l.as_str()));
            }
            if let Some(t) = &tab_s {
                audit.push(("tab", t.as_str()));
            }
            audit.push(("outcome", if out.is_error { "error" } else { "ok" }));
            audit.push(("code", out.error_code.unwrap_or("-")));
            audit.push(("dur_ms", dur_s.as_str()));
            crate::log::audit(&audit);
            let result = json!({
                "content": with_advisory(session, out.content),
                "isError": out.is_error,
            });
            (Some(JsonRpc::ok(id, result)), out.resolved_tab)
        }
        // Unknown method → JSON-RPC method-not-found.
        _ => (
            Some(JsonRpc::err(
                id,
                -32601,
                format!("method not found: {method}"),
            )),
            None,
        ),
    }
}

/// Prepend a pending version-drift advisory to a tool result's content blocks.
///
/// The advisory is delivered inside a tool result rather than as an MCP logging
/// notification because that is the one channel the model is guaranteed to read:
/// client support for `notifications/message` varies, and most clients never
/// surface it to the model at all. It cannot ride on `initialize.instructions`
/// either — the extension usually has not connected yet when that is answered.
///
/// Prepending (rather than appending) keeps it ahead of a potentially large
/// payload, and works uniformly for the image blocks `page_screenshot` returns.
/// [`Session::take_advisory`] is one-shot, so this is a no-op on every later call.
fn with_advisory(session: &Session, content: Value) -> Value {
    let Some(msg) = session.take_advisory() else {
        return content;
    };
    let Value::Array(blocks) = content else {
        return content; // dispatch always returns an array; be defensive anyway
    };
    let mut out = vec![json!({ "type": "text", "text": msg })];
    out.extend(blocks);
    Value::Array(out)
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

    // ADR-0028 Phase 0: the refuse / takeover / stale decision, socket-less.
    #[test]
    fn lock_conflict_classifies_own_stale_and_live_owners() {
        use super::{lock_conflict, LockHeld};
        // No previous lock: nothing to decide.
        assert_eq!(lock_conflict(None, 42), LockHeld::Claimable);
        // A lock naming OUR pid counts as ours even though that pid is very
        // much alive — pid reuse and same-pid restarts must not read as a
        // foreign live server.
        let mine = std::process::id();
        assert_eq!(
            lock_conflict(
                Some(crate::ipc::LockFile {
                    port: 1,
                    secret: "s".into(),
                    pid: mine
                }),
                mine
            ),
            LockHeld::Claimable
        );
        // Stale: pid 0 can never be a live process (reserved, and the pid
        // classifier rejects it before any signal is sent).
        assert_eq!(
            lock_conflict(
                Some(crate::ipc::LockFile {
                    port: 1,
                    secret: "s".into(),
                    pid: 0
                }),
                mine
            ),
            LockHeld::Claimable
        );
        // A genuinely live foreign owner: Live — the caller refuses or takes
        // over, never silently claims. pid 1 (launchd/init) is alive on every
        // unix; the liveness probe differs on Windows, so gate this arm.
        #[cfg(unix)]
        assert_eq!(
            lock_conflict(
                Some(crate::ipc::LockFile {
                    port: 1,
                    secret: "s".into(),
                    pid: 1
                }),
                mine
            ),
            LockHeld::Live(1)
        );
    }

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

    // ADR-0028 Phase 1b scheduling v1: mutations serialize, reads/waits and
    // non-tool methods run concurrently.
    #[test]
    fn mutating_ops_are_classified_for_the_scheduler() {
        use super::is_mutating_tool_call;
        let call = |name: &str| JsonRpc {
            jsonrpc: Some("2.0".into()),
            id: Some(json!(1)),
            method: Some("tools/call".into()),
            params: Some(json!({ "name": name, "arguments": {} })),
            result: None,
            error: None,
        };
        let mutating = [
            "page_click",
            "page_fill",
            "page_eval",
            "page_scroll",
            "page_screenshot",
            "tab_close",
            "tab_open",
            "page_snapshot_precise",
        ];
        for m in mutating {
            assert!(is_mutating_tool_call(&call(m)), "{m} must serialize");
        }
        let concurrent = [
            "page_text",
            "page_links",
            "page_snapshot",
            "page_wait_for",
            "tab_list",
            "cookie_get",
            "storage_get",
        ];
        for m in concurrent {
            assert!(
                !is_mutating_tool_call(&call(m)),
                "{m} must run concurrently"
            );
        }
        // Non tools/call methods never take the lock.
        let mut init = call("tab_list");
        init.method = Some("initialize".into());
        assert!(!is_mutating_tool_call(&init));
    }

    #[test]
    fn initialize_serves_the_embedded_agent_prompt() {
        let (resp, resolved_tab) = super::handle(&Session::new(), None, &request("initialize"));
        assert!(resolved_tab.is_none(), "initialize resolves no tab");
        let resp = resp.expect("initialize returns a response");
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

#[cfg(test)]
mod advisory_tests {
    use super::with_advisory;
    use crate::peer::PeerInfo;
    use crate::session::Session;
    use serde_json::json;

    fn armed_session() -> Session {
        let session = Session::new();
        // Inject the host version rather than using this build's: a 0.0.0 dev
        // build (ADR-0026) silences every comparison by design, so no announce
        // could arm an advisory here.
        session.record_announce_against(
            "0.2.0",
            1,
            PeerInfo {
                version: Some("0.1.0".into()),
                ..Default::default()
            },
        );
        session
    }

    #[test]
    fn passes_content_through_when_nothing_is_armed() {
        let content = json!([{ "type": "text", "text": "{}" }]);
        assert_eq!(with_advisory(&Session::new(), content.clone()), content);
    }

    // The advisory goes FIRST so it is not buried under a large payload, the
    // original blocks survive untouched, and it appears only once.
    #[test]
    fn prepends_once_then_stops() {
        let session = armed_session();
        let content = json!([{ "type": "text", "text": "payload" }]);

        let first = with_advisory(&session, content.clone());
        let blocks = first.as_array().expect("content stays an array");
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0]["text"].as_str().unwrap().contains("0.1.0"));
        assert_eq!(blocks[1], content[0]);

        assert_eq!(with_advisory(&session, content.clone()), content);
    }

    // page_screenshot returns an image block; the advisory must ride along
    // without mangling it.
    #[test]
    fn prepends_ahead_of_an_image_block() {
        let content = json!([{ "type": "image", "data": "iVBOR", "mimeType": "image/png" }]);
        let out = with_advisory(&armed_session(), content.clone());
        let blocks = out.as_array().unwrap();
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1], content[0]);
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
