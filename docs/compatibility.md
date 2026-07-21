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
| Extension/binary release version | SemVer (e.g. `0.1.0`) | `Cargo.toml` (see [ADR-0013](./adr/0013-ci-and-toolchain.md)) | Release artifact version; for release discipline see [release.md](./release.md) |

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

## Handshake and Fast Failure (Contract Defined, Wiring Pending)

The `handshake` section of [`protocol-version.json`](../contracts/protocol-version.json) describes
the **intended** negotiation flow, layered on top of the existing `hello` secret authentication (see
[ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md)):

1. After the secret check passes, the extension reports its own `protocolVersion` and list of capability ids.
2. The server compares protocol versions: **on incompatibility it fails fast**, returning
   the `PROTOCOL_MISMATCH` from [`errors.json`](../contracts/errors.json)
   (`category: protocol`, `retryable: false`) with a clear message, rather than accepting the connection and
   only blowing up late on some `tools/call` with an "unknown op".
3. A capability required by a tool is not advertised → reject that tool call up front, rather than dispatching an op the extension cannot handle.

**An honest note on the current state**: this "version + capability handshake" is currently **defined only in the contracts** (`protocol-version.json`
+ `capabilities.json`); the handshake **wiring on the code side has not yet been connected** — it is intentionally deferred, to be wired up once the binary and
extension can be upgraded independently (such as when listed on the Chrome Web Store or when release cadences diverge). What has landed so far is the **first stage**:
pending requests are bound to the connection generation, and generation-guarded reconnection keeps an old connection from affecting a new one
(see [architecture.md §5.2](./architecture.md#52-native-host-reconnection-flow)).
The `PROTOCOL_MISMATCH` error code is already in place in the contracts and can be enabled as soon as the wiring lands.

## See Also

- Error classification and `PROTOCOL_MISMATCH`: [architecture.md §11.1](./architecture.md#111-error-classification-errorsjson),
  [`contracts/errors.json`](../contracts/errors.json).
- Connection and reconnection semantics: [architecture.md §5.2](./architecture.md#52-native-host-reconnection-flow),
  [operations.md](./operations.md).
- Release and SemVer discipline: [release.md](./release.md).
