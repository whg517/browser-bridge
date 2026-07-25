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
   → Observed page content is *data*, not commands, to the agent. The standing
   defenses are the **per-site allowlist** (the agent only acts on approved
   origins — see threat 1), **per-tool enable/disable** (any tool can be turned
   off — "tool disabled in settings" — which is also the `page_eval` kill
   switch), and **always-on masking** of token-like values in `page_eval`
   results. `page_snapshot_precise` also always shows an on-page NOTICE, but
   this is informational, not a blocking confirmation.
   **Reduced protection:** as of
   [ADR-0020](../adr/0020-remove-interactive-confirmations.md) there is **no**
   per-action confirmation. On an already-allowlisted origin the agent can
   submit forms / click navigating links, run JS (when `page_eval` is enabled),
   and close tabs with **no prompt**. Injection resistance therefore rests on
   the allowlist and on the model treating page content as data — not on a human
   approving each individual action.

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

- With per-action confirmations removed
  ([ADR-0020](../adr/0020-remove-interactive-confirmations.md), superseding
  [ADR-0006](../adr/0006-toast-confirmation-for-high-risk.md) and the
  confirmation half of
  [ADR-0008](../adr/0008-page-eval-confirmation-channel.md)), high-risk clicks,
  `page_eval` (unless disabled per-tool), and `tab_close` run on any allowlisted
  origin **without a prompt**. The allowlist and the per-tool disable are the
  only gates, so a successful prompt injection on an approved origin can act
  with the user's session until the user notices. (This also removes the earlier
  60s same-origin grace window.)
- Masking is heuristic — it can miss a novel secret format or over-mask benign
  data.
- `page_snapshot_precise` briefly attaches the debugger (infobar flash).
- **CDP mode** (`cdpMode`, opt-in, off by default — see
  [ADR-0017](../adr/0017-cdp-mode-all-ops.md)) routes all page ops through
  `chrome.debugger`. When enabled it **bypasses page CSP** (letting `page_eval`
  run on strict-CSP sites) and holds a **persistent debugger attach** for the
  tab (the "Started debugging this browser" banner stays up). The allowlist and
  masking are unchanged; the residual risk is the wider surface and the removed
  CSP defense-in-depth layer, accepted as the explicit price of the opt-in.
