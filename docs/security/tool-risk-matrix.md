# Tool risk matrix

Every tool browser-bridge exposes, with its risk level, what it can read/change,
whether it touches credentials, the Chrome permission it needs, and how the user
is protected. This is the reference for security review: **adding or changing a
tool means updating this table** (see [SECURITY.md](../../SECURITY.md)).

Risk levels: **Low** (read-only, no sensitive data) · **Medium** (reads page
content or navigates) · **High** (writes to the page, or reads credentials) ·
**Critical** (arbitrary code / maximal blast radius).

| Tool | Risk | Reads | Writes / effect | Credentials? | Chrome perm | User protection |
|------|------|-------|-----------------|--------------|-------------|-----------------|
| `tab_list` | Low | tab titles/URLs | — | no | `tabs` | allowlist not required (metadata only) |
| `tab_focus` | Low | — | activates a tab | no | `tabs` | — |
| `tab_open` | Medium | — | opens a URL (navigation) | no | `tabs` | allowlist-gated origin |
| `tab_close` | High | tab title/URL | **closes a tab** (data loss) | no | `tabs` | per-tool disable in settings (no per-action prompt; not restricted to http(s)) |
| `page_snapshot` | Low | interactive elements (a11y) | — | no | `scripting` | allowlist-gated; content injected |
| `page_click` | High¹ | element under ref | clicks (may submit/navigate) | no | `scripting` | allowlist-gated; per-tool disable (no per-action prompt) |
| `page_fill` | High | — | types into a field | possibly (into password fields) | `scripting` | password value masked in the echo |
| `page_text` | Medium | visible page text | — | masked | `scripting` | passwords + long digit runs masked |
| `page_screenshot` | Medium | viewport pixels | — | possibly (whatever's on screen) | `tabs` | — |
| `page_scroll` | Low | scroll position | scrolls | no | `scripting` | — |
| `page_wait_for` | Low | selector/text presence | — | no | `scripting` | — |
| `page_eval` | **Critical** | anything the page can | **arbitrary JS** in the page | yes (can read tokens/cookies) | `scripting` (host) | result always masked; allowlist-gated; per-tool disable is the kill switch — no per-action prompt |
| `page_snapshot_precise` | Medium | authoritative a11y tree (CDP) | — | no | `debugger` | always-on informational pre-warn notice (not a blocking confirm); "debugging" infobar flashes |
| `cookie_get` | High | cookies incl. **httpOnly** | — (read-only) | **yes** | `cookies` | allowlist-scoped; values masked; no `cookie_set` by design |
| `storage_get` | High | local/sessionStorage | — (read-only) | **yes** (tokens) | `scripting` | same-origin; values **always** masked |

¹ `page_click` is Medium for ordinary elements; **High** when the target is a
submit button or a navigating link (bigger blast radius) — but these do not
prompt before running.

## Cross-cutting protections

- **Allowlist**: page-level ops only run on origins the user approved (per-site
  prompt + `chrome.permissions.request`). `allowAllSites` is an explicit opt-in.
- **Masking**: `page_text`, `cookie_get`, `storage_get`, and `page_eval` output
  run through the mask (JWT / long hex / long digit runs / token-like strings).
  `storage_get` masking is not user-toggleable.
- **No per-action confirmations**: high-risk clicks, `page_eval`, and `tab_close`
  run **without prompting**. There are no interactive confirmation toasts. On an
  already-allowlisted origin the AI can submit forms, run JS (if `page_eval` is
  enabled), and close tabs with no per-action approval — the allowlist bounds
  *which* sites, not *what* happens
  on an approved one. Keep the allowlist tight (avoid "allow all sites"), disable
  `page_eval` when unused, and disable any tool the agent shouldn't have.
- **Read-only by design**: no `cookie_set` / `storage_set` (writing httpOnly
  cookies is a session-fixation risk — see [ADR-0010](../adr/0010-cookie-storage-readonly.md)).
- **CDP mode (opt-in, off by default)**: the `cdpMode` setting reroutes **every**
  page-level op through `chrome.debugger` (CDP) in the page's MAIN world instead
  of a content script (see [ADR-0017](../adr/0017-cdp-mode-all-ops.md)). It does
  **not** change any tool's contract, permission, or masking — the same allowlist
  / mask protections above still apply. Its two
  security tradeoffs: it **bypasses page CSP** (so `page_eval` runs on strict-CSP
  sites like Bing), and it holds a **persistent debugger attach** for the tab, so
  the "Started debugging this browser" banner stays up the whole time it's on.

## When you add or change a tool

Update this table **and** run the security-change checklist in
[SECURITY.md](../../SECURITY.md). A change that raises a tool's blast radius
(new permission, new sensitive read, new write, weaker allowlist gating, wider
masking bypass) requires a threat-model update and a security-labeled review.
