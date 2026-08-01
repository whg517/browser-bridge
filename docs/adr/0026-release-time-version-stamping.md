# ADR-0026: The repo carries `0.0.0`; the release version is stamped from the tag

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

[ADR-0013](./0013-ci-and-toolchain.md) made `Cargo.toml` the single source of
truth for the release version: `scripts/sync-version.sh` propagated it into
`extension/manifest.json` and `extension/package.json`, a CI job
(`version-consistency`) enforced that the three agreed, and `release.yml` refused
to build unless the pushed tag matched `Cargo.toml`. Releasing therefore meant
"bump `Cargo.toml`, run `make sync-version`, commit, tag".

That worked, but it puts a *release* fact into the *source* tree, and three
problems follow from it:

1. **Every build off `main` claims to be a release.** A `make install` from
   source, a PR artifact, a locally-run `make ext-package`, a developer's
   unpacked extension — all report `0.5.0`, indistinguishable from the published
   `v0.5.0`. When a user files a bug against "0.5.0" there is no way to tell
   which one they are running.
2. **Two sources of truth that must be manually reconciled.** The tag and
   `Cargo.toml` both encode the version, and the release only fails *after* the
   tag is pushed — the most expensive place to discover a typo, since a pushed
   tag has to be deleted and re-pushed.
3. **A mandatory bump commit.** Every release needed a mechanical
   "chore: bump version" commit — and `chore` is a banned commit type in this
   repo ([CONTRIBUTING.md](../../CONTRIBUTING.md)), so it had to be mislabelled
   as `build:` or `ci:` to land at all.

This gets worse now that the extension is published on the Chrome Web Store
([ADR-0019](./0019-chrome-web-store-distribution.md)): the extension auto-updates
while the native host binary is upgraded by hand, so host/extension version drift
is routine, and "which version is this really?" needs a trustworthy answer on
both sides ([ADR-0027](./0027-version-announce-and-drift-advisory.md) makes the
bridge report it).

## Decision

**The git tag is the only source of the release version. The repository
permanently carries the placeholder `0.0.0` — in `Cargo.toml`, `Cargo.lock`,
`extension/manifest.json` and `extension/package.json` alike — and `release.yml`
stamps the real version into the working tree immediately before it builds.**

`0.0.0` is a valid version for all three ecosystems (Cargo, npm, and Chrome's
manifest, which accepts only dot-separated integers), so no per-file special
casing is needed and `check-version.sh` stays a plain equality check. It is also
a version nothing will ever ship, which makes it self-evidently a placeholder:
`browser-bridge --version`, `doctor`, MCP `serverInfo` and `chrome://extensions`
all reporting `0.0.0` is the intended signal for "this was built locally".

Stamping tag `vX.Y.Z[-suffix]` writes the full version to `Cargo.toml`,
`Cargo.lock` and `package.json`. The manifest gets the **numeric core** `X.Y.Z`,
since Chrome would reject a prerelease suffix there.

### Mechanics

- **`scripts/stamp-version.sh [X.Y.Z[-suffix]]`** (replaces `sync-version.sh`) —
  stamps a version, or resets the tree to the placeholder when called with no
  argument. It validates the argument as SemVer before touching any file.
- **`scripts/check-version.sh`** — two modes. The default asserts the tree holds
  the placeholder consistently (this is the `version-consistency` CI gate on
  every push, unchanged in name and invocation). `--stamped X.Y.Z` asserts the
  tree holds exactly that version, and is what proves the release stamp landed.
- **`release.yml`** — a `Stamp version from tag` step replaces the old
  `Verify tag matches Cargo version` step. It runs on every matrix leg (each leg
  is an independent checkout) and **before** both `cargo build --release` and
  `npm ci && npm run build`.
- **`make stamp-version VERSION=x.y.z`** — the manual escape hatch; no `VERSION`
  resets to the placeholder.

## Alternatives Considered

- **Keep `Cargo.toml` as the source, add a `-dev` suffix on `main`** (bump to
  `0.6.0-dev`, drop the suffix at release). Still requires a bump commit per
  cycle, still lets a dev build masquerade as *nearly* a release, and the Chrome
  manifest cannot hold the suffix anyway — so it buys nothing over the
  placeholder while keeping all of the bookkeeping.
- **`0.0.0-dev` as the placeholder, with the manifest carrying `"version":
  "0.0.0"` + `"version_name": "0.0.0-dev"`.** Chrome displays `version_name` in
  `chrome://extensions`, so the explicit "-dev" marker would be visible there.
  Rejected as not worth the asymmetry: one of the three files would encode the
  placeholder differently from the other two, `check-version.sh` would grow a
  fourth field and a core-vs-full distinction in its *normal* mode, and `0.0.0`
  on its own already reads unambiguously as "not a release".
- **Derive the version from `git describe` at build time** (a `build.rs` +
  an esbuild define). No files to stamp at all, and every build self-labels
  precisely — but it makes the version invisible in the source tree, requires
  full git history in every build context (the release tarball and the store zip
  have none), and `build.rs` would have to fabricate a manifest value for Chrome
  regardless. Too much machinery for a project that releases by hand.
- **Automate the bump with release-please / cargo-release.** Solves the bump
  commit, not the underlying problem: `main` would still carry a real version
  number that every dev build wears.

## Consequences

**Good**

- A version number is now a reliable claim: only artifacts produced by the
  tagged release pipeline carry one. Everything else says `0.0.0`.
- Releasing is a single act — `git tag vX.Y.Z && git push --tags`. No bump
  commit, and therefore no banned-`chore`-type workaround.
- A mistyped tag can no longer disagree with anything, because there is nothing
  left to disagree with.

**Costs and limits, honestly stated**

- **Two prereleases sharing a core collide in the manifest.** `v0.6.0-rc.1` and
  `v0.6.0-rc.2` both stamp manifest `version: "0.6.0"` — the suffix survives only
  in `Cargo.toml`/`package.json`, so Chrome cannot tell the two extension builds
  apart and the Chrome Web Store would reject the second as a duplicate. This is
  accepted: prereleases are GitHub-only artifacts and are never uploaded to the
  store.
- **The CHANGELOG lost its enforcer.** The bump commit used to drag the author
  into `CHANGELOG.md`. Replacing it, `release.yml` now fails if the CHANGELOG has
  no `## [X.Y.Z]` heading for the version being tagged.
- **A locally-built store zip is unpublishable.** `make ext-package` off `main`
  produces a `0.0.0` store zip. It prints a warning rather than failing, because
  packaging for Load-unpacked is an everyday dev action; the publishable zip
  comes from the release ([docs/chrome-web-store.md](../chrome-web-store.md)).
- **The stamp is not committed.** Released tags point at a tree that says
  `0.0.0`. Reproducing a release build by hand means running
  `./scripts/stamp-version.sh <version>` first. The release artifacts carry SLSA
  build provenance, which is the stronger guarantee anyway.

## Relationship to Other ADRs

- **[ADR-0013](./0013-ci-and-toolchain.md)**: supersedes its "single version
  source = `Cargo.toml`" decision and the `sync-version.sh` flow. Everything else
  in that ADR (task entry point, CI gates, lint/format discipline) is unaffected.
- **[ADR-0019](./0019-chrome-web-store-distribution.md)**: the store upload zip
  is now only ever produced by a tagged release build.
- **[ADR-0027](./0027-version-announce-and-drift-advisory.md)**: consumes this —
  `0.0.0` on both sides of the bridge is the signal for "a dev build, do not
  nag about drift".
