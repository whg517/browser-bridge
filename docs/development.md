# Development guide

This document covers the local dev loop, the build/test toolchain, and the
release process. For the **branch / commit / sync / merge workflow** (worktrees,
Conventional Commits, rebase, squash-merge, gates), see
[`../CONTRIBUTING.md`](../CONTRIBUTING.md). For *why* the project is structured
the way it is, see [architecture.md](./architecture.md) and the [ADRs](./adr/).

## Prerequisites

| Tool | Used for | Notes |
|------|----------|-------|
| Rust (cargo) | the `browser-bridge` binary | stable toolchain; `rustfmt` + `clippy` components |
| Node.js + npm | bundling the extension | esbuild build → `extension/dist/` |
| Python 3 | protocol e2e tests | stdlib only |
| bun | DOM-layer tests | runs `tests/dom_test.ts` |
| Chrome | DOM + smoke tests | `CHROME_BIN` overrides the path |
| `make` | task runner (optional) | `Makefile` collects every dev task; `make help` lists them. Each recipe is a plain command you can also run by hand |
| [`shellcheck`](https://www.shellcheck.net/) | linting the shell scripts (optional) | `make lint-scripts`; CI gates it |

## Layout

```
src/                 Rust: MCP server + native-host bridge (see architecture.md §4.1)
extension/
  src/*.ts           TypeScript sources (background/content/options/popup)
  dist/              esbuild output — the load-unpacked target (gitignored)
  build.mjs          esbuild driver
  manifest.json, *.html, toast.css, icons/   static assets, copied into dist/
tests/               e2e.py (protocol), dom_test.ts (DOM), ext_test.ts (smoke)
scripts/             lib.sh (shared helpers) + check-version.sh, stamp-version.sh
```

Shell scripts (`install/install.sh`, `scripts/*.sh`, `tests/run_all.sh`) share
`scripts/lib.sh` (sourced) for cargo discovery and version parsing — edit the
candidate list or parsing in one place. They're `shellcheck`-clean (CI gates
it; `make lint-scripts` locally).

## Common tasks

With `make` (`make help` lists every target):

```sh
make build          # cargo build --release  → target/release/browser-bridge
make test           # rust + extension unit tests + protocol e2e (no browser)
make test-browser   # build the extension, then DOM + smoke tests (needs bun + Chrome)
make ci             # every CI gate except the browser + installer-smoke jobs
make ext-build      # bundle the extension (src/ → dist/)
make ext-package    # zip the extension → dist-artifacts/ (load-unpacked + store zips)
make gen            # regenerate ops.ts from contracts/ (run after editing tools.json)
make fmt            # cargo fmt
make install        # build + install binary + host manifest
```

Or run the underlying commands directly:

```sh
cargo build --release
cargo test
cargo fmt --check && cargo clippy --all-targets -- -D warnings
python3 tests/e2e.py
npm --prefix extension ci
npm --prefix extension run typecheck   # tsc --noEmit
npm --prefix extension run lint         # eslint
npm --prefix extension run format:check # prettier
npm --prefix extension run build        # esbuild → dist/
```

## Working on the extension

The extension is authored in TypeScript and bundled with esbuild. Because
esbuild only strips types, a correct typing change produces a byte-identical
bundle — a handy way to prove a refactor is behavior-neutral (diff `dist/*.js`
against a saved reference).

```sh
cd extension
npm install
npm run watch     # rebuild dist/ on change
```

Load `extension/dist/` as an unpacked extension in `chrome://extensions`
(Developer mode). Rebuild after editing `src/`, then hit the reload button on
the extension card.

## Building and packaging locally

| Want | Command | Output |
|------|---------|--------|
| The extension bundle (to **Load unpacked**) | `make ext-build` | `extension/dist/` |
| The two extension **zips** | `make ext-package` | `dist-artifacts/browser-bridge-extension.zip` + `…-store.zip` |
| The release **binary** | `make build` | `target/release/browser-bridge` |

`make ext-package` produces the same two zips the release pipeline uploads, so
you can eyeball them before a Chrome Web Store upload:

- `browser-bridge-extension.zip` — manifest `key` **kept**; this is the
  **Load-unpacked** package (the `key` pins the extension ID).
- `browser-bridge-extension-store.zip` — manifest `key` **stripped**; this is
  the **Chrome Web Store** upload (the store owns the signing key and rejects an
  upload that still carries a `key`). See
  [chrome-web-store.md](./chrome-web-store.md) and
  [ADR-0019](./adr/0019-chrome-web-store-distribution.md).

Both land in `dist-artifacts/` (gitignored). The full per-platform release
archives (binary + `dist/` + installer) are built by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) on a `v*`
tag, not locally.

## Testing

Three suites, all wired into `tests/run_all.sh` (and CI):

- **Protocol** (`tests/e2e.py`) — drives the real release binary as
  subprocesses over the actual wire protocols. No browser needed.
- **DOM** (`tests/dom_test.ts`, bun) — injects the built `dist/content.js` into
  a headless Chrome page via CDP and exercises every content-script op.
- **Smoke** (`tests/ext_test.ts`, bun + puppeteer-core) — launches Chrome with
  `dist/` loaded and checks the service worker boots. Set `BB_EXT_DIR` to point
  at a different unpacked extension.

```sh
bash tests/run_all.sh          # all three (skips browser tests if bun/Chrome absent)
CHROME_BIN=/path/to/chrome bash tests/run_all.sh
```

## Logging

Both binary modes log to **stderr** (stdout carries the wire protocols). Set the
level with `BB_LOG`:

```sh
BB_LOG=debug browser-bridge          # verbose
BB_LOG=error browser-bridge          # quiet
# default is info
```

## Releasing

**The git tag is the only source of the version.** The repo permanently carries
the placeholder `0.0.0`, and `release.yml` stamps the real version into the
tree right before it builds ([ADR-0026](./adr/0026-release-time-version-stamping.md)).
There is no version to bump.

```sh
# 1. update CHANGELOG.md (move [Unreleased] items under the new version heading;
#    release.yml refuses to build without a "## [X.Y.Z]" section for the tag)
# 2. gate on a clean tree
make release             # check-version + full ci
# 3. tag — pushing a v* tag triggers .github/workflows/release.yml, which stamps
#    the version from the tag, then builds macOS Apple Silicon, Linux x64, and
#    Windows x64 archives (binary + built extension + installer) plus the two
#    extension zips, and publishes them to GitHub Releases.
git tag vX.Y.Z && git push --tags
```

`0.0.0` is what a locally-built binary (`browser-bridge --version`, `doctor`,
MCP `serverInfo`) and a locally-loaded unpacked extension report — that is the
point: it is immediately distinguishable from anything the release pipeline
produced. Chrome's manifest `version` takes only dot-separated integers, so a
stamped *prerelease* keeps the full string in `Cargo.toml`/`package.json` and its
numeric core in the manifest (`v0.6.0-rc.1` → manifest `0.6.0`).

CI (`.github/workflows/ci.yml`) runs `./scripts/check-version.sh` on every push
and fails if the tree has drifted off the placeholder. To stamp by hand — to
reproduce a release build locally, say:

```sh
make stamp-version VERSION=0.6.0   # ./scripts/stamp-version.sh 0.6.0
make stamp-version                 # no VERSION → reset to 0.0.0
```
