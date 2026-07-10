//! Session state owned by the MCP server process.
//!
//! The MCP server is the single source of truth. It:
//!   - owns the localhost TCP listener (published via the lock file),
//!   - accepts the native host's inbound connection (one at a time),
//!   - serializes tool invocations as `BridgeReq` over that connection and
//!     correlates the `BridgeResp` by id using a one-shot channel per id.
//!
//! If the native host disconnects (Chrome closed, SW recycled), the next
//! tool call blocks/retries until a fresh host connects back. The extension
//! is responsible for re-calling `connectNative` on its own.

use std::collections::HashMap;
use std::io::{self, BufReader, BufWriter};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::error::CallError;
use crate::ipc;
use crate::protocol::{bridge_read, bridge_write, BridgeReq, BridgeResp};

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<BridgeResp>>>>;

/// Shared session. Cheap to clone — everything is behind Arc.
#[derive(Clone)]
pub struct Session {
    /// Writer to the currently-connected native host (if any). Wrapped so the
    /// MCP thread can swap it when a new host connects.
    writer: Arc<Mutex<Option<BufWriter<TcpStream>>>>,
    /// Pending request callbacks keyed by BridgeReq.id.
    pending: Pending,
    next_id: Arc<AtomicU64>,
}

impl Session {
    pub fn new() -> Self {
        Session {
            writer: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Take ownership of a freshly-accepted connection from the native host.
    /// Replaces any previous connection (the old one is dropped/closed).
    /// Spawns a reader thread that dispatches BridgeResp by id.
    pub fn attach_connection(&self, stream: TcpStream) -> io::Result<()> {
        // Validate the hello line (auth) before trusting the connection.
        let mut reader = BufReader::new(stream.try_clone()?);
        let first: Option<Value> = bridge_read(&mut reader)?;
        let hello_ok = first.as_ref().map(ipc::validate_hello).unwrap_or(false);
        if !hello_ok {
            log_warn!("session", "rejected inbound connection: bad/missing hello");
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "bad hello"));
        }
        log_info!("session", "native host connected and authenticated");

        // Store the writer half.
        let writer = BufWriter::new(stream);
        *self.writer.lock().unwrap() = Some(writer);

        // Spawn the reader: each BridgeResp routes to its pending sender.
        // On disconnect it clears the shared writer so the next `call` waits
        // for a fresh host to reconnect instead of writing into a dead socket.
        let pending = self.pending.clone();
        let writer_slot = self.writer.clone();
        thread::spawn(move || {
            loop {
                let resp: Option<BridgeResp> = match bridge_read(&mut reader) {
                    Ok(r) => r,
                    Err(e) => {
                        log_warn!("session", "bridge read error: {e}");
                        break;
                    }
                };
                let resp = match resp {
                    Some(r) => r,
                    None => {
                        log_info!("session", "native host disconnected");
                        break;
                    }
                };
                // The first line after hello is a real response. (Hello itself
                // was consumed above and is a Value, not a BridgeResp, so it
                // can't reach here.)
                let tx = pending.lock().unwrap().remove(&resp.id);
                if let Some(tx) = tx {
                    let _ = tx.send(resp);
                } else {
                    log_warn!("session", "no pending caller for id {}", resp.id);
                }
            }
            // Reader ended (disconnect / error): drop the writer so callers
            // block-and-wait for the next host connection rather than writing
            // into a dead socket.
            *writer_slot.lock().unwrap() = None;
        });

        Ok(())
    }

    /// Send a request to the extension and wait for the correlated response.
    /// Returns the response data on success, or a typed [`CallError`].
    pub fn call(&self, op: &str, tab_id: Option<i64>, args: Value) -> Result<Value, CallError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = BridgeReq {
            id,
            op: op.to_string(),
            tab_id,
            args,
        };

        // Register the one-shot receiver BEFORE sending, to avoid a race
        // where the response arrives before we're listening.
        let (tx, rx) = mpsc::channel::<BridgeResp>();
        self.pending.lock().unwrap().insert(id, tx);

        // If the native host hasn't connected yet, wait briefly for it. The
        // extension's service worker reconnects on a ~2s timer; right after
        // the MCP client spawns a fresh MCP server, the first tool call can arrive
        // before the host has re-established its bridge connection. Waiting
        // here (rather than failing instantly) makes startup robust.
        if self.writer.lock().unwrap().is_none() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
            while std::time::Instant::now() < deadline {
                if self.writer.lock().unwrap().is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }

        // Send. If still no connection, error with a clear hint.
        {
            let mut guard = self.writer.lock().unwrap();
            let writer = match guard.as_mut() {
                Some(w) => w,
                None => {
                    // Clean up the pending entry on failure.
                    self.pending.lock().unwrap().remove(&id);
                    return Err(CallError::NotConnected);
                }
            };
            if let Err(e) = bridge_write(writer, &req) {
                self.pending.lock().unwrap().remove(&id);
                return Err(CallError::Write(e));
            }
        }

        // Wait for the response. Generous timeout: the extension may need to
        // prompt the user (Toast) for high-risk actions, which can take a
        // while.
        let timeout = Duration::from_secs(120);
        match rx.recv_timeout(timeout) {
            Ok(resp) => {
                if resp.ok {
                    Ok(resp.data.unwrap_or(Value::Null))
                } else {
                    Err(CallError::Extension(
                        resp.error.unwrap_or_else(|| "unknown error".into()),
                    ))
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().remove(&id);
                Err(CallError::Timeout(timeout))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.pending.lock().unwrap().remove(&id);
                Err(CallError::Disconnected)
            }
        }
    }
}
