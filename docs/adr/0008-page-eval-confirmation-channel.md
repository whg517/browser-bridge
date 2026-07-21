# ADR-0008: page_eval High-Risk Confirmation Channel

- **Status**: Accepted
- **Date**: 2026-07-07
- **Supersedes**: [ADR-0005](./0005-page-eval-disabled-by-default.md) (the decision not to implement in v0.1)

## Context

[ADR-0005](./0005-page-eval-disabled-by-default.md) decided that v0.1 would not implement `page_eval` at all. The rationale was that the attack surface was too large — arbitrary JS execution can steal tokens and cookies, and issue requests as the user. v0.1 first stabilized the base architecture and security model.

v0.1 has shipped and been verified (protocol-layer e2e PASS), and we have entered phase two. We now need to add `page_eval`, but it must satisfy the preconditions ADR-0005 set at the time: **a high-risk confirmation channel + return-value redaction**.

## Decision

**Implement `page_eval` using an enlarged in-page Toast confirmation + a 60s same-origin confirmation-free window + configurable return-value redaction (on by default):**

| Dimension | Implementation |
|------|------|
| **Confirmation UI** | Enlarged in-page Toast (a warning color scheme that distinguishes it from the regular Toast), showing the full code (`<pre>`, scrollable) + target domain + tab title + Allow/Deny, with a 30s timeout that denies |
| **Confirmation-free window** | Reuse the existing `lastConfirmed` mechanism, key = `${origin}:eval`; after approval, same-origin eval no longer prompts for 60 seconds |
| **Execution method** | `new Function('"use strict"; return (async () => { <code> })()')()` — global scope, supports await/return |
| **Return-value redaction** | content.js redacts **before** the result leaves the page context (avoiding raw tokens traveling through the IPC chain). Regexes cover JWT / long hex / long numbers / sensitive keywords, processed recursively. The switch is stored in `chrome.storage.local` (`evalMask`), defaults to true, and can be turned off in the popup |

## Alternatives Considered

### Option A: Dedicated extension window (chrome.windows.create)
- **Pros**: Not disturbed by page CSS; long code can be seen in full
- **Cons**: Complex to implement (SW ↔ window communication); an extra window interrupts the flow; the window may be obscured
- **Not chosen**: The user chose the in-page Toast; reusing the existing mechanism is lighter

### Option B: Confirm on every eval (no confirmation-free window)
- **Pros**: Most secure
- **Cons**: Consecutive evals are annoying; eval should not be high-frequency, but debugging scenarios may execute it in succession
- **Not chosen**: The user chose the 60s same-origin confirmation-free window, consistent with the existing Toast mechanism

### Option C: A popup pre-authorization switch (all evals silent once checked)
- **Ruled out**: The attack surface returns to the "fully open" level, defeating the purpose of high-risk confirmation

### Alternatives for return-value redaction
- **No redaction**: Simplest to implement, but tokens/cookies/keys may enter the AI context and logs, a large leak risk
- **Mandatory redaction**: Most secure, but occasionally hits legitimate data by mistake
- **Configurable (on by default)**: The user chose this, balancing flexibility and security

## Technical Choice for the Execution Method: the Function Constructor

**Why not `eval(code)`**:
- eval is constrained by the scope of its call site (calling eval inside the content script closure cannot see the page's global variables)
- In strict mode, eval has its own scope, and assignments do not leak outward

**Why `new Function`**:
- Executes in the global scope, able to access the page globals (variables on window, framework APIs)
- Supports `return` and `await` (wrapped as an async IIFE)
- Wrapping: `new Function('"use strict"; return (async () => { ' + code + ' })()')()`

**Known limitations**:
- Hard to reliably set an execution timeout (once the Function constructor is running, JS is single-threaded and cannot be interrupted externally). Left for the future
- A code syntax error will throw a `SyntaxError` at call time; needs try/catch and returning the error message

## Edge Cases in Return-Value Serialization

eval may return any type, and `serializeResult` needs to handle them safely:

| Type | Handling |
|------|------|
| Circular-reference object | Tracked with a WeakSet; when an already-visited object is seen, replace it with `"[Circular]"` |
| DOM node | Replace with `"<Element tag#id>"` |
| Error | Serialize as `{name, message, stack?}` |
| Symbol / BigInt / function | `.toString()` |
| Promise | Auto-await (already wrapped as async) |
| Oversized (>10KB) | Truncate + `"[truncated]"` |

## ⚠️ Risk Note: the confirmation-free window is riskier for eval than for click

**A 60s same-origin confirmation-free window means**: after the user approves the first eval, **a completely different second eval will execute silently** within 60 seconds.

Compared with the click scenario: click's "same-kind actions" (for example clicking 5 links in a row) are at least similar operations; eval's two calls are **entirely unrelated** — the first might be `document.title`, and the second might be `fetch('/transfer', {...})`.

**Reasons for accepting this risk**:
1. eval should not be used at high frequency (the tool description forces the AI to try page_click/page_fill first)
2. When the user approves the first one, they are already looking at the full code and are informed
3. If genuinely worried, one can disable the entire eval capability in the popup (left as a future switch; this proposal does not do it)

This risk is explained to the AI in the tool description, and is also noted in the security-model table in the README.

## Update (2026-07-15): added a toggle switch `confirmPageEval` (on by default)

This ADR originally **ruled out**, under "Option C", the "silent eval after pre-authorization". In practice, browser-bridge's core scenario is exactly **letting the AI drive the browser fully automatically**, and having to manually click "Allow" on every `page_eval` interrupts automation (`tab_close` likewise). We therefore added two settings (both defaulting to **true**, preserving the original "confirm every time" behavior):

| Setting | When turned off | Default |
|------|--------|------|
| `confirmPageEval` | `page_eval` no longer prompts for confirmation, executing arbitrary JS directly | On |
| `confirmTabClose` | `tab_close` no longer prompts "Close tab?" | On |

The difference from the originally ruled-out "Option C" — and also the reason for accepting it:
1. **On by default** — does not change any existing user's security posture; the user must **actively** turn it off.
2. **A prominent warning on the Options page** — the card for turning off `confirmPageEval` clearly states "the AI will execute arbitrary JS directly with no prompt"; this is an **informed** choice.
3. **Consistency** — the three high-risk categories (click / eval / close tab) now each have their own confirmation switch (`confirmHighRiskClick` / `confirmPageEval` / `confirmTabClose`), with unified semantics, no longer the split of "click can be turned off, eval cannot".
4. The allowlist (site level) and `pageEvalEnabled` (master switch) — the two gates — are unaffected.

Turning off `confirmPageEval` is equivalent to returning to the attack surface of "arbitrary JS executing with no prompt" — this is noted both in the switch warning and in this section, and is left to the user's own judgment.

## Consequences

### Positive
- **Capability completeness**: Complex interactions (CustomEvent, SPA routing, reading JS variables, canvas) become achievable
- **Redaction prevents leaks**: Return values are processed before leaving the page, tokens do not travel through the IPC chain
- **Reuse of existing mechanisms**: Toast + lastConfirmed + storage switch, keeping the code increment manageable

### Negative
- **Increased attack surface**: An arbitrary-JS-execution capability is introduced; even with confirmation, a single mistaken approval leaks
- **Confirmation-free window risk**: As described above, higher than the click scenario
- **Redaction may hit legitimate data**: Long numeric IDs and legitimate long hex (such as hash values) get masked; the user can turn off the switch
- **No execution timeout**: An infinite-loop eval will hang the tool call (the 120s session timeout is a backstop, but the page freezes)

### Neutral
- page_eval is not ranked near the top of the default `tools/list` order, and its description forces the AI to use it cautiously

## Implementation

- `src/tools.rs`: add the Tool definition + dispatch branch
- `extension/content.js`: `runEval()` + `confirmWithEvalToast()` + `serializeResult()` + `maskSensitive()` + `getMaskSetting()`
- `extension/toast.css`: `.zcb-eval-card` / `.zcb-eval-code` / `.zcb-eval-meta` warning color scheme
- `extension/popup.html/js`: the redaction switch
- Docs: requirements FR-3 adds page_eval; architecture §7 supplements the Function choice

## Relationship to Other ADRs

- **Supersedes [ADR-0005](./0005-page-eval-disabled-by-default.md)**: ADR-0005's "not implemented in v0.1" decision is overturned by this ADR; ADR-0005's status changes to Superseded by #0008
- **Works with [ADR-0006](./0006-toast-confirmation-for-high-risk.md)**: Reuses the Toast mechanism, but eval's Toast is larger, shows code, and uses a warning color scheme
- **Works with [ADR-0004](./0004-allowlist-with-optional-host-permissions.md)**: The allowlist is still the first layer (site level), and the eval Toast is the action-level second layer
