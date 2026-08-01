#!/usr/bin/env bash
# Verify the version is consistent across the crate and the extension.
#
#   ./scripts/check-version.sh                  the tree must hold the 0.0.0 placeholder
#   ./scripts/check-version.sh --stamped X.Y.Z  the tree must hold exactly X.Y.Z
#
# The default mode is the CI gate on every push: `main` and every branch off it
# carry the placeholder, and the real version is stamped from the git tag at
# release-build time (ADR-0026). The release workflow runs
# `stamp-version.sh <tag>` and then this script in `--stamped` mode to prove the
# stamp landed everywhere.
#
# Chrome's manifest `version` accepts only dot-separated integers, so a stamped
# prerelease holds its numeric core there. Exits 1 on any mismatch.
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODE="placeholder"
WANT="$BB_DEV_VERSION"
case "${1:-}" in
  "") ;;
  --stamped)
    MODE="stamped"
    WANT="${2:-}"
    [[ -n "$WANT" ]] || bb_die "--stamped needs a version argument"
    ;;
  *) bb_die "unknown argument '$1' (usage: check-version.sh [--stamped X.Y.Z])" ;;
esac
WANT_CORE="$(bb_version_core "$WANT")"

CARGO="$(bb_cargo_version)"
MANIFEST="$(bb_json_version "$BB_ROOT/extension/manifest.json")"
PKG="$(bb_json_version "$BB_ROOT/extension/package.json")"

printf 'expected (%s)          %s\n' "$MODE" "$WANT"
printf 'Cargo.toml               %s\n' "$CARGO"
printf 'extension/manifest.json  %s\n' "$MANIFEST"
printf 'extension/package.json   %s\n' "$PKG"

fail=0
# check <label> <actual> <expected>
check() {
  [[ "$2" == "$3" ]] || {
    echo "MISMATCH: $1 is '$2', expected '$3'" >&2
    fail=1
  }
}
check "Cargo.toml version" "$CARGO" "$WANT"
# The manifest holds the numeric core (identical to $WANT unless it is a prerelease).
check "manifest.json version" "$MANIFEST" "$WANT_CORE"
check "package.json version" "$PKG" "$WANT"

if [[ "$fail" -ne 0 && "$MODE" == "placeholder" ]]; then
  echo "hint: the repo stays at the $BB_DEV_VERSION placeholder — run './scripts/stamp-version.sh' to reset it" >&2
fi

if [[ "$fail" -eq 0 ]]; then
  echo "versions consistent ✓"
fi
exit "$fail"
