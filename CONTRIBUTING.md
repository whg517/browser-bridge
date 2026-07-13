# Contributing to browser-bridge

Thanks for your interest. This is a small, security-sensitive project (it drives
a real logged-in browser), so changes are held to a high bar for correctness and
for preserving the safety model.

## Before you start

- Read [docs/development.md](./docs/development.md) for the dev loop and
  [docs/architecture.md](./docs/architecture.md) for the design.
- Behavioral or security-model changes should reference (or add) an
  [ADR](./docs/adr/). Don't quietly weaken a confirmation/allowlist boundary.

## Workflow

1. Branch off `main`.
2. Make your change with a matching test where practical.
3. Run the full gate locally (`make help` lists all targets):
   ```sh
   make ci            # rust fmt/clippy/test + extension typecheck/lint/format/build + protocol e2e
   make test-browser  # DOM + smoke tests (needs bun + Chrome)
   ```
4. Keep commits focused; write a clear message explaining the *why*.
5. Open a PR. CI (`.github/workflows/ci.yml`) must be green.

## Code style

- **Rust** — `cargo fmt` (enforced by `cargo fmt --check`) and `cargo clippy`
  with `-D warnings`. Errors on the tool-call path use the typed `CallError`
  (`src/error.rs`); log via the `log_*!` macros (`src/log.rs`), never bare
  `eprintln!` for diagnostics. Remember: **stdout is protocol** — all logging
  goes to stderr.
- **Extension (TypeScript)** — ESLint + Prettier (`npm run lint`,
  `npm run format:check`). Prefer real types over `any` in new code (the initial
  migration left `any` in some DOM helpers; tightening them is welcome).
- Keep the `DEFAULTS` settings objects in `background.ts`, `content.ts`, and
  `options.ts` in sync, and keep the tool `op` strings in sync with `tools.rs`.

## Adding a tool

A new tool touches both sides (see architecture.md §10):

1. **Add it to [`contracts/tools.json`](contracts/tools.json)** — the single
   source for the catalogue (name, description, uiLabel, risk, scope,
   permission, confirmation, inputSchema). Run `make gen` to regenerate
   `extension/src/shared/ops.ts`, and bump the count in `tool_count_is_pinned`.
2. Add the matching `Tool` definition + `dispatch` arm in `src/tools.rs`. The
   `matches_contract` test (`cargo test`) enforces name/description/schema parity
   with the contract.
3. Handle the `op` in `extension/src/background.ts` (and `content.ts` if it's a
   page-level DOM op).
4. Give it a risk row in the [tool risk matrix](docs/security/tool-risk-matrix.md).
5. Extend `tests/e2e.py` (and `dom_test.ts` for DOM ops).

## Versioning

`Cargo.toml` is the source of truth. Bump it, run `make sync-version`, and update
`CHANGELOG.md`. CI fails if the crate and extension versions drift.

## License

By contributing you agree your contributions are licensed under
[Apache-2.0](./LICENSE).
