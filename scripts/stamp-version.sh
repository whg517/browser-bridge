#!/usr/bin/env bash
# Stamp a version across the crate and the extension, or reset the tree to the
# in-repo placeholder.
#
#   ./scripts/stamp-version.sh 0.6.0        stamp a release version
#   ./scripts/stamp-version.sh 0.6.0-rc.1   stamp a prerelease
#   ./scripts/stamp-version.sh              reset to the 0.0.0 placeholder
#
# `main` (and every branch off it) always carries the placeholder; the release
# workflow stamps the real version from the git tag right before it builds, so
# nothing built locally can claim to be a release (ADR-0026).
#
# Chrome's manifest `version` accepts only dot-separated integers, so a
# prerelease is stamped there as its numeric core:
#
#   tag v0.6.0-rc.1  ->  Cargo.toml / package.json  0.6.0-rc.1
#                        manifest.json              0.6.0
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

FULL="${1:-$BB_DEV_VERSION}"
# Reject a non-SemVer argument up front. A typo'd tag would otherwise be written
# into four files and only surface much later, mid-release.
[[ "$FULL" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
  bb_die "not a SemVer version: '$FULL' (expected X.Y.Z or X.Y.Z-suffix)"
CORE="$(bb_version_core "$FULL")"

if [[ "$FULL" == "$BB_DEV_VERSION" ]]; then
  echo "stamping the placeholder version: $FULL"
elif [[ "$FULL" != "$CORE" ]]; then
  echo "stamping release version: $FULL (manifest version $CORE)"
else
  echo "stamping release version: $FULL"
fi

# Cargo.toml — the [package] version is the first `^version` line in the file.
CARGO_TOML="$BB_ROOT/Cargo.toml"
tmp="$(mktemp)"
awk -v v="$FULL" '!seen && /^version[[:space:]]*=/ { sub(/"[^"]*"/, "\"" v "\""); seen=1 } { print }' \
  "$CARGO_TOML" >"$tmp"
mv "$tmp" "$CARGO_TOML"
echo "updated Cargo.toml"

# Cargo.lock carries the crate's own version too, so it must follow. `cargo
# metadata` rewrites the lockfile in place without building anything. Probe for
# cargo in a subshell first: bb_find_cargo exits on failure, and a missing
# toolchain should only warn here (the extension-only paths still work).
if (bb_find_cargo) >/dev/null 2>&1; then
  bb_find_cargo
  "$BB_CARGO" metadata --quiet --format-version 1 >/dev/null
  echo "updated Cargo.lock"
else
  echo "warning: cargo not found — Cargo.lock left stale" >&2
fi

# extension/manifest.json — replace the "version": "..." string in place.
# ("manifest_version" is a distinct key and is not matched by "version".)
MANIFEST="$BB_ROOT/extension/manifest.json"
tmp="$(mktemp)"
sed -E "s/(\"version\"[[:space:]]*:[[:space:]]*\")[^\"]+(\")/\1${CORE}\2/" "$MANIFEST" >"$tmp"
mv "$tmp" "$MANIFEST"
echo "updated extension/manifest.json"

# extension/package.json + package-lock.json — npm keeps both in sync.
(cd "$BB_ROOT/extension" && npm version "$FULL" --no-git-tag-version --allow-same-version >/dev/null)
echo "updated extension/package.json + package-lock.json"

"$BB_ROOT/scripts/check-version.sh" --stamped "$FULL"
