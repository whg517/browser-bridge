# ADR-0028: Standalone Multi-Agent Broker (One Browser, N MCP Clients)

- **Status**: Accepted
- **Date**: 2026-09-01
- **Supersedes parts of**: ADR-0002 (three-process topology gains a fourth role), ADR-0018 (workspace group becomes per-agent)
- **Origin**: [#45](https://github.com/whg517/browser-bridge/issues/45) (RFC + design evaluation)

## Background

Multiple AI agents each spawn their own MCP server over stdio. Today they cannot
share the browser: `run()` unconditionally supplants the previous server
(`start_bridge(true)` reads the lock, kills the prior pid, rewrites the lock),
and `Session` holds exactly one native-host connection. The second agent's
arrival silently kills the first agent's session. Multi-agent use is an
observed need, not a hypothetical.

The lock file has no occupancy check at all — `lock.write()` is an unconditional
rename-overwrite (even the one-shot `call` mode writes it) — so "last writer
wins" is baked into the mechanism, not a policy.

## Decision

Introduce a **standalone broker process** as a new mode of the single binary
(`browser-bridge --broker`, same binary per ADR-0001). Responsibility split:

| Role | Owns | Never touches |
|---|---|---|
| MCP server (per client, stdio) | MCP JSON-RPC framing, forwarding, client info | lock, native connection, scheduling |
| Broker (one per user) | lock file, the single native-host connection, clientId assignment, multiplexing, scheduling, audit | MCP framing |
| Native host | dumb stdin↔TCP pipe (unchanged, ADR-0002) | anything else |
| Extension | policy, per-agent tab groups, scoping enforcement, confirmations | multiplexing |

### Process lifecycle

- The **first** server that finds no live broker spawns one (child process,
  spawn-and-forget: the broker outlives its spawner — Unix re-parents orphans,
  Windows child processes are not tied to the parent without a job object,
  which we deliberately do not create).
- The broker owns the lock and the native-host connection. The host is
  unchanged: it still reads `{port, secret}` from the lock and connects — the
  broker is just a longer-lived thing behind the same socket.
- **Reference counting**: each connected server is a registration; the broker
  exits after the last client disconnects, with a short linger (~30 s) so a
  client restart does not tear down the browser session.
- **Crash recovery**: the lock records the broker pid. A server that finds the
  lock's pid dead treats the lock as stale, wins it by atomic placement (see
  Phase 0), spawns a fresh broker, and the extension reconnects via the
  existing respawn loop (host dies on TCP drop → SW reconnects → reads new
  lock). No new recovery machinery is needed on the browser side.

### Wire protocol (protocol 1 → 2)

- Broker listens on **one** TCP port (the one in the lock). The hello line
  gains a `role` field: `"native-host"` or `"mcp-server"`, validated against
  the existing per-run secret (`validate_hello` extension; negative test: a
  wrong role is rejected).
- Server→broker messages carry the MCP `method` + `params`; the broker runs
  the existing dispatch pipeline (`check_required` / `check_arg_types` /
  `build_payload` / `session.call`) and returns the MCP result. The server
  stays a thin adapter; audit stays in the broker and gains a `client` field.
- **clientId is granted by the broker, bound to the TCP connection at
  registration, and attached server-side.** It is never a request field — a
  client cannot spoof another client's id. The display name comes from the
  client's MCP `initialize` `clientInfo` (confirmations and audit show e.g.
  `claude-code (a1b2)`).
- Requests on the native connection gain `clientId` end-to-end (protocol 2)
  so the extension can scope per agent. Single-agent = one client with a
  fixed id; behavior unchanged.
- The handshake that `contracts/protocol-version.json` designed but never
  wired (role + capability exchange at connect) lands as part of this.

### Scheduling (v1)

Mutating ops (`page_click`, `page_fill`, `page_eval`, `page_scroll`,
`page_screenshot`, `tab_close`) serialize behind one broker-side mutex; reads
and waits (`page_text`, `page_links`, `page_snapshot*`, `tab_list`,
`page_wait_for`) run concurrently. Rationale: the "current tab" pointer lives
in the extension, so the broker cannot schedule per-tab until the extension
reports per-client tab targets (v2). A global mutation lock is coarse but
predictable and needs no protocol feedback.

Because the extension side stays a single SW with a single
`chrome.debugger` caller, two agents' CDP work on one tab is interleaved
`Runtime.evaluate` calls from one SW — there is no second-debugger-client
problem to solve.

### Tab addressing first (hard dependency, lands before the broker)

Every page tool's contract says "the active tab" — a single, global browser
concept. Concurrency requires per-agent addressing, which is an
extension + contract change independent of the transport work:

- explicit `tabId` preferred on page ops (the `tab_id` pipe already exists,
  dispatch just never sets it);
- otherwise, a **per-session virtual focus** pointer (per clientId, inside
  the agent's group) replaces "the active tab";
- `page_screenshot` becomes per-tab (`Page.captureScreenshot`);
  `captureVisibleTab` is window-global and cannot capture a background tab —
  same precedent as ADR-0025 requiring CDP mode for high-fidelity ops.

Landing this first means the extension is concurrency-ready before the
broker exists, and single-agent users get the robustness benefits early.

### Scoping and security

- Per-agent tab groups: "Browser Bridge · <name>", color rotation (generalizes
  ADR-0018's single group).
- `tab_open` lands in the agent's group; page ops with an explicit `tabId`
  must target the agent's own group or get user confirmation; no `tabId`
  resolves to the session's virtual focus. `tab_list` returns the agent's
  group by default, other tabs labeled with ownership (information is not
  hidden; operations are limited — "polite isolation", no strong boundary).
- Audit lines carry `client`; confirmation toasts name the agent.
- Threat model and [tool risk matrix](../security/tool-risk-matrix.md) updated
  (new trusted process, new hello role); negative tests required: clientId
  spoofing rejected at the broker, cross-group op rejected at the extension,
  wrong-role hello rejected.

## Alternatives Considered

### A. Peer/master-election — the first server acts as the broker
No new process type; late servers TCP-connect to the first one's `handle()`
loop; death of the master triggers re-election. Rejected: it mixes two roles
in one process (a server restart re-elects and disturbs everyone), and the
maintainer explicitly chose **separation of concerns** — the MCP server should
remain a pure stdio adapter.

### B. Extension as the multiplexer (N native-host connections)
Chrome allows multiple `connectNative` ports, but `connectNative` carries no
per-connection payload, so a host process cannot know which server to bridge
to (needs a rendezvous scheme), and long-lived routing state inside a
recyclable MV3 service worker is exactly the fragility the keepalive/announce
work (ADR-0027) fights. Rejected.

### C. No concurrency — refuse or queue the second agent
Phase 0 is kept as the immediate step (it removes the silent-kill), but
observed multi-agent demand makes queue-only insufficient as the end state.

## Staged implementation

| Stage | Content | Size |
|---|---|---|
| Phase 0 | Atomic lock placement + refuse-to-supplant by default + `--takeover` flag (independent of this ADR's later phases; do first) | small |
| Phase 1a | Tab addressing migration: explicit `tabId`, per-session virtual focus, per-tab screenshot | medium |
| Phase 1b | Broker mode: `--broker`, hello roles, thin servers, clientId grant, v1 scheduling, MCP-over-TCP | medium |
| Phase 1c | Per-agent groups, scoping enforcement, confirmation labels, audit client field | medium |
| Phase 2 | Per-tab scheduling (extension reports per-client tab targets), fairness, per-agent policy, read-only agent role | later |

## Consequences

- Four process roles on one machine (server × N, broker × 1, host × 1,
  extension × 1) — the broker is the only new one, and it is a mode of the
  existing binary, not a new artifact.
- Protocol 2 is a breaking wire change; the version handshake (soft advisory
  today) gains a hard gate at connect: an extension that does not speak
  protocol 2 gets a clear NOT_CONNECTED-style error naming the version gap,
  not silent misbehavior.
- Single-agent behavior is preserved: one server + one broker it spawned is
  the degenerate case, with one extra hop (server→broker instead of
  server→host) costing one localhost TCP leg.
- The linger window means a browser session can outlive all clients by ~30 s;
  the lock/registry must make that state visible to `doctor`.

## Implementation notes (updated during Phase 1b)

Reality adjusted a few details; the architecture stands.

- **Mutation set**: the v1 global mutation lock covers `page_click`,
  `page_fill`, `page_eval`, `page_scroll`, `page_screenshot`, `tab_close` —
  plus `tab_open` (it moves the Phase 1a current-tab pointer) and
  `page_snapshot_precise` (a debugger attach excludes any concurrent CDP op
  on the tab). Reads and waits run concurrently.
- **Client handshake carries `proto`**: a stale pre-2.0 broker cannot be
  detected via announce (clients never receive announcements), so thin
  servers state their protocol in the hello and the broker rejects
  mismatches with a structured `brokerRejected` line. The extension's half
  of the handshake stays the announce frame — now a HARD gate
  (`PROTOCOL_MISMATCH`) when the peer announces a version, soft advisory for
  peers that predate announcing.
- **Legacy hosts**: a hello without a `role` means `native-host` — older
  installs spawn the host straight from the manifest with no way to add
  arguments.
- **Lock hygiene under succession**: every deferred lock removal (signal
  handler, linger timer) deletes the lock only if it still names the exiting
  process — a supplanting successor claims the lock the instant its
  predecessor dies, and a late cleanup would orphan the new bridge (this
  exact race made `--takeover` a silent no-op in e2e). `connect()` also no
  longer clears a lock on a failed connect: a refused connect during a
  broker's startup is normal, and the claim loop's liveness check owns
  stale-lock recovery.
- **Refusal semantics shift**: Phase 0's "second server refuses" described
  server-owns-bridge; under the broker a second server JOINS.
  `--takeover` displaces the broker — taking every client's bridge down
  with it, deliberately — and the old thin server may rejoin the new
  bridge (self-healing is correct behavior, and the e2e suite asserts the
  broker death + fresh claim rather than the server's death).
- **Client labels**: ids are granted per TCP connection (`c1`, `c2`, …);
  display names come from the MCP `initialize` `clientInfo` and are for
  labels only (audit, confirmation text) — authorization never reads them.

## Implementation notes — Phase 1c (per-agent workspaces + scoping)

- **Explicit targeting is scoped; the shared visible surface is not.** An
  explicit `tabId` must name a tab in the calling agent's own workspace group
  (`TAB_OUT_OF_SCOPE` otherwise — the user's ungrouped tabs included), and the
  same boundary guards `tab_focus` / `tab_close` / `page_snapshot_precise` /
  `cookie_get`. The active-tab fallback stays unscoped: driving what the user
  is looking at is the product, it is physically one surface, and the mutation
  lock serializes it. Per-action user confirmation remains future work; until
  then the boundary is a hard reject whose message names the way out.
- **Workspaces key off the granted `clientId`** (`c1`, …), stable for the
  connection. The group is remembered BY ID in session storage so it survives
  retitling when the display name lands later; a reconnecting client gets a
  fresh id and therefore a fresh workspace — its old tabs remain visible in
  `tab_list` (`owner: "agent"`) but out of reach. A persistent client
  identity is a Phase 2 refinement.
- **`tab_list` gains `owner`** (`"you" | "agent" | "user"`): information is
  not hidden across agents — operations are.
- **`clientName` rides the envelope separately from `clientId`** (labels
  only): the name arrives asynchronously from `initialize` clientInfo, and
  the scoping identity must never change underneath a conversation.
- **Errors**: `TAB_OUT_OF_SCOPE` added to contracts/errors.json (producer:
  extension), the extension's `BridgeErrorCode` union, and the Rust
  `EXTENSION_CODES` allowlist.

## Implementation notes — Phase 2 (per-tab scheduling)

- **The extension reports the resolved tab on every response** (`BridgeResp
  .tabId`, optional): the broker remembers each client's last-known target
  and keys mutation scheduling on it. Same-tab mutations serialize; different
  tabs run concurrently; an unknown target (usually a client's first op) is
  conservative and excludes everything. `page_eval` — the one mutation that
  can run for seconds — is the big winner.
- **Audit gains `tab=`**: every tool call's audit line names the tab it acted
  on, which was previously only implicit in payloads.
