# AGENTS.md

Guidance for AI agents (and humans) working in **browser-bridge** — a Rust MCP
server + native-messaging host + MV3 Chrome extension that lets an MCP client
drive the user's real Chrome. This is small, security-sensitive software: it acts
in a logged-in browser, so correctness and the safety model come first.

Read this first, then follow the linked docs. **The full development process is
[`CONTRIBUTING.md`](./CONTRIBUTING.md) — it is authoritative; this file only
summarizes.**

## Golden rules

1. **Never develop on `main`.** It is protected. Work in a git worktree under
   `.worktree/`, on a branch named `type/branch-name` (kebab-case, descriptive,
   e.g. `feat/capability-handshake`). Branch from the latest `origin/main`:
   `git worktree add .worktree/feat/x -b feat/x origin/main`.
2. **Stay synced with rebase.** Before committing and before merging:
   `git pull --rebase origin main`. History stays linear — no merge commits.
3. **Conventional Commits, and `chore` is banned.** `type(scope): subject` with
   `type` ∈ `feat｜fix｜docs｜refactor｜perf｜test｜ci｜build｜style｜revert`.
   Explain the *why* in the body.
4. **Gates must be green before merge.** Run `make ci` locally; the PR's required
   CI checks must pass. See [Gates](#gates).
5. **Land via squash-merge PR.** Push the branch, open a PR against `main`, wait
   for green + review, then squash-merge (one change = one commit). Agents do
   **not** self-approve or self-merge — a human does.
6. Clean up the worktree and branch after merge.

## Safety red lines (a past incident nearly crashed a machine)

- **Never** run `pkill` / `killall` / any pattern-matched process kill. Only
  `kill` a specific PID you started and verified.
- **Never** run browser tests against a browser that could capture the user's
  real session. Browser tests use an **isolated Chrome for Testing / Chromium**
  via `CHROME_BIN` only. Do not launch the user's daily Chrome.
- Anything affecting a process or window you did not start yourself → **stop and
  ask**.
- Runtime-behavior changes (reconnect, capability handshake, service-worker
  logic) can only be *fully* verified in an isolated browser — flag that
  verification gap; don't claim it's done from static checks alone.

## Gates

```sh
make ci        # rust fmt/clippy/test + extension typecheck/lint/format + protocol e2e + version/gen consistency
```

Individually: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test`; `npm --prefix extension run typecheck|lint|format:check`,
`npm --prefix extension test`; `node scripts/gen-ops.mjs` (must leave no diff).
Browser suites (`make test-browser`) need `CHROME_BIN` → isolated Chrome and are
**not** part of the required gate.

## Project map

| Area | Where | Notes |
|------|-------|-------|
| Dev process | [`CONTRIBUTING.md`](./CONTRIBUTING.md) | branch/commit/sync/merge rules (authoritative) |
| Build & test toolchain | [`docs/development.md`](./docs/development.md) | prerequisites, `make` targets, releasing |
| Architecture | [`docs/architecture.md`](./docs/architecture.md) | components, protocols, security model |
| Cross-process contracts | [`contracts/`](./contracts/README.md) | tools, error codes, capabilities, protocol version, envelopes — single source of truth |
| Operations / CLI | [`docs/operations.md`](./docs/operations.md), [`docs/cli.md`](./docs/cli.md) | `doctor`/`status`, `BB_LOG`/audit |
| Tests & browser safety | [`tests/README.md`](./tests/README.md) | suites + the `CHROME_BIN` isolation rule |

## Conventions worth knowing

- **stdout is protocol** in both binary modes — all diagnostics go to stderr via
  the `log_*!` macros (`src/log.rs`), never bare `eprintln!`.
- Tool-call errors use the typed `CallError` (`src/error.rs`), mapped to the
  stable codes in [`contracts/errors.json`](./contracts/errors.json).
- The tool catalogue is generated from [`contracts/tools.json`](./contracts/tools.json)
  (`make gen` → `extension/src/shared/ops.ts`); Rust parity is enforced by
  `cargo test`. Adding a tool touches both sides — see `CONTRIBUTING.md`.
