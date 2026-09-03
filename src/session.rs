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
//! ## Generation-guarded connection
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
//!
//! ## Peer announce
//!
//! The first frame a connection carries may be the extension's announce (see
//! [`crate::peer`]). The reader intercepts it instead of routing it, records the
//! peer's version, and — when it disagrees with this binary's — arms a one-shot
//! advisory that the MCP layer attaches to the next tool result. Both are scoped
//! to the connection: a reconnect re-announces and re-arms.

use std::collections::HashMap;
use std::io::{self, BufReader, BufWriter};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::error::CallError;
use crate::ipc;
use crate::peer::{self, PeerInfo, ANNOUNCE_ID};
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
    /// Set once the first tool call has been made. Only that call waits the long
    /// window for a sleeping service worker to wake — see [`Session::call`].
    warmed: Arc<AtomicBool>,
    /// What the currently-connected extension announced about itself, paired
    /// with the generation that announced it. Cleared when that generation's
    /// reader ends, so a stale peer version can never outlive its connection.
    peer: Arc<Mutex<Option<(u64, PeerInfo)>>>,
    /// A version-drift advisory waiting to be attached to the next tool result.
    /// Armed once per announce, taken once — see [`Session::take_advisory`].
    advisory: Arc<Mutex<Option<String>>>,
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
            warmed: Arc::new(AtomicBool::new(false)),
            peer: Arc::new(Mutex::new(None)),
            advisory: Arc::new(Mutex::new(None)),
        }
    }

    /// What the connected extension announced about itself, if anything. `None`
    /// when no host is attached, or when the extension predates the announce
    /// frame (in which case it is simply treated as legacy).
    pub fn peer(&self) -> Option<PeerInfo> {
        self.peer.lock().unwrap().as_ref().map(|(_, p)| p.clone())
    }

    /// Take the pending version-drift advisory, leaving none behind.
    ///
    /// One-shot **per connection**, deliberately. Repeating it on every tool call
    /// would flood the transcript and teach the agent to skip past it; saying it
    /// once, on the first result after the extension announces, puts it where
    /// the model is already reading. A reconnect re-announces and therefore
    /// re-arms it, which is right — that is a genuinely new pairing.
    pub fn take_advisory(&self) -> Option<String> {
        self.advisory.lock().unwrap().take()
    }

    /// Record an announce for `generation` and arm the drift advisory if the
    /// peer's version disagrees with ours.
    fn record_announce(&self, generation: u64, info: PeerInfo) {
        self.record_announce_against(peer::HOST_VERSION, generation, info)
    }

    /// [`Self::record_announce`] with the host version injected.
    ///
    /// Split out from the reader thread so the policy is unit-testable without
    /// sockets, and parameterized on the host version because the real one is
    /// whatever this build was stamped as — in the ordinary `0.0.0` dev build
    /// (ADR-0026) *every* comparison is deliberately silent, so a test pinned to
    /// `HOST_VERSION` could never observe an armed advisory.
    pub(crate) fn record_announce_against(
        &self,
        host_version: &str,
        generation: u64,
        info: PeerInfo,
    ) {
        log_info!(
            "session",
            "generation {generation}: {}",
            peer::describe(&info)
        );
        // Assigned unconditionally: a reconnect to a now-matching extension must
        // *disarm* an advisory left over from the previous connection.
        let advisory = peer::drift_advisory(host_version, &info);
        if let Some(msg) = &advisory {
            log_warn!("session", "{msg}");
        }
        *self.advisory.lock().unwrap() = advisory;
        *self.peer.lock().unwrap() = Some((generation, info));
    }

    /// Take ownership of a freshly-accepted connection from the native host.
    /// The CALLER has already read the hello line (the broker must see the
    /// role before deciding where the connection goes), and passes it in
    /// along with the reader positioned after it. Replaces any previous
    /// connection (the old one is dropped/closed). Spawns a reader thread
    /// that dispatches BridgeResp by id.
    ///
    /// Only `native-host` clients may attach: an `mcp-server` hello on this
    /// slot would let a thin server drive the extension directly, bypassing
    /// the broker's clientId stamping — exactly what the grant-based id
    /// scheme (ADR-0028 Phase 1b) exists to prevent.
    pub fn attach_connection(
        &self,
        stream: TcpStream,
        mut reader: BufReader<TcpStream>,
        hello: Value,
    ) -> io::Result<()> {
        let role_ok = matches!(ipc::hello_role(&hello), Some(ipc::HelloRole::NativeHost));
        if !role_ok {
            log_warn!(
                "session",
                "rejected inbound connection: bad hello, or a non-host role on the extension slot"
            );
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
        let session = self.clone();
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
                // The extension's announce rides in on the reserved id 0 (see
                // crate::peer for why it wears the BridgeResp envelope). Consume
                // it here rather than routing it: id 0 is never a request id, so
                // routing would only log "no pending caller" and throw the
                // version away.
                if resp.id == ANNOUNCE_ID {
                    if let Some(info) = peer::parse_announce(resp.data.as_ref()) {
                        session.record_announce(my_gen, info);
                        continue;
                    }
                }
                // Otherwise a real response. (Hello itself was consumed above
                // and is a Value, not a BridgeResp, so it can't reach here.)
                // Ids are globally unique (a single monotonic counter), so
                // routing by id alone never cross-wires connections. This path
                // locks only the pending mutex, which is compatible with the
                // conn→pending ordering used elsewhere.
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
            // 3. Forget what this connection told us about itself, under the
            //    same generation guard: a newer host may already have announced,
            //    and its version must survive our teardown. An un-taken advisory
            //    dies with the connection it described.
            {
                let mut peer_guard = session.peer.lock().unwrap();
                if peer_guard.as_ref().map(|(gen, _)| *gen) == Some(my_gen) {
                    *peer_guard = None;
                    *session.advisory.lock().unwrap() = None;
                }
            }
            // Senders drop here (locks already released), unblocking callers.
            drop(drained);
        });

        Ok(())
    }

    /// The generation id of the currently-attached connection, if any.
    ///
    /// Returns `Some(generation)` while a native host is connected, or `None`
    /// when the slot is empty (never connected, or between reconnects). Used by
    /// the MCP server to tag audit lines so operators can correlate a tool call
    /// with the specific connection it ran over, across reconnects. Just a lock
    /// and a map — non-blocking and cheap.
    pub fn current_generation(&self) -> Option<u64> {
        self.conn.lock().unwrap().as_ref().map(|c| c.generation)
    }

    /// Send a request to the extension and wait for the correlated response.
    /// Returns the response data on success, or a typed [`CallError`].
    /// Send a request to the extension and wait for the correlated response.
    ///
    /// `client` is the broker-granted client label (`c1:claude-code`) stamped
    /// onto the BridgeReq envelope so the extension can scope per agent and
    /// the audit can name the actor; `None` on the single-process paths.
    ///
    /// Before anything is sent, the version handshake gates the call: a peer
    /// that ANNOUNCED a different protocol version gets PROTOCOL_MISMATCH —
    /// with clientId on the envelope, a cross-version pairing misroutes ops
    /// rather than degrading (ADR-0028 Phase 1b). A peer that announces
    /// nothing predates the announce frame and keeps the soft advisory.
    pub fn call(
        &self,
        op: &str,
        tab_id: Option<i64>,
        args: Value,
        client: Option<&str>,
    ) -> Result<Value, CallError> {
        if let Some((_, info)) = self.peer.lock().unwrap().as_ref() {
            if let Some(peer_v) = info
                .protocol_version
                .filter(|v| *v != peer::PROTOCOL_VERSION)
            {
                return Err(CallError::ProtocolMismatch {
                    peer: peer_v,
                    ours: peer::PROTOCOL_VERSION,
                });
            }
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = BridgeReq {
            id,
            op: op.to_string(),
            tab_id,
            client_id: client.map(str::to_string),
            args,
        };

        // Register the one-shot receiver BEFORE sending, to avoid a race where
        // the response arrives before we're listening. The generation is not
        // known yet (the connection may still be reconnecting), so tag the entry
        // with the UNSENT sentinel; it is rewritten to the real generation under
        // the conn lock just before the write. A reader draining a real
        // generation (>= 1) will never touch this sentinel entry.
        // Refuse an oversized request here, before it is registered or sent.
        // The host would otherwise reject it at the framing layer and treat that
        // as a fatal write error, dropping the whole connection — the client got
        // CONNECTION_LOST (retryable) for one malformed call and would sensibly
        // retry it into the same failure. Measured: a 0.9 MB page_fill goes
        // through, 1.2 MB took the bridge down.
        //
        // The length measured here is the length the host will frame: it
        // forwards the parsed value verbatim, and serde_json emits the same
        // bytes for the same keys and values.
        match serde_json::to_vec(&req) {
            Ok(encoded) if encoded.len() > crate::protocol::NM_MAX_OUTGOING => {
                return Err(CallError::PayloadTooLarge {
                    bytes: encoded.len(),
                });
            }
            Ok(_) => {}
            // Unserializable args are not a size problem; let the normal path
            // surface whatever it surfaces rather than guessing here.
            Err(_) => {}
        }

        let (tx, rx) = mpsc::channel::<BridgeResp>();
        self.pending
            .lock()
            .unwrap()
            .insert(id, (UNSENT_GENERATION, tx));

        // If the native host hasn't connected yet, wait for it rather than failing
        // instantly. Right after the MCP client spawns a fresh server, the first
        // tool call routinely arrives before the extension has re-established the
        // bridge.
        //
        // The FIRST call of a server's life gets a longer window than the rest.
        // At that point the extension's service worker is usually asleep — MV3
        // stops it after ~30s idle, and the user was typing their prompt, not
        // browsing — so it has to be woken by its own alarm before it can
        // connect. Measured against Chrome 150 with no browser interaction, that
        // wake took 1.4s to 21.5s across six runs, so 12s left roughly a third of
        // first calls failing. 30s covers the observed spread with margin.
        //
        // Later calls keep the short window on purpose: by then a connection has
        // either been seen (so the extension is healthy and a drop is transient)
        // or the environment is genuinely broken — Chrome closed, extension
        // removed — and blocking every subsequent call for 30s would turn one
        // clear failure into a very slow one.
        let first_call = !self.warmed.swap(true, Ordering::SeqCst);
        if self.conn.lock().unwrap().is_none() {
            let wait = if first_call { 30 } else { 12 };
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait);
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

        // Wait for the response. Generous timeout: a page op (navigation,
        // waiting on a selector, a slow render) can take a while.
        let timeout = Duration::from_secs(120);
        match rx.recv_timeout(timeout) {
            Ok(resp) => {
                if resp.ok {
                    Ok(resp.data.unwrap_or(Value::Null))
                } else {
                    Err(CallError::Extension {
                        code: resp.code,
                        message: resp.error.unwrap_or_else(|| "unknown error".into()),
                    })
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

    // Only the first call gets the long wait. Later calls must not, or a broken
    // environment (Chrome closed, extension removed) would block every single
    // call for 30s instead of failing once, clearly.
    #[test]
    fn only_the_first_call_takes_the_long_wait() {
        let session = Session::new();
        assert!(
            !session.warmed.swap(true, Ordering::SeqCst),
            "first call is the long one"
        );
        assert!(
            session.warmed.swap(true, Ordering::SeqCst),
            "every later call is short"
        );
        assert!(session.warmed.load(Ordering::SeqCst));
        // A fresh session starts over — each server process gets one long wait.
        assert!(!Session::new().warmed.load(Ordering::SeqCst));
    }

    #[test]
    fn fresh_session_reports_no_generation() {
        // A brand-new session has no attached connection, so there is no
        // generation to report. (Attaching a real connection needs a socket,
        // which is intentionally out of scope for this unit test.)
        let session = Session::new();
        assert_eq!(session.current_generation(), None);
        // Same via Default, which just forwards to `new`.
        assert_eq!(Session::default().current_generation(), None);
    }

    fn peer_at(version: &str) -> PeerInfo {
        PeerInfo {
            version: Some(version.to_string()),
            ..Default::default()
        }
    }

    // Announcing a version that disagrees with ours records the peer AND arms
    // exactly one advisory: the model must be told, but only once per pairing.
    #[test]
    fn announce_records_the_peer_and_arms_one_advisory() {
        let session = Session::new();
        assert!(session.peer().is_none());
        assert!(session.take_advisory().is_none());

        session.record_announce_against("0.2.0", 1, peer_at("0.1.0"));
        assert_eq!(
            session.peer().and_then(|p| p.version).as_deref(),
            Some("0.1.0")
        );

        let msg = session.take_advisory().expect("drift is advised");
        assert!(msg.contains("0.1.0") && msg.contains("0.2.0"), "{msg}");
        assert!(
            session.take_advisory().is_none(),
            "the advisory must be one-shot"
        );
    }

    // A matching version is recorded but says nothing — and, critically, must
    // clear any advisory left armed by a previous connection, or a reconnect to
    // a now-matching extension would keep nagging forever.
    #[test]
    fn matching_announce_records_but_disarms() {
        let session = Session::new();
        session.record_announce_against("0.2.0", 1, peer_at("0.1.0"));
        session.record_announce_against("0.2.0", 2, peer_at("0.2.0"));
        assert!(session.peer().is_some());
        assert!(session.take_advisory().is_none());
    }

    // The real entry point still works end to end; in a 0.0.0 dev build the
    // policy is silent by design, which is exactly what this asserts.
    #[test]
    fn record_announce_uses_the_built_in_host_version() {
        let session = Session::new();
        session.record_announce(1, peer_at(crate::peer::HOST_VERSION));
        assert!(session.peer().is_some());
        assert!(session.take_advisory().is_none());
    }

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
        // the clobber the generation guard fixes).
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
