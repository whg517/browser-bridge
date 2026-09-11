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
| The MCP clients (Claude Code, Codex, …) | **yes, by design** | the user configured them; they drive the tools. Since ADR-0028 several clients can share one browser concurrently |
| The Rust binary (MCP server + native host + **broker**) | yes | the thing we're securing. The broker is the same binary in another mode and holds the lock, the extension connection, and client identity grant |
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
- **All configured MCP clients are equally trusted.** Per-agent isolation
  (ADR-0028 Phase 1c) is **politeness isolation** — it prevents accidents
  between agents the user chose to run — not a security boundary. A client
  that lies about its identity can adopt another agent's workspace, and that
  is accepted because every client is user-installed and equally trusted.
- **The user trusts this Chrome with agent access.** The extension is loaded in
  a real Chrome the user controls and accepts that a connected MCP client can
  read and operate **any** open tab. There is no origin gate (see
  [ADR-0024](../adr/0024-remove-allowlist.md)); security rests
  on the controls below, not on per-site consent.

## Primary threats & mitigations

1. **The agent operates on a site or tab the user didn't intend** (whether from
   a misread instruction or the agent wandering).
   → There is **no per-site gate** — the extension holds `<all_urls>` and acts on
   any tab. This is an accepted risk (see [ADR-0024](../adr/0024-remove-allowlist.md)).
   The residual controls are: everything happens **visibly** in the user's own
   Chrome, **per-tool enable/disable** limits what any client can do, the agent
   prompt instructs the model to stay on the tabs and tasks the user named, and
   each agent is **workspace-scoped** (ADR-0028 Phase 1c): an explicitly
   targeted tab must lie in the agent's own group or the call is refused with
   `TAB_OUT_OF_SCOPE`.

2. **Prompt injection: page content tricks the model into a dangerous tool
   call** (e.g. "run this eval", "read cookies and post them").
   → Observed page content is *data*, not commands, to the agent. The standing
   defenses are **per-tool enable/disable** (any tool can be turned off — "tool
   disabled in settings" — which is also the `page_eval` kill switch) and
   **always-on masking** of token-like values in `page_eval` results.
   `page_snapshot_precise` also always shows an on-page NOTICE, but this is
   informational, not a blocking confirmation.
   **Reduced protection:** there is **no** origin gate and **no** per-action
   confirmation. On any origin the agent can submit forms / click navigating
   links, run JS (when `page_eval` is enabled), and close tabs with **no
   prompt**. Injection resistance therefore rests on the model treating page
   content as data, on high-risk tools being disabled when unused, and on the
   user watching — not on origin gating or a human approving each action.

3. **Credential/token exfiltration.**
   → Cookies/storage are **read-only** (no set); `cookie_get` is scoped to the
   active tab's domain, `storage_get` is same-origin, and both are **masked**
   (JWT/hex/long-digit/token-like) before leaving the extension.
   `storage_get` masking is not user-toggleable. `page_text` masks passwords and
   card-like numbers.

4. **Another local process hijacks the bridge** to issue tool calls or read
   responses.
   → The native host authenticates with a **per-run secret** read from a 0600
   lock file; the MCP server rejects connections with a bad/absent hello.

5. **One agent interferes with another** (both configured by the user, sharing
   the browser): racing on the same tabs, closing each other's tabs, or
   silently acting on a tab the other agent believes is its own.
   → **Per-agent workspaces**: each client is granted an identity by the
   broker and gets its own tab group; explicit cross-workspace `tabId`
   targeting is refused (`TAB_OUT_OF_SCOPE`); `tab_list` labels every tab's
   owner (`you` / `agent` / `user`); mutations serialize per tab so two
   agents cannot interleave writes on one page. This is **politeness
   isolation** — coordination against accidents, not a security boundary
   (all involved clients are trusted by assumption).
   A related, accepted risk: **client identity is keyed by the client's own
   declared name** (`name:<clientInfoName>`), so same-name instances share a
   workspace and a client lying about its name adopts that workspace. Inside
   the model (all clients trusted) this costs nothing; it is documented, not
   defended.

6. **A malformed/oversized message crashes or corrupts the bridge.**
   → Native-messaging framing is length-checked (64 MB inbound clamp, 1 MB
   outbound cap); a `panic = "abort"` profile + stderr panic hook keep panics
   off the protocol stream; parse errors are surfaced, not fatal. (Protocol
   fuzzing is a planned hardening — see the roadmap.)

## Explicit non-goals

- Defending against a compromised OS account or a hostile process running as the
  same user beyond the bridge-secret check.
- Defending against a malicious MCP client the user configured.
- **Strong isolation between agents.** Workspaces, scoping, and per-tab
  scheduling prevent *accidental* interference between agents the user runs;
  they are not a security boundary between mutually distrustful clients (all
  of them are equally trusted by assumption).
- Multi-user / shared-machine isolation.
- Remote attackers (there is no remote attack surface).

## Residual risks (accepted, tracked)

- There is no origin gate and no per-action confirmation: high-risk clicks,
  `page_eval` (unless disabled per-tool), and `tab_close` run on **any** origin
  **without a prompt**. The per-tool disable and masking are the only gates, so a
  successful prompt injection can act with the user's session on any open tab
  until the user notices. This is an accepted trade-off
  ([ADR-0024](../adr/0024-remove-allowlist.md)).
- Masking is heuristic — it can miss a novel secret format or over-mask benign
  data.
- **Same-name MCP client instances share one workspace**, and a client that
  misreports its `clientInfo` name adopts that name's workspace (ADR-0028,
  stable identity). Harmless among trusted clients; worth knowing when
  running two instances of the same tool expecting isolation.
- `page_snapshot_precise` briefly attaches the debugger (infobar flash).
- **`page_eval` cannot run at all without CDP mode.** The extension's
  isolated-world CSP blocks `new Function` on every page under MV3, not just
  strict-CSP ones ([ADR-0025](../adr/0025-page-eval-requires-cdp-mode.md)). The
  extension deliberately does **not** attach a debugger by itself to get around
  that — it fails with a message the agent relays, leaving the decision to grant
  debugger-backed access with the operator.
- **CDP mode** (`cdpMode`, opt-in, off by default — see
  [ADR-0017](../adr/0017-cdp-mode-all-ops.md)) routes all page ops through
  `chrome.debugger`. When enabled it **bypasses page CSP** (which is what makes
  `page_eval` usable at all) and holds a **persistent debugger attach** for the
  tab (the "Started debugging this browser" banner stays up). Masking is
  unchanged; the residual risk is the wider surface and the removed
  CSP defense-in-depth layer, accepted as the explicit price of the opt-in.
