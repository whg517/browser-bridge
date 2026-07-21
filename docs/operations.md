# Operations: Running and Operating browser-bridge

> This document covers how to operate browser-bridge at runtime: the two binary modes, read-only diagnostics, logging/auditing,
> the lock file, and native host reconnection. For full subcommand usage and troubleshooting "server not reachable", see
> [cli.md](./cli.md) (not repeated here); for component boundaries, see [architecture.md](./architecture.md).

## Two Binary Modes

`browser-bridge` is a single binary + subcommand dispatch (see [ADR-0001](./adr/0001-use-rust-single-binary.md)):

- **MCP server** (no arguments): the default mode, spawned by the MCP client. Listens on localhost TCP, holds session
  state, and dispatches tools. stdout carries MCP JSON-RPC.
- **native host** (`--native-host`): a thin bridge, spawned by Chrome via the wrapper. Forwards between the
  Native Messaging frames on stdin/stdout and TCP NDJSON. stdout carries NM frames.

In both modes, **stdout carries only protocol bytes**; any diagnostics go to stderr — a single stray write corrupts the frame stream
(see [trust-boundaries.md](./security/trust-boundaries.md)).

## Read-Only Diagnostics: doctor / status

`browser-bridge doctor` (aliased as `status`) is a **read-only** self-check: it does not listen on ports, write the lock file, or spawn
child processes; it only probes and prints environment and connection conclusions (version/platform, lock file port/pid, MCP server reachability,
whether the native host manifest is in place). It **performs no repairs** — it does not kill processes, delete the lock file, or restart the server.
For the meaning of each item and how to interpret "server not reachable", see [cli.md](./cli.md#doctor--status-read-only-self-check).

## Logging and Auditing: BB_LOG / BB_LOG_FORMAT

Diagnostics all go to **stderr**, and two environment variables control the output (full table in [cli.md](./cli.md#logging-and-auditing-bb_log--bb_log_format)):

- `BB_LOG`: `error` / `warn` / `info` (default) / `debug` — the log threshold.
- `BB_LOG_FORMAT`: `text` (default) / `json` — the audit line format.

**Structured audit events**: each time the MCP server handles a `tools/call`, it emits one audit line carrying, per call,
`req` (the monotonic request id), `tool`, `outcome` (`ok`/`error`), `code` (on error, the stable code from
[`errors.json`](../contracts/errors.json)), and `dur_ms`. With `BB_LOG_FORMAT=json`,
each line is a JSON object for easy machine collection. For the leveled logging design, see
[ADR-0014](./adr/0014-leveled-logging.md).

Audit lines **do not record** sensitive content (full page text, cookie/storage values, complete eval return values, form-fill values) —
redaction is done on the extension side (see [threat-model.md](./security/threat-model.md)).

> Audit lines carry both the **per-call request id** and the cross-connection **connection id** (the `conn` field,
> provided by `Session::current_generation()`), making it easy to correlate to a specific connection across reconnects.

## Lock File

The bridge socket uses a **lock file under the user directory** to publish the port and authenticate: on startup the MCP server writes
`{ port, pid, per-run secret }`, with file permissions `0600` on Unix; when the native host connects it reads the lock file,
connects to TCP, and sends `hello` using the secret. For the design, see
[ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md) and
[trust-boundaries.md](./security/trust-boundaries.md).

**Stale lock file**: a previous server that exited abnormally may leave a lock file behind (with a stale port/pid); when a new server starts it
detects and replaces it (on Windows it uses `TerminateProcess` to take over the old server, see
[architecture.md §9](./architecture.md#9-known-limitations)). `doctor` only reads the lock file and does not clean it up.

## native host Reconnection

An MV3 Service Worker is force-restarted every 5 minutes (Chromium #40733525), which closes the Port and causes the
native host to exit on stdin EOF. Reconnection is driven by the extension (see
[architecture.md §5.2](./architecture.md#52-native-host-reconnection-flow)):

```
Chrome closes extension Port → native host stdin EOF → host exits
extension onDisconnect → scheduleReconnect(2s)
after 2s connectNative() → Chrome re-spawns host → reads lock file → connects to TCP → sends hello
MCP server validate_hello → session.attach_connection(replaces old connection)
```

Session state (the current tab, ref map) lives in the MCP server process rather than the SW, so an SW restart does not lose the session;
ref markers are stamped on DOM attributes, so the content script can rebuild the refMap after a restart. Pending requests are bound to a
**connection generation**, and generation-guarded reconnection guarantees that an old connection cannot affect a new one
(see [compatibility.md](./compatibility.md)).

## See Also

- Subcommand usage and troubleshooting: [cli.md](./cli.md).
- Versioning and handshake: [compatibility.md](./compatibility.md).
- Security incident handling: [security/incident-response.md](./security/incident-response.md).
