# ADR-0027: The extension announces its version; drift is reported to the agent, not enforced

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

Nothing on the bridge carried the extension's version. `serverInfo.version` in
the MCP `initialize` response, `browser-bridge doctor`, and `--help` all report
the *host binary's* `CARGO_PKG_VERSION`; the extension never called
`chrome.runtime.getManifest()`. A version/capability handshake was specified in
[`contracts/protocol-version.json`](../../contracts/protocol-version.json) and
[compatibility.md](../compatibility.md), but the wiring was explicitly deferred —
and that contract had **zero code consumers** on either side.

The two halves are upgraded through entirely separate channels: the binary by
hand (release tarball or `install.sh`), the extension automatically by the Chrome
Web Store ([ADR-0019](./0019-chrome-web-store-distribution.md)). So
`host v0.6.0 + extension v0.5.0` is not an exotic failure — it is the *normal*
state for some window after every release, and the window is as long as the user
takes to notice. What the agent sees in that window is a tool that fails with
"unknown op", or a new argument silently ignored, with nothing pointing at the
cause. It then does the worst possible thing: retries, or works around the
"broken" tool.

[ADR-0026](./0026-release-time-version-stamping.md) makes this both more visible
and more answerable — versions are now trustworthy claims, so comparing them is
worth doing.

## Decision

**The extension announces itself on connect; the server records it and, on a
version mismatch, hands the agent a one-shot advisory. Nothing is enforced.**

### The announce frame

On every successful `connectNative`, the extension posts one frame:

```json
{"id":0,"ok":true,"data":{"announce":{
  "protocolVersion":1,
  "version":"0.6.0",
  "browser":{"name":"Chrome","version":"141.0.7390.55"}}}}
```

It is shaped as a **`BridgeResp` on the reserved id `0`**, and that is the load-
bearing decision. "Old binary + new extension" is precisely the drift being
reported, so the frame must be harmless to a server that has never heard of it.
The Rust side deserializes every inbound line into `BridgeResp`, whose `id`/`ok`
are required — a bare `{"type":"announce",…}` line would fail to parse, and that
error **kills the reader loop and drops the connection**, leaving the extension
to reconnect-loop forever against any older host. As a legal `BridgeResp` it
parses on every version; `Session::next_id` starts at 1, so it can never collide
with a real reply, and a server predating this simply logs "no pending caller for
id 0" and carries on.

The native host bridges extension→server frames verbatim, so it needed no change.
The addition is backward compatible in both directions, so `protocolVersion`
stays at `1`.

### The advisory

On drift the server arms a message and the MCP layer **prepends it as a text
block to the next tool result**:

> `[browser-bridge] Version mismatch: the native host binary is v0.6.0 but the
> connected Chrome extension is v0.5.0. … The extension is older than the host
> binary — update the extension … Tell the user about this; do not try to work
> around it silently.`

- **One-shot per connection.** Repeating it on every call would flood the
  transcript and train the agent to skip it. A reconnect re-announces and
  re-arms, which is correct: that is a genuinely new pairing.
- **Silent when either side reports `0.0.0`.** That is the local-build
  placeholder from ADR-0026, and mixing a local binary with a released extension
  is a normal thing to do while developing.
- **A direction is claimed only when it can be.** Same-core-different-suffix or
  unparsable versions get the advisory without a "which side is behind" claim.

### `protocolVersion` is recorded, not enforced

The announce carries it and the server logs it, but no connection is ever
refused and `PROTOCOL_MISMATCH` stays unused. Enforcement waits until there is a
real protocol v2 to reject — a bug in that path means no bridge at all, which is
a far worse failure than the drift it would be guarding against. The contract
now separates what landed (`announce`) from what is still intended
(`handshake.onMismatch`, `handshake.onMissingCapability`).

## Alternatives Considered

- **MCP logging notifications (`notifications/message`).** The protocol-native
  channel for exactly this. Rejected because client support varies and most
  clients never surface log notifications to the model — the one reader who has
  to act on this would likely never see it.
- **`initialize.instructions`.** Cannot work: the extension usually has not
  connected when `initialize` is answered, so there is nothing to report yet.
- **A dedicated `bridge_status` tool.** Discoverable and queryable, and a
  reasonable future addition — but the agent has to *choose* to call it, so the
  drift it exists to reveal is exactly what stops it from being called. It also
  costs a 17th entry in the tool catalogue, the risk matrix and the docs.
- **Appending rather than prepending the advisory.** Prepending keeps it ahead
  of a potentially large payload (a full snapshot, a screenshot) that would
  otherwise bury it.
- **Refusing the connection on drift.** Far too aggressive for a mismatch that
  is usually harmless — most tools work fine across one minor version.

## Consequences

**Good**

- Drift is now self-reporting, in the one channel the model reliably reads, with
  an explicit instruction to surface it to the user rather than route around it.
- `contracts/protocol-version.json` finally has code consumers on both sides:
  `src/peer.rs` asserts against it in `cargo test`, and `scripts/gen-ops.mjs`
  emits `PROTOCOL_VERSION` into the generated `ops.ts`, so `make gen-check`
  catches drift from the contract.
- The server also learns the Chrome/Chromium version, which is useful context
  for diagnosing browser-specific failures.

**Costs and limits, honestly stated**

- **`doctor` still cannot show the extension version.** It runs as a separate
  process with no `Session`, so it only knows its own. Surfacing the peer there
  would mean writing peer state into the lock file, which is security-sensitive
  (it holds the port and the bridge secret) and out of proportion to the benefit.
- **The advisory path is not covered end-to-end by `tests/e2e.py`.** That suite
  drives a binary built from the repo, which always reports `0.0.0`, and the
  policy is deliberately silent for local builds — so no announce can arm an
  advisory there. e2e proves the frame is absorbed, recorded (asserted via the
  server's log line) and never breaks the bridge; the advisory itself is covered
  by unit tests in `src/peer.rs`, `src/session.rs` and `src/mcp_server.rs`, with
  the host version injected.
- **Announce delivery is best-effort.** A `postMessage` that throws is logged and
  swallowed: this is diagnostic context and must never keep the bridge from
  carrying real tool calls. The cost is that a failed announce looks exactly like
  a legacy extension.
- **The Chrome version comes from the user-agent string.** An MV3 service worker
  has no better source (`userAgentData` gives only a major version without an
  async high-entropy call). Unrecognised user agents report `unknown` rather
  than failing.

## Relationship to Other ADRs

- **[ADR-0026](./0026-release-time-version-stamping.md)**: supplies the
  trustworthy versions this compares, and the `0.0.0` placeholder that switches
  the advisory off for local builds.
- **[ADR-0002](./0002-three-process-architecture-localhost-tcp.md)**: the
  announce layers on top of the `hello` secret authentication, after it passes.
- **[ADR-0019](./0019-chrome-web-store-distribution.md)**: store auto-updates are
  what make drift routine rather than exceptional.
