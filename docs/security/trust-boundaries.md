# Trust boundaries

The system spans three processes and four protocol hops. Each hop is a trust
boundary — data crossing it is validated and/or authenticated. Pairs with the
[threat model](threat-model.md).

```
MCP client ──①──▶ Rust MCP server ──②──▶ native host ──③──▶ extension ──④──▶ web page
   (trusted)         (trusted)           (trusted)         (trusted)        (UNTRUSTED)
```

## ① MCP client ↔ Rust MCP server  (stdio, JSON-RPC 2.0)

- **Direction of trust**: the client is trusted (user-configured). This boundary
  is about *protocol correctness*, not authz.
- **Enforcement**: strict JSON-RPC parsing; unknown methods → `-32601`; parse
  errors surfaced, not fatal; **stdout carries only protocol** (diagnostics go
  to stderr, or a stray write corrupts the stream).

## ② Rust MCP server ↔ native host  (localhost TCP, NDJSON)

- **Direction of trust**: this is the one boundary defended against *local*
  peers — any process that can reach `127.0.0.1:<port>`.
- **Enforcement**: the native host must send a `hello` with the **per-run secret**
  from the 0600 lock file; a bad/missing secret is rejected. The port is
  ephemeral and published only in the lock file. Each connection is size-checked
  NDJSON; the newest authenticated connection replaces the previous writer.

## ③ Chrome ↔ native host  (Native Messaging framing)

- **Direction of trust**: Chrome spawns the host per the host manifest, whose
  `allowed_origins` **pins the extension ID** — only our extension can talk to
  it.
- **Enforcement**: 4-byte LE length prefix + JSON; 64 MB inbound clamp, 1 MB
  outbound cap; single-writer + flush-per-frame on stdout; `panic = "abort"` +
  stderr panic hook so a panic can't corrupt the frame stream. Shutdown on stdin
  EOF.

## ④ Extension ↔ web page  (Chrome API / content script / DOM)

- **Direction of trust**: **the page is untrusted.** This is the security-
  critical boundary.
- **Enforcement**:
  - **No origin gate (accepted)**: the extension holds `<all_urls>` and runs
    page-level ops on any tab with no per-site approval (see
    [ADR-0024](../adr/0024-remove-allowlist.md)). This boundary
    is therefore *not* defended by origin gating; the controls below plus the
    upstream host-trust hops (③, ②) carry it.
  - **Per-tool disable**: any tool (including `page_eval`) can be turned off in
    the Options page; a disabled tool is refused at dispatch.
  - **Masking**: page text, cookies, storage, and eval output are masked before
    crossing back toward the model.
  - **Isolation**: content scripts run in the isolated world; `page_eval` uses a
    `Function` constructor (not the content script's scope) and its result is
    serialized safely (cycles/DOM/exotic types) before masking.
  - **Read-only credentials**: no cookie/storage writes.

## Invariants that must not regress

- stdout on either binary mode = protocol bytes only.
- The bridge never serves a connection that failed the hello check.
- The host manifest's `allowed_origins` always pins exactly our extension ID(s).
- No tool writes cookies or web storage.

Changing any of these is a **security-relevant change** (see
[SECURITY.md](../../SECURITY.md)).
