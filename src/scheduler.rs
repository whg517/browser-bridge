//! Mutation scheduling, v2 (ADR-0028 Phase 2): one mutation per TAB at a
//! time, across all brokered clients.
//!
//! Phase 1b serialized every mutation behind one global mutex — correct, but
//! it made two agents working in their OWN workspaces wait on each other's
//! short ops (and on each other's `page_eval`, which can run for seconds).
//! Now a mutation whose target tab is KNOWN (the extension reports the tab it
//! resolved on every response) serializes only against mutations on the SAME
//! tab; different tabs run concurrently.
//!
//! A mutation whose target is UNKNOWN is deliberately conservative: it
//! excludes everything (and waits for everything). The common case of an
//! unknown target is an agent's very first op — brief — and the pessimism is
//! cheap next to the misroute it prevents.
//!
//! Fairness is FIFO-ish via a waiter count: known-target ops wait behind a
//! pending unknown-target op, so an unknown op cannot be starved by a stream
//! of tab-targeted ones.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};

/// The live mutation scheduler. Shared across all client threads.
#[derive(Default)]
pub struct Scheduler {
    state: Mutex<State>,
    cv: Condvar,
}

#[derive(Default)]
struct State {
    /// One real mutex per tab that has an active (or queued) known-target
    /// mutation. Each mutex is leaked ONCE per distinct tab (`Box::leak`, a
    /// `Mutex<()>` is ~40 bytes) so its guard can be `'static`: a guard that
    /// borrowed from this map would be self-referential. Bounded by the
    /// distinct tabs a broker sees over its life.
    locks: HashMap<i64, &'static Mutex<()>>,
    /// Per-tab count of in-flight-or-queued known-target mutations.
    holders: HashMap<i64, usize>,
    /// Active unknown-target mutations (mutually exclusive with everything).
    wildcard: usize,
    /// Unknown-target mutations waiting for the field to clear.
    wildcard_waiting: usize,
}

impl Scheduler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Acquire the mutation slot for `tab` (`None` = unknown target). Blocks
    /// until the invariants hold; see the struct docs.
    pub fn acquire(&self, tab: Option<i64>) -> SchedulerGuard<'_> {
        match tab {
            Some(t) => {
                let lock = {
                    let mut st = self.state.lock().unwrap();
                    // Queue behind a pending unknown-target op (fairness).
                    while st.wildcard > 0 || st.wildcard_waiting > 0 {
                        st = self.cv.wait(st).unwrap();
                    }
                    *st.holders.entry(t).or_insert(0) += 1;
                    *st.locks
                        .entry(t)
                        .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))))
                };
                // Serializes against same-tab holders; holding the state lock
                // here would deadlock a concurrent release, so the state is
                // released above and only the tab mutex is awaited.
                let tab_guard = lock.lock().unwrap();
                SchedulerGuard {
                    sched: self,
                    tab: Some(t),
                    _tab_guard: Some(tab_guard),
                }
            }
            None => {
                let mut st = self.state.lock().unwrap();
                st.wildcard_waiting += 1;
                while st.wildcard > 0 || !st.holders.is_empty() {
                    st = self.cv.wait(st).unwrap();
                }
                st.wildcard_waiting -= 1;
                st.wildcard += 1;
                drop(st);
                SchedulerGuard {
                    sched: self,
                    tab: None,
                    _tab_guard: None,
                }
            }
        }
    }
}

/// RAII slot from [`Scheduler::acquire`].
pub struct SchedulerGuard<'a> {
    sched: &'a Scheduler,
    tab: Option<i64>,
    // Held for the guard's lifetime; declared last so it drops AFTER the
    // bookkeeping in `drop` has released the scheduler state. `'static`
    // because the mutex is the leaked per-tab lock, not a map entry.
    _tab_guard: Option<std::sync::MutexGuard<'static, ()>>,
}

impl Drop for SchedulerGuard<'_> {
    fn drop(&mut self) {
        let mut st = self.sched.state.lock().unwrap();
        match self.tab {
            Some(t) => {
                if let Some(h) = st.holders.get_mut(&t) {
                    *h -= 1;
                    if *h == 0 {
                        st.holders.remove(&t);
                    }
                }
            }
            None => st.wildcard -= 1,
        }
        drop(st);
        // `_tab_guard` (if any) drops after the state lock is released.
        self.sched.cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    type Shared = std::sync::Arc<Scheduler>;

    #[test]
    fn same_tab_mutations_serialize() {
        let s: Shared = std::sync::Arc::new(Scheduler::new());
        let g1 = s.acquire(Some(1));
        let sc = s.clone();
        let (tx, rx) = mpsc::channel();
        let h = std::thread::spawn(move || {
            let g2 = sc.acquire(Some(1));
            tx.send("acquired").unwrap();
            drop(g2);
        });
        // The second same-tab mutation must NOT get in while the first holds.
        assert!(rx.recv_timeout(Duration::from_millis(80)).is_err());
        drop(g1);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "acquired");
        h.join().unwrap();
    }

    #[test]
    fn different_tabs_run_concurrently() {
        let s: Shared = std::sync::Arc::new(Scheduler::new());
        let g1 = s.acquire(Some(1));
        let done = std::sync::Arc::new(AtomicBool::new(false));
        let seen = done.clone();
        let sc = s.clone();
        let h = std::thread::spawn(move || {
            let g2 = sc.acquire(Some(2));
            seen.store(true, Ordering::SeqCst);
            drop(g2);
        });
        std::thread::sleep(Duration::from_millis(60));
        assert!(
            done.load(Ordering::SeqCst),
            "a different tab must not wait on tab 1"
        );
        h.join().unwrap();
        drop(g1);
    }

    #[test]
    fn unknown_target_excludes_known_and_vice_versa() {
        let s: Shared = std::sync::Arc::new(Scheduler::new());
        // Known held -> unknown waits.
        let g1 = s.acquire(Some(1));
        let sc = s.clone();
        let (tx, rx) = mpsc::channel();
        let h = std::thread::spawn(move || {
            let g = sc.acquire(None);
            tx.send("wildcard").unwrap();
            drop(g);
        });
        assert!(rx.recv_timeout(Duration::from_millis(80)).is_err());
        drop(g1);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "wildcard");
        h.join().unwrap();

        // Unknown held -> known waits (both tabs).
        let gw = s.acquire(None);
        let done = std::sync::Arc::new(AtomicBool::new(false));
        let seen = done.clone();
        let sc = s.clone();
        let h = std::thread::spawn(move || {
            let g = sc.acquire(Some(5));
            seen.store(true, Ordering::SeqCst);
            drop(g);
        });
        std::thread::sleep(Duration::from_millis(60));
        assert!(!done.load(Ordering::SeqCst));
        drop(gw);
        h.join().unwrap();
        assert!(done.load(Ordering::SeqCst));
    }

    #[test]
    fn queued_unknown_op_wins_over_later_known_ops() {
        // Fairness: once an unknown-target op is WAITING, later known-target
        // ops queue behind it instead of starving it.
        let s: Shared = std::sync::Arc::new(Scheduler::new());
        let g1 = s.acquire(Some(1));
        let (tx_w, rx_w) = mpsc::channel();
        let waiter = s.clone();
        let hw = std::thread::spawn(move || {
            let g = waiter.acquire(None); // waits for g1
            tx_w.send("wildcard-acquired").unwrap();
            drop(g);
        });
        // Let the unknown op register itself as waiting.
        std::thread::sleep(Duration::from_millis(80));

        let (tx_k, rx_k) = mpsc::channel();
        let known = s.clone();
        let hk = std::thread::spawn(move || {
            let g = known.acquire(Some(2));
            tx_k.send("known-acquired").unwrap();
            drop(g);
        });
        drop(g1); // release the field
                  // The unknown op goes first; the later known op proceeds after it.
        assert_eq!(
            rx_w.recv_timeout(Duration::from_secs(2)).unwrap(),
            "wildcard-acquired"
        );
        assert_eq!(
            rx_k.recv_timeout(Duration::from_secs(2)).unwrap(),
            "known-acquired"
        );
        hw.join().unwrap();
        hk.join().unwrap();
    }
}
