# Release: tag-driven release pipeline

> This document explains how browser-bridge is released: pushing a tag triggers prebuilt artifacts, checksums, a dual-mode install script,
> and an attached CycloneDX SBOM. For version discipline see [compatibility.md](./compatibility.md);
> for installation artifact paths see [architecture.md §4.3](./architecture.md#43-installation-artifacts).

## Trigger: push a tag

Releases are driven by **git tag** (`.github/workflows/release.yml`, `on: push: tags: ["v*"]`,
with a `workflow_dispatch` manual entry point as well):

```bash
git tag v0.1.0 && git push --tags
```

The first step of the pipeline is **version stamping**: the tag is the single source of the version
(see [ADR-0026](./adr/0026-release-time-version-stamping.md)). The repo itself permanently carries the
placeholder `0.0.0`, so `scripts/stamp-version.sh "${TAG#v}"` writes the real version into `Cargo.toml`,
`Cargo.lock`, `extension/manifest.json` and `extension/package.json` **before** anything is built, on every
matrix leg; `scripts/check-version.sh --stamped` then proves the stamp landed in all four. Chrome's manifest
`version` takes only dot-separated integers, so a prerelease is stamped there as its numeric core
(`v0.6.0-rc.1` → manifest `0.6.0`). A second gate fails the run if `CHANGELOG.md` has no `## [X.Y.Z]` section
for the tag. A tag with a suffix (such as `v0.1.0-rc.1`) is marked as a prerelease.

## Build matrix and prebuilt tarball

release.yml builds across a matrix (currently `macos-26/arm64`, `ubuntu-24.04/x64`, and `windows-2025/x64`; Intel macOS is
**intentionally omitted** due to the scarcity of hosted runners — Intel users run the arm64 build under Rosetta 2 or build from source). The prebuilt Linux binary's glibc floor is set by the symbols it references (~2.34, the pthread-merge point) and **not** by the builder image, so it runs on glibc ≥ 2.34 (RHEL 9, Debian 12, Ubuntu 22.04+); hosts older than that build from source. For each target:

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

## SBOM: CycloneDX, attached after the binaries

Each release attaches a CycloneDX Software Bill of Materials, `browser-bridge.cdx.json`, generated from the **committed
lockfiles** (`Cargo.lock` + `extension/package-lock.json`) — `anchore/sbom-action` scans the declared dependencies rather
than an installed tree (a fresh checkout has no `node_modules/target`). This is the `sbom` job in release.yml:

- It `needs` the build matrix, so it starts **only after** the binaries have already been published — the binary release
  never waits on SBOM tooling.
- It is marked `continue-on-error`, so an `anchore/sbom-action` failure **never fails the release run**.
- It **stamps the version from the tag first**, exactly as the build matrix does. Being a separate job it gets its own
  fresh checkout, which carries the `0.0.0` placeholder ([ADR-0026](./adr/0026-release-time-version-stamping.md)) — and
  since the SBOM is generated *from the lockfiles*, skipping this makes it name a root component version that does not
  exist. The `v0.6.0-rc.1` rehearsal shipped exactly that: an SBOM claiming `browser-bridge 0.0.0` alongside binaries
  correctly reporting `0.6.0-rc.1`.
- `softprops/action-gh-release` attaches the JSON to the Release for the tag.

**Why in-pipeline, not a separate `release: published` workflow**: GitHub suppresses the `release: published` event for
releases created with the default `GITHUB_TOKEN` (workflow-recursion prevention). release.yml creates the Release with
`action-gh-release` + `GITHUB_TOKEN`, so that event never fired and the old standalone `sbom.yml` silently stopped
producing SBOMs after v0.1.1. Running the SBOM as a `needs`-gated, `continue-on-error` job in the same workflow makes it
deterministic while keeping the original decoupling intent — **an SBOM-tooling failure must never block the binary
release**.

**Manual backfill / re-attach**: `.github/workflows/sbom.yml` remains as a `workflow_dispatch`-only tool that (re)attaches
an SBOM to an existing release:

```bash
gh workflow run sbom.yml -f tag=v0.4.0
```

It was used to backfill v0.2.0–v0.4.0, which shipped before the in-pipeline job existed.

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
