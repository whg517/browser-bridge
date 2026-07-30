# ADR-0022: Read same-origin sub-frames (allFrames page reading)

- **Status**: Accepted
- **Date**: 2026-07-28

## Context

The content-script tools (`page_snapshot`, `page_text`, `page_links`) read only
the **top document**: the content script is injected into the top frame only
(`executeScript({target:{tabId}})`, no `allFrames`), and DOM/text APIs don't
cross frame boundaries. So content inside an `<iframe>` — even a same-origin one
— is invisible (confirmed while triaging #91's sibling evaluation). Cross-origin
iframes are additionally out of process (site isolation) and unreachable by any
same-origin JS.

We want reading tools to see **same-origin sub-frame** content.

## Decision

**Aggregate same-origin sub-frames in the service worker, keeping the content
script frame-agnostic.** Reading is default-on (no opt-in flag).

- **Content script unchanged.** Each frame's content script still snapshots /
  reads only its own document and mints bare `eN` refs. All frame logic is in
  `ContentScriptBackend` (`background/backends/content-script.ts`).
- **Enumerate frames without a new permission.** `enumerateFrames(tabId)` runs
  `executeScript({allFrames:true, func:()=>location.href})` → `[{frameId,url}]`.
  This avoids the `webNavigation` permission (which adds a "read your browsing
  history" install warning). Frames the extension has no host permission for are
  simply absent from the results.
- **Per-frame allowlist gate.** Each sub-frame's origin is checked with a new
  **non-prompting** `isAllowed(url)`; frames whose origin isn't already allowed
  are silently skipped (no per-frame prompts). The top frame keeps the existing
  prompting `ensureAllowed`.
- **Frame-namespaced refs.** When merging a snapshot, the SW prefixes each
  sub-frame node's `ref` with `f<frameId>:` (top stays bare — back-compat) and
  tags it with the source frame url. `page_click`/`page_fill` parse `f<N>:` off
  the ref and route the op to that frame (`sendMessage(tabId, msg, {frameId})`)
  with the bare ref — so `eN` never collides across frames, and `refs.ts` needs
  no change. A fabricated cross-frame ref is re-gated with `isAllowed` before
  acting (defense in depth).
- **Merge shapes** (pure, unit-tested in `background/frames.ts`): snapshot
  concatenates nodes; text appends each sub-frame under a `--- frame f<N> (url)
  ---` marker; links concatenate (sub-frame links tagged with their frame url),
  capped at 500.
- **Fast path.** If there are no readable sub-frames, the merge path returns
  early and the plain top-frame path runs — a single-frame page pays only one
  extra `executeScript` (the enumerate) and gets byte-identical output.

## Scope (this pass)

- Reading ops (`page_snapshot`/`page_text`/`page_links`) + `page_click`/`page_fill`
  routing. Other ops (scroll/screenshot/wait/eval/storage) stay top-frame.
- **Same-origin** sub-frames. Cross-origin frames are reachable only if the user
  granted their origin (e.g. via "allow all sites") and are gated per frame.
- **Content-script backend only.** CDP mode (`cdpMode`, opt-in, off by default)
  still reads the top frame — per-frame CDP execution contexts are a separate,
  larger change.

## Alternatives Considered

### Opt-in `frames: true` param
- **Pros**: back-compat; no output change unless requested.
- **Not chosen**: the product decision was default-on for a seamless agent
  experience; the fast path keeps single-frame pages unchanged anyway.

### `chrome.webNavigation.getAllFrames`
- **Pros**: the canonical frame-enumeration API (gives frame urls directly).
- **Cons**: requires the `webNavigation` permission → a "read your browsing
  history" install warning.
- **Not chosen**: `executeScript` func-injection returns frameId + url with no
  new permission.

### Crawl frames from the content script
- **Cons**: a content script can't reach a cross-origin child document, and
  same-origin `contentDocument` crawling reimplements what per-frame injection
  gives for free (and breaks under site isolation).
- **Not chosen**.

## Consequences

### Positive
- Same-origin iframe content is now readable, and click/fill work inside those
  frames via the `f<N>:` refs — no ref collisions.
- No new manifest permission; the merge logic is pure and unit-tested.

### Negative / trade-offs
- Every read op does one extra `executeScript` (the enumerate) even on
  single-frame pages (~a few ms).
- **CDP mode is inconsistent** — it still reads the top frame only, so the
  tool descriptions' "includes sub-frames" holds for the default backend but not
  when `cdpMode` is on. Documented here; a follow-up can add per-frame CDP.
- The SW-side orchestration (inject/enumerate/dispatch) isn't covered by the
  headless-Chrome DOM test harness (which drives the content script in a single
  document); only the pure merge logic is unit-tested. End-to-end multi-frame
  behavior relies on manual / opt-in integration testing.
