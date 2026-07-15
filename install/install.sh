#!/usr/bin/env bash
# install.sh — build browser-bridge and register the Chrome native messaging host.
#
# Usage:
#   ./install.sh                        Build + install everything. The
#                                       extension ID is fixed (pinned by the
#                                       `key` in extension/manifest.json), so no
#                                       ID copy-paste is needed.
#   ./install.sh --extension-id ID      Override the pinned extension ID.
#   ./install.sh --browser chrome       Linux: install for chrome, chromium,
#                                       or both (default: auto-detect).
#   ./install.sh --skip-extension-build Reuse an existing extension/dist. Useful
#                                       in WSL when only the Rust toolchain is
#                                       installed in Linux.
#   ./install.sh --uninstall            Remove what this installer placed (binary,
#                                       run-host wrapper, native-host manifest,
#                                       run.lock). Leaves Chrome and the loaded
#                                       extension untouched.
#
# Two modes, auto-detected:
#   - source checkout (Cargo.toml present): builds the binary (Rust) + the
#     extension (Node/npm), then installs.
#   - prebuilt release tarball (no Cargo.toml): installs the shipped binary +
#     extension/dist directly — no Rust or Node needed.
# macOS/Linux + Google Chrome or Chromium.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Project root. In a release tarball the installer sits at the archive root next
# to extension/ (ROOT == HERE); in the source tree it lives in install/ with the
# project one level up (ROOT == HERE/..). Detect by which layout is beside us.
if [[ -d "$HERE/extension" || -f "$HERE/Cargo.toml" ]]; then
  ROOT="$HERE"
else
  ROOT="$(cd "$HERE/.." && pwd)"
fi
HOST_NAME="com.browser_bridge.host"
BINARY_NAME="browser-bridge"

# Deterministic extension ID, derived from the public `key` in
# extension/manifest.json (same for everyone, regardless of load path). If you
# ever change that key, update this to match (or pass --extension-id).
PINNED_EXTENSION_ID="mkjjlmjbcljpcfkfadfmhblmmddkdihf"

# ---- platform + args ------------------------------------------------------

EXTENSION_ID="$PINNED_EXTENSION_ID"
BROWSER="auto"
SKIP_EXTENSION_BUILD="${BB_SKIP_EXTENSION_BUILD:-0}"
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      EXTENSION_ID="${2:-}"
      [[ -n "$EXTENSION_ID" ]] || { echo "error: --extension-id requires a value" >&2; exit 1; }
      shift 2
      ;;
    --browser)
      BROWSER="${2:-}"
      [[ -n "$BROWSER" ]] || { echo "error: --browser requires chrome, chromium, or both" >&2; exit 1; }
      shift 2
      ;;
    --skip-extension-build)
      SKIP_EXTENSION_BUILD=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

[[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]] || {
  echo "error: extension id must be 32 characters in the range a-p" >&2
  exit 1
}

OS="$(uname -s)"
declare -a NM_DIRS=()
# Candidate per-user runtime/data dirs where the MCP server may have written its
# run.lock (mirrors LockFile::path() in src/ipc.rs). Only used by --uninstall,
# and only the exact file "run.lock" is ever removed from them.
declare -a LOCK_DIRS=()
case "$OS" in
  Darwin)
    INSTALL_DIR="${BB_INSTALL_DIR:-$HOME/.browser-bridge}"
    NM_DIRS+=("${BB_NM_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}")
    [[ -n "${XDG_RUNTIME_DIR:-}" ]] && LOCK_DIRS+=("$XDG_RUNTIME_DIR/browser-bridge")
    LOCK_DIRS+=("$HOME/Library/Application Support/browser-bridge")
    ;;
  Linux)
    INSTALL_DIR="${BB_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/browser-bridge}"
    CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
    [[ -n "${XDG_RUNTIME_DIR:-}" ]] && LOCK_DIRS+=("$XDG_RUNTIME_DIR/browser-bridge")
    [[ -n "${XDG_CACHE_HOME:-}" ]] && LOCK_DIRS+=("$XDG_CACHE_HOME/browser-bridge")
    LOCK_DIRS+=("$HOME/.cache/browser-bridge")
    if [[ -n "${BB_NM_DIR:-}" ]]; then
      NM_DIRS+=("$BB_NM_DIR")
    else
      if [[ "$BROWSER" == "auto" ]]; then
        if [[ "$UNINSTALL" == "1" ]]; then
          # We cannot know which browser was targeted at install time, so clean
          # the manifest from both candidate locations (the file is uniquely
          # named for this project, so this is safe).
          BROWSER="both"
        elif command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 || [[ -d "$CONFIG_HOME/google-chrome" ]]; then
          BROWSER="chrome"
        elif command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 || [[ -d "$CONFIG_HOME/chromium" ]]; then
          BROWSER="chromium"
        else
          BROWSER="chrome"
          echo "[install] no Linux browser detected; installing manifest for Google Chrome"
        fi
      fi
      case "$BROWSER" in
        chrome) NM_DIRS+=("$CONFIG_HOME/google-chrome/NativeMessagingHosts") ;;
        chromium) NM_DIRS+=("$CONFIG_HOME/chromium/NativeMessagingHosts") ;;
        both)
          NM_DIRS+=("$CONFIG_HOME/google-chrome/NativeMessagingHosts")
          NM_DIRS+=("$CONFIG_HOME/chromium/NativeMessagingHosts")
          ;;
        *) echo "error: --browser must be chrome, chromium, or both" >&2; exit 1 ;;
      esac
    fi
    ;;
  *)
    echo "error: unsupported platform: $OS (use install.ps1 on Windows)" >&2
    exit 1
    ;;
esac

# ---- uninstall ------------------------------------------------------------
# Reverses exactly what the install path above lays down: the binary and
# run-host wrapper in INSTALL_DIR, the native-host manifest in each NM_DIR, and
# the run.lock the server writes. Idempotent, prints every removal, never uses
# wildcards, never touches a process or the browser, and never removes anything
# this project did not create.

if [[ "$UNINSTALL" == "1" ]]; then
  echo "[uninstall] removing browser-bridge artifacts on $OS"
  removed=0

  # Native-host manifest(s) — the file we wrote, named uniquely for this project.
  for NM_DIR in "${NM_DIRS[@]}"; do
    MANIFEST="$NM_DIR/$HOST_NAME.json"
    if [[ -f "$MANIFEST" ]]; then
      rm -f "$MANIFEST"
      echo "[uninstall] removed host manifest: $MANIFEST"
      removed=1
    else
      echo "[uninstall] not present: $MANIFEST"
    fi
  done

  # Binary + native-host wrapper we placed in INSTALL_DIR.
  for artifact in "$INSTALL_DIR/$BINARY_NAME" "$INSTALL_DIR/run-host.sh"; do
    if [[ -e "$artifact" ]]; then
      rm -f "$artifact"
      echo "[uninstall] removed: $artifact"
      removed=1
    else
      echo "[uninstall] not present: $artifact"
    fi
  done
  # INSTALL_DIR is created by this installer; drop it only when now empty. rmdir
  # (never rm -r) guarantees we never delete unrelated files a user may have put
  # there.
  if [[ -d "$INSTALL_DIR" ]]; then
    if rmdir "$INSTALL_DIR" 2>/dev/null; then
      echo "[uninstall] removed empty dir: $INSTALL_DIR"
    fi
  fi

  # Runtime lock file the MCP server writes. Remove the exact file "run.lock"
  # from each candidate dir (no globbing), then drop the dir if it is now empty.
  for LOCK_DIR in "${LOCK_DIRS[@]}"; do
    LOCK="$LOCK_DIR/run.lock"
    if [[ -f "$LOCK" ]]; then
      rm -f "$LOCK"
      echo "[uninstall] removed lock file: $LOCK"
      removed=1
    fi
    if [[ -d "$LOCK_DIR" ]]; then
      rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
  done

  if [[ "$removed" == "0" ]]; then
    echo "[uninstall] nothing to remove — already clean"
  fi
  echo "[uninstall] done. Chrome and the loaded extension were left untouched;"
  echo "[uninstall] if you loaded the unpacked extension, remove it yourself via"
  echo "[uninstall] chrome://extensions."
  exit 0
fi

# ---- source vs prebuilt ---------------------------------------------------
# Source checkout (Cargo.toml present) → build the binary + extension.
# Prebuilt release tarball (no Cargo.toml) → use the shipped browser-bridge and
# extension/dist as-is; no Rust/Node needed.

if [[ -f "$ROOT/Cargo.toml" ]]; then
  # shellcheck source=SCRIPTDIR/../scripts/lib.sh
  source "$ROOT/scripts/lib.sh"
  bb_find_cargo # sets BB_CARGO + puts its dir on PATH (plain call, not subshell)
  echo "[install] source mode — building with $BB_CARGO"
  "$BB_CARGO" build --release --manifest-path "$ROOT/Cargo.toml"
  BIN_SRC="$ROOT/target/release/$BINARY_NAME"

  if [[ "$SKIP_EXTENSION_BUILD" == "1" ]]; then
    DIST_DIR="$ROOT/extension/dist"
    [[ -d "$DIST_DIR" ]] || {
      echo "error: --skip-extension-build requires an existing $DIST_DIR" >&2
      exit 1
    }
    echo "[install] reusing existing extension bundle at $DIST_DIR"
  else
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      echo "error: Linux/macOS Node.js + npm are needed to build the extension." >&2
      echo "       Install Node.js, or build extension/dist elsewhere and pass --skip-extension-build." >&2
      exit 1
    fi
    echo "[install] building extension bundle (esbuild)…"
    [[ -d "$ROOT/extension/node_modules" ]] || npm --prefix "$ROOT/extension" install
    npm --prefix "$ROOT/extension" run build
    DIST_DIR="$ROOT/extension/dist"
  fi
else
  echo "[install] prebuilt mode — using shipped binary + extension (no build)"
  BIN_SRC="$ROOT/$BINARY_NAME"
  DIST_DIR="$ROOT/extension/dist"
  [[ -f "$BIN_SRC" ]] || { echo "error: prebuilt binary not found at $BIN_SRC" >&2; exit 1; }
  [[ -d "$DIST_DIR" ]] || { echo "error: extension/dist not found at $DIST_DIR" >&2; exit 1; }
fi

# ---- install binary -------------------------------------------------------

mkdir -p "$INSTALL_DIR"
TMP_BIN="$INSTALL_DIR/$BINARY_NAME.tmp.$$"
cp "$BIN_SRC" "$TMP_BIN"
chmod 0755 "$TMP_BIN"
mv -f "$TMP_BIN" "$INSTALL_DIR/$BINARY_NAME"
echo "[install] binary installed at $INSTALL_DIR/$BINARY_NAME"

# macOS: a browser-downloaded prebuilt binary carries the com.apple.quarantine
# xattr, which the copy above inherits. Chrome spawns this binary via the native
# messaging host, and Gatekeeper can then silently block the (unsigned,
# not-yet-notarized) launch. Clear the attribute on the installed copy so the
# host starts. Best-effort: the source-built binary has no such attribute, and
# `xattr` may be absent, so never fail the install on this. This is a stopgap
# until the release binary is notarized.
if [[ "$OS" == "Darwin" ]] && command -v xattr >/dev/null 2>&1; then
  if xattr -p com.apple.quarantine "$INSTALL_DIR/$BINARY_NAME" >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null \
      && echo "[install] cleared com.apple.quarantine (Gatekeeper) on the binary"
  fi
fi

# ---- host manifest --------------------------------------------------------

# Chrome native-messaging manifests have no `args` field, so Unix installs use
# a tiny wrapper to select the binary's native-host mode.
WRAPPER="$INSTALL_DIR/run-host.sh"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$INSTALL_DIR/$BINARY_NAME" --native-host
EOF
chmod 0755 "$WRAPPER"

# allowed_origins pins the extension ID (fixed via the manifest key).
ORIGINS="[\"chrome-extension://$EXTENSION_ID/\"]"

for NM_DIR in "${NM_DIRS[@]}"; do
  mkdir -p "$NM_DIR"
  MANIFEST="$NM_DIR/$HOST_NAME.json"
  cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Browser Bridge native messaging host",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": $ORIGINS
}
EOF
  chmod 0644 "$MANIFEST"
  echo "[install] host manifest written to $MANIFEST"
done
echo "[install]   allowed_origins: $ORIGINS"

cat <<TIP

────────────────────────────────────────────────────────────────────
NEXT STEPS  (no extension-ID copying — it's pinned to $EXTENSION_ID)
────────────────────────────────────────────────────────────────────
1. Load the extension:
   - Open chrome://extensions → enable "Developer mode" (top right)
   - "Load unpacked" → select: $DIST_DIR
   (Verify the ID under the name is $EXTENSION_ID — the manifest already
    trusts it, so nothing to patch.)

2. Register the MCP server with your client. The binary is at:
   $INSTALL_DIR/$BINARY_NAME   (run with no arguments; speaks MCP over stdio)
   A ready-to-copy JSON snippet is in mcp-config.example.json (beside this
   installer). E.g. Claude Code:
   claude mcp add browser-bridge -- "$INSTALL_DIR/$BINARY_NAME"

3. Restart Chrome (so it picks up the native messaging host manifest).

4. In your MCP client, try "list my browser tabs". Approve new sites via the
   Browser Bridge toolbar icon when prompted.
TIP
