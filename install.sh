#!/usr/bin/env bash
# install.sh — build browser-bridge and register the Chrome native messaging host.
#
# Usage:
#   ./install.sh                        Build + install host manifest (uses a
#                                       placeholder allowed_origin that you
#                                       must patch after loading the extension).
#   ./install.sh --extension-id ABCD... Build, then write the real extension ID
#                                       into allowed_origins.
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

# ---- find cargo -----------------------------------------------------------

CARGO=""
CARGO_DIR=""
for candidate in cargo /opt/homebrew/bin/cargo "$HOME/.cargo/bin/cargo"; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CARGO="$(command -v "$candidate")"
    # Remember the dir so we can add it to PATH for the build subprocess
    # (cargo shells out to rustc; rustc must be on PATH).
    CARGO_DIR="$(dirname "$CARGO")"
    break
  fi
done
if [[ -z "$CARGO" ]]; then
  echo "error: cargo not found. Install Rust (https://rustup.rs) or fix PATH." >&2
  exit 1
fi
echo "[install] using cargo: $CARGO ($("$CARGO" --version))"

# Make sure rustc is discoverable for cargo's subprocesses. Prepend the dir
# containing cargo (Homebrew ships rustc alongside cargo) to PATH.
if [[ -n "$CARGO_DIR" ]] && [[ ":$PATH:" != *":$CARGO_DIR:"* ]]; then
  export PATH="$CARGO_DIR:$PATH"
fi

# ---- parse args -----------------------------------------------------------

EXTENSION_ID=""
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

# allowed_origins: empty list if we don't yet know the extension id (Chrome
# will refuse to connect, which is the safe default). Patch after loading.
ORIGINS="[]"
if [[ -n "$EXTENSION_ID" ]]; then
  ORIGINS="[\"chrome-extension://$EXTENSION_ID/\"]"
fi

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

if [[ -z "$EXTENSION_ID" ]]; then
  cat <<TIP

────────────────────────────────────────────────────────────────────
NEXT STEPS
────────────────────────────────────────────────────────────────────
1. Load the extension:
   - Open chrome://extensions
   - Enable "Developer mode" (top right)
   - Click "Load unpacked" → select: $HERE/extension/dist
   - Copy the extension ID (the 32-char string under the extension name).

2. Patch the host manifest with that ID:
   $0 --extension-id <PASTE_ID_HERE>

3. Register the MCP server with your agent (see README → Install for
   Claude Code / Codex / generic MCP clients). The binary is at:
   $INSTALL_DIR/$BINARY_NAME   (run with no arguments; it speaks MCP over stdio)
   A ready-to-copy JSON snippet is in mcp-config.example.json.

4. Restart Chrome (so it picks up the native messaging host manifest).

5. In your MCP client, the tools tab_list / page_snapshot / ... should now
   work. Click the Browser Bridge toolbar icon to approve sites on demand.
TIP
else
  echo ""
  echo "[install] extension ID set. Restart Chrome for the change to take effect."
fi
