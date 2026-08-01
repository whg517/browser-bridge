#!/usr/bin/env bash
# Shared helpers for the browser-bridge shell scripts. Source it, don't run it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"   # from scripts/
#
# Every function is prefixed `bb_` to avoid clashing with the caller's names.

# Repo root, derived from this file's location (scripts/ is a direct child).
BB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export BB_ROOT

# Print an error to stderr and exit. Usage: bb_die "message" [exit_code]
bb_die() {
  echo "error: $1" >&2
  exit "${2:-1}"
}

# Locate a cargo binary (PATH, then the common Homebrew / rustup spots), set the
# global BB_CARGO to its absolute path, and prepend its directory to PATH so the
# rustc it shells out to is discoverable. Exits via bb_die if cargo is missing.
#
# Call it as a plain statement (NOT `$(bb_find_cargo)`) — the PATH export must
# happen in the caller's shell, not a command-substitution subshell. Read the
# result from $BB_CARGO afterwards.
bb_find_cargo() {
  local candidate
  BB_CARGO=""
  for candidate in cargo /opt/homebrew/bin/cargo "$HOME/.cargo/bin/cargo"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      BB_CARGO="$(command -v "$candidate")"
      break
    fi
  done
  [[ -n "$BB_CARGO" ]] || bb_die "cargo not found. Install Rust (https://rustup.rs) or fix PATH." 2
  export BB_CARGO
  local dir
  dir="$(dirname "$BB_CARGO")"
  if [[ ":$PATH:" != *":$dir:"* ]]; then
    export PATH="$dir:$PATH"
  fi
}

# The in-repo placeholder version. `main` and every feature branch always carry
# it, so no locally-built binary or unpacked extension can claim a release
# version; the real one is stamped from the git tag at release-build time only
# (see ADR-0026 and scripts/stamp-version.sh).
BB_DEV_VERSION="0.0.0"
export BB_DEV_VERSION

# Echo the crate version from Cargo.toml.
bb_cargo_version() {
  grep -m1 '^version' "$BB_ROOT/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/'
}

# Echo the "version" string from a JSON file. ("manifest_version" is a distinct
# key and is not matched.)
bb_json_version() {
  grep -m1 '"version"' "$1" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

# Echo the numeric core of a SemVer string: 0.6.0-rc.1 -> 0.6.0. Chrome's
# manifest `version` accepts only dot-separated integers, so a prerelease tag is
# stamped there as its core.
bb_version_core() {
  echo "${1%%-*}"
}
