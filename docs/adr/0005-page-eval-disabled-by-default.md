# ADR-0005: page_eval Disabled by Default

- **Status**: Superseded by [ADR-0008](./0008-page-eval-confirmation-channel.md)
- **Date**: 2026-07-07

> **Superseded**: This ADR decided that "v0.1 will not implement page_eval." After v0.1 shipped, work moved into phase two, and
> [ADR-0008](./0008-page-eval-confirmation-channel.md) implemented the high-risk confirmation channel for page_eval.
> This document is kept as a historical record of the trade-offs and attack-surface analysis made at the time (which remain valid).

## Context

`page_eval` — executing arbitrary JavaScript in the page context — is **the most powerful and the most dangerous** capability in browser automation.

Why it is powerful: it can do almost anything (read JS variables, dispatch custom events, call page APIs, bypass the UI and act directly).

Why it is dangerous: **as soon as the AI's instructions are subverted (prompt injection), it can, inside a page where the user is already logged in**:
- Steal tokens from `localStorage` / `sessionStorage`
- Read `document.cookie` (obtainable as long as the extension has host permission)
- Call the page's fetch/XHR to send requests as the user (transfer money, delete data)
- Read any sensitive information in the DOM (credit card numbers, private message contents)

This is far more dangerous than `page_click` / `page_fill` — the latter two are at least observable at the UI level (the user can see the click/input happen), whereas `eval` is silent.

## Decision

**v0.1 does not implement the `page_eval` tool at all.**

It will be added in phase two, and only if it satisfies:
1. Goes through a **dedicated high-risk confirmation channel** (distinct from the in-page Toast of [ADR-0006](./0006-toast-confirmation-for-high-risk.md); it may need stronger confirmation, such as a standalone window showing the full JS code)
2. Redacts return values by default (masks suspected tokens / long strings)
3. Forces the AI to explain in the tool description why eval is needed (making the model explicitly acknowledge the risk)

## Alternatives Considered

### Option A: Implement eval, high-risk confirmation (the "disabled by default, requires high-risk confirmation" option chosen at decision time)
- **Mechanism**: The tool exists, but every call goes through the confirmation channel
- **Pros**: Full capability, usable when needed
- **Cons**: Introduces the largest attack surface right in v0.1
- **v0.1 handling**: The user chose this direction, but **for the v0.1 implementation we simply do not implement it**, deferring the design of the "high-risk confirmation channel" to phase two. The rationale is that v0.1's 11 tools already cover 90% of scenarios, eval is not required; get the base architecture and security model running solidly first

### Option B: Fully disabled, never implement
- **Pros**: Permanently eliminates the largest attack surface
- **Cons**: Powerless against complex interactions (dispatching custom events, reading JS variables, SPA routing)
- **Not chosen**: The user chose "disabled by default + high-risk confirmation," which implies accepting conditional access

### Option C: Open up eval with no special confirmation
- **Pros**: Maximum capability, simplest to implement
- **Cons**: Largest attack surface, violates the security-first principle
- **Excluded**: The user explicitly did not choose it

## Consequences

### Positive (v0.1)
- **Minimal attack surface**: v0.1's tools are all "observable UI actions," with no silent code execution
- **Simple to audit**: No need to design eval's redaction / confirmation / sandbox
- **Clear security model**: click/fill are constrained by the Toast, snapshot/text are read-only and redacted

### Negative
- **Cannot handle complex interactions**: Powerless in scenarios that require dispatching a `CustomEvent`, reading framework state, or operating canvas/WebGL
- **Must be filled in during phase two**: Designing the high-risk confirmation channel is a chunk of work

### Neutral
- v0.1's `page_click` / `page_fill` already use a native setter + dispatchEvent, which covers the forms of mainstream frameworks like React/Vue; most automation scenarios do not need eval

## Phase-Two Design Draft (Not Implemented)

If `page_eval` were implemented, the design would roughly be:
- New tool `page_eval(code)`, executing against the current tab by default
- On invocation the content script pops a **standalone confirmation window** (not a Toast), showing:
  - The full JS code (scrollable)
  - The target domain + tab title
  - "Execute" / "Reject" buttons, with a 30-second timeout defaulting to reject
- Return values are redacted before being sent back to MCP (regex-masking suspected JWTs, long hex, long numbers)
- The tool description forces the AI to state "why eval is needed instead of click/fill"

This design is **not a commitment**; it may change when phase two is implemented.

## Relationship to Other ADRs

- Works with [ADR-0004](./0004-allowlist-with-optional-host-permissions.md) (allowlist): the allowlist guards against unfamiliar sites, while disabling eval guards against code execution on already-authorized sites
- Works with [ADR-0006](./0006-toast-confirmation-for-high-risk.md) (Toast): the Toast governs UI actions, while eval (if implemented) needs stronger confirmation
