# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Fixes from a live 16-tool regression sweep against a real Chrome (see the
[QA runbook's regression log](tests/manual/canvas-embeddings/README.md#regression-log)).

### Changed
- **`page_eval` now states its prerequisite instead of failing cryptically.**
  MV3 governs the content script's isolated world with the *extension's* CSP,
  which has no `'unsafe-eval'` — so `new Function` is blocked there on **every**
  page, for every user, not just the "strict-CSP sites" ADR-0017 described. The
  tool therefore requires the **CDP mode** setting, which was never documented as
  a prerequisite and which nothing pointed you towards when the call failed.

  The extension does **not** enable it for you: a blocked call fails with a
  message written to be relayed, telling the agent to stop and ask you to turn
  CDP mode on rather than retrying or routing around it. The same prerequisite
  now appears in the tool's own description, the MCP `instructions` payload, and
  the Options-page copy. Attaching a debugger stays the operator's decision
  ([ADR-0025](docs/adr/0025-page-eval-requires-cdp-mode.md)).

### Fixed
- **`page_screenshot` no longer breaks on pages with iframes.** Page ops that
  aren't frame-routed now address the top frame explicitly. They were sent
  without a `frameId`, which makes Chrome broadcast to *every* frame and answer
  with whichever replies first — so once any read op had injected all frames, a
  page with 2+ iframes fired one `captureVisibleTab` per frame, exceeded
  Chrome's 2/sec throttle, and failed with `capture failed` from then on.
- **`page_scroll` reports the top document's position again.** The same
  broadcast let a sub-frame answer, so `direction:bottom` on a long page could
  report a 300 px iframe's scroll limit — and scrolled the iframes as a side
  effect. `page_eval` likewise ran once per frame.
- **`page_snapshot_precise` masks password fields.** It returned
  `input[type=password]` values in cleartext while `page_snapshot` and the CDP
  snapshot both masked them; masking now happens in the page, so the value never
  reaches the extension.
- **Cookie and storage masking reads the key name.** A value is redacted when
  its key/cookie name names a secret (`csrftoken`, `apiKey`, `sessionid`), not
  only when the value itself matches a pattern — `session_apikey` = `sk-proj-…`
  used to come back in full. The pattern catalogue also learned provider API
  keys (`sk-`/`sk_`, `ghp_`, `xoxb-`, `AKIA…`, `AIza…`), and the JWT rule no
  longer needs 8+ characters in every segment.
- **`page_snapshot` reports `checked` for checkboxes and radios** instead of
  `value: "on"` (the submit payload, which reads as "ticked" whatever the real
  state is). All three snapshot backends agree.
- **An unknown `page_scroll` direction is an error**, not a silent no-op that
  returned coordinates as if it had scrolled.
- **Missing required arguments return `INVALID_ARGUMENT`** instead of
  `EXECUTION_FAILED`. They are checked against the tool's published
  `inputSchema` before the call reaches the browser, rather than being coerced
  to `""`/`0` and failing in the page.
- **A cross-frame `page_click`/`page_fill` echoes the ref it was given**
  (`f7:e2`), not the bare `e2` that names a different element in the top frame.
- **`page_eval` fails loudly when a Content-Security-Policy blocks it.** A page
  whose `script-src` omits `'unsafe-eval'` forbids `new Function`; that used to
  return success carrying a soft error object full of CSP text. It is now a tool
  error naming the remedy (enable CDP mode), while ordinary JS errors keep
  coming back as structured data. The limitation is documented on the tool.
- **`page_screenshot` failures carry Chrome's own message** instead of a bare
  `capture failed` — the service worker already forwarded the reason and the
  content script was discarding it.
- `install.sh` no longer prints a stale tool count or tells users to approve
  sites through the toolbar icon, a flow removed in 0.5.0.

## [0.5.0] - 2026-07-27

Additive over 0.4.0 — a link-extraction tool, richer page-reading options, and a
localized (English + 简体中文) extension UI. No breaking changes.

### Added
- **`page_links` tool** — returns every `<a href>` on the active tab as
  `{text, href, type}` (`mailto` / `tel` / `external` / `internal` / `anchor`),
  surfacing contact links and href targets that `page_text` only shows as anchor
  labels. Works even when `page_snapshot` is empty; hrefs are masked (tokens
  redacted, emails/phones preserved). Tool count 15 → 16.
- **`page_text` `mode`** — `"visible"` (default, unchanged) or `"full"`, which
  also includes text behind `display:none` / inactive tab panels.
- **`page_wait_for` `settled` + `minCount`** — `settled` resolves once the DOM
  stops mutating (~500 ms; SPA / lazy-content friendly); `minCount` waits until
  at least N elements match `selector`, not just the first.
- **Extension UI internationalization (English + Simplified Chinese)** — the
  popup, options page, and in-page toast are localized, with a Language override
  (Auto / English / 中文) in the Options page. AI-facing text (the tool contract,
  agent prompt) stays English ([ADR-0021](docs/adr/0021-extension-i18n.md)).

### Fixed
- **`page_snapshot` no longer returns a bare empty tree on lazy / heavy-JS
  pages** — it settles and retries when the first walk is empty, and a
  persistently-empty result carries a `note` explaining likely causes (still
  loading / iframe / shadow DOM) and suggesting `page_wait_for {settled}` or
  `page_snapshot_precise`.
- **SBOM attached to every release again.** The CycloneDX SBOM
  (`browser-bridge.cdx.json`) is now produced by a `continue-on-error` job in
  the release workflow instead of a standalone `release: published` workflow.
  GitHub suppresses that event for releases created with the default
  `GITHUB_TOKEN`, so no SBOM had shipped since v0.1.1; SBOMs for v0.2.0–v0.4.0
  were backfilled.

### Changed
- Release runner images bumped to `ubuntu-24.04` / `macos-26` / `windows-2025`.
  The prebuilt Linux binary's glibc floor is set by the symbols it references
  (~2.34), so it still runs on glibc ≥ 2.34 (RHEL 9, Debian 12, Ubuntu 22.04+).

## [0.4.0] - 2026-07-25

Removes the interactive per-action confirmations and every confirmation /
`page_eval` configuration toggle. The security boundary is now the standing
controls only: the per-site allowlist (primary gate), per-tool enable/disable
(the `page_eval` kill switch), and always-on masking of `page_eval` / cookie /
storage results. **Breaking** — nine settings are removed; see below.

### Removed
- **Interactive per-action confirmations.** High-risk clicks (submit buttons /
  links), `page_eval`, and `tab_close` no longer show an in-page confirmation
  prompt — they run directly. Six settings are retired (`confirmHighRiskClick`,
  `confirmPageEval`, `confirmTabClose`, `confirmGraceMs`, `clickToastTimeoutMs`,
  `evalToastTimeoutMs`), and `tab_close` is no longer limited to http(s) tabs.
- **The `page_eval` / precise-snapshot Security toggles.** `pageEvalEnabled`,
  `evalMask`, and `warnPreciseSnapshot` are removed; their protections are now
  always-on and non-configurable — `page_eval` results are always masked and the
  `page_snapshot_precise` on-page notice is always shown. To turn `page_eval`
  off, disable it in the Options page's **Tool enablement** grid (now its kill
  switch). The Options page now holds Execution mode, Tool enablement, and
  Allowed sites.

### Added
- **`page_wait_for` gains an `until` option** — opt-in
  `until: "domcontentloaded" | "load"` (default `"load"`, backward compatible);
  `domcontentloaded` resolves once the DOM is parsed, for pages usable well
  before the window `load` event.

### Changed
- **Tab grouping is now unconditional.** The `groupTabs` toggle was removed —
  tabs the AI opens via `tab_open` are always collected into the "Browser Bridge"
  group ([ADR-0018](docs/adr/0018-tab-workspace-group.md)); grouping is
  best-effort, so a failure never fails `tab_open`.

### Fixed
- **`page_snapshot` no longer collapses onto a covering `<iframe>`** — the
  interactive walk guards out `iframe`/`frame`/`object`/`embed`, so a full-page
  marketing frame no longer hides the real, actionable tree.
- **`page_text` no longer leaks hidden/script/style text** — both backends read
  the live `document.body.innerText` (only rendered content) instead of a
  detached `body.cloneNode()` that silently degraded to `textContent`.
- **`tab_open` on an un-approved origin returns an actionable error** — it
  distinguishes user-denied from timed-out, and the timeout message points to
  the fix (retry to re-open the prompt, click the `!` badge, or pre-approve in
  Settings).

## [0.3.0] - 2026-07-24

Agent onboarding and a fully English project. Additive over 0.2.0 — no breaking
changes.

### Added
- **Agent kickstart prompt served over MCP** — the `initialize` response now
  carries an `instructions` field: a short, safety-first prompt that teaches the
  model how to drive the browser (snapshot → act by `ref`, don't do irreversible
  things unprompted, never exfiltrate secrets, and the per-site allowlist +
  high-risk confirmation gates). MCP clients that support server instructions
  hand it to the model automatically at connect time; the same prompt is a
  copy-paste block in the README Quickstart for a manual first run. Single
  source: `docs/agent-prompt.md`.

### Changed
- **The project is now entirely in English** — all documentation (README,
  `docs/`, every ADR) plus the shipped extension's user-facing strings, tool
  labels, and confirmation dialogs were translated from Chinese.
- The release pipeline now emits **two** extension zips: `…-store.zip` (manifest
  `key` stripped) for Chrome Web Store uploads, and the existing
  `browser-bridge-extension-<tag>.zip` (`key` kept) for load-unpacked — the two
  install paths need opposite `key` handling (**ADR-0019**).

### Removed
- The opt-in Chrome Web Store auto-publish workflow — store publishing is manual
  (upload the key-stripped zip in the dashboard).

## [0.2.0] - 2026-07-21

Non-MCP CLI surface, one-command agent registration, and Windows automation
support. No breaking changes — everything is additive over 0.1.0.

### Added
- **`browser-bridge tools [--json]`** and **`call <tool> [json]`** subcommands:
  discover the tool catalogue (same shape as MCP `tools/list`) and run one tool
  without an MCP handshake — for non-MCP agents and shell scripts. `tools`
  starts no bridge; `call` prints the tool's raw JSON and refuses (exit 4) while
  an MCP client owns the single bridge.
- **Installer auto-registration for Codex and OpenClaw** — `--register-codex` /
  `--register-openclaw` (and `--unregister-*`), mirroring `--register-claude-code`;
  runs each client's own `mcp add`/`remove` CLI, never hand-edits configs.
- **`docs/integrations.md`** — per-agent register-and-verify guide (Codex,
  OpenClaw, Cursor, Windsurf, Cline, Claude Code/Desktop, LangChain, Hermes
  Agent, and the Hermes/harmony format via the `tools`/`call` CLI).
- **`install.ps1 -TargetUser <account>`** — install into a specific desktop
  user's profile + hive when running as SYSTEM/elevated (automation agents);
  running as SYSTEM without it is refused rather than silently mis-installing.
- **`BB_LOCK_DIR`** env override — decouples the lock-file location from
  `LOCALAPPDATA`/XDG so the server and native host can be pinned to one directory
  when they run under different user contexts.
- **Chrome Web Store distribution** — the extension is published on the store;
  the installers trust both the store id and the pinned unpacked id (**ADR-0019**),
  and the install docs lead with the store listing. Publishing is manual (upload
  a key-stripped zip in the dashboard).

### Changed
- README leads with **Add from Chrome Web Store** (the listing is live), with
  load-unpacked demoted to an advanced path; the installer trusts both the store
  id and the pinned unpacked id.

### Fixed
- Windows SYSTEM/elevated installs no longer misroute to the SYSTEM profile
  (binary / manifest / registry key / lock landed where Chrome couldn't see them
  → permanent `NOT_CONNECTED`).

### Dependencies
- Dependabot bumps: `thiserror`, `serde`, `serde_json` (Rust), `esbuild`
  (extension), and pinned CI actions. Extension TypeScript stays on 5.x — TS7
  (the native compiler) is blocked by the `typescript-eslint` peer range.

## [0.1.0] - 2026-07-19

First stable release — a Rust single-binary MCP server + `--native-host` bridge
and an MV3 extension that lets any MCP client (Claude Code, Codex, …) operate the
user's real Chrome. Ships the v0.1 tool set (tab management, page
snapshot/click/fill/text/screenshot/scroll/wait, `page_eval`,
`page_snapshot_precise`, `cookie_get`, `storage_get`) behind per-site approval
and per-action confirmation, plus an engineering-standardization overhaul, an
opt-in CDP execution mode, restyled confirmations, dark mode, and a Chrome Web
Store listing. See `docs/` for the requirements, architecture, and ADRs.

### Added
- Unified `Makefile` task runner (`build`, `fmt`, `lint`, `test`, `ci`,
  `ext-*`, `install`).
- Rust unit tests for the protocol framing, bridge envelope, lock file, tool
  schemas, and error display.
- Leveled stderr logging gated by `BB_LOG` (`error|warn|info|debug`, default
  `info`).
- TypeScript + esbuild build pipeline for the extension (`extension/src/*.ts`
  → `extension/dist/`), with `@types/chrome`, ESLint (flat config), and
  Prettier.
- GitHub Actions CI (`rust`, `extension`, `version-consistency`, `e2e`,
  `browser` jobs).
- `scripts/check-version.sh` and `scripts/sync-version.sh` to keep the crate
  and extension versions in lockstep (Cargo.toml is the source of truth).
- `LICENSE` (Apache-2.0), `CONTRIBUTING.md`, `docs/development.md`,
  `.editorconfig`.
- **Prebuilt release tarballs** — tagging `v*` triggers a GitHub Actions release
  build (macOS Apple Silicon) that publishes a binary + built extension +
  installer. `install.sh` auto-detects a prebuilt tarball and installs with no
  Rust/Node toolchain. The matrix also builds Linux x64 and Windows x64, each
  with a `.sha256` checksum and SLSA build-provenance attestation, plus a
  standalone extension zip; a decoupled workflow attaches a CycloneDX SBOM.
- **Opt-in CDP execution mode** (`cdpMode`, off by default) — routes every page
  op through `chrome.debugger` (CDP) in the page's main world instead of the
  content script, which **bypasses page CSP** so `page_eval` works on strict-CSP
  sites (e.g. Bing). Keeps every confirmation/allowlist/masking gate. A
  persistent debugger attach shows Chrome's "Started debugging this browser"
  banner while enabled. (ADR-0017)
- **`confirmPageEval` / `confirmTabClose` settings** — opt out of the per-call
  confirmation for `page_eval` / `tab_close` for hands-off automation. Both
  default on, so behavior is unchanged unless you turn them off.
- **Extension-ID self-check** — the service worker logs a loud `[bb]` error at
  startup when the running extension ID isn't one of the trusted IDs (pinned or
  store), the most common "won't connect" cause (native-messaging
  `allowed_origins` mismatch).
- **Tab grouping** — tabs the agent opens are collected into a dedicated
  "Browser Bridge" tab group, keeping AI-driven tabs visually separated from the
  user's own.
- **`--uninstall`** (both installers) — removes exactly what the installer
  placed (binary, native-host manifest, `run.lock`; the HKCU key on Windows),
  with a symmetric `--unregister-claude-code` that runs `claude mcp remove`.
- **Dark mode** for the options and popup pages (`prefers-color-scheme`).
- **macOS Gatekeeper**: the installer clears the `com.apple.quarantine`
  attribute on the installed binary so a browser-downloaded build isn't silently
  blocked when Chrome spawns the native host.
- Docs: a Chrome Web Store publication checklist (`docs/chrome-web-store.md`) and
  a privacy policy.

### Changed
- **Installers moved to `install/`** (`install/install.sh`, `install/install.ps1`,
  `install/mcp-config.example.json`) to slim the repository root. Release archives
  are unchanged — they still ship the installer flat at the archive root, so the
  extract-and-run flow (`./install.sh`) is the same. From a source checkout, run
  `./install/install.sh`. Each installer auto-detects whether it sits beside
  `extension/` (release archive) or one level up (source tree).
- **Extension ID is now pinned** via a public `key` in the manifest
  (`mkjjlmjbcljpcfkfadfmhblmmddkdihf`), so it's the same for everyone
  regardless of load path. `install.sh` writes the host manifest with that ID
  directly — **no more "copy the extension ID and re-run with --extension-id"**.
  (`--extension-id` remains as an override.)
- **Published to the Chrome Web Store**, which assigns its own fixed ID
  (`dgccjfjjilfpkbdllclmkiicajndkfcd`). The installers now write **both** IDs to
  `allowed_origins` by default, so store installs and unpacked/dev loads both
  connect; `--extension-id` narrows trust to a single ID.
- **Decoupled from ZCode — now generic across MCP clients** (Claude Code, Codex,
  any MCP client). The server already spoke standard MCP; this is a naming/docs
  change plus two identifier renames:
  - **Native host id `com.zcode.browser_bridge` → `com.browser_bridge.host`**
    (breaking: reinstall the host manifest via `install.sh`, and the manifest
    file is now `com.browser_bridge.host.json`).
  - Example config `zcode-mcp-config.json` → `mcp-config.example.json` (generic
    `mcpServers` shape); README documents Claude Code / Codex / generic setup.
- **Load-unpacked target moved from `extension/` to `extension/dist/`** (the
  build output). `install.sh` now builds the bundle; update your unpacked
  extension path accordingly.
- Rust errors on the tool-call path are now typed (`thiserror`) instead of
  strings.
- Signal handling: `SIGTERM`/`SIGINT` now trigger a graceful shutdown that
  removes the lock file (via a `libc` `sigwait` thread); scattered hand-rolled
  `extern "C"` shims collapsed onto `libc`.
- **README redesigned** — security-first intro, a prebuilt-first 60-second
  quickstart, the accurate 15-tool catalogue grouped by risk, plus
  configuration and troubleshooting sections.
- **Confirmation toasts restyled** — one consistent size (360px) across all of
  them; high-risk confirmations (submit/navigate click, `tab_close`, `page_eval`)
  now use a red danger theme, while the informational toast stays blue.
- **Installer UX** — prints the fully-resolved `claude mcp add …` command and
  can auto-register with Claude Code when its CLI is present.
- Repository tidy: `deny.toml` moved to `ci/deny.toml`; the remaining root files
  are documented in `GOVERNANCE.md` as reference-locked (required at root by a
  tool or convention).

### Fixed
- `page_fill` no longer sends a bogus "masked" copy of the value alongside the
  real one; a single `value` key is sent.
- The bridge session clears its writer on disconnect so the next tool call
  waits for a fresh host to reconnect instead of writing into a dead socket.
- Removed dead code (`is_connected`, an empty reserved `SENSITIVE_HOSTS`, a
  duplicate unused `STORAGE_KEY`).
- **Release workflow** pins `actions/checkout` to the released tag, so a manual
  `workflow_dispatch` run builds (and signs/labels) the tag rather than `main`.

### Dependencies
- Added `libc` and `thiserror` (Rust); esbuild/TypeScript/ESLint/Prettier
  toolchain (extension dev-dependencies).
