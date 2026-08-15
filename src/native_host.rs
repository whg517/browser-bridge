//! Native-host mode: the `--native-host` subprocess spawned by Chrome.
//!
//! It is intentionally dumb. Two threads:
//! - stdin -> TCP: read native-messaging frames, forward each JSON value as an
//!   NDJSON line over the bridge socket.
//! - TCP -> stdout: read NDJSON lines from the bridge socket, frame each as a
//!   native-messaging message on stdout.
//!
//! All real logic lives in the MCP server on the other side of the socket.
//! EOF on stdin (Chrome disconnected) is our shutdown signal.

use std::io::{self, BufRead, BufReader, BufWriter};
use std::thread;
use std::time::Duration;

use crate::ipc;
use crate::protocol::{bridge_write, nm_read_frame, nm_write_frame};
use serde_json::Value;

/// Poll for the MCP server until it appears. Returns only on success; the stdin
/// reader thread owns every exit path, so a host whose port Chrome has closed
/// dies there rather than looping forever.
///
/// The interval is a compromise: short enough that starting an MCP client feels
/// instant, long enough that an idle browser session costs nothing measurable.
/// `ipc::connect` clears a stale lock file itself, so a crashed server is
/// recovered from on the next tick.
fn connect_waiting() -> std::net::TcpStream {
    const RETRY: Duration = Duration::from_millis(500);
    let mut logged = false;
    loop {
        match ipc::connect() {
            Ok(s) => return s,
            Err(e) => {
                if !logged {
                    // Log once, not every tick: this is the normal state while
                    // the user has not started their MCP client yet.
                    log_info!("native-host", "waiting for MCP server ({e})");
                    logged = true;
                }
                thread::sleep(RETRY);
            }
        }
    }
}

pub fn run() -> i32 {
    // Read stdin from the very start, BEFORE the bridge is up, buffering frames
    // until it is. Two reasons, both learned the hard way:
    //
    // 1. Chrome closes our stdin when the extension drops the port. If we only
    //    started reading after connecting, a host waiting for a server that
    //    never arrives would never notice and would linger as a zombie.
    // 2. The extension posts its announce frame immediately on connect
    //    (shared/announce.ts). Waiting to read would drop it, and the server
    //    would treat a known extension as an unknown legacy one.
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    thread::spawn(move || {
        let mut stdin = io::stdin();
        loop {
            match nm_read_frame(&mut stdin) {
                Ok(Some(v)) => {
                    if tx.send(v).is_err() {
                        break; // bridge side gone; that thread owns the exit
                    }
                }
                Ok(None) => {
                    log_info!("native-host", "stdin EOF, shutting down");
                    std::process::exit(0);
                }
                Err(e) => {
                    log_warn!("native-host", "stdin read error: {e}");
                    std::process::exit(0);
                }
            }
        }
    });

    // Wait for the MCP server rather than exiting when it is not up yet.
    //
    // Exiting immediately (the old behaviour) closed the port, and closing the
    // port is what let Chrome recycle the extension's service worker — which is
    // the whole reason a wake alarm was needed at all. `connectNative()` keeps a
    // service worker alive for as long as the port is open, so a host that WAITS
    // keeps the extension resident and reconnects the instant a server appears,
    // instead of the extension polling every 30s and spawning a host each time
    // only for it to fail and exit.
    //
    // The alarm stays as a backstop for what this cannot cover: the host
    // crashing, Chrome tearing it down, or the extension being reloaded.
    //
    // Cost: one idle process per browser session, sleeping between cheap lock
    // file checks. That is strictly less than a service-worker wake plus a
    // process spawn every 30 seconds. Chrome bounds its lifetime for us — when
    // the browser closes or the extension unloads, stdin hits EOF above.
    let stream = connect_waiting();
    log_info!("native-host", "connected to MCP server bridge socket");

    let stream_clone = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            log_error!("native-host", "clone stream: {e}");
            return 1;
        }
    };

    // Shutdown policy: the native host has no useful work to do if EITHER
    // direction of the bridge breaks. When Chrome closes the port (stdin EOF)
    // we must exit; when the MCP server drops our TCP connection (e.g. a new
    // server instance supplanted the old one) we ALSO must exit promptly, so
    // that Chrome observes the port closing and the extension reconnects
    // against the freshly-written lock file.
    //
    // Earlier code tried to coordinate the two threads with a channel and
    // joined both handles. That deadlocks when the TCP side dies: the stdin
    // thread is blocked inside nm_read_frame waiting for a frame that Chrome
    // (still alive) will never send, so the join never returns. The process
    // lingers as a zombie holding an open stdin/stdout pair, which means the
    // extension's onDisconnect never fires and it never reconnects — the
    // MCP server's tool calls then report "extension not connected".
    //
    // Fix: let whichever thread finishes first terminate the whole process.
    // process::exit runs no destructors, but our writers flush after every
    // frame, so no buffered data is lost on the normal close paths.
    let tcp_out = stream;

    // Thread A: buffered stdin frames -> TCP.
    //
    // Reads from the channel the stdin thread fills, not from stdin directly:
    // by the time we get here that thread has been running since before the
    // bridge came up, so anything Chrome sent while we were waiting (notably the
    // extension's announce) is already queued and gets flushed in order.
    thread::spawn(move || {
        let mut tcp = BufWriter::new(tcp_out);
        for frame in rx {
            if let Err(e) = bridge_write(&mut tcp, &frame) {
                log_warn!("native-host", "tcp write error: {e}");
                break;
            }
        }
        // The channel closing means the stdin thread is gone, which only happens
        // on a path that already exits. A write error means the bridge is dead
        // and this process has nothing left to do either.
        log_debug!("native-host", "frame->TCP thread ending; exiting process");
        std::process::exit(0);
    });

    // Thread B: TCP -> stdout. This thread is the main one; if IT exits we
    // simply fall through to the return below (which also ends the process).
    let stdout = io::stdout();
    let out_handle = thread::spawn(move || {
        let tcp_in = BufReader::new(stream_clone);
        let mut lines = tcp_in.lines();
        // stdout must be flushed after every frame; acquire a single locked,
        // buffered writer for the whole thread (single-writer discipline).
        let mut out = BufWriter::new(stdout.lock());
        loop {
            // The first line is the hello/auth. Bridge the rest verbatim,
            // since the MCP server only cares about JSON values.
            let line = match lines.next() {
                Some(Ok(l)) => l,
                Some(Err(e)) => {
                    log_warn!("native-host", "tcp read error: {e}");
                    break;
                }
                None => {
                    log_info!("native-host", "tcp EOF");
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    log_warn!("native-host", "tcp line not json: {e}");
                    continue;
                }
            };
            // Skip the hello line (auth) — it never goes to Chrome.
            if value.get("hello").is_some() {
                continue;
            }
            if let Err(e) = nm_write_frame(&mut out, &value) {
                log_warn!("native-host", "stdout write error: {e}");
                break;
            }
        }
        log_debug!("native-host", "TCP->stdout thread ending");
    });

    // Block until the TCP->stdout thread ends. The stdin->TCP thread will
    // have already called process::exit(0) on its own close path; if it
    // hasn't, we exit here once the TCP side closes.
    let _ = out_handle.join();
    log_debug!("native-host", "exit");
    std::process::exit(0);
}
