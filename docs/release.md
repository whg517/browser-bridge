# Release: tag-driven release pipeline

> This document explains how browser-bridge is released: pushing a tag triggers prebuilt artifacts, checksums, a dual-mode install script,
> and a decoupled SBOM workflow. For version discipline see [compatibility.md](./compatibility.md);
> for installation artifact paths see [architecture.md §4.3](./architecture.md#43-installation-artifacts).

## Trigger: push a tag

Releases are driven by **git tag** (`.github/workflows/release.yml`, `on: push: tags: ["v*"]`,
with a `workflow_dispatch` manual entry point as well):

```bash
git tag v0.1.0 && git push --tags
```

The first step of the pipeline is a **version consistency check**: after stripping the leading `v` and any `-dev`/`-rc` prerelease suffix from the tag,
its core version must equal the `version` in `Cargo.toml`, otherwise it fails outright. Cargo is the single source of truth for the version
(see [ADR-0013](./adr/0013-ci-and-toolchain.md)). A tag with a suffix (such as `v0.1.0-rc.1`)
is marked as a prerelease.

## Build matrix and prebuilt tarball

release.yml builds across a matrix (currently `macos-14/arm64` and `ubuntu-22.04/x64`; Intel macOS is
**intentionally omitted** due to the scarcity of hosted runners, and Linux uses an older glibc baseline to broaden compatibility). For each target:

1. `cargo build --release` produces the binary.
2. `npm ci && npm run build` produces the extension bundle (`extension/dist/`).
3. Package into `browser-bridge-<tag>-<platform>-<arch>.tar.gz`, containing the binary,
   `extension/dist`, `install.sh`, `mcp-config.example.json`, `LICENSE`, and `README.md`.
4. Generate a `.tar.gz.sha256` checksum (`shasum` or `sha256sum`).
5. Use `softprops/action-gh-release` to create the GitHub Release, attaching the tarball + `.sha256`,
   and auto-generate the release notes.

Users therefore **do not need a Rust/Node toolchain** to install. All third-party Actions are pinned to a commit SHA (supply-chain governance).

## Dual-mode install.sh

A single `install.sh` automatically distinguishes two modes:

- **Source mode** (`Cargo.toml` present): builds the binary on the spot with Rust and the extension with Node/npm, then installs.
- **Prebuilt mode** (no `Cargo.toml`, i.e. after extracting the release tarball): directly installs the bundled binary and
  `extension/dist`, with **no need** for Rust or Node.

Both modes register the Chrome native messaging host manifest (`allowed_origins` hard-codes the extension ID);
for details see [architecture.md §4.3](./architecture.md#43-installation-artifacts) and
[operations.md](./operations.md). Windows uses `install.ps1` (see [ADR-0015](./adr/0015-windows-support.md)).

## SBOM: decoupled CycloneDX workflow

`.github/workflows/sbom.yml` is independent of release.yml and triggers on `release: published` (i.e. once the release
**has already been created**):

- Uses `anchore/sbom-action` to generate, from the **committed lockfiles** (`Cargo.lock` + `extension/package-lock.json`),
  CycloneDX JSON (`browser-bridge.cdx.json`), scanning the declared dependencies rather than the installed tree
  (a fresh checkout has no `node_modules/target`).
- Attaches the SBOM as an asset to the Release for the corresponding tag.

**Why decouple**: the SBOM workflow is separated from the binary release, so an SBOM-tooling failure **never blocks** the binary release.

## SemVer rules

Compatibility discipline is upheld even before 1.0; `0.x` is not treated as an excuse to break compatibility arbitrarily:

- **Patch**: bug fixes, internal refactors, logging improvements; no changes to tool parameters or security semantics.
- **Minor**: new tools, new optional fields, new capabilities, new configuration; backward compatible.
- **Major**: removing/renaming tools, changing field meanings, changing default permissions, relaxing security boundaries, an incompatible bridge protocol
  or extension version (corresponding to an internal bridge protocol version bump, see [compatibility.md](./compatibility.md)).

## Not yet landed (honest disclosure)

- macOS **real integration tests in the release gate**: these require a real browser and are not yet part of the release gate.

## See Also

- Operations and diagnostics: [operations.md](./operations.md).
- Versioning and handshake: [compatibility.md](./compatibility.md).
- CI and toolchain: [ADR-0013](./adr/0013-ci-and-toolchain.md).
