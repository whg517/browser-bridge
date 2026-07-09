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

use crate::ipc;
use crate::protocol::{bridge_write, nm_read_frame, nm_write_frame};
use serde_json::Value;

pub fn run() -> i32 {
    // Connect to the MCP server's localhost TCP socket (reads the lock file).
    let stream = match ipc::connect() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[native-host] cannot connect to MCP server: {e}");
            // No way to talk to Chrome usefully without the server; exit so
            // the extension sees onDisconnect and can surface the error.
            return 1;
        }
    };
    eprintln!("[native-host] connected to MCP server bridge socket");

    let stream_clone = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[native-host] clone stream: {e}");
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

    // Thread A: stdin -> TCP
    thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut tcp = BufWriter::new(tcp_out);
        loop {
            let frame: Option<Value> = match nm_read_frame(&mut stdin) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[native-host] stdin read error: {e}");
                    break;
                }
            };
            let frame = match frame {
                Some(v) => v,
                None => {
                    // EOF on stdin: Chrome disconnected. Canonical shutdown.
                    eprintln!("[native-host] stdin EOF, shutting down");
                    break;
                }
            };
            if let Err(e) = bridge_write(&mut tcp, &frame) {
                eprintln!("[native-host] tcp write error: {e}");
                break;
            }
        }
        // Either side breaking means this process is done. Exit immediately so
        // Chrome tears down the port and the extension reconnects.
        eprintln!("[native-host] stdin->TCP thread ending; exiting process");
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
                    eprintln!("[native-host] tcp read error: {e}");
                    break;
                }
                None => {
                    eprintln!("[native-host] tcp EOF");
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[native-host] tcp line not json: {e}");
                    continue;
                }
            };
            // Skip the hello line (auth) — it never goes to Chrome.
            if value.get("hello").is_some() {
                continue;
            }
            if let Err(e) = nm_write_frame(&mut out, &value) {
                eprintln!("[native-host] stdout write error: {e}");
                break;
            }
        }
        eprintln!("[native-host] TCP->stdout thread ending");
    });

    // Block until the TCP->stdout thread ends. The stdin->TCP thread will
    // have already called process::exit(0) on its own close path; if it
    // hasn't, we exit here once the TCP side closes.
    let _ = out_handle.join();
    eprintln!("[native-host] exit");
    std::process::exit(0);
}
