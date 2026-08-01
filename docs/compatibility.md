# Compatibility: Protocol and Capability Versions

> This document explains browser-bridge's three kinds of "version", the compatibility strategy for the internal bridge protocol, and the
> **current contract state** of the version/capability handshake. For an overview of the protocol boundary, see [architecture.md §11](./architecture.md#11-protocol-boundaries-error-classification-and-handshake);
> for the single source of truth for contracts, see [`contracts/`](../contracts/README.md).

## Three Mutually Distinct "Versions"

Before discussing compatibility, first distinguish the three levels (see [architecture.md §11.2](./architecture.md#112-capability--version-handshake-capabilitiesjson--protocol-versionjson)):

| Version | Value | Single source | Meaning of a change |
|------|------|------|----------|
| MCP JSON-RPC version | Date string `2025-06-18` | [ADR-0007](./adr/0007-mcp-protocol-version-2025-06-18.md) | External protocol between MCP client ↔ MCP server; locked, not changed casually |
| Internal bridge protocol version | Monotonic integer (currently `1`) | [`contracts/protocol-version.json`](../contracts/protocol-version.json) | Wire contract between MCP server ↔ native host ↔ extension |
| Extension/binary release version | SemVer (e.g. `0.1.0`) | The git tag (see [ADR-0026](./adr/0026-release-time-version-stamping.md)); the repo itself carries `0.0.0` | Release artifact version; for release discipline see [release.md](./release.md) |

This document focuses on the **internal bridge protocol version**: it is a small integer that is incremented (+1) only when the bridge wire contract
(the shape of `BridgeReq`/`BridgeResp`, the `hello` handshake, op/capability semantics) undergoes an **incompatible** change.
Backward-compatible changes such as adding optional fields, adding tools, or adding capabilities do not bump it (under SemVer they land on the
minor of the release version; see [release.md](./release.md#semver-rules)).

## Capability Negotiation: capabilities.json

Beyond the protocol version, a connection must also negotiate a **capability set**.
[`capabilities.json`](../contracts/capabilities.json) groups tools by shared Chrome permission/scope
(such as `page_eval`, `cookie_read`, `page_snapshot_precise`), conceptually derived from the
`permission`/`scope` notions in `tools.json`. The design intent is: on connection, the extension/native host reports the **actually available**
capability ids (permission granted, tool not disabled), and a tool may only be called when its capability is advertised.

## What Landed: the Announce Frame and the Drift Advisory

On every connect the extension sends **one unsolicited frame** describing itself, layered on top of the
existing `hello` secret authentication ([ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md)):

```json
{"id":0,"ok":true,"data":{"announce":{
  "protocolVersion":1,"version":"0.6.0",
  "browser":{"name":"Chrome","version":"141.0.7390.55"}}}}
```

It wears the `BridgeResp` envelope on the **reserved id `0`** deliberately. "Old binary + new extension" is
exactly the drift being reported, so the frame must be harmless to a server that predates it: the Rust side
deserializes every inbound line into `BridgeResp` (`id`/`ok` required), and a line that fails to parse kills
the reader loop and drops the connection. As a legal `BridgeResp` it parses everywhere, and since request ids
start at 1 it can never collide with a reply. Being purely additive, it did **not** bump `protocolVersion`.

What the server does with it ([ADR-0027](./adr/0027-version-announce-and-drift-advisory.md)):

- **Release-version mismatch → advise, never enforce.** The next tool result carries a prepended text block
  naming both versions, saying which side is behind, and telling the agent to raise it with the user instead
  of working around it. One-shot per connection; a reconnect re-arms it. Silent when either side reports the
  `0.0.0` local-build placeholder ([ADR-0026](./adr/0026-release-time-version-stamping.md)).
- **`protocolVersion` → recorded and logged only.** No connection is refused; `PROTOCOL_MISMATCH` stays unused.

`browser-bridge doctor` still reports only the host's own version: it runs as a separate process with no
session, and putting peer state in the lock file (which holds the port and the bridge secret) is not worth it.

## Handshake and Fast Failure (Contract Defined, Wiring Still Pending)

The `handshake` section of [`protocol-version.json`](../contracts/protocol-version.json) describes
the **intended** negotiation flow, the enforcing half that the announce frame above does not implement:

1. After the secret check passes, the extension reports its own `protocolVersion` and list of capability ids.
2. The server compares protocol versions: **on incompatibility it fails fast**, returning
   the `PROTOCOL_MISMATCH` from [`errors.json`](../contracts/errors.json)
   (`category: protocol`, `retryable: false`) with a clear message, rather than accepting the connection and
   only blowing up late on some `tools/call` with an "unknown op".
3. A capability required by a tool is not advertised → reject that tool call up front, rather than dispatching an op the extension cannot handle.

**An honest note on the current state**: only the *reporting* half of this is wired. The announce frame above carries
the extension's `protocolVersion`, and the server records and logs it — but it never rejects a connection, and
`PROTOCOL_MISMATCH` remains unused. Capability negotiation (`capabilities.json`) is not wired at all: no capability list
is advertised and no tool call is gated on one.

Enforcement stays deferred on purpose. A bug in a fail-fast path means **no bridge at all**, which is a far worse
outcome than the drift it would guard against, and there is no protocol v2 to reject yet. The pieces already in place
for when it lands: pending requests are bound to the connection generation, and generation-guarded reconnection keeps an
old connection from affecting a new one (see [architecture.md §5.2](./architecture.md#52-native-host-reconnection-flow));
the `PROTOCOL_MISMATCH` code is defined in the contracts; and both sides now read `protocolVersion` from
`protocol-version.json` (asserted in `cargo test` via `src/peer.rs`, generated into `ops.ts` via `make gen`).

## See Also

- Error classification and `PROTOCOL_MISMATCH`: [architecture.md §11.1](./architecture.md#111-error-classification-errorsjson),
  [`contracts/errors.json`](../contracts/errors.json).
- Connection and reconnection semantics: [architecture.md §5.2](./architecture.md#52-native-host-reconnection-flow),
  [operations.md](./operations.md).
- Release and SemVer discipline: [release.md](./release.md).
