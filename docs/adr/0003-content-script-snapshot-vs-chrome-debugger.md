# ADR-0003: snapshot via content script instead of chrome.debugger

- **Status**: Accepted
- **Date**: 2026-07-07

## Background

One of browser-bridge's core capabilities is `page_snapshot`: it returns the page's accessibility tree (a11y tree), letting the AI reference elements via a stable `ref` (like Playwright/chrome-devtools-mcp do). The **accuracy of the snapshot directly determines the stability of the subsequent click/fill** — this is the linchpin of the entire system.

There are two implementation paths:

1. **chrome.debugger API**: attach to the tab, call `Accessibility.getFullAXTree` over CDP, and obtain Chrome's internal authoritative a11y tree.
2. **content script**: inject JS, walk the DOM with a TreeWalker, and recompute role/accessible-name ourselves.

Investigation (see the architecture investigation report for details) uncovered a decisive constraint.

## Decisive constraint: chrome.debugger forces an infobar

**As soon as the extension calls `chrome.debugger.attach`, Chrome forcibly displays a "Started debugging this browser" banner at the top of every tab.**

- It cannot be dismissed from inside the extension (a hard-coded Chromium security feature).
- The only way around it is to launch Chrome with the `--silent-debugger-extension-api` command-line flag — **which puts us right back on the "specially launched Chrome" path, contradicting the project's core goal G2 (zero special launch)**.
- The banner shows on every tab (not just the target tab), and it shifts the viewport down by about 30px, breaking coordinate-based positioning.
- Enterprise forced installation (ExtensionInstallForcelist) can suppress it in some scenarios, but that requires an enterprise policy and does not apply to individual users.

This finding was confirmed through investigation during technology selection, when the user clearly stated that "the whole point of building an extension is to not have to specially launch Chrome every time."

## Decision

**In v0.1, snapshot defaults to the content script and does not call chrome.debugger:**

- Walk visible elements with `TreeWalker(SHOW_ELEMENT)`.
- Recompute `role` (prefer `getAttribute('role')`, otherwise map by tag: `button→button`, `a[href]→link`, `input→textbox/checkbox/...`).
- Recompute the `accessible name` (a simplified accname-1.2: `aria-label` → `aria-labelledby` resolution → `<label for>` → `title` → truncated innerText).
- Tag every meaningful node with `data-zcb-ref="eN"`, storing the mapping in the content script's closure.
- Return a slimmed-down tree: interactive nodes only + a selector fallback.

**Phase-two addition**: add a `page_snapshot_precise` tool that, when positioning fails, has the SW temporarily attach → fetch `Accessibility.getFullAXTree` → detach immediately. The infobar will flash during this window, and **this will be clearly disclosed to the user in the tool description**.

## Alternatives Considered

### Option A: pure chrome.debugger (accept the infobar)
- **Pros**: authoritative and accurate a11y tree; shadow DOM automatically included; coverage close to 100%.
- **Cons**: the infobar is permanently displayed; you either put up with it (poor user experience, viewport shift breaks automation) or add a launch flag (violates G2).
- **Excluded**: conflicts with the project's core goal.

### Option B: default to content script, temporarily attach the debugger when positioning fails (the user's final choice)
- **Pros**: no infobar day-to-day; a fallback for edge cases.
- **Cons**:
  - Medium implementation complexity (must handle attach/detach timing and error recovery).
  - The user will intermittently see the infobar flash (already committed to disclosing this in the design).
- **v0.1 status**: the content script part is implemented; the debugger fallback is deferred to phase two.

### Option C: pure content script (alternative, not selected)
- **Pros**: no infobar; zero perceptible impact on the user; no special launch needed.
- **Cons**: cannot read shadow DOM; recomputing complex ARIA drifts; about 10% of edge cases are inaccurate.
- **Not selected**: the user chose Option B and wanted a debugger fallback.

## Consequences

### Positive
- **Zero infobar day-to-day**: the debugger is never called, so the user notices nothing.
- **Does not violate G2**: no special launch of Chrome required.
- **About 90% coverage**: sufficient for everyday interactions (button/input/link/menuitem).

### Negative
- **Cannot read shadow DOM**: a closed shadow root is entirely unreachable; an open shadow root requires dedicated traversal (not implemented in v0.1).
- **Complex ARIA is inaccurate**: for edge cases such as aria-hidden subtrees, presentational roles, and `aria-describedby`, the simplified computation drifts.
- **Non-authoritative accessible name computation**: Chrome's internal `element.computedRole`/`computedName` (AOM) are not exposed to JS, so the content script must recompute them, which diverges from Chrome's actual tree.
- **Cross-origin iframes**: the content script cannot read them due to the same-origin restriction.
- **Phase-two debugger fallback**: requires the extra implementation of `page_snapshot_precise` plus handling the attach/detach lifecycle.

## Implementation details (v0.1)

- The `snapshot()` function in `extension/content.js`.
- `INTERACTIVE_TAGS` / `INTERACTIVE_ROLES` decide which nodes enter the tree.
- The respective approximation logic of `roleOf()` / `nameOf()` / `isVisible()` / `cssSelectorOf()`.
- refs are stored as a DOM attribute + a content script Map, so they can be rebuilt from the DOM after the SW restarts.

## Known test gaps

- The DOM operations in content.js (snapshot/click/fill) **have not yet been run on a real page** — the protocol-layer e2e tests PASS, but the DOM layer awaits real-world testing after the user loads the extension.
- Shadow DOM support and complex-ARIA accuracy need to be validated on real pages before deciding the priority of the phase-two debugger fallback.

## See Also

- Investigation: the Chrome infobar is hard-coded in Chromium (`chrome/app/generated_resources.grd`), and `--silent-debugger-extension-api` is the only way around it.
- Playwright aria snapshots and chrome-devtools-mcp both use CDP for exactly this reason.
- AOM's `computedRole`/`computedName` are not exposed to content script JS, so they can only be recomputed.
