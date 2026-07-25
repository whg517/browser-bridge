# ADR-0020: Remove Interactive Per-Action Confirmations

- **Status**: Accepted
- **Date**: 2026-07-24
- **Supersedes**: [ADR-0006](./0006-toast-confirmation-for-high-risk.md) (high-risk click / short-lived confirmation window), [ADR-0008](./0008-page-eval-confirmation-channel.md) (page_eval confirmation channel)

## Context

Three operations used to interrupt the AI with an in-page confirmation the user had to approve:

- **high-risk clicks** (submit buttons / navigating links) — ADR-0006
- **page_eval** (every call, with a 60s same-origin grace window) — ADR-0008
- **tab_close** (an in-page "Close tab?" prompt)

Each was individually toggleable (`confirmHighRiskClick`, `confirmPageEval`, `confirmTabClose`), and three more settings tuned their timeouts/grace window (`clickToastTimeoutMs`, `evalToastTimeoutMs`, `confirmGraceMs`).

In practice these prompts are the main obstacle to **hands-off automation**: an agent driving the browser stalls on every submit, every eval, and every tab close waiting for a human click. For workflows where the user already trusts the connected agent, the prompts add friction without adding much protection they don't already get from the other layers. The per-action confirmation is also the least consistent layer — it fires on a heuristic ("is this click high-risk?") and is easy to fatigue-click through.

Changing the confirmation model is a security-boundary change, so per [GOVERNANCE](../../GOVERNANCE.md) it is recorded as an ADR.

## Decision

**Remove the interactive per-action confirmations. These operations now run without prompting**, and the six associated settings are retired.

The security boundary is now the set of **standing** controls, not per-action prompts:

1. **Per-site allowlist ([ADR-0004](./0004-allowlist-with-optional-host-permissions.md))** — the AI can only act on origins the user has approved (or all sites, if the user explicitly opts in). This is the primary gate and is unchanged.
2. **Per-tool enable/disable (the kill switch)** — any tool can be turned off in the Options page; a disabled tool is refused with "tool disabled in settings". This is how `page_eval` (the highest-risk tool) is disabled.
3. **Always-on `page_eval` result masking** — token-like values (JWTs, long hex, long numbers, key-like strings) are redacted from every `page_eval` return value.
4. **`page_snapshot_precise` notice** — always shows an on-page notice before attaching the debugger; an informational heads-up, not a blocking confirmation.

> **Update (later):** the dedicated `pageEvalEnabled` / `evalMask` / `warnPreciseSnapshot` toggles (and the Options "Security" section) were removed. The protections above are unchanged in effect — masking and the precise-snapshot notice are now **always on** (non-optional), and `page_eval` is disabled via the general per-tool disable rather than its own switch.

`tab_close` no longer needs to render a prompt in the page, so it is no longer restricted to http(s) tabs.

The tool descriptions in `contracts/tools.json` (and the Rust catalogue + generated `ops.ts`) and the agent kickstart prompt ([`docs/agent-prompt.md`](../agent-prompt.md), embedded in the MCP `initialize` instructions) are updated to stop promising confirmations that no longer happen.

## Alternatives Considered

### A. Keep the confirmations but make them mandatory (drop only the toggles)
- **Rejected**: the request was explicitly to stop being asked; mandatory prompts would keep the friction the change is meant to remove.

### B. Keep confirmation for `page_eval` only, drop the click/tab_close ones
- A defensible middle ground (eval is the highest-risk tool). **Rejected for now** in favor of one consistent model; `pageEvalEnabled` + the allowlist already bound eval, and re-introducing a single confirmation later is cheap if warranted.

### C. Invert to an allowlist-only "trusted" mode via a global toggle
- **Rejected**: adds another mode to reason about; the allowlist already is the standing trust boundary.

## Consequences

### Positive
- **Hands-off automation works** — agents no longer stall on clicks, evals, or tab closes.
- **Simpler, more honest model** — one standing boundary (the allowlist) instead of a heuristic per-action prompt layered on top; six settings and a chunk of confirmation UI/plumbing are gone.
- Tool descriptions and the agent prompt no longer describe protections that don't exist.

### Negative / Trade-offs
- **Less defense against a misbehaving or hijacked agent.** On an already-allowlisted site, the AI can now submit forms, run arbitrary JS (if `page_eval` is enabled), and close tabs with **no per-action prompt**. The allowlist still bounds *which sites*, but not *what happens* on an approved site.
- Users who relied on the confirmations as a safety net should keep the allowlist tight (avoid "allow all sites"), disable `page_eval` when not needed, and disable any tool they don't want the agent to use.

## Relationship to Other ADRs
- **Supersedes** [ADR-0006](./0006-toast-confirmation-for-high-risk.md) and the confirmation half of [ADR-0008](./0008-page-eval-confirmation-channel.md). The `page_eval` **kill switch + masking** from ADR-0008 are retained.
- Leans on [ADR-0004](./0004-allowlist-with-optional-host-permissions.md) (allowlist) as the primary remaining boundary.
- Orthogonal to [ADR-0017](./0017-cdp-mode-all-ops.md) (CDP mode) — the CDP backend drops the same confirmations as the content path.
- See the [threat model](../security/threat-model.md) and [per-tool risk matrix](../security/tool-risk-matrix.md) for the updated posture.
