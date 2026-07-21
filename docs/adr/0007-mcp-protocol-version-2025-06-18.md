# ADR-0007: Lock MCP Protocol Version 2025-06-18

- **Status**: Accepted
- **Date**: 2026-07-07

## Context

MCP (Model Context Protocol) is evolving quickly. Protocol versions are identified by date strings (e.g. `2024-11-05`, `2025-06-18`), and different versions differ in their handshake fields, capability declarations, and message formats.

As an MCP server, browser-bridge needs to declare the protocol version it speaks in the `initialize` response, and implement that version accordingly. Choosing the wrong version will cause the MCP client handshake to fail or behave abnormally.

## Decision

**Lock the protocol version to `2025-06-18`** (the current stable version at the time of research).

Concrete implementation:
- `protocolVersion: "2025-06-18"` in the `initialize` response
- Implement the minimal message set for this version: `initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`
- Do not implement `resources/` / `prompts/` (optional; capabilities only declares `{"tools": {}}`)
- Report tool errors with `isError: true` inside the result, not via a JSON-RPC error
- Return `-32601` for unknown methods

## Alternatives Considered

### Option A: Use the latest draft version
- **Research finding**: there is a draft proposal to remove the `initialize` / `notifications/initialized` handshake in favor of a stateless model
- **Problem**: at the time of research, **no released client** used this draft
- **Rejected**: using the draft would be incompatible with all real-world clients

### Option B: Use the older `2024-11-05`
- **Problem**: the field conventions and capability model of the older version diverge from current client implementations
- **Rejected**: MCP clients commonly implement 2025-06-18, and using an older version could miss new conventions

### Option C: Negotiate (echo back whatever version the client sends)
- **Problem**: the server should declare the versions it supports and let the client negotiate. Blindly echoing the client's version would make the server claim support it hasn't actually implemented
- **Resolution**: the server declares `2025-06-18`; if the client sends a different version, it is up to the client whether to continue (our implementation does no active negotiation)

## Consequences

### Positive
- **Compatible with MCP clients**: MCP clients commonly implement this exact version, so the handshake passes
- **Stable**: the protocol version is locked and does not drift with drafts
- **Minimal implementation**: only the required messages are implemented, keeping the code small and easy to audit

### Negative
- **Future follow-up required**: if MCP releases a new stable version and clients upgrade, browser-bridge may need to update the protocol version number and adapt to the new conventions
- **No active negotiation**: if a client insists on a different version, we will not downgrade/upgrade (we simply declare 2025-06-18, and if the client does not accept it the connection fails)

## Key Implementation Details

From the byte-level protocol research (see the architecture research report for details):

### Transport
- NDJSON, LF-separated, **no embedded newlines** (serde serialization escapes them automatically)
- Receive on stdin, send on stdout, stderr for logging only
- One `\n` per message

### Handshake
```
client → server: {"jsonrpc":"2.0","id":1,"method":"initialize",
                  "params":{"protocolVersion":"2025-06-18","capabilities":{},...}}
server → client: {"jsonrpc":"2.0","id":1,"result":{
                  "protocolVersion":"2025-06-18",
                  "capabilities":{"tools":{}},
                  "serverInfo":{"name":"browser-bridge","version":"0.1.0"}}}
client → server: {"jsonrpc":"2.0","method":"notifications/initialized"}  ← no id, no reply
```

### Tool errors (critical)
Report tool execution failures with **`isError: true` inside the result**, **not** via a JSON-RPC error:
```json
{"jsonrpc":"2.0","id":3,"result":{
  "content":[{"type":"text","text":"Error: extension not connected"}],
  "isError":true
}}
```
Rationale: let the model see the error text and self-correct; a JSON-RPC error signals a protocol-layer failure and would confuse middleware.

### Must handle ping
Clients send `ping` for keepalive, and the server must reply with an empty result:
```json
// in:  {"jsonrpc":"2.0","id":7,"method":"ping"}
// out: {"jsonrpc":"2.0","id":7,"result":{}}
```
Many clients treat an unanswered ping as a dead server.

## Implementation

The `handle()` function in `src/mcp_server.rs`: 5 method branches plus a default `-32601`.

## Verified

End-to-end test PASS:
- initialize response correctly returns protocolVersion/capabilities/serverInfo
- notifications/initialized is correctly swallowed (no response)
- tools/list returns 11 tools
- ping returns an empty result
- Exit code 0, lock file cleaned up properly

## See Also

- [MCP Lifecycle 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [MCP Tools 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- draft spec changelog (stateless handshake proposal, not adopted)
