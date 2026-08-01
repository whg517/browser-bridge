# ADR-0025: `page_eval` requires CDP mode; the failure is relayed, not escalated

- **Status**: Accepted
- **Date**: 2026-08-01
- **Corrects**: [ADR-0017](./0017-cdp-mode-all-ops.md)

## Context

`page_eval` runs `new Function` inside the content script. A live 16-tool sweep
found it failing **on every page tested** — including `https://example.com` and
a local fixture, neither of which sends any CSP at all — with:

```
EvalError: Evaluating a string as JavaScript violates the following Content
Security Policy directive: script-src 'self' 'wasm-unsafe-eval'
'inline-speculation-rules' http://localhost:* http://127.0.0.1:* …
```

That policy is not any page's. It is **Chrome's default CSP for the extension
itself**, and under MV3 the content script's isolated world is governed by the
*extension's* CSP rather than the page's ([Chrome docs][docs]: the page's CSP
applies only when a content script is injected into the main world). It permits
`'wasm-unsafe-eval'` but not `'unsafe-eval'`, so `new Function` throws there
unconditionally.

Confirmed by experiment — three pages differing **only** in their CSP:

| page's own CSP | `page_eval` |
|---|---|
| none | blocked |
| `script-src 'self' 'unsafe-eval'` (explicitly permits eval) | blocked |
| `script-src 'self'` | blocked |

If the page's policy governed, the middle row would have succeeded.

**This corrects the premise of ADR-0017**, which described the limitation as
affecting "strict-CSP sites (such as Bing, GitHub)". The real scope is every
site, for every user: with `cdpMode` off — the shipped default — `page_eval` has
never been able to work. The existing suites miss it because `dom_test.ts`
injects `content.js` into the **main world** via CDP, where the fixture's
(absent) CSP applies and `new Function` is therefore fine.

So `page_eval` is not a tool with an edge case; it is a tool with a
prerequisite, and nothing told anyone that.

## Decision

**`page_eval` requires CDP mode. When it is off, the call fails with a message
written to be relayed to the operator by the agent — the extension does not turn
anything on by itself.**

- The block is classified in `shared/csp-eval.ts` and thrown (not returned as an
  `__evalError` payload, which reads like a result), so it surfaces as a tool
  error. Ordinary JS faults in the caller's code still come back as data.
- The message names the remedy in operator terms and instructs the agent to
  **stop and ask** rather than retry or route around it.
- The same prerequisite is stated in three other places the agent or user
  actually reads: the tool's own description in `contracts/tools.json`, the MCP
  `instructions` payload (`docs/agent-prompt.md`), and the Options-page copy for
  the CDP-mode toggle.

### Alternative considered: escalate automatically

Catch the block in the service worker and re-run that one call through
`chrome.debugger` (attaching for the duration, then detaching). Implemented and
tested end-to-end, then **rejected**:

- **It escalates privilege on the agent's initiative.** `chrome.debugger` is a
  strictly larger surface than a content script, and the trigger would be a
  model deciding to call `page_eval` — not the operator deciding to grant it.
  Turning on the debugger is the operator's call to make.
- **The consent prompt that would make it visible costs more than it's worth.**
  An in-page toast (the mechanism `page_snapshot_precise` uses) auto-proceeds
  after 8s, which measured at ~10s per eval against a 2–4s baseline. Caching the
  consent needs `chrome.storage.session`, because MV3 recycles the service
  worker between calls and in-memory state does not survive. That is a lot of
  machinery, and a prompt in the page, to soften something the operator can
  simply switch on once.
- **It splits the mental model.** With it, `page_eval` sometimes attaches a
  debugger and sometimes doesn't, for reasons invisible from the outside — the
  same unpredictability ADR-0017 rejected in its own Option A.

Being told plainly "turn this on to use this tool" is better than the tool
quietly granting itself more access.

## Consequences

### Positive
- No privilege escalation the operator didn't ask for; `cdpMode` remains the
  single, explicit switch for debugger-backed control (ADR-0017 intact).
- The prerequisite is discoverable before the failure (tool description, MCP
  instructions, Options copy) and actionable at the failure.
- No in-page prompt, no per-call latency, no session-scoped consent state.

### Negative / trade-offs (accepted)
- **`page_eval` does not work out of the box.** A user who never opens the
  Options page cannot use it at all; they get an explanation instead of a
  result. This is the honest state of affairs — it was already true, silently,
  before this ADR.
- Enabling CDP mode is coarser than a per-call attach: it routes *all* page ops
  through the debugger and keeps the banner up while on.

[docs]: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
