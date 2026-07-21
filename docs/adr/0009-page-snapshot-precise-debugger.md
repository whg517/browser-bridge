# ADR-0009: page_snapshot_precise uses chrome.debugger to obtain the authoritative a11y tree

- **Status**: Accepted
- **Date**: 2026-07-08
- **Supplements**: [ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md) (the v0.1 decision to default to the content script)

## Background

[ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md) decided that v0.1's `page_snapshot` defaults to a content-script approximation and does not call `chrome.debugger`, in order to avoid the infobar banner. At that time the plan was: "in phase two, add a `page_snapshot_precise` tool that attaches temporarily when locating fails."

The v0.1 content-script snapshot covers roughly 90% of scenarios, but is inaccurate in the following edge cases:
- **closed shadow DOM**: completely unreachable by the content script
- **complex ARIA**: the simplified accessible-name computation drifts (`aria-hidden` subtrees, presentational role, `aria-describedby`)
- **computedRole/computedName**: Chrome's internal AOM computation results are not exposed to JS, so the content script can only recompute them
- **cross-origin iframe**: same-origin restrictions make it unreadable

These scenarios require Chrome's **authoritative** a11y tree. The only way to obtain it is CDP's `Accessibility.getFullAXTree`.

## Decision

**Add a standalone tool `page_snapshot_precise` that uses `chrome.debugger` + CDP to obtain the authoritative a11y tree:**

| Dimension | Implementation |
|------|------|
| Trigger | Explicit invocation by the AI (no automatic fallback on failure, since failure detection is unreliable) |
| infobar handling | Before attaching, show a prompt Toast via the content script (blue tone), informing the user that "Chrome will show a debugging banner that disappears automatically shortly"; the user can cancel, and it continues automatically after a 30s timeout |
| ref system | Reuse the `data-zcb-ref` attribute, with the prefix `p` (precise) to distinguish it from the content script's `e` |
| Execution location | background.js (SW) — `chrome.debugger` can only be called in the extension context |

## Core technical flow (confirmed via protocol research)

```
chrome.debugger.attach({tabId}, "1.3")
  → Accessibility.getFullAXTree()               // each AXNode carries backendDOMNodeId
  → for each interactive node:
      DOM.resolveNode({backendNodeId})          // → RemoteObjectId
      Runtime.callFunctionOn({                  // tag the element with data-zcb-ref
        objectId,
        functionDeclaration: "function(ref){this.setAttribute('data-zcb-ref',ref); return {role:..., name:...}; }",
        arguments: [{value: ref}]
      })
  → chrome.debugger.detach({tabId})             // infobar disappears (must be in finally)
```

**Key facts (confirmed by research)**:
- Each AXNode carries `backendDOMNodeId` — this is the bridge to the DOM
- `DOM.resolveNode({backendNodeId})` returns a `RemoteObjectId`
- `Runtime.callFunctionOn` can execute JS on that node (tag attributes, read info)
- `getFullAXTree` **does not require** `Accessibility.enable()` (enable is only for keeping AXNodeId stable across calls; we already have stability via backendDOMNodeId)
- An AXNode's `role`/`name` is Chrome's authoritative computation — use it directly, no need to recompute

## Key advantage: unified ref abstraction

The `data-zcb-ref` attribute tagged by the precise snapshot uses the **exact same mechanism** as the content-script snapshot. content.js's `resolveTarget` already has a DOM-attribute fallback path:

```javascript
function resolveTarget(args) {
  if (args.ref) {
    let el = refMap.get(args.ref);                    // in-memory map (same-page content snapshot)
    if (!el) {
      el = document.querySelector(`[${REF_ATTR}="${args.ref}"]`);  // DOM-attribute fallback (precise snapshot)
    }
    ...
  }
}
```

So `page_click`/`page_fill` can operate on nodes obtained from the precise snapshot with **zero changes**. The unified ref abstraction fully decouples the two snapshot implementations.

## ref namespace isolation

The two counters would collide (the content script's `e3` and precise's `e3` point to different elements). Solution:
- content-script snapshot: `e1`/`e2`/`e3`...
- precise snapshot: `p1`/`p2`/`p3`...

With different prefixes, content.js looks up by attribute value and needs no changes.

## Alternatives Considered

### Option A: add a `precise: true` parameter to page_snapshot (no new tool)
- **Pros**: does not increase the tool count
- **Cons**: the AI may forget to add the parameter; the return structure would have to accommodate both sources
- **Not chosen**: the user chose a standalone tool for clearer boundaries

### Option B: automatic fallback on failure (auto-attach after the content snapshot fails)
- **Pros**: transparent to the AI, self-heals on failure
- **Cons**: failure detection is unreliable (a content snapshot may succeed while a click fails for an unrelated reason, which would still trigger it falsely); the debugger flash is unpredictable
- **Excluded**: the user explicitly rejected it

### Option C: attach directly without showing a prompt Toast
- **Pros**: fastest
- **Cons**: users would be confused or alarmed by an unfamiliar "debugging" banner; no informed consent
- **Not chosen**: the user chose to prompt before attaching

## infobar behavior (confirmed)

- **Displayed continuously during attach**: Chrome's top "Started debugging this browser" banner, shown on all tabs
- **Disappears after detach**
- **Cannot be closed**: except with the `--silent-debugger-extension-api` launch flag (which contradicts the project's founding goal G2)
- Within a single handler: attach → fetch the tree → tag → detach, so the infobar only flashes briefly (typically < 1 second)
- **The prompt Toast informs the user in advance**, so they are not caught off guard

## Error-handling matrix

| Situation | Handling |
|------|------|
| `chrome://`/`chrome-extension://`/webstore/`view-source:`/`about:` | Intercept upfront, return an error (the debugger cannot attach) |
| "Another debugger already attached" | Return the error "please close DevTools for this tab" |
| User clicks cancel (prompt Toast) | Do not attach, return "cancelled" |
| onDetach during tree fetch (user closes tab/navigates) | Return an error, clean up state |
| Any error | **Detach on the finally path**, to prevent the infobar from persisting |

**Key: `detach` must be on the finally path** — any error must detach, otherwise the infobar stays visible forever, a UX disaster.

## Consequences

### Positive
- **Authoritatively accurate**: Chrome's internal a11y tree, full coverage of shadow DOM / complex ARIA
- **No need to recompute role/name**: take the AXNode fields directly
- **Unified ref**: page_click/fill require zero changes
- **Informed consent**: the prompt Toast lets the user anticipate the infobar

### Negative
- **The infobar always appears**: even if it only flashes, it is visible on all tabs
- **Conflicts with DevTools**: fails when the tab already has DevTools open
- **Unavailable on pages like chrome://**: a built-in restriction
- **Complex CDP flow**: multi-step async callbacks, and a failure at any step must reliably detach
- **Slightly slower execution**: multiple CDP commands; compared with the content script's < 50ms, precise may take 200-500ms

### Neutral
- The precise snapshot uses `p`-prefixed refs, isolated from content's `e` prefix

## Implementation

- `extension/manifest.json`: add the `debugger` permission
- `extension/background.js`: `snapshotPrecise(tabId)` function, full CDP flow + error handling
- `extension/content.js`: `showInfoToast` + `page_snapshot_precise_info` case
- `extension/toast.css`: `.zcb-info-card` blue tone
- `src/tools.rs`: tool definition + dispatch

## Relationship to Other ADRs

- **Supplements [ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md)**: ADR-0003 decided to default to the content script (avoiding the infobar); this ADR provides an explicit precise fallback path. The two coexist: use `page_snapshot` day-to-day (no infobar), and use `page_snapshot_precise` when authority is needed (infobar flash + prompt)
- **Differs from [ADR-0008](./0008-page-eval-confirmation-channel.md)**: the eval Toast is a high-risk confirmation (deny by default, requires an active Allow), whereas precise's info Toast is an informational prompt (continue by default, requires an active cancel)
