# ADR-0024: Remove the per-site allowlist; declare `<all_urls>` outright

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

Since ADR-0004 the extension gated every page/tab/cookie op behind a per-site
**allowlist**: `<all_urls>` was an *optional* host permission, new origins raised
a popup approve/deny prompt (which also ran `chrome.permissions.request`), and
the service worker refused ops on origins the user hadn't approved
(`ensureAllowed` / `ensureDomainAllowed`, and `isSubFrameAllowed` for sub-frames
per ADR-0023).

In practice this consent layer created more friction than value for how the tool
is actually used: it drives a real, developer-controlled Chrome that the operator
has deliberately wired to an MCP client. The per-site prompt raced with a 60s
timeout, the allowlist glob could drift from the actual host permission (a whole
class of "Cannot access" dead-ends), and inherited-origin sub-frames
(`about:srcdoc` / `blob:`) needed special-casing just to be readable. The
operator already accepts that the connected MCP client can act on their browser.

## Decision

**Delete the allowlist / per-site approval mechanism entirely. Declare
`<all_urls>` as a required host permission, granted at install.**

- **Manifest**: `<all_urls>` moves from `optional_host_permissions` to
  `host_permissions`. There is no runtime `permissions.request`.
- **Removed code**: `background/allowlist-store.ts` and `shared/allowlist.ts`
  (+ tests); `ensureAllowed` / `ensureDomainAllowed` / `isSubFrameAllowed` calls
  in the content-script + CDP backends, `precise.ts`, `cookies.ts`, `tabs.ts`;
  the popup approve/deny + "Allowed sites" UI; the options-page allowed-sites
  add/remove UI and the "Allow all sites" toggle; the `allowAllSites` setting;
  the `resolve_allow` / `get_allowlist` / `add_allow` / `remove_allow` runtime
  messages. Reads now span every sub-frame with no per-frame gate.
- **Supersedes/removes**: ADR-0004 (allowlist) and ADR-0023 (sub-frame origin
  gating) are deleted; the gating parts of ADR-0022 no longer apply (allFrames
  reading remains, ungated).

## Consequences

### Positive
- No per-site prompts, no allowlist/permission drift, no `about:srcdoc`/`blob:`
  special-casing — page reading/acting "just works" on any site, including
  iframe-embedded previews/canvases.
- Substantially less code and surface (storage, popup/options UI, SW gating).

### Negative / trade-offs (accepted)
- **The per-site consent boundary is gone.** The connected MCP client can
  read/operate ANY tab in the user's real Chrome — including logged-in and
  sensitive sites — with no approval. This is an accepted risk for the intended
  "operator wires their own dev Chrome" model.
- **Broader install-time permission.** The store listing shows "read and change
  all your data on all websites", and Chrome Web Store review scrutinizes a
  blanket host permission more heavily. The privacy policy is updated to state
  this plainly.

### Residual security controls (unchanged)
The native host trusts only the pinned extension IDs (`allowed_origins`); a
single MCP client owns the bridge at a time; per-tool enable/disable still gates
individual tools; returned values are masked (tokens/secrets); `cookie_get` is
read-only + masked (ADR-0010); `page_eval` remains high-risk (gated only by its
per-tool disable); `cdpMode` is off by default (ADR-0017).
