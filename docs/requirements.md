# Requirements Document: browser-bridge

> Let MCP clients (such as Claude Code, Codex) operate the **real Chrome the user is actively using**—
> real tabs, real login state, real cookies—instead of launching a blank simulated browser.

## 1. Background and Problem

### 1.1 Current State
Users want to let AI (via an MCP client) operate their own browser directly: scraping pages behind a login, auto-filling forms, processing information across tabs. But AI has no such capability by default—it can issue HTTP requests, but it **cannot see or take over the user's already-open, already-logged-in browser session**.

### 1.2 Shortcomings of Existing Approaches

| Approach | Problem |
|------|------|
| CDP (`--remote-debugging-port=9222` special launch of Chrome) | Must **restart the browser**, breaking daily usage habits; once the port is open, any process on the machine can control it, with no permission boundary |
| Playwright/Puppeteer launching a new instance | Not the user's browser—no login state, cookies, or extensions; you have to log in again every time |
| `chrome-devtools-mcp` (Microsoft) | Goes through CDP, still requires special launch of Chrome or exposing a debug port |
| Pure HTTP scraping | Cannot see login state; JS-rendered pages are unreachable |

### 1.3 The Core Problem We Are Solving
**Let AI safely operate the pages of the user's real browser, without restarting Chrome and without exposing a debug port.**

## 2. Goals and Non-Goals

### 2.1 Goals (v0.1)
- **G1 Real browser**: operate the Chrome the user is currently using, preserving all login state, extensions, and cookies
- **G2 Zero special launch**: install the extension once for lasting effect, no need to start with `--remote-debugging-port` every time
- **G3 Secure and controllable**: new sites require user authorization; high-risk actions (submit, navigation) prompt real-time confirmation popups
- **G4 MCP integration**: connect as a standard MCP server to MCP clients, with a stable and composable tool set
- **G5 Single-binary distribution**: the entire backend compiles into a single Rust binary, deployment = copying one file

### 2.2 Non-Goals / Deferred Capabilities
- ✅ **`page_eval` now complete**: early v0.1 did not implement arbitrary JS execution; phase two added it, with a high-risk confirmation channel + redacted return values. See [ADR-0008](./adr/0008-page-eval-confirmation-channel.md) (supersedes the early [ADR-0005](./adr/0005-page-eval-disabled-by-default.md))
- ✅ **Cookie/Storage read-only now complete**: phase three added `cookie_get` / `storage_get`, strictly read-only with redacted output. See [ADR-0010](./adr/0010-cookie-storage-readonly.md)
- ✅ **Precise snapshot now complete**: `page_snapshot_precise` explicitly uses chrome.debugger, prompts the user before the call, and briefly shows an infobar during the call. The default `page_snapshot` still uses an approximate content script. See [ADR-0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md) and [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md)
- ❌ **No recording/replay or batch task orchestration**. That is the play layer of phase three
- ❌ **No support for non-Chromium browsers**. Currently targets
  Google Chrome on macOS/Windows/Linux, and Chromium on Linux

## 3. User Stories

### US-1: Scrape pages behind a login
> As a developer, I want AI to read the content of my **logged-in** internal system pages, so it can help me analyze based on real data.

Acceptance: AI calls `page_snapshot` + `page_text`; on first visit the extension shows an authorization popup, I click Allow; afterwards it can read the redacted page text.

### US-2: Auto-fill forms
> As an everyday user, I want AI to help me fill a long list of fields (address, order information) in a web form, reducing manual input.

Acceptance: AI calls `page_snapshot` to get field refs, and calls `page_fill` to fill each one in; password fields are redacted in the logs.

### US-3: Multi-tab processing
> As a researcher, I want AI to list all my open tabs, locate a specific one, and answer questions based on its content.

Acceptance: AI calls `tab_list` → `tab_focus` → `page_snapshot`, working across tabs.

### US-4: Safety confirmation
> As a user, when AI is about to click "Submit Order" or follow a link, I must have a chance to refuse, to avoid mistaken operations.

Acceptance: when clicking a submit-type button or link, a Toast pops up in the top-right of the page, auto-rejecting after 30 seconds of no response; after approval, same-origin same-type actions skip confirmation for 60 seconds.

### US-5: Developer extension integration
> As an MCP client user, I want to connect browser-bridge as an MCP server, and just say "list my tabs" directly in the conversation to use it.

Acceptance: after adding browser-bridge to the client's MCP server configuration, the client's connection management UI shows `browser-bridge` as connected, and the tools are callable.

## 4. Functional Requirements

### FR-1 Tab Management
- `tab_list` — list all tabs (id/title/url/active)
- `tab_focus` — activate a specified tab
- `tab_open(url)` — open a new tab (domain constrained by the allowlist)
- `tab_close(tabId)` — show an in-page Toast confirmation before closing an http(s) tab

### FR-2 Page Reading
- `page_snapshot` — return an a11y-style tree of interactive elements, each node having a stable `ref`, role, accessible name, and fallback selector
- `page_snapshot_precise` — **precise version**: uses chrome.debugger + CDP to obtain Chrome's authoritative a11y tree, covering shadow DOM / complex ARIA; shows a prompt Toast before attach, and a debug banner flashes at the top of Chrome during the call (~1 second); refs use the `p` prefix, and page_click/fill need no changes. See [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md)
- `page_text` — return body text (password fields and suspected card numbers redacted)
- `page_screenshot` — return the visible viewport as PNG (base64)

### FR-3 Page Operations
- `page_click(ref|selector)` — click; submit/link types trigger a Toast confirmation
- `page_fill(ref|selector, value)` — fill a form; uses the native setter to trigger the change detection of frameworks (React/Vue); password fields are recorded redacted
- `page_scroll(direction|pixels)` — scroll
- `page_wait_for(selector|text|nav, timeoutMs)` — wait for a selector/text, or wait for the page load to complete
- `page_eval(code)` — **high-risk**: execute arbitrary JS. Each call pops an enlarged Toast showing the full code; same-origin skips confirmation for 60s; return values are redacted by default (JWT/long hex/long numbers/sensitive keywords), which can be turned off in the popup. Uses `new Function` to execute in the global scope, supporting await/return. See [ADR-0008](./adr/0008-page-eval-confirmation-channel.md)

### FR-4 Security Controls
- **FR-4.1 Domain allowlist**: on the first operation against a new origin, the extension shows a popup requesting authorization; authorization simultaneously requests the host permission for that domain via `chrome.permissions.request`. The allowlist is stored in `chrome.storage.local` and can be revoked in the popup. See [ADR-0004](./adr/0004-allowlist-with-optional-host-permissions.md)
- **FR-4.2 High-risk Toast**: submit clicks and link navigations trigger an in-page Toast, rejecting on a 30-second timeout, and after approval skipping same-origin same-type confirmation for 60 seconds. See [ADR-0006](./adr/0006-toast-confirmation-for-high-risk.md)
- **FR-4.3 Host authentication**: the native messaging manifest's `allowed_origins` hard-codes the extension ID; the bridge socket authenticates with a per-run secret + a lock file in the user directory (Unix mode 0600)
- **FR-4.4 Redaction**: `page_text` masks `<input type=password>` and long numeric strings; `page_fill` redacts the password field value in the parameter echo

### FR-5 Cookie/Storage Read-Only (Phase Three)
- **FR-5.1 `cookie_get`**: read cookies (including httpOnly), naturally constrained by host_permissions (reusing the allowlist); the output value is redacted, while structural fields (name/domain/httpOnly) are preserved
- **FR-5.2 `storage_get`**: read the page's localStorage/sessionStorage (content script, same-origin); output is always redacted (not controlled by the evalMask toggle, since the token leakage risk is equivalent to eval)
- **FR-5.3 No writes**: no cookie_set / cookie_remove / storage_set—cookie_set could forge httpOnly cookies (session fixation attacks), something even XSS cannot do. See [ADR-0010](./adr/0010-cookie-storage-readonly.md)

## 5. Non-Functional Requirements

| Dimension | Requirement |
|------|------|
| **NFR-1 Performance** | single tool-call round trip (excluding user confirmation) < 500ms (local link) |
| **NFR-2 Resources** | release binary < 1MB; resident MCP server memory < 20MB |
| **NFR-3 Zero runtime dependencies** | the user's machine only needs Rust at compile time; the runtime depends on no Python/Node/any runtime; introduces no native dependencies beyond libc |
| **NFR-4 Robustness** | can automatically recover the connection after a 5-minute SW restart, native host crash, or Chrome restart |
| **NFR-5 Auditability** | all security-related decisions (authorization, confirmation, rejection) have an ADR record; extension permission declarations are minimized |
| **NFR-6 PATH independence** | the host manifest uses absolute paths; does not depend on the user shell's PATH configuration (known constraint: the user's PATH does not include `/opt/homebrew/bin`) |

## 6. Scope Boundaries

### 6.1 Included in v0.1
- 11 tools (see FR-1~FR-3); **phase two adds `page_eval` + `page_snapshot_precise`** (13 total); **phase three adds `cookie_get` + `storage_get`** (15 total)
- Two-layer security of allowlist + Toast
- content script-style snapshot
- macOS/Windows/Linux + Chrome; Linux also supports Chromium; WSL supports both the Windows
  Chrome interop mode and the WSLg Linux browser mode

### 6.2 Not Included in v0.1, Later Phases
- **Phase two**:
  - `page_snapshot_precise` — debugger-fallback precise snapshot (flashes an infobar, requires notifying the user)
  - ✅ `page_eval` — high-risk confirmation channel (enlarged Toast + same-origin 60s skip-confirmation + configurable redaction). **Complete**, see [ADR-0008](./adr/0008-page-eval-confirmation-channel.md)
  - ✅ `page_snapshot_precise` — debugger precise snapshot (prompt Toast + infobar flash + p-prefixed ref). **Complete**, see [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md)
- **Phase three**:
  - ✅ `cookie_get` / `storage_get` (read-only, limited to allowlisted domains, redacted output). **Complete**, see [ADR-0010](./adr/0010-cookie-storage-readonly.md)
  - Skill layer (distilling high-frequency plays—scraping list pages, form filling, cross-tab operations—into skills)
  - Recording/replay, batch task orchestration

### 6.3 Explicitly Excluded
- No browser history/bookmarks/download management
- No network request interception/modification
- No multi-browser sync support

## 7. Phasing

| Phase | Scope | Status |
|------|------|------|
| **Phase one: v0.1 minimum viable** | FR-1~FR-4 + NFR-1~6 | ✅ code complete, protocol-layer e2e tests PASS, awaiting user extension-load acceptance |
| **Phase two: precision** | debugger-fallback snapshot, page_eval high-risk channel | ✅ complete (page_eval + page_snapshot_precise) |
| **Phase three: extended capabilities** | cookie/storage, skill layer, orchestration | 🔄 cookie/storage complete; skill layer/orchestration not started |

## 8. Acceptance Criteria (v0.1)

1. `install.sh` (macOS/Linux) or `install.ps1` (Windows) runs through, the extension loads successfully, and the host manifest registers
2. The MCP client can see `browser-bridge` as connected
3. AI says "list tabs" in the conversation → sees the real list of tabs
4. AI says "screenshot the current page" → AI can analyze the screenshot
5. AI says "fill XXX in the search box and click search" → it really executes in the user's browser; a Toast confirmation pops up on submit
6. Visiting an unauthorized domain → the extension shows an authorization popup
7. Protocol-layer end-to-end tests PASS (NM frames, MCP JSON-RPC, TCP bridge)

## 9. Glossary

| Term | Meaning |
|------|------|
| **MCP** | Model Context Protocol, the standard protocol between AI and tools, based on JSON-RPC 2.0 |
| **Native Messaging** | Chrome's official mechanism for communication between an extension and a local process, frame format = 4-byte little-endian length + JSON |
| **MV3** | Manifest V3, the latest standard for Chrome extensions, where background switches to a Service Worker |
| **SW** | Service Worker, the MV3 background script, which Chrome force-restarts every 5 minutes |
| **CDP** | Chrome DevTools Protocol, the protocol for controlling Chrome via a debug port |
| **ref** | the stable identifier the snapshot assigns to each interactive element (such as `e3`), which AI uses to locate elements |
| **a11y** | accessibility, the accessibility tree—the semantic structure of page elements |
