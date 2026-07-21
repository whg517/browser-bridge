# ADR-0018: Group AI Tabs Into a "Browser Bridge" Group (Workspace)

- **Status**: Accepted
- **Date**: 2026-07-16

## Background

browser-bridge drives the user's **real browser**, so the tabs the AI opens with `tab_open` get mixed in with the user's own tabs. They are hard to tell apart, hard to reclaim all at once, and operations can easily disrupt a page the user is actively using.

A common approach taken by other tools (such as Codex connecting to a local browser) is to place the tabs opened by the AI into a **named tab group (Chrome Tab Group)** and operate within it. Benefits:

1. **Isolated, non-intrusive**: the AI's tabs are visually separated from the user's;
2. **Transparent and reclaimable**: the user sees at a glance "these belong to the AI" and can collapse/close the whole group;
3. **Multi-agent friendly**: it is the lightest-weight form of "one workspace per session" (while still sharing the same browser profile and login state).

## Decision

Tabs opened by `tab_open` are **automatically placed into a tab group named "Browser Bridge"** (blue). Within the same window it reuses an existing group of the same name, and creates/names/colors one if none exists.

- Controlled by the `groupTabs` setting, **enabled by default**; can be turned off on the Options page.
- Requires the new **`tabGroups`** permission (used to name/color the group; `chrome.tabs.group()` itself falls under `tabs`).
- Grouping is **best-effort UX**: if grouping fails (exception, restricted page) it only `console.warn`s and **never** lets `tab_open` fail because of it.
- The return value of `tab_list` gains a `groupId` field (`undefined` when ungrouped), making it easier for the AI/user to identify ownership.

## Alternatives Considered

### Option A: Hard isolation — page operations may only act on tabs inside the group
- **Pros**: stronger "sandbox" semantics
- **Cons**: changes the existing targeting semantics (operations often act on the active tab, and the active tab may not be in the group), easily causing unexpected failures
- **Not chosen**: this round only does "organization + visibility" and does not change operation targeting; hard isolation is left for later (needs to be paired with session isolation)

### Option B: Add a standalone `tab_group` tool (explicit group creation/move-in/focus)
- **Pros**: finer control
- **Cons**: it is a **contract change** (requires touching `contracts/tools.json` + the Rust directory + code generation)
- **Not chosen**: this round does the zero-contract-change automatic grouping first; an explicit tool can be a follow-up increment

### Option C: Separate browser context (incognito-like)
- **Ruled out**: that is isolation with "a different set of cookies/login state", which contradicts the product goal of "reusing the user's real login state", and it is not a visible tab group

## Consequences

### Positive
- AI tabs are consolidated, visible, and reclaimable as a group; no longer scattered around disturbing the user
- Even a single agent benefits directly; it also lays the groundwork for future multi-agent isolation of "one workspace per session"
- Zero contract change, purely extension-side changes, Rust/protocol untouched

### Negative / Trade-offs
- Adds the `tabGroups` permission (low risk: it only organizes tabs and does not touch the data plane such as page content/cookies); when publishing to the Chrome Web Store, a permission change triggers re-review and re-authorization by the user
- **Does not solve the connection-layer multi-agent problem**: the single lock file + preemptive kill + single native connection still exist (that is the connection layer; this ADR is the in-browser organization layer, a different level)

## Relationship to Other ADRs

- Orthogonal to [ADR-0004](./0004-allowlist-with-optional-host-permissions.md): grouping does not change the allowlist/authorization
- Complementary to (not a replacement for) the "multi-client broker" (see the RFC example in [GOVERNANCE.md](../../GOVERNANCE.md))
