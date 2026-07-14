# contracts/

The **single source of truth** for cross-process contracts. Edit here, then
regenerate/verify — don't hand-edit the derived files.

## `tools.json`

The tool catalogue: for each tool, its `name`, `uiLabel` (options page), `risk`,
`scope`, `permission`, `confirmation`, model-facing `description`, and
`inputSchema`.

Derived / verified from it:

- **`extension/src/shared/ops.ts`** — *generated* by `scripts/gen-ops.mjs`
  (`make gen`). CI fails if it's out of date.
- **`src/tools.rs`** — *verified* by the `matches_contract` test (`cargo test`):
  names, descriptions, and schemas must match the contract.
- **`extension/src/shared/ops.test.ts`** — asserts `ops.ts` matches the contract.

So a tool's identity lives in one place; Rust and TypeScript both fail CI if
they drift from it.

## `errors.json`

The cross-process error taxonomy: for each error, a stable `code` (for
programmatic handling), a `category`, a `retryable` flag, a user/model-facing
`message`, and the Rust `CallError` variant(s) it maps from. Rust maps
`CallError -> code` (verified by `cargo test` against this file); the extension
maps its failures to the same codes. See
[docs/architecture.md](../docs/architecture.md#11-协议边界错误分类与握手) for how it
fits the protocol.

## `capabilities.json`

The capability catalogue for connection-time negotiation. Each capability has a
stable `id`, a `description`, the Chrome `permissions` it needs, and the `tools`
(from `tools.json`) it covers. It is derived **conceptually** from `tools.json`
(each tool's `permission` + `scope`). On connect, the extension/host advertise
which capability ids are actually available; a tool is callable only if its
capability is advertised. Keep in sync with `tools.json` when tools change.

## `protocol-version.json`

The **internal bridge** protocol version — a small integer for the
MCP server ↔ native host ↔ extension wire contract. Distinct from the MCP
JSON-RPC version (`2025-06-18`, see
[ADR-0007](../docs/adr/0007-mcp-protocol-version-2025-06-18.md)) and from the
extension release version (Cargo is the version source). It also documents the
intended compatibility handshake: exchange version + capabilities on connect and
fail fast (`PROTOCOL_MISMATCH`) on incompatibility, rather than a late
"unknown op". See [RFC-0001](../docs/rfc/0001-connection-state-machine.md).

## `bridge-request.schema.json` / `bridge-response.schema.json`

JSON Schema (draft 2020-12) for the internal bridge **envelope** — the
`BridgeReq { id, op, tabId?, args }` request and `BridgeResp { id, ok, data?, error? }`
response that cross MCP server ↔ native host ↔ extension. They are the source of
truth for the envelope *shape* and mirror the interfaces in
[`extension/src/shared/types.ts`](../extension/src/shared/types.ts) (kept in sync
by hand — `types.ts` is not generated from them yet). They describe the current
wide form (`op` a plain string, `args` a flat bag of optional fields); the typed
/ discriminated-union form is a planned follow-up (see
[docs/governance-roadmap.md](../docs/governance-roadmap.md) P1#3). The `data`
payload is intentionally unconstrained, and stable error **codes** live in
`errors.json`, not in the response schema.

## Adding / changing a tool

1. Edit `tools.json`.
2. `make gen` (regenerates `ops.ts`).
3. Update the Rust handler in `src/tools.rs` (the test enforces parity).
4. `cargo test` + `make ci`.

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-tool).
