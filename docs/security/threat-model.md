# Threat model

What browser-bridge protects, from whom, and what it explicitly does not defend
against. Pairs with [trust-boundaries.md](trust-boundaries.md) and the
[tool risk matrix](tool-risk-matrix.md).

## Assets

- The user's **authenticated browser sessions** (cookies incl. httpOnly, web
  storage tokens) — i.e. the ability to act *as the user* on sites they're
  logged into.
- **Page content** the user can see.
- The ability to **execute actions** (click/fill/navigate/eval) as the user.
- Integrity of the **wire protocols** (a corrupted stream can hang or crash the
  bridge).

## Actors

| Actor | Trusted? | Notes |
|-------|----------|-------|
| The user | yes | owns the machine and Chrome profile |
| The MCP client (Claude Code, Codex, …) | **yes, by design** | the user configured it; it drives the tools |
| The Rust binary (MCP server + native host) | yes | the thing we're securing |
| The MV3 extension | yes | but runs alongside untrusted page code |
| **The web page** | **NO** | may be attacker-controlled; may host prompt-injection |
| Other local users / processes | **NO** | may try to connect to the bridge socket |
| The network | out of scope | no remote surface — everything is localhost/stdio |

## Trust assumptions

- **Single-user machine.** The bridge socket is localhost-only with a per-run
  secret in a 0600 lock file; the model assumes no hostile local user with the
  same UID.
- **The MCP client is trusted.** A malicious client the user themselves
  installed is out of scope — it already has whatever the user granted it. The
  tools exist to be driven by that client.
- **Chrome's sandbox and extension model hold.** We rely on MV3 isolation
  between content scripts and page JS, and on Chrome enforcing host permissions.

## Primary threats & mitigations

1. **A web page influences the agent into acting on it without approval.**
   → Page-level ops require an **allowlisted origin**; a new origin triggers an
   explicit user prompt + `chrome.permissions.request`. The page can't add
   itself to the allowlist.

2. **Prompt injection: page content tricks the model into a dangerous tool
   call** (e.g. "run this eval", "read cookies and post them").
   → Observed page content is *data*, not commands, to the agent. Independently,
   high-risk actions (submit/link click, `page_eval`, tab close) require an
   **in-page user confirmation** the page cannot forge or auto-dismiss, and
   `page_eval` confirms **every call** showing the full code.

3. **Credential/token exfiltration.**
   → Cookies/storage are **read-only** (no set), **allowlist-scoped**, and
   **masked** (JWT/hex/long-digit/token-like) before leaving the extension.
   `storage_get` masking is not user-toggleable. `page_text` masks passwords and
   card-like numbers.

4. **Another local process hijacks the bridge** to issue tool calls or read
   responses.
   → The native host authenticates with a **per-run secret** read from a 0600
   lock file; the MCP server rejects connections with a bad/absent hello.

5. **A malformed/oversized message crashes or corrupts the bridge.**
   → Native-messaging framing is length-checked (64 MB inbound clamp, 1 MB
   outbound cap); a `panic = "abort"` profile + stderr panic hook keep panics
   off the protocol stream; parse errors are surfaced, not fatal. (Protocol
   fuzzing is a planned hardening — see the roadmap.)

## Explicit non-goals

- Defending against a compromised OS account or a hostile process running as the
  same user beyond the bridge-secret check.
- Defending against a malicious MCP client the user configured.
- Multi-user / shared-machine isolation.
- Remote attackers (there is no remote attack surface).

## Residual risks (accepted, tracked)

- The `page_eval` **60s grace window** lets *unrelated* same-origin code run
  without re-prompting (see [ADR-0008](../adr/0008-page-eval-confirmation-channel.md)).
- Masking is heuristic — it can miss a novel secret format or over-mask benign
  data.
- `page_snapshot_precise` briefly attaches the debugger (infobar flash).
- **CDP mode** (`cdpMode`, opt-in, off by default — see
  [ADR-0017](../adr/0017-cdp-mode-all-ops.md)) routes all page ops through
  `chrome.debugger`. When enabled it **bypasses page CSP** (letting `page_eval`
  run on strict-CSP sites) and holds a **persistent debugger attach** for the
  tab (the "Started debugging this browser" banner stays up). The allowlist,
  per-action confirmation toasts, and masking are unchanged; the residual risk
  is the wider surface and the removed CSP defense-in-depth layer, accepted as
  the explicit price of the opt-in.
