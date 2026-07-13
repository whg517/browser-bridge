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
#
# Two modes, auto-detected:
#   - source checkout (Cargo.toml present): builds the binary (Rust) + the
#     extension (Node/npm), then installs.
#   - prebuilt release tarball (no Cargo.toml): installs the shipped binary +
#     extension/dist directly — no Rust or Node needed.
# macOS/Linux + Google Chrome or Chromium.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
case "$OS" in
  Darwin)
    INSTALL_DIR="${BB_INSTALL_DIR:-$HOME/.browser-bridge}"
    NM_DIRS+=("${BB_NM_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}")
    ;;
  Linux)
    INSTALL_DIR="${BB_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/browser-bridge}"
    CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
    if [[ -n "${BB_NM_DIR:-}" ]]; then
      NM_DIRS+=("$BB_NM_DIR")
    else
      if [[ "$BROWSER" == "auto" ]]; then
        if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 || [[ -d "$CONFIG_HOME/google-chrome" ]]; then
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

# ---- source vs prebuilt ---------------------------------------------------
# Source checkout (Cargo.toml present) → build the binary + extension.
# Prebuilt release tarball (no Cargo.toml) → use the shipped browser-bridge and
# extension/dist as-is; no Rust/Node needed.

if [[ -f "$HERE/Cargo.toml" ]]; then
  # shellcheck source=scripts/lib.sh
  source "$HERE/scripts/lib.sh"
  bb_find_cargo # sets BB_CARGO + puts its dir on PATH (plain call, not subshell)
  echo "[install] source mode — building with $BB_CARGO"
  "$BB_CARGO" build --release --manifest-path "$HERE/Cargo.toml"
  BIN_SRC="$HERE/target/release/$BINARY_NAME"

  if [[ "$SKIP_EXTENSION_BUILD" == "1" ]]; then
    DIST_DIR="$HERE/extension/dist"
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
    [[ -d "$HERE/extension/node_modules" ]] || npm --prefix "$HERE/extension" install
    npm --prefix "$HERE/extension" run build
    DIST_DIR="$HERE/extension/dist"
  fi
else
  echo "[install] prebuilt mode — using shipped binary + extension (no build)"
  BIN_SRC="$HERE/$BINARY_NAME"
  DIST_DIR="$HERE/extension/dist"
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
   A ready-to-copy JSON snippet is in mcp-config.example.json. E.g. Claude Code:
   claude mcp add browser-bridge -- "$INSTALL_DIR/$BINARY_NAME"

3. Restart Chrome (so it picks up the native messaging host manifest).

4. In your MCP client, try "list my browser tabs". Approve new sites via the
   Browser Bridge toolbar icon when prompted.
TIP
