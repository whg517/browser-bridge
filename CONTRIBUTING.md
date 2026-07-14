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

`main` is protected — you cannot push to it directly, and development **never**
happens on `main`. Every change lives on a branch in its own git worktree, and
lands via a squash-merged PR whose gates are green.

1. **Sync + branch in a worktree.** Each change gets its own git worktree under
   `.worktree/` (gitignored), on a branch named `type/branch-name` — `type` is a
   commit type (see [Commit convention](#commit-convention)) and `branch-name`
   is kebab-case and descriptive (e.g. `feat/capability-handshake`,
   `fix/reconnect-writer-clobber`). Always branch from the latest `origin/main`:
   ```sh
   git fetch origin
   git worktree add .worktree/feat/my-change -b feat/my-change origin/main
   cd .worktree/feat/my-change
   ```
2. Make the change with a matching test where practical.
3. **Stay synced.** Before committing, and again before merging, rebase onto the
   latest main so history stays linear (no merge commits):
   ```sh
   git pull --rebase origin main
   ```
4. **Gate locally — everything must pass** (`make help` lists all targets):
   ```sh
   make ci            # rust fmt/clippy/test + extension typecheck/lint/format + protocol e2e + version/gen consistency
   ```
   Browser tests (`make test-browser`) run **only** against an isolated Chrome
   for Testing via `CHROME_BIN`, never your daily Chrome (see Safety below and
   [tests/README.md](./tests/README.md)). They are not in the required gate;
   runtime-behavior changes (reconnect, handshake, service worker) must be
   verified there manually.
5. **Open a PR and squash-merge.** Push the branch, open a PR against `main`,
   wait for **all required checks green**, then **squash-merge** (one change =
   one commit on `main`):
   ```sh
   git push -u origin feat/my-change
   gh pr create --base main
   gh pr merge --squash        # after review + green checks
   ```
   Humans review, approve, and merge — automation never self-approves or
   self-merges.
6. Clean up: `git worktree remove .worktree/feat/my-change && git branch -d feat/my-change`.

## Commit convention

Commits follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): subject`.

- Allowed `type`: `feat` `fix` `docs` `refactor` `perf` `test` `ci` `build`
  `style` `revert`. **`chore` is not allowed** — every change maps to a more
  precise type (dependency bumps → `build`/`ci`, misc scripts → `build`,
  documentation → `docs`).
- `scope` is optional (`session`, `tools`, `error`, `ci`, `ext`, …).
- `subject` is imperative, present tense, lower-case, no trailing period; explain
  the *why* in the body. One logical change per commit.

## Safety (non-negotiable)

This project drives a real logged-in browser, and a past incident nearly took
down a machine. Never run `pkill` / `killall` / any pattern process-kill — only
`kill` a specific PID you started and verified. Never point browser tests at a
browser that could capture your real session — use an isolated Chrome for
Testing / Chromium via `CHROME_BIN`. Anything that would affect a process or
window you didn't start yourself: stop and ask first.

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
2. Add the matching `Tool` definition (`src/tools/catalogue.rs`) and a `HANDLERS`
   registry entry + `build_*` payload fn (`src/tools/handlers.rs`). The
   `matches_contract` and `registry_covers_catalogue` tests (`cargo test`)
   enforce parity with the contract.
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
