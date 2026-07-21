# ADR-0011: Settings Managed via a Dedicated Options Page

- **Status**: Accepted
- **Date**: 2026-07-09

## Context

As phases two and three landed incrementally, the design accumulated a large number of configurable security policies and behavior switches scattered across the codebase:

- **ADR-0008**'s `page_eval` return-value redaction switch (`evalMask`) — crammed into the popup in v0.2
- **ADR-0006**'s high-risk click confirmation, 60-second confirmation-free grace period, and 30s Toast timeout — all hardcoded in content.js
- **ADR-0009**'s pre-precise-snapshot prompt — shown every time, cannot be dismissed
- **ADR-0004**'s allowlist — could only be revoked, not manually added (popup.js comments explicitly state manual add was not implemented in v0.1)
- Whether each tool is enabled — no master switch

These values were initially hardcoded as "secure defaults," on the rationale that the v0.1/v0.2 phases prioritized getting the base architecture running stably. But as they piled up, users had **no way whatsoever** to adjust these behaviors — they could neither turn off a confirmation they found annoying, nor tune timeouts per scenario, nor disable page_eval, the tool with the largest attack surface. Security policy was "welded shut."

At the same time, the original popup was only 320px wide and had already started to feel crowded (connection status + pending-approval prompt + allowlist + evalMask switch). Continuing to pile switches into the popup is not sustainable.

A unified entry point for configuration management is needed.

## Decision

**Register a dedicated full-page Options settings page (`options.html`, opened in a new tab) via the manifest `options_ui`, centralizing management of all configurable items; add a "⚙ Settings" button at the top of the popup to jump to it, and migrate the `evalMask` switch out of the popup.**

All configuration items are stored in `chrome.storage.local`, following the existing flat-key convention (consistent with `evalMask` / `allowlist`), with `change` events persisting immediately (no "Save" button needed, consistent with popup behavior).

### Configuration Item Inventory

| key | Type | Default | Related | Purpose |
|-----|------|------|------|------|
| `pageEvalEnabled` | bool | true | ADR-0008 | page_eval master switch; when off, arbitrary JS execution is rejected outright |
| `evalMask` | bool | true | ADR-0008 | page_eval return-value redaction |
| `confirmHighRiskClick` | bool | true | ADR-0006 | High-risk click (submit/link) confirmation switch |
| `warnPreciseSnapshot` | bool | true | ADR-0009 | Informational prompt before a precise snapshot |
| `confirmGraceMs` | int | 60000 | ADR-0006 | Grace period exempting repeat confirmations for the same origin and type (0 = confirm every time) |
| `clickToastTimeoutMs` | int | 30000 | ADR-0006 | Auto-reject timeout for the click confirmation Toast |
| `evalToastTimeoutMs` | int | 45000 | ADR-0008 | Auto-reject timeout for the eval confirmation Toast |
| `disabledTools` | string[] | [] | — | Set of disabled tool (op) names |
| `allowAllSites` | bool | false | ADR-0004 | Skip per-site approval and allow all sites |

## Alternatives Considered

### Option A: Cram everything into the popup
- **Pros**: Simplest to implement, no new files needed; users see all settings by clicking the extension icon
- **Cons**: The popup is 320px wide and can't scroll much; it gets extremely crowded once switches multiply; the popup's role is "connection status + approval shortcuts," so mixing in a big pile of settings blurs its responsibilities
- **Not chosen**: The extension is already near the popup's capacity limit

### Option B: Dedicated Options page (chosen)
- **Pros**: Ample space, groupable, extensible; matches Chrome extension conventions (the details page has an "Extension options" entry); keeps the popup lightweight
- **Cons**: One extra jump (click extension icon → click Settings); the options page and popup are two separate contexts, so state must be synced via storage
- **Implementation**

### Option C: Full-screen tab, remove the popup settings entry
- **Pros**: Cleanest
- **Cons**: Every configuration change requires clicking "Extension details → Options," poor discoverability
- **Ruled out**: Adding a jump button to the popup costs almost nothing, so keeping it is friendlier

## Key Design Decisions

### 1. Tool disabling is intercepted at the extension dispatch layer, not filtered in the Rust tools/list

`disabledTools` is checked at the entry of `dispatch()` in `background.js`: on a hit, it does `throw new Error("tool disabled in settings: <op>")`.

**Why not change `tools/list` in `src/tools.rs`**: the sole data source for configuration lives in the extension (`chrome.storage.local`), which the Rust host cannot read. To make the AI literally "not see" disabled tools, the extension would need to sync the configuration to the host (changing the IPC protocol) — a large amount of work that introduces the burden of maintaining cross-process consistency.

**Cost**: the AI still sees disabled tools in `tools/list` and only receives a clear error on invocation. This is accepted after weighing the trade-off — disabled tools at least cannot execute, and the error message is explicit, consistent with the principle "security through interception, not through hiding."

### 2. The allowAllSites switch must synchronously request the <all_urls> permission

Once "allow all sites" is enabled, `ensureAllowed` lets requests through directly, no longer performing per-site approval. But the extension still needs the `<all_urls>` host permission to inject the content script into arbitrary pages — otherwise injection silently fails after the approval check is skipped.

`optional_host_permissions: ["<all_urls>"]` is already declared; when the switch is turned on, `chrome.permissions.request({ origins: ["<all_urls>"] })` is called inside the options page's change event (a valid user gesture); if the user denies, the checkbox rolls back. On load, `chrome.permissions.contains` is used to reconcile the stored value with the actual permission, preventing drift.

### 3. Adding a site on the options page does not proactively request the host permission

Manually adding to the allowlist only writes to `chrome.storage.local`. The rationale: under MV3, `chrome.permissions.request` must run in a user-gesture (popup/action) context; although the options page is an extension page, requesting permissions from it is restricted. When the site is actually accessed, `ensureAllowed` triggers the normal permission-request flow (going through the popup approval prompt).

### 4. The DEFAULTS constant is mirrored in three places

The default values for configuration items are defined in separate `DEFAULTS` objects in `options.js` / `background.js` / `content.js` (content.js holding the subset of in-page behaviors), with comments marking KEEP IN SYNC. This follows the project's existing cross-file sync convention (e.g., the `op` strings mirrored in three places across background.js / content.js / tools.rs).

## Consequences

### Positive
- **Adjustable security policy**: users can turn off annoying confirmations, tune timeouts, and disable page_eval per scenario, no longer welded shut
- **Clear responsibilities**: the popup focuses on connection status + approval shortcuts; configuration belongs to the options page
- **Extensible**: adding a new configuration item only requires a storage key + DEFAULTS + a UI control, following a uniform pattern
- **Follows convention**: `options_ui` is the standard Chrome extension way to manage settings

### Negative
- **DEFAULTS mirrored in three places**: adding a configuration item requires syncing DEFAULTS across three files, which is easy to miss. Constrained by the fact that each extension script loads independently, there is no lightweight shared-module option (the project consistently uses comment conventions for syncing)
- **Tool disabling is not hiding**: the AI still sees disabled tools and is intercepted by an error at invocation time — not "truly removed from the tool set"
- **allowAllSites risk**: once enabled, any site (including banking/email/intranet) can be operated on without approval; the UI has a prominent warning but ultimately relies on the user's judgment

### Neutral
- Configuration takes effect immediately (a change is stored to storage right away, and the next action reads the new value), but in-memory caches such as `_maskCache` in content.js already injected into a page only refresh on the next eval

## Implementation Details

- `extension/manifest.json`: add `options_ui: { page: "options.html", open_in_tab: true }`
- `extension/options.html`: full-page layout, grouped (Security / Confirmation timeouts and grace period / Tool enablement / Allowed sites), with a yellow warning card for dangerous switches
- `extension/options.js`: read/write storage, immediate form persistence, allowlist add/remove, allowAllSites permission request/removal/reconciliation
- `extension/popup.html` / `popup.js`: add a "⚙ Settings" button (`openOptionsPage`), remove the evalMask section
- `extension/background.js`: DEFAULTS + `getSetting`, disabledTools interception at the `dispatch` entry, `add_allow` message, `snapshotPrecise` reading warnPreciseSnapshot, `ensureAllowed`/`ensureDomainAllowed` reading allowAllSites
- `extension/content.js`: DEFAULTS + `getSetting`, runEval reading pageEvalEnabled, click reading confirmHighRiskClick, grace period/timeout reading from storage

## Relationship to Other ADRs

- **[ADR-0004](./0004-allowlist-with-optional-host-permissions.md)**: allowAllSites is a "master switch" variant of the allowlist — it skips per-site approval but underneath still relies on the same optional host permissions mechanism. Manually adding to the allowlist fills in the add capability that was missing in v0.1
- **[ADR-0006](./0006-toast-confirmation-for-high-risk.md)**: confirmHighRiskClick / confirmGraceMs / clickToastTimeoutMs make this ADR's hardcoded values (60s grace, 30s timeout, confirmation on/off) configurable, with defaults matching the original decision
- **[ADR-0008](./0008-page-eval-confirmation-channel.md)**: pageEvalEnabled (master switch), evalMask (migrated from the popup), and evalToastTimeoutMs make this ADR's policy configurable
- **[ADR-0009](./0009-page-snapshot-precise-debugger.md)**: warnPreciseSnapshot makes the pre-precise-snapshot prompt dismissible
