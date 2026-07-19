# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
