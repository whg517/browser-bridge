# Development guide

This document covers the local dev loop, the build/test toolchain, and the
release process. For *why* the project is structured the way it is, see
[architecture.md](./architecture.md) and the [ADRs](./adr/).

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
scripts/             lib.sh (shared helpers) + check-version.sh, sync-version.sh
```

Shell scripts (`install.sh`, `scripts/*.sh`, `tests/run_all.sh`) share
`scripts/lib.sh` (sourced) for cargo discovery and version parsing — edit the
candidate list or parsing in one place. They're `shellcheck`-clean (CI gates
it; `make lint-scripts` locally).

## Common tasks

With `make` (`make help` lists every target):

```sh
make build          # cargo build --release
make test           # rust unit tests + protocol e2e
make test-browser   # build the extension, then DOM + smoke tests (needs bun + Chrome)
make ci             # everything CI runs, minus the browser job
make ext-build      # bundle the extension (src/ → dist/)
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

`Cargo.toml` is the single source of truth for the version.

```sh
# 1. bump the version in Cargo.toml
# 2. propagate it to the extension manifest + package files
make sync-version        # ./scripts/sync-version.sh
# 3. update CHANGELOG.md (move [Unreleased] items under the new version)
# 4. gate on a clean tree
make release             # check-version + full ci
# 5. tag — pushing a v* tag triggers .github/workflows/release.yml, which
#    builds macOS Apple Silicon and Linux x64 tarballs (binary + built
#    extension + install.sh) and publishes them to GitHub Releases.
git tag vX.Y.Z && git push --tags
```

CI (`.github/workflows/ci.yml`) enforces version consistency on every push, so
a forgotten `sync-version` fails the build. The release workflow also refuses to
run if the tag doesn't match the Cargo version.
