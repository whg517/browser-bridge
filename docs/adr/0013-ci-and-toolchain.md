# ADR-0013: Unified Toolchain and CI (Task Entry Point + GitHub Actions + Single Version Source)

- **Status**: Accepted (task entry point later revised: justfile → Makefile-only)
- **Date**: 2026-07-10
- **Deciders**: User + AI assistant

> **Revision note**: This ADR originally used a **justfile** as the task entry point, and for a while also carried a 1:1 mirrored
> `Makefile` (for environments without `just`). Keeping two task runners in sync manually carried a drift risk, so it was later **consolidated down to
> only the `Makefile`** (zero install, no need for `cargo install just`), and the `justfile` has been deleted. Below, wherever
> `justfile` / `just <recipe>` is mentioned, it is now provided by `Makefile` / `make <target>` instead; the recipe names and aggregates
> (`make ci`, etc.) are unchanged, and the rest of the decisions — CI, gates, version syncing, and so on — are unaffected.

## Context

The project spans two tech stacks (a Rust backend + a TypeScript extension) and multiple kinds of tests (Rust unit tests, protocol e2e, the DOM layer, smoke), but before this cleanup there was no unified developer entry point or automated gate:

- **Scattered commands**: build, test, and lint were each a string of commands you had to memorize (`cargo ...`, `npm --prefix extension run ...`, `python3 tests/e2e.py`, `bun ...`), spread across the README and people's memory, making it hard for new contributors to reproduce "what counts as passing".
- **No CI**: there were no automated checks at all — formatting, lint, and tests all relied on the committer's diligence, and regressions could easily slip into main.
- **Version drift**: the same version number lived in three places — `Cargo.toml`, `extension/manifest.json`, and `extension/package.json`. Editing them by hand made it easy to miss one, leaving the backend and the extension on inconsistent versions.

This cleanup gives the project an engineering baseline of "one command runs everything + CI blocks regressions + no version drift".

## Decision

**Adopt a justfile as the unified task entry point + GitHub Actions CI + rustfmt/clippy/eslint/prettier gates + a version-sync mechanism with Cargo.toml as the single source of truth.**

### 1. justfile task entry point
The `justfile` collapses all developer actions into named recipes: `build` / `fmt` / `lint` / `test-rust` / `test-e2e` / `ext-build` / `ext-typecheck` / `ext-lint` / `ext-format-check` / `test-browser` / `install` / `sync-version` / `check-version`, plus the aggregate recipe **`just ci`** (= fmt-check + clippy + Rust unit tests + extension typecheck/lint/format-check/build + e2e). By running `just ci` before committing, contributors can reproduce most of the CI gates locally (browser tests are broken out separately as `test-browser` because they require Chrome).

### 2. GitHub Actions CI (`.github/workflows/ci.yml`)
Triggered on push to main / PR / manual dispatch, with concurrency cancellation, split into five jobs:

| job | Contents |
|-----|------|
| **rust** | `cargo fmt --check` → `clippy --all-targets -D warnings` → `cargo test` → `cargo build --release` |
| **extension** | `npm ci` → `typecheck` → `lint` → `format:check` → `build` (in `extension/`) |
| **version-consistency** | `./scripts/check-version.sh` |
| **e2e** | builds the release binary, then `python3 tests/e2e.py` (drives the real binary) |
| **browser** | installs Chrome + bun, builds the extension, then runs `dom_test.ts` + `ext_test.ts` |

### 3. Quality gates
- **Rust**: `rustfmt` (`--check`) + `clippy` with **`-D warnings`** to promote every lint warning to an error.
- **Extension**: `tsc --noEmit` (strict types) + **ESLint** (flat config, focused on correctness) + **Prettier** (`--check`, the sole arbiter of formatting). Prettier owns formatting, ESLint owns correctness, and their responsibilities do not overlap.

### 4. Single source of truth for versions
**`Cargo.toml` is the single source of truth for the version**, kept consistent by two scripts:
- `scripts/check-version.sh`: verifies that `extension/manifest.json` and `extension/package.json` match `Cargo.toml`, and exits 1 on any mismatch (run by CI's version-consistency job).
- `scripts/sync-version.sh`: propagates the Cargo version number into the manifest (in-place `sed` replacement, avoiding the `manifest_version` key) and into package.json (+ package-lock.json, via `npm version`), then runs check automatically at the end.

Version bump flow: edit `Cargo.toml` → `just sync-version` → commit.

## Alternatives Considered

### Task entry point: Makefile vs npm scripts vs justfile
- **Makefile**: general-purpose but full of syntax traps (tab sensitivity, `.PHONY`, variable escaping), and skewed toward "just run a string of commands".
- **npm scripts**: inherently belong to the Node world; cramming Rust/Python tasks into `package.json` is awkward, and it requires a Node project at the root.
- **justfile (adopted)**: purpose-built as a "named task runner" — straightforward syntax, no tab traps, recipes can depend on each other (`test-e2e: build`), and it orchestrates the Rust/Node/Python commands across all three stacks while staying language-neutral.

### CI platform: GitHub Actions
The project is hosted on GitHub, so Actions has zero extra onboarding cost, and off-the-shelf actions like `dtolnay/rust-toolchain` / `Swatinem/rust-cache` / `browser-actions/setup-chrome` cover all the requirements. No external CI was considered.

### Version source: Cargo as source vs a standalone VERSION file
- **Standalone VERSION file**: adds one more intermediate source that everything has to read, which actually increases the number of sync points.
- **Cargo.toml as source (adopted)**: the backend is the main body of the project, so the crate version is naturally the release version; the extension manifest/package are downstream, so one-way propagation suffices, keeping the direction clear.

## Consequences

### Positive
- **One-command reproduction**: `just ci` makes "what counts as passing" executable and reproducible, so contributors can self-check locally.
- **Regressions blocked at the door**: formatting, lint (clippy `-D warnings`), types, unit tests, e2e, and DOM/smoke are all automated, keeping main green.
- **No version drift**: CI enforces consistency across all three places, and bumps follow an explicit one-way flow (edit Cargo → sync).
- **Clear responsibilities**: Prettier owns formatting, ESLint/clippy own correctness, each doing its own job.

### Negative / Trade-offs
- **Contributors must install the toolchain**: a full local self-check needs `just`, Rust (rustfmt/clippy), Node, and Python, and browser tests additionally need bun + Chrome. The barrier is higher than "just tweak something quickly".
- **Version bumps must go through sync**: you can't just edit one version number in one place; forgetting to run `sync-version` gets caught by the version-consistency job (which is the intended design, but is a one-time learning cost for anyone unfamiliar with the flow).
- **`-D warnings` is strict**: any new clippy warning turns CI red — the upside is no lingering tech debt, the cost is occasionally having to handle a harmless warning or add an explicit allow.

### Neutral
- Browser tests (which need Chrome) are not part of the `just ci` aggregate and are broken out separately as `test-browser` / CI's browser job — because their environment dependencies are heavy, they are kept in a separate layer from the pure-logic gates.

## Implementation

- `justfile`: all recipes + the `ci` / `test` aggregates.
- `.github/workflows/ci.yml`: the five jobs rust / extension / version-consistency / e2e / browser.
- `scripts/check-version.sh` + `scripts/sync-version.sh`: Cargo-as-source version verification and propagation.
- Rust: `cargo fmt` / `clippy -D warnings`; extension: `eslint.config.js` (flat) + Prettier.

## Relationship to Other ADRs

- **[ADR-0012](./0012-typescript-esbuild-extension-build.md)**: the extension job's typecheck/lint/format/build gates exist precisely to serve the TS + esbuild pipeline introduced by that ADR.
- **[ADR-0014](./0014-leveled-logging.md)**: the newly added Rust logging/error modules are covered by the rust job's clippy + `cargo test`.
