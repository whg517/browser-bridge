# ADR-0017: CDP Mode — All page operations can optionally go through chrome.debugger

- **Status**: Accepted
- **Date**: 2026-07-15
- **Relationship**: [ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md) (default goes through content script), [ADR-0009](./0009-page-snapshot-precise-debugger.md) (precise uses CDP at a single point), [ADR-0008](./0008-page-eval-confirmation-channel.md) (page_eval confirmation channel)

## Background

On the default path, page-level operations (snapshot / click / fill / text / screenshot / scroll / wait_for / eval / storage_get) are executed by the background injecting a content script and then dispatching through `chrome.tabs.sendMessage` (the decision in ADR-0003: avoid chrome.debugger's "You are debugging this browser" banner).

This path has a hard limitation: **strict-CSP sites** (such as Bing, GitHub, and others that set `script-src` without `unsafe-eval`) block `new Function` / `eval` inside the content script, causing `page_eval` to fail outright. ADR-0009 already proved that chrome.debugger's `Runtime.evaluate` executes in the page's **MAIN world** and is not constrained by the page's CSP (because it is not the page itself doing the eval, but the debugger performing the evaluation). ADR-0009 only used CDP for a single tool, `page_snapshot_precise` (attach → grab tree → detach, so the banner only flashes briefly).

Requirement: provide a **global switch** that makes **all** page operations go through CDP instead, so that:

- `page_eval` can also run on strict-CSP sites;
- deep control is consistent with the "Started debugging this browser" banner behavior (everything uniformly goes through MAIN world).

## Decision

**Add a user setting `cdpMode` (default `false`). When enabled, dispatch routes all page-level operations to the CDP backend; when disabled, behavior is byte-for-byte identical to today (still goes through content script).**

The implementation is organized around three patterns (`extension/src/background/`):

| Role | Module | Responsibility |
|------|------|------|
| **Strategy** | `page-backend.ts` | `PageBackend` interface + `selectBackend(cdpMode)`; two implementations: `ContentScriptBackend` (existing path, extracted as-is) and `CdpBackend` |
| **Facade** | `cdp/session.ts` | `CdpSession` wraps `chrome.debugger` for a single tab; `attach/detach/send/evaluate/screenshot`; also exports `dbgAttach/dbgDetach/dbgSend/isDebuggable` for reuse by precise.ts (DRY) |
| **Registry** | `cdp/registry.ts` | `CdpSessionRegistry` singleton, `Map<tabId, CdpSession>`; lazily attaches and **keeps the session alive** (the banner stays up for the duration of CDP mode, by design); tears down on tab close / onDetach / `cdpMode` disabled |
| **Portable page functions** | `cdp/page-fns.ts` | Self-contained functions (no imports, no closures over module scope) that are `toString()`-ed and executed in the page via `Runtime.evaluate`, faithfully porting the DOM logic of each content op one by one |

Key design points:

- **Unified ref**: CDP's `page_snapshot` runs the **same DOM traversal algorithm** as `content/snapshot.ts` (not the AX tree — that is `page_snapshot_precise`), stamping the **same `data-zcb-ref="eN"`** attribute. As a result, the refs from the CDP and content paths are fully interchangeable, and `page_click`/`page_fill` can resolve them simply by looking up the DOM attribute.
- **Confirmation without a content script**: the confirmation toasts for high-risk click and `page_eval` are built and resolved inside the page via `Runtime.evaluate` (`awaitPromise:true`), which resolves the user's choice; because CDP mode does not inject `toast.css`, the toast styling is inlined. The settings barriers (`confirmHighRiskClick`/`pageEvalEnabled`/`evalMask`), the 60s same-origin confirmation grace period (`confirmGraceMs`), and the `isHighRiskClick` determination all match the content path, with the grace-period state kept in the SW.
- **Serialization/redaction**: `page_eval` retrieves the value via CDP `returnByValue`, then redacts it in the SW by reusing `shared/masking.ts`; `storage_get` reads the raw value in the page and redacts in the SW (always on, ADR-0010).
- **screenshot**: under CDP, `Page.captureScreenshot` is preferred and the page function is not used.
- **DRY**: `precise.ts` is changed to import `dbgAttach/dbgDetach/dbgSend/isDebuggable` from `cdp/session.ts`, removing the private copy, with no behavior change.
- **contracts unchanged**: this is an execution-path switch, not a tool-contract change; neither `contracts/` nor the tool definitions are modified.

## Alternatives Considered

### Option A: Only route `page_eval` through CDP on CSP sites (everything else unchanged)
- **Pros**: minimal change, banner only flashes during eval
- **Cons**: snapshot/click/fill still run in the content world, so the ref system has to shuttle back and forth between the two paths; "CSP site" detection is unreliable (requires failing first and then falling back); users cannot predict "when does which path get used"
- **Not chosen**: the requirement is a **unified** deep-control switch, not a per-tool patch

### Option B: Go through CDP by default (drop the content script path)
- **Pros**: a single implementation, no dual paths
- **Cons**: the banner is **permanently present**, the access surface grows, and it contradicts the default trade-off of ADR-0003; the vast majority of sites do not need a CSP bypass
- **Not chosen**: the default must remain the content script, with no banner

### Option C: Bundle the page logic into one big string maintained by hand
- **Cons**: high risk of drifting away from the content source
- **Not chosen**: instead we "export the real TS functions + `toString()`", validated by tsc/eslint/prettier, with self-containment verified at build time

## Consequences

### Positive
- **CSP bypass**: strict-CSP sites (Bing, etc.) can also run `page_eval`
- **Unified deep control**: all page ops go through MAIN world; refs are interchangeable with the content path
- **DRY**: the `chrome.debugger` primitives live in a single place (`cdp/session.ts`), reused by precise
- **Zero regression by default**: when `cdpMode` is disabled, dispatch goes through the original `ContentScriptBackend`, byte-for-byte equivalent

### Negative (security trade-offs)
- **Persistent banner**: during CDP mode, the session stays attached and the "You are debugging this browser" banner is shown continuously (visible on all tabs) — this is a deliberate, informed signal
- **Larger access surface**: the debugger is attached the whole time, so the theoretical attack surface is larger than precise's "attach-and-go"
- **CSP is bypassed**: page_eval can run even on strict-CSP sites (this is exactly the goal, but it means one layer of defense-in-depth is removed)
- **Serialization differences**: CDP `returnByValue`'s serialization is not fully identical to content's `serializeResult` (see "Risks"), but both are redacted through the same `maskSensitive`
- **Performance**: multiple `Runtime.evaluate` round trips are slightly slower than content's single `sendMessage`

### Neutral
- Off by default; enabled explicitly by the user on the Options page only when a CSP bypass or unified deep control is needed
- Tabs with DevTools already open cannot be attached (same limitation as precise)

## Implementation

- `extension/src/background/page-backend.ts`, `backends/content-script.ts`, `backends/cdp.ts`
- `extension/src/background/cdp/{session,registry,page-fns,click-risk}.ts`
- `extension/src/background/dispatch.ts`: the page block is changed to `selectBackend(cdpMode).run(op, args, tab)`
- `extension/src/background/precise.ts`: reuses the primitives from `cdp/session.ts`
- `extension/src/background.ts`: calls `installCdpLifecycleListeners()` at startup
- `extension/src/shared/{types,settings}.ts`: add `cdpMode` (default false)
- `extension/options.html` + `options.ts`: add an "Execution Mode" settings card
- Unit tests: `selectBackend`, `isHighRiskClick`/`describeAction`/`describeForToast`, `isDebuggable`, `buildEvaluateExpression`, page-fn self-containment
