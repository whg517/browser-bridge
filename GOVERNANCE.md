# Governance

How changes get made in browser-bridge. Small project, light process — but the
process that exists is enforced by CI, not by memory. See also
[CONTRIBUTING.md](CONTRIBUTING.md) (dev workflow) and [SECURITY.md](SECURITY.md)
(security bar).

## Branching

Trunk-based. `main` is always releasable.

```
main
 ├── feat/...
 ├── fix/...
 ├── refactor/...
 └── docs/...
```

Branch prefixes use the Conventional Commits types
(`feat|fix|docs|refactor|perf|test|ci|build|style|revert`); `chore` is not used
(see [CONTRIBUTING.md](CONTRIBUTING.md)). No long-lived `develop`. Branches merge
via PR and are deleted after merge.

`main` rules (enforced where possible via branch protection):

- changes land through PRs with green CI;
- no force-push;
- security-relevant PRs get extra scrutiny (see below);
- even the solo maintainer uses PRs for non-trivial work, to keep CI in the loop.

## Definition of Done

A change is done when:

- inputs are typed and (for tools) schema-validated;
- a new/changed tool has a risk level in the [risk matrix](docs/security/tool-risk-matrix.md);
- the permission/allowlist/confirmation path is clear;
- there are **positive and negative** tests (negative especially for security);
- errors have stable codes; logs contain no sensitive data;
- docs / generated files / CHANGELOG are updated;
- CI is green;
- no unexplained `any`, `unwrap()`/`expect()` on a production path, or new
  permission slipped in.

## Security-relevant changes

If a change touches permissions, credential access, confirmation, allowlist,
masking, bridge auth, the lock file/secret, or widens `page_eval` (full list in
[SECURITY.md](SECURITY.md)):

- use the [security-change issue/PR checklist](.github/ISSUE_TEMPLATE/security-change.yml);
- update the [tool risk matrix](docs/security/tool-risk-matrix.md) and, if a
  trust boundary moves, the [threat model](docs/security/threat-model.md);
- add a negative test proving the boundary still holds.

## Decisions: ADR vs RFC

- **ADR** (`docs/adr/`) records a decision *already made* (why single-binary,
  why localhost TCP, why a given confirmation UI). Status: Proposed / Accepted /
  Superseded / Deprecated.
- **RFC** (open a discussion/issue) is for proposing a *significant change*
  before building it — multi-client broker, a write capability, adopting Tokio,
  a new protocol version, Edge/Firefox support, enterprise policy. Flow:
  `RFC → discussion → accepted/rejected → implement → ADR records the outcome`.

## Tracking work & tech debt

Tech debt lives in GitHub Issues, not in comments or memory. Labels:

```
type:feature  type:bug  type:refactor  type:security  type:docs  type:tech-debt
area:rust  area:extension  area:protocol  area:installer  area:testing  area:release
priority:P0  priority:P1  priority:P2  priority:P3
```

A tech-debt issue states: the problem, the risk, the current workaround, the
target state, and what should trigger addressing it.

## Repository root is reference-locked

The files at the repository root are intentionally minimal, and most of them
**cannot move** without breaking tooling — a future "tidy-up" that relocates them
will silently break the build or lint gates. Before moving anything at root,
know why it is there:

- **Tool-pinned to root (cannot move):** `Cargo.toml` / `Cargo.lock` (cargo
  crate root), `rust-toolchain.toml` (rustup resolves it from the project root),
  `rustfmt.toml` and `clippy.toml` (`cargo fmt` / clippy discover them from the
  crate root; no CLI override is set), `deny.toml` (`cargo deny check` is invoked
  bare, so it uses the default root path), `.editorconfig` / `.gitignore` /
  `.gitattributes` / `.shellcheckrc` (walked up from the working tree).
- **Convention / GitHub-surfaced (keep at root):** `README.md`, `LICENSE`,
  `SECURITY.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`, `CHANGELOG.md`, `AGENTS.md`.
- **Referenced by path (moving requires editing every reference):** the
  installers and example config live in `install/` (`install.sh` / `install.ps1`
  / `mcp-config.example.json`), packaged *flat* at the archive root by
  `release.yml`; each installer detects the repo-vs-tarball layout to locate
  `extension/` and the crate. `Makefile` (root) is the canonical task entrypoint.

If a genuine reason to relocate one appears, update every reference in the same
change (CI workflows, `Makefile`, `scripts/`, docs, `CODEOWNERS`) and confirm the
lint/build gates still find their config.

## Versioning & release

`Cargo.toml` is the single source of truth; `make sync-version` propagates it.
Tagging `vX.Y.Z` triggers the release build. SemVer discipline applies even
pre-1.0 — a `0.x` bump is not a license to break compatibility silently
(tool removal/rename, permission widening, protocol breaks are "major"-shaped).
See [docs/development.md](docs/development.md#releasing).
