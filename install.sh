#!/usr/bin/env bash
# install.sh — build browser-bridge and register the Chrome native messaging host.
#
# Usage:
#   ./install.sh                        Build + install everything. The
#                                       extension ID is fixed (pinned by the
#                                       `key` in extension/manifest.json), so no
#                                       ID copy-paste is needed.
#   ./install.sh --extension-id ABCD... Override the pinned ID (e.g. a Web Store
#                                       build with a different ID).
#
# Prereqs: Rust toolchain. We look for cargo in the usual spots (PATH, then
# Homebrew's /opt/homebrew/bin) so this works even on shells where Homebrew
# isn't on PATH.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.browser_bridge.host"
INSTALL_DIR="$HOME/.browser-bridge"
BINARY_NAME="browser-bridge"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

# Deterministic extension ID, derived from the public `key` in
# extension/manifest.json (same for everyone, regardless of load path). If you
# ever change that key, update this to match (or pass --extension-id).
PINNED_EXTENSION_ID="fignfifoniblkonapihmkfakmlgkbkcf"

# shellcheck source=scripts/lib.sh
source "$HERE/scripts/lib.sh"

# ---- find cargo -----------------------------------------------------------
# Sets BB_CARGO and prepends its dir to PATH (so the rustc it shells out to is
# discoverable). Must be a plain call, not a subshell.
bb_find_cargo
CARGO="$BB_CARGO"
echo "[install] using cargo: $CARGO ($("$CARGO" --version))"

# ---- parse args -----------------------------------------------------------

EXTENSION_ID="$PINNED_EXTENSION_ID"
if [[ "${1:-}" == "--extension-id" ]]; then
  EXTENSION_ID="${2:-}"
  if [[ -z "$EXTENSION_ID" ]]; then
    echo "error: --extension-id requires a value (the 32-char extension id)" >&2
    exit 1
  fi
fi

# ---- build ----------------------------------------------------------------

echo "[install] building release…"
"$CARGO" build --release --manifest-path "$HERE/Cargo.toml"

# ---- build the extension bundle -------------------------------------------

# The extension is authored in TypeScript and bundled to extension/dist/ with
# esbuild; dist/ is the load-unpacked target. Needs Node + npm.
if command -v npm >/dev/null 2>&1; then
  echo "[install] building extension bundle (esbuild)…"
  if [[ ! -d "$HERE/extension/node_modules" ]]; then
    npm --prefix "$HERE/extension" install
  fi
  npm --prefix "$HERE/extension" run build
  echo "[install] extension bundle at $HERE/extension/dist"
else
  echo "warning: npm not found — cannot build the extension bundle." >&2
  echo "         Install Node.js (https://nodejs.org) then re-run, or build" >&2
  echo "         manually: cd extension && npm install && npm run build" >&2
fi

# ---- install binary -------------------------------------------------------

mkdir -p "$INSTALL_DIR"
TMP_BIN="$INSTALL_DIR/$BINARY_NAME.tmp.$$"
cp "$HERE/target/release/$BINARY_NAME" "$TMP_BIN"
chmod 0755 "$TMP_BIN"
mv -f "$TMP_BIN" "$INSTALL_DIR/$BINARY_NAME"
echo "[install] binary installed at $INSTALL_DIR/$BINARY_NAME"

# ---- host manifest --------------------------------------------------------

# We need to pass --native-host to the binary. Chrome's native messaging has
# no `args` field, so on macOS we use a tiny wrapper script with a shebang.
WRAPPER="$INSTALL_DIR/run-host.sh"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$INSTALL_DIR/$BINARY_NAME" --native-host
EOF
chmod 0755 "$WRAPPER"

mkdir -p "$NM_DIR"
MANIFEST="$NM_DIR/$HOST_NAME.json"

# allowed_origins pins the extension ID (fixed via the manifest key).
ORIGINS="[\"chrome-extension://$EXTENSION_ID/\"]"

cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Browser Bridge native messaging host",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": $ORIGINS
}
EOF

echo "[install] host manifest written to $MANIFEST"
echo "[install]   allowed_origins: $ORIGINS"

cat <<TIP

────────────────────────────────────────────────────────────────────
NEXT STEPS  (no extension-ID copying — it's pinned to $EXTENSION_ID)
────────────────────────────────────────────────────────────────────
1. Load the extension:
   - Open chrome://extensions → enable "Developer mode" (top right)
   - "Load unpacked" → select: $HERE/extension/dist
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
