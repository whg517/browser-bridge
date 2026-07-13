#!/usr/bin/env bash
# Run all browser-bridge tests: protocol layer (e2e.py) + DOM layer (dom_test.ts).
# Exits 0 only if ALL tests pass.
#
# Requirements:
#   - Rust toolchain (cargo) for building the release binary
#   - Python 3 for tests/e2e.py
#   - bun + Chrome for tests/dom_test.ts and tests/ext_test.ts
#     (set CHROME_BIN to override the path)
#
# Each layer is independent; failures in one still let the others run so you see
# all problems in one pass — hence no `set -e` (we collect failures in FAILED).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$HERE/../scripts/lib.sh"
REPO="$BB_ROOT"
FAILED=0

# Locate cargo (sets BB_CARGO, prepends its dir to PATH for rustc discovery).
bb_find_cargo
CARGO="$BB_CARGO"

echo "═══ browser-bridge test suite ═══"
echo "(1/4) build release binary"
"$CARGO" build --release --manifest-path "$REPO/Cargo.toml" || { echo "BUILD FAILED"; exit 1; }

echo ""
echo "(2/4) build extension bundle (esbuild)"
# The DOM + smoke tests exercise the BUILT extension/dist/, so build it first.
if command -v npm >/dev/null 2>&1; then
  [[ -d "$REPO/extension/node_modules" ]] || npm --prefix "$REPO/extension" install
  npm --prefix "$REPO/extension" run build || { echo "EXTENSION BUILD FAILED"; FAILED=1; }
else
  echo "  SKIP  npm not found — cannot build extension (DOM/smoke tests will skip)"
fi

echo ""
echo "(3/4) protocol-layer tests (tests/e2e.py)"
python3 "$HERE/e2e.py" || { echo "PROTOCOL TESTS FAILED"; FAILED=1; }

echo ""
echo "(4/4) DOM-layer + smoke tests"
# SAFETY: browser tests must run against an ISOLATED browser (Chrome for
# Testing / Chromium via CHROME_BIN), never your daily Chrome — a non-headless
# --load-extension launch can capture and close your real session. We do NOT
# default CHROME_BIN to the system Chrome; if it's unset, skip the browser suite.
if [[ ! -d "$REPO/extension/dist" ]]; then
  echo "  SKIP  extension/dist missing (build step above did not run)"
elif [[ -z "${CHROME_BIN:-}" ]]; then
  echo "  SKIP  browser tests: set CHROME_BIN to an isolated Chrome for Testing /"
  echo "        Chromium binary (NOT your daily Chrome). See tests/README.md → Safety."
elif [[ ! -x "$CHROME_BIN" ]]; then
  echo "  SKIP  CHROME_BIN not executable: $CHROME_BIN"
else
  export CHROME_BIN
  if command -v bun >/dev/null 2>&1; then
    bun "$HERE/dom_test.ts" || { echo "DOM TESTS FAILED"; FAILED=1; }
  else
    echo "  SKIP  bun not found for DOM tests (install: https://bun.sh)"
  fi
  bun "$HERE/ext_test.ts" || { echo "SMOKE TEST FAILED"; FAILED=1; }
fi

echo ""
if [[ "$FAILED" -eq 0 ]]; then
  echo "═══ ALL TESTS PASSED ═══"
else
  echo "═══ SOME TESTS FAILED ═══"
fi
exit "$FAILED"
