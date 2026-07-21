# browser-bridge Documentation

This directory is the **single source of truth** for the browser-bridge project. Code comments answer "what does this code do"; this directory answers "why is it done this way, what needs to be done, and what are the constraints."

## Documentation Map

| Document | Contents | Audience |
|------|------|------|
| [requirements.md](./requirements.md) | Requirements: goals, user stories, functional/non-functional requirements, scope boundaries, phasing | Everyone (read this first) |
| [architecture.md](./architecture.md) | Architecture: components, data flow, protocol, security model, key constraints, technology choices | Implementers, reviewers |
| [cli.md](./cli.md) | CLI subcommands and troubleshooting: `doctor`/`status` read-only self-checks, `tools`/`call`, interpreting "server not reachable" | Users, troubleshooters |
| [integrations.md](./integrations.md) | Integrating various agents (Codex/OpenClaw/Cursor/Windsurf/Cline/Claude/LangChain/Hermes): register and get discovered | Users, integrators |
| [operations.md](./operations.md) | Operations: the two binary modes, `doctor`/`status`, `BB_LOG`/auditing, lock files, native host reconnection | Users, operators |
| [compatibility.md](./compatibility.md) | Compatibility: the three version types, internal protocol version, capability/version handshake (current state of the contract) | Implementers, reviewers |
| [release.md](./release.md) | Release: tag-driven pipeline, precompiled tarball + checksums, dual-mode `install.sh`, SBOM | Releasers, reviewers |
| [chrome-web-store.md](./chrome-web-store.md) | Decision checklist for listing on the Chrome Web Store: pinned-ID migration, review risks, prerequisites | Maintainers (decision) |
| [security/incident-response.md](./security/incident-response.md) | Security incident response runbook: reporting, triage, mitigation (disabling tools/revoking the allowlist/master switch), disclosure | Maintainers, reporters |
| [adr/](./adr/) | Architecture Decision Records (ADRs): a traceable record of every "why this choice was made" | Reviewers, future contributors |

> The single source of truth for the cross-process contract (tool catalog, error
> classification, capabilities, protocol version) lives in
> [`contracts/`](../contracts/README.md).

> **The development workflow** (branch/commit/sync/merge conventions) is in the root [`CONTRIBUTING.md`](../CONTRIBUTING.md);
> the agent quick-reference entry point is [`AGENTS.md`](../AGENTS.md). The build/test toolchain is in [development.md](./development.md).

## How to Read

- **First time learning the project** → `requirements.md` → `architecture.md`
- **Want to change a design decision** → first read the corresponding ADR, review the trade-offs made at the time, then decide whether to overturn it
- **Want to add a new feature** → first confirm in the "scope boundaries" of `requirements.md` whether it is within the v0.1 scope

## ADR Index

An ADR (Architecture Decision Record) documents decisions where **there were multiple reasonable options and one was ultimately chosen**. Routine, uncontroversial choices do not get an ADR.

| # | Title | Status |
|---|------|------|
| [0001](./adr/0001-use-rust-single-binary.md) | Rust single binary + subcommand dispatch | Accepted |
| [0002](./adr/0002-three-process-architecture-localhost-tcp.md) | Three-process architecture + localhost TCP bridge | Accepted |
| [0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md) | Snapshot via content script rather than chrome.debugger | Accepted |
| [0004](./adr/0004-allowlist-with-optional-host-permissions.md) | Allowlist + optional host permissions granted on demand | Accepted |
| [0005](./adr/0005-page-eval-disabled-by-default.md) | page_eval disabled by default | Superseded by #0008 |
| [0006](./adr/0006-toast-confirmation-for-high-risk.md) | In-page toast + short-lived confirmation-free window for high-risk actions | Accepted |
| [0007](./adr/0007-mcp-protocol-version-2025-06-18.md) | Lock the MCP protocol version to 2025-06-18 | Accepted |
| [0008](./adr/0008-page-eval-confirmation-channel.md) | page_eval high-risk confirmation channel | Accepted |
| [0009](./adr/0009-page-snapshot-precise-debugger.md) | page_snapshot_precise uses chrome.debugger to obtain the authoritative a11y tree | Accepted |
| [0010](./adr/0010-cookie-storage-readonly.md) | Read-only Cookie/Storage access | Accepted |
| [0011](./adr/0011-options-page-for-settings.md) | Manage configuration through a dedicated Options page | Accepted |
| [0017](./adr/0017-cdp-mode-all-ops.md) | CDP mode: all page operations can optionally go through chrome.debugger | Accepted |
| [0018](./adr/0018-tab-workspace-group.md) | Group AI tabs into the "Browser Bridge" group (workspace) | Accepted |
| [0019](./adr/0019-chrome-web-store-distribution.md) | Distribute via the Chrome Web Store (dual ID) | Accepted |

## ADR Writing Conventions

When adding a new ADR:
- Filename: `NNNN-kebab-case-title.md`, numbered continuing from the highest value
- Status: Accepted / Superseded by #NNNN / Deprecated
- Required sections: Context, Decision, Alternatives Considered, Consequences
- One decision per document, no mixing

An overturned ADR is **not deleted**; change its status to `Superseded by #NNNN`, add a link, and preserve the history.
