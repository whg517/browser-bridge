# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Engineering-standardization overhaul (no user-facing behavior change to the
tools themselves; the extension now ships from a build step).

### Added
- Unified `justfile` task runner (`build`, `fmt`, `lint`, `test`, `ci`,
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

### Changed
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

### Fixed
- `page_fill` no longer sends a bogus "masked" copy of the value alongside the
  real one; a single `value` key is sent.
- The bridge session clears its writer on disconnect so the next tool call
  waits for a fresh host to reconnect instead of writing into a dead socket.
- Removed dead code (`is_connected`, an empty reserved `SENSITIVE_HOSTS`, a
  duplicate unused `STORAGE_KEY`).

### Dependencies
- Added `libc` and `thiserror` (Rust); esbuild/TypeScript/ESLint/Prettier
  toolchain (extension dev-dependencies).

## [0.1.0]

Initial implementation: Rust single-binary MCP server + `--native-host` bridge,
MV3 extension, and the v0.1 tool set (tab management, page snapshot/click/fill/
text/screenshot/scroll/wait, `page_eval`, `page_snapshot_precise`, `cookie_get`,
`storage_get`). See `docs/` for the requirements, architecture, and ADRs.
