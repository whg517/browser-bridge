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
//!
//! ## Generation-guarded connection (RFC-0001)
//!
//! Each accepted connection is stamped with a monotonic `generation` id. The
//! live writer is stored together with the generation that owns it ([`Conn`]),
//! so a stale reader thread can only tear down *its own* connection: on
//! disconnect it clears the slot **only if** the slot still holds its
//! generation. If a newer host already attached in the race window, the old
//! reader leaves the live connection untouched instead of clobbering it.
//!
//! Pending requests are likewise tagged with the generation they were sent
//! under. When a reader for generation `G` exits, it drains (drops) every
//! pending sender tagged `G`, so those callers fail fast with
//! [`CallError::Disconnected`] instead of waiting the full 120s timeout.
//! Newer-generation pending entries survive.

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

/// The live connection to the native host, paired with the generation id that
/// owns it. Storing the generation alongside the writer makes cleanup atomic
/// under the connection mutex: a reader can compare its own generation against
/// whatever currently occupies the slot before touching it.
struct Conn {
    generation: u64,
    writer: BufWriter<TcpStream>,
}

/// Pending request callbacks keyed by `BridgeReq.id`. Each entry carries the
/// generation it was sent under, so a disconnecting reader can drop exactly the
/// callers that belonged to its (now-dead) connection.
type Pending = Arc<Mutex<HashMap<u64, (u64, mpsc::Sender<BridgeResp>)>>>;

/// Sentinel generation for a pending entry that has been registered but not yet
/// bound to a live connection (see [`Session::call`]). Real generations start
/// at 1, so a reader draining generation `G >= 1` can never accidentally drop a
/// not-yet-sent pending entry.
const UNSENT_GENERATION: u64 = 0;

/// Decide whether a reader thread owning `my_gen` should clear the connection
/// slot on disconnect. Clear **only** when the slot still holds *my* generation;
/// a newer connection (or an already-empty slot) must be left untouched. This is
/// the core of the anti-clobber fix and is unit-tested directly.
fn should_clear_conn(current: Option<u64>, my_gen: u64) -> bool {
    current == Some(my_gen)
}

/// Remove and return every pending entry whose generation matches `my_gen`.
/// Dropping the returned senders wakes those callers immediately with a closed
/// channel (surfaced as [`CallError::Disconnected`]). Entries tagged with any
/// other generation — including newer, still-live connections — are left in the
/// map. Factored out so the drain policy is unit-testable without sockets.
fn drain_pending_for_generation(
    pending: &mut HashMap<u64, (u64, mpsc::Sender<BridgeResp>)>,
    my_gen: u64,
) -> Vec<mpsc::Sender<BridgeResp>> {
    let ids: Vec<u64> = pending
        .iter()
        .filter(|(_, (gen, _))| *gen == my_gen)
        .map(|(id, _)| *id)
        .collect();
    ids.into_iter()
        .map(|id| pending.remove(&id).expect("id just enumerated").1)
        .collect()
}

/// Shared session. Cheap to clone — everything is behind Arc.
#[derive(Clone)]
pub struct Session {
    /// The currently-connected native host (if any), paired with its
    /// generation. Wrapped so the MCP thread can swap it when a new host
    /// connects and so a reader can atomically decide whether to clear it.
    conn: Arc<Mutex<Option<Conn>>>,
    /// Pending request callbacks keyed by BridgeReq.id, tagged by generation.
    pending: Pending,
    next_id: Arc<AtomicU64>,
    /// Monotonic per-connection generation counter. Starts at 1 so that
    /// generation 0 is reserved as the [`UNSENT_GENERATION`] sentinel.
    next_gen: Arc<AtomicU64>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Session {
            conn: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            next_gen: Arc::new(AtomicU64::new(1)),
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

        // Allocate this connection's generation before publishing the writer, so
        // the writer and its owning generation are installed together.
        let my_gen = self.next_gen.fetch_add(1, Ordering::SeqCst);
        log_info!(
            "session",
            "native host connected and authenticated (generation {my_gen})"
        );

        // Store the writer half together with its generation.
        let writer = BufWriter::new(stream);
        *self.conn.lock().unwrap() = Some(Conn {
            generation: my_gen,
            writer,
        });

        // Spawn the reader: each BridgeResp routes to its pending sender. The
        // reader is bound to `my_gen`; on disconnect it only tears down the
        // connection it actually owns.
        let pending = self.pending.clone();
        let conn_slot = self.conn.clone();
        thread::spawn(move || {
            loop {
                let resp: Option<BridgeResp> = match bridge_read(&mut reader) {
                    Ok(r) => r,
                    Err(e) => {
                        log_warn!("session", "bridge read error (generation {my_gen}): {e}");
                        break;
                    }
                };
                let resp = match resp {
                    Some(r) => r,
                    None => {
                        log_info!("session", "native host disconnected (generation {my_gen})");
                        break;
                    }
                };
                // The first line after hello is a real response. (Hello itself
                // was consumed above and is a Value, not a BridgeResp, so it
                // can't reach here.) Ids are globally unique (a single monotonic
                // counter), so routing by id alone never cross-wires
                // connections. This path locks only the pending mutex, which is
                // compatible with the conn→pending ordering used elsewhere.
                let entry = pending.lock().unwrap().remove(&resp.id);
                if let Some((_gen, tx)) = entry {
                    let _ = tx.send(resp);
                } else {
                    log_warn!("session", "no pending caller for id {}", resp.id);
                }
            }

            // Reader ended (disconnect / error). Under a consistent lock order
            // (conn mutex THEN pending mutex):
            //   1. Clear the connection slot, but ONLY if it still holds our
            //      generation — a newer host may have already replaced us in the
            //      race window, and clobbering it would leave `call` wrongly
            //      returning NotConnected against a healthy connection.
            //   2. Drop every pending sender tagged with our generation so those
            //      in-flight callers fail fast with `Disconnected` instead of
            //      blocking for the full 120s timeout. Newer-generation pending
            //      is left untouched.
            let drained = {
                let mut conn_guard = conn_slot.lock().unwrap();
                let current = conn_guard.as_ref().map(|c| c.generation);
                if should_clear_conn(current, my_gen) {
                    *conn_guard = None;
                }
                let mut pending_guard = pending.lock().unwrap();
                drain_pending_for_generation(&mut pending_guard, my_gen)
            };
            // Senders drop here (locks already released), unblocking callers.
            drop(drained);
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

        // Register the one-shot receiver BEFORE sending, to avoid a race where
        // the response arrives before we're listening. The generation is not
        // known yet (the connection may still be reconnecting), so tag the entry
        // with the UNSENT sentinel; it is rewritten to the real generation under
        // the conn lock just before the write. A reader draining a real
        // generation (>= 1) will never touch this sentinel entry.
        let (tx, rx) = mpsc::channel::<BridgeResp>();
        self.pending
            .lock()
            .unwrap()
            .insert(id, (UNSENT_GENERATION, tx));

        // If the native host hasn't connected yet, wait briefly for it. The
        // extension's service worker reconnects on a ~2s timer; right after
        // the MCP client spawns a fresh MCP server, the first tool call can arrive
        // before the host has re-established its bridge connection. Waiting
        // here (rather than failing instantly) makes startup robust.
        if self.conn.lock().unwrap().is_none() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
            while std::time::Instant::now() < deadline {
                if self.conn.lock().unwrap().is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }

        // Send. If still no connection, error with a clear hint. Lock ordering
        // is always conn mutex THEN pending mutex when nesting, matching the
        // reader-cleanup path, so the two can never deadlock.
        {
            let mut guard = self.conn.lock().unwrap();
            let conn = match guard.as_mut() {
                Some(c) => c,
                None => {
                    // Clean up the pending entry on failure.
                    self.pending.lock().unwrap().remove(&id);
                    return Err(CallError::NotConnected);
                }
            };
            // Bind this pending entry to the live connection's generation so a
            // subsequent disconnect of *this* connection drains it fast.
            let generation = conn.generation;
            if let Some(entry) = self.pending.lock().unwrap().get_mut(&id) {
                entry.0 = generation;
            }
            if let Err(e) = bridge_write(&mut conn.writer, &req) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generations_are_monotonic() {
        // Mirrors the `next_gen` counter: strictly increasing, starting at 1 so
        // that 0 stays free as the UNSENT sentinel.
        let next = AtomicU64::new(1);
        let a = next.fetch_add(1, Ordering::SeqCst);
        let b = next.fetch_add(1, Ordering::SeqCst);
        let c = next.fetch_add(1, Ordering::SeqCst);
        assert_eq!((a, b, c), (1, 2, 3));
        assert!(a < b && b < c);
        assert_ne!(a, UNSENT_GENERATION);
    }

    #[test]
    fn clear_decision_only_true_when_current_matches_mine() {
        // Slot still holds my generation -> I own it, so I must clear it.
        assert!(should_clear_conn(Some(7), 7));
        // A newer connection replaced the slot -> leave it untouched (this is
        // the clobber the RFC fixes).
        assert!(!should_clear_conn(Some(8), 7));
        // An older generation must never clear a newer live slot.
        assert!(!should_clear_conn(Some(2), 5));
        // Slot already empty -> nothing to clear.
        assert!(!should_clear_conn(None, 7));
    }

    #[test]
    fn drain_drops_only_my_generation_and_wakes_those_callers() {
        let mut pending: HashMap<u64, (u64, mpsc::Sender<BridgeResp>)> = HashMap::new();
        // gen 1: two in-flight callers; gen 2: one in-flight caller on the newer
        // (still-live) connection.
        let (tx1a, rx1a) = mpsc::channel::<BridgeResp>();
        let (tx1b, rx1b) = mpsc::channel::<BridgeResp>();
        let (tx2, rx2) = mpsc::channel::<BridgeResp>();
        pending.insert(10, (1, tx1a));
        pending.insert(11, (1, tx1b));
        pending.insert(20, (2, tx2));

        let drained = drain_pending_for_generation(&mut pending, 1);
        assert_eq!(drained.len(), 2);
        // gen 1 entries removed; the newer gen 2 entry survives.
        assert!(!pending.contains_key(&10));
        assert!(!pending.contains_key(&11));
        assert!(pending.contains_key(&20));

        // Dropping the drained senders closes their channels: those callers
        // observe `Disconnected` immediately rather than waiting 120s.
        drop(drained);
        assert!(matches!(rx1a.recv(), Err(mpsc::RecvError)));
        assert!(matches!(rx1b.recv(), Err(mpsc::RecvError)));

        // The newer generation's caller is untouched: its sender is still held
        // in the map, so its receiver is merely empty (not disconnected).
        assert!(matches!(rx2.try_recv(), Err(mpsc::TryRecvError::Empty)));
    }

    #[test]
    fn drain_for_absent_generation_is_a_noop() {
        let mut pending: HashMap<u64, (u64, mpsc::Sender<BridgeResp>)> = HashMap::new();
        let (tx, _rx) = mpsc::channel::<BridgeResp>();
        pending.insert(1, (5, tx));

        let drained = drain_pending_for_generation(&mut pending, 99);
        assert!(drained.is_empty());
        // The unrelated entry is left in place.
        assert!(pending.contains_key(&1));
    }

    #[test]
    fn drain_never_touches_unsent_sentinel_entries() {
        // A pending entry that was registered but not yet sent carries the
        // UNSENT sentinel generation and must survive any real-generation drain.
        let mut pending: HashMap<u64, (u64, mpsc::Sender<BridgeResp>)> = HashMap::new();
        let (unsent_tx, unsent_rx) = mpsc::channel::<BridgeResp>();
        let (live_tx, _live_rx) = mpsc::channel::<BridgeResp>();
        pending.insert(1, (UNSENT_GENERATION, unsent_tx));
        pending.insert(2, (1, live_tx));

        let drained = drain_pending_for_generation(&mut pending, 1);
        assert_eq!(drained.len(), 1);
        assert!(pending.contains_key(&1));
        // The sentinel caller is still connected (sender retained in the map).
        assert!(matches!(
            unsent_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }
}
