# ADR-0006: In-Page Toast + Short-Lived Confirmation-Free Window for High-Risk Actions

- **Status**: Accepted
- **Date**: 2026-07-07

## Context

Even after a user has authorized a site via the allowlist ([ADR-0004](./0004-allowlist-with-optional-host-permissions.md)), that site can still contain "high-risk actions" — actions that may cause irreversible side effects:

- **Form submissions** (clicking a `type=submit` button): placing orders, transferring funds, publishing, deleting
- **Link navigation** (clicking `<a href>` / role=link): navigating to a new page, which may trigger server-side operations (even GET requests can mutate data)
- **Closing a tab on a high-risk domain**: accidentally closing a bank or admin console

If the AI executes these actions silently, the user may have no idea what happened. A secondary confirmation mechanism is needed.

## Decision

**Use an in-page toast confirmation + a 60-second same-origin, same-type confirmation-free window:**

1. **Trigger point**: before performing a click, the content script calls `confirmWithToast()` if the target is a submit/link-type element
2. **Toast UI**: inject a card in the top-right corner of the page, showing "Browser Bridge / Click 'xxx'?" plus Allow/Deny buttons
3. **Timeout**: automatically Deny after 30 seconds of no response (to prevent tool calls from hanging forever)
4. **Confirmation-free window**: after the user clicks Allow, the same origin + same action type will not prompt again for 60 seconds (to avoid annoying back-to-back confirmations)
5. **Closing tabs**: in the background's `tab_close`, first send a confirmation toast to the target page, and only close it after the user allows

## Alternatives Considered

### Option A: Dedicated confirmation window (standalone popup window)
- **Mechanism**: pop up a standalone window for every high-risk action, listing the action details
- **Pros**: highest level of safety; the large UI space can display complete information
- **Cons**: heavyweight experience — every high-risk action requires switching over to click a confirmation, interrupting the AI workflow
- **Not chosen**: the user chose the toast (lightweight). The dedicated window is reserved for future high-risk confirmation of `page_eval` ([ADR-0005](./0005-page-eval-disabled-by-default.md))

### Option B: In-page toast + short-lived confirmation-free window (chosen by the user)
- **Pros**: lightweight experience; back-to-back operations of the same type are not annoying
- **Cons**: may be missed (the toast is in a corner); within the 60-second window, back-to-back high-risk AI actions are no longer confirmed
- **v0.1 implementation**

### Option C: Risk tiering (silent for low-risk / confirm for high-risk)
- **Mechanism**: within an authorized domain, low-risk actions (ordinary clicks/form filling) are silent; only high-risk ones (eval, submit, navigation) prompt
- **Pros**: best balance point
- **Cons**: high implementation complexity (a risk-tiering table must be maintained)
- **Not chosen**: the user chose Option B at the time, but Option C is actually the natural evolution of Option B (the v0.1 implementation already implies tiering — only submit/link triggers a toast, while ordinary clicks are silent)

## Consequences

### Positive
- **Lightweight experience**: the toast does not steal focus, so the user can keep working
- **Prevents permanent hangs**: the 30-second timeout denial ensures tool calls do not lock up
- **Friendly to back-to-back operations**: the 60-second confirmation-free window means, for example, clicking 5 links in a row will not prompt 5 times

### Negative
- **May be missed**: the toast is in a corner, so a user whose attention is elsewhere may miss it
- **60-second window risk**: within the window, if the AI is induced into performing high-risk actions back to back, only the first is confirmed; this is an experience/safety trade-off
- **Click layer only**: currently only click is gated; there is no gating of a form's Enter submit or a JS-triggered submit (to be added in phase two)

## Implementation Details

`extension/content.js`:

```javascript
// Determine high-risk
function isHighRiskClick(el) {
  const role = roleOf(el);
  if (role === "button" && (el.getAttribute("type") || "").toLowerCase() === "submit") return true;
  if (el.tagName === "A" && el.hasAttribute("href")) return true;
  if (role === "link") return true;
  return false;
}

// Confirmation-free window
let lastConfirmed = { key: null, until: 0 };
async function confirmWithToast(question, actionDesc) {
  const key = `${location.origin}:${actionDesc}`;
  if (lastConfirmed.key === key && Date.now() < lastConfirmed.until) return; // within window
  const approved = await showToast(question);
  if (!approved) throw new Error(`user denied: ${actionDesc}`);
  lastConfirmed = { key, until: Date.now() + 60_000 };
}
```

- `showToast()`: injects a DOM card, the Promise resolves true/false
- The card styles are in `toast.css`; the key styles are also inlined in `ensureToastHost()` (in case toast.css did not load)
- The z-index is extremely high (2147483647) to ensure it stays on top

## Known Limitations (phase-two improvements)

1. **Only gates click**: a form's Enter submit and `form.submit()` JS calls are not intercepted
2. **Not aware of SPA routing**: "soft navigations" via pushState/replaceState do not trigger it (the user perceives a navigation, but it is not intercepted)
3. **Confirmation-free key granularity**: currently `origin:actionType`; in the future `origin:actionType:targetSelector` could be considered for finer granularity
4. **Toast can be interfered with by page CSS**: although a high z-index + inlined key styles are used, in extreme cases a page may override them with `!important`

## Relationship to Other ADRs

- Works together with [ADR-0004](./0004-allowlist-with-optional-host-permissions.md): the allowlist is the first layer (site level), and the toast is the second layer (action level)
- Differs from [ADR-0005](./0005-page-eval-disabled-by-default.md): the toast is used for UI actions (click/fill), whereas page_eval, if implemented, would need stronger confirmation (a dedicated window)
