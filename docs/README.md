# browser-bridge Documentation

This directory is the **single source of truth** for the browser-bridge project. Code comments answer "what does this code do"; this directory answers "why is it done this way, what needs to be done, and what are the constraints."

## Documentation Map

| Document | Contents | Audience |
|------|------|------|
| [requirements.md](./requirements.md) | Requirements: goals, user stories, functional/non-functional requirements, scope boundaries, phasing | Everyone (read this first) |
| [architecture.md](./architecture.md) | Architecture: components, data flow, protocol, security model, key constraints, technology choices | Implementers, reviewers |
| [cli.md](./cli.md) | CLI subcommands and troubleshooting: `doctor`/`status` read-only self-checks, `tools`/`call`, interpreting "server not reachable" | Users, troubleshooters |
| [integrations.md](./integrations.md) | Integrating various agents (Codex/OpenClaw/Cursor/Windsurf/Cline/Claude/LangChain/Hermes): register and get discovered | Users, integrators |
| [agent-prompt.md](./agent-prompt.md) | The copy-paste kickstart prompt for first-time agent use — also served over MCP `initialize` instructions | Users, integrators |
| [wsl.md](./wsl.md) | WSL usage guide: Windows-Chrome (interop) vs WSLg-Linux-Chrome topologies, install paths, don't-mix rules | WSL users |
| [operations.md](./operations.md) | Operations: the two binary modes, `doctor`/`status`, `BB_LOG`/auditing, lock files, native host reconnection | Users, operators |
| [compatibility.md](./compatibility.md) | Compatibility: the three version types, internal protocol version, capability/version handshake (current state of the contract) | Implementers, reviewers |
| [release.md](./release.md) | Release: tag-driven pipeline, precompiled tarball + checksums, dual-mode `install.sh`, SBOM | Releasers, reviewers |
| [development.md](./development.md) | Development guide: local dev loop, build/test toolchain, prerequisites, the `Makefile` tasks | Contributors |
| [chrome-web-store.md](./chrome-web-store.md) | Chrome Web Store release runbook: build the key-stripped store zip and upload a new version (decision in ADR-0019) | Maintainers |
| [privacy-policy.md](./privacy-policy.md) | Privacy policy for the store listing: what the extension accesses, no data collection, read-only masked credentials | Users, store reviewers |
| [security/threat-model.md](./security/threat-model.md) | Threat model: assets, adversaries, per-threat mitigations, residual risks | Maintainers, reviewers |
| [security/tool-risk-matrix.md](./security/tool-risk-matrix.md) | Per-tool risk matrix: blast radius and gating for each tool | Maintainers, reviewers |
| [security/trust-boundaries.md](./security/trust-boundaries.md) | Trust boundaries across the three processes / four protocol hops, plus invariants that must not regress | Maintainers, reviewers |
| [security/incident-response.md](./security/incident-response.md) | Security incident response runbook: reporting, triage, mitigation (disabling tools / unloading the extension), disclosure | Maintainers, reporters |
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
| [0007](./adr/0007-mcp-protocol-version-2025-06-18.md) | Lock the MCP protocol version to 2025-06-18 | Accepted |
| [0009](./adr/0009-page-snapshot-precise-debugger.md) | page_snapshot_precise uses chrome.debugger to obtain the authoritative a11y tree | Accepted |
| [0010](./adr/0010-cookie-storage-readonly.md) | Read-only Cookie/Storage access | Accepted |
| [0011](./adr/0011-options-page-for-settings.md) | Manage configuration through a dedicated Options page | Accepted |
| [0012](./adr/0012-typescript-esbuild-extension-build.md) | Write the extension in TypeScript, bundle to dist/ with esbuild | Accepted |
| [0013](./adr/0013-ci-and-toolchain.md) | Unified toolchain + CI (task runner, GitHub Actions, single version source) | Accepted |
| [0014](./adr/0014-leveled-logging.md) | Leveled logging (BB_LOG) + typed errors with thiserror | Accepted |
| [0015](./adr/0015-windows-support.md) | Run and install locally on Windows | Accepted |
| [0016](./adr/0016-linux-wsl-support.md) | Dual run modes for Linux and WSL | Accepted |
| [0017](./adr/0017-cdp-mode-all-ops.md) | CDP mode: all page operations can optionally go through chrome.debugger | Accepted |
| [0018](./adr/0018-tab-workspace-group.md) | Group AI tabs into the "Browser Bridge" group (workspace) | Accepted |
| [0019](./adr/0019-chrome-web-store-distribution.md) | Distribute via the Chrome Web Store (dual ID) | Accepted |
| [0021](./adr/0021-extension-i18n.md) | Extension UI i18n (English + Simplified Chinese) via `_locales` + a runtime toggle | Accepted |
| [0022](./adr/0022-allframes-page-reading.md) | Read sub-frames (SW-orchestrated allFrames; frame-namespaced refs) | Accepted |
| [0024](./adr/0024-remove-allowlist.md) | Remove the per-site allowlist; declare `<all_urls>` outright | Accepted |
| [0026](./adr/0026-release-time-version-stamping.md) | The repo carries `0.0.0`; the release version is stamped from the tag | Accepted |
| [0027](./adr/0027-version-announce-and-drift-advisory.md) | The extension announces its version; drift is reported to the agent, not enforced | Accepted |

## ADR Writing Conventions

When adding a new ADR:
- Filename: `NNNN-kebab-case-title.md`, numbered continuing from the highest value
- Status: Accepted / Deprecated
- Required sections: Context, Decision, Alternatives Considered, Consequences
- One decision per document, no mixing
