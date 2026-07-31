# ADR-0023: Effective-origin gating for inherited-origin sub-frames + permission-drift recovery

- **Status**: Accepted
- **Date**: 2026-07-31

## Context

ADR-0022 made `page_snapshot` / `page_text` / `page_links` (and `page_click` /
`page_fill`) aggregate same-origin sub-frames. Each sub-frame is gated by a
non-prompting allowlist check on the frame's own `location.href`. Two problems
surfaced while validating whether the tools can read an **AI "canvas" / preview
artifact** (an interactive doc an agent renders into an iframe — e.g. a job
preview on a recruiting site):

1. **Inherited-origin sub-frames are wrongly skipped.** Frames created by an
   allowed page but whose URL doesn't encode that page's origin fail the gate:
   - `srcdoc` iframe → `location.href` is `about:srcdoc` → origin glob
     `about:///*` → never matches `https://site/*`.
   - `blob:` iframe → `blob:https://site/<uuid>` → `new URL(...).host` is empty →
     glob `blob:///*` → never matches.
   - `about:blank` iframe → same problem.

   These are the *most common* ways a preview/canvas is embedded, and they are
   effectively same-origin (they inherit / carry the embedder's origin). Yet
   they only read when "allow all sites" is on (which bypasses the gate). Under a
   normal per-origin grant they were silently dropped.

2. **Allowlist/permission drift has no recovery.** Per-origin globs live in the
   allowlist, but the actual host permission comes from the optional `<all_urls>`
   grant (there is no `activeTab` and no per-origin `host_permissions`). Turning
   **off** "allow all sites" revokes `<all_urls>`, stranding every allowlisted
   origin **with no host permission**. `ensureAllowed` saw the glob still in the
   list and returned early *without prompting*, so `executeScript` hard-failed
   with `Cannot access contents of url …` and the user had no way to recover
   short of manually removing and re-adding the origin.

## Decision

**Gate sub-frames by their *effective* origin, and let `ensureAllowed` recover
from permission drift.**

- **`effectiveOriginGlob(frameUrl, topUrl)`** (pure, unit-tested in
  `shared/allowlist.ts`): maps an inherited-origin frame URL to the origin it
  should be gated by — `about:srcdoc` / `about:blank` → the (already user-
  approved) **top** document's origin; `blob:` → its embedded **inner** origin;
  everything else → its own origin. A genuinely cross-origin frame still resolves
  to its own origin and still needs its own grant.
- **`isSubFrameAllowed(frameUrl, topUrl)`** replaces `isAllowed(url)` at the two
  sub-frame gates in `ContentScriptBackend` (read aggregation + `f<N>:` ref
  routing). The top URL is threaded through from `run(tab)`.
- **Permission-drift recovery in `ensureAllowed`**: when an origin is
  allowlisted, also verify the host permission via `chrome.permissions.contains`.
  If it's missing, fall through to the normal approval prompt (which the popup
  uses to re-run `chrome.permissions.request`) instead of returning to a certain
  `Cannot access` failure.

## Scope

- Reading + ref click/fill across sub-frames, both backends (cdpMode delegates
  these ops to the content-script backend per ADR-0022).
- `data:` frames are intentionally **not** remapped — a `data:` URL gets an
  opaque origin (it does not inherit the embedder), so gating it by the top
  would be unsound. It stays gated by its own (unmatchable) origin → skipped.

## Consequences

### Positive
- Same-origin previews/canvases embedded via `srcdoc` / `blob:` / `about:blank`
  are now readable and operable under a normal per-origin grant — no need to
  enable "allow all sites".
- Disabling "allow all sites" no longer bricks previously-allowlisted origins;
  the next tool call re-prompts to re-acquire the host permission.

### Negative / trade-offs
- `ensureAllowed` now does one extra `chrome.permissions.contains` on the
  allowlisted-hit path (cheap; skipped entirely when "allow all sites" is on).
- `about:srcdoc` / `about:blank` are gated by the **top** origin because frame
  enumeration (`executeScript`, no `webNavigation`) doesn't give the parent
  chain. A srcdoc/blank frame nested under a *cross-origin* middle frame would
  thus be gated by the top rather than its true parent — but the extension can
  only enumerate/inject into it when it already holds permission for that
  subtree, so this doesn't broaden reach beyond what was granted.
- Still validated by the pure `effectiveOriginGlob` unit tests + manual
  multi-embedding QA (six iframe embedding modes); the SW orchestration remains
  outside the headless DOM harness (per ADR-0022).
