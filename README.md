# browser-bridge

Let ZCode (or any MCP client) operate **your real Chrome** — your tabs, your
login sessions, your bookmarks — through a Chrome extension + native messaging
host. No separate browser instance, no CDP debug port, no `--remote-debugging`
startup flag.

You stay in control: every new site needs explicit approval, and high-risk
actions (form submit, link navigation) pop a confirmation toast you must
approve.

## 📚 文档

完整设计文档在 [`docs/`](./docs/):

- [需求文档](./docs/requirements.md) — 目标、用户故事、功能/非功能需求、范围边界
- [架构文档](./docs/architecture.md) — 组件、数据流、协议、安全模型、关键约束
- [架构决策记录 (ADR)](./docs/adr/) — 每一个"为什么这么选"的可追溯记录:
  - [0001 用 Rust 单二进制](./docs/adr/0001-use-rust-single-binary.md)
  - [0002 三进程架构 + localhost TCP](./docs/adr/0002-three-process-architecture-localhost-tcp.md)
  - [0003 snapshot 走 content script 而非 chrome.debugger](./docs/adr/0003-content-script-snapshot-vs-chrome-debugger.md)
  - [0004 白名单 + optional host permissions](./docs/adr/0004-allowlist-with-optional-host-permissions.md)
  - [0005 page_eval 默认禁用](./docs/adr/0005-page-eval-disabled-by-default.md)(已被 0008 取代)
  - [0006 高危动作用 Toast 确认](./docs/adr/0006-toast-confirmation-for-high-risk.md)
  - [0007 锁定 MCP 协议版本 2025-06-18](./docs/adr/0007-mcp-protocol-version-2025-06-18.md)
  - [0008 page_eval 高危确认通道](./docs/adr/0008-page-eval-confirmation-channel.md)
  - [0009 page_snapshot_precise 用 chrome.debugger](./docs/adr/0009-page-snapshot-precise-debugger.md)
  - [0010 Cookie/Storage 只读访问](./docs/adr/0010-cookie-storage-readonly.md)

```
ZCode ──stdio MCP──▶ browser-bridge (MCP server, Rust)
                          │
                          │ localhost TCP (NDJSON)
                          ▼
                   browser-bridge --native-host  ◀── spawned by Chrome
                          │
                          │ chrome.runtime.connectNative
                          ▼
                   Browser Bridge extension (MV3) ──▶ your page
```

## How it works

One Rust binary, two modes:

- **Default (MCP server)** — launched by ZCode under `mcp.servers`. Speaks
  JSON-RPC 2.0 over stdio (MCP, protocol version `2025-06-18`). Owns session
  state and a localhost TCP socket published via a lock file.
- **`--native-host`** — launched by Chrome via the native messaging host
  manifest. A thin bridge that translates Chrome's native-messaging frames
  (4-byte LE length prefix + JSON) to NDJSON lines on the TCP socket.

Why two processes and a socket? Chrome spawns the native host itself; the MCP
server is spawned by ZCode. They aren't parent/child, so they need an IPC.
The native host is intentionally dumb — all real logic lives in the MCP
server, which means the MV3 service worker recycling (Chrome kills SWs every
~5 min) and host restarts don't lose session state.

## Tools (v0.1)

| Tool | What it does |
|------|--------------|
| `tab_list` / `tab_focus` / `tab_open` / `tab_close` | Tab management |
| `page_snapshot` | Accessibility-style tree of interactive elements (each with a stable `ref`) |
| `page_click` | Click by `ref` or `selector`; submit/link clicks require confirmation |
| `page_fill` | Type into a field (native setter, so React/Vue detect it) |
| `page_text` | Visible page text (passwords & card-like numbers masked) |
| `page_screenshot` | Visible viewport as PNG |
| `page_scroll` | Up / down / top / bottom / N pixels |
| `page_wait_for` | Wait for selector / text / navigation |
| `page_eval` | ⚠ HIGH RISK — execute arbitrary JS. Every call shows the full code in a confirmation prompt; return value masked by default. |
| `page_snapshot_precise` | Authoritative a11y tree via chrome.debugger (shadow DOM, complex ARIA). Briefly shows a 'debugging' banner; user is warned first. Refs use `p` prefix. |
| `cookie_get` | Read cookies for the active tab (incl. httpOnly). Scoped to allowlisted hosts. Read-only; values masked. |
| `storage_get` | Read the page's localStorage / sessionStorage (where frameworks keep tokens). Same-origin only. Always masked. |

Not yet implemented (planned): cookie/storage *writes* (read-only by design —
see [ADR-0010](./docs/adr/0010-cookie-storage-readonly.md)), IndexedDB reads,
and a skill layer for common workflows.

## Install

Prereqs: Rust toolchain (Homebrew Rust works; `install.sh` finds cargo on
PATH or at `/opt/homebrew/bin/cargo`).

```sh
./install.sh
```

This builds the binary, installs it to `~/.browser-bridge/`, and writes the
native messaging host manifest to
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.zcode.browser_bridge.json`
(with an empty `allowed_origins` placeholder).

Then:

1. **Load the extension.** `chrome://extensions` → enable Developer mode →
   "Load unpacked" → select the `extension/` directory in this repo. Copy
   the 32-char **extension ID** shown on the card.

2. **Patch the host manifest with the extension ID:**
   ```sh
   ./install.sh --extension-id <PASTE_ID_HERE>
   ```

3. **Register the MCP server with ZCode.** Copy the `browser-bridge` entry
   from `zcode-mcp-config.json` into `~/.zcode/cli/config.json` under
   `mcp.servers`, then restart your ZCode session.

4. **Restart Chrome** so it picks up the native messaging host manifest.

5. In ZCode, try: *"list my browser tabs."* The first time you target a new
   site, the extension toolbar icon shows a badge — click it and approve.

## Security model

| Boundary | How it's enforced |
|----------|-------------------|
| Site allowlist | Stored in `chrome.storage.local`. A new origin triggers a popup prompt; approving it also calls `chrome.permissions.request` for that host (required for the content script to inject). |
| High-risk actions | Submit-button clicks and link navigations inject a confirmation toast in the page; 30 s auto-deny, 60 s grace window after approval for the same kind of action on the same origin. |
| `page_eval` | High-risk channel: enlarged confirmation toast per call, same-origin 60s grace window, return value masked (JWT/hex/numbers/secrets) by default. See [ADR-0008](./docs/adr/0008-page-eval-confirmation-channel.md). |
| Sensitive data | `page_text` masks `<input type=password>` and long digit runs. `page_fill` on a password field masks the value in the args echo. |
| Host impersonation | The host manifest's `allowed_origins` pins the extension ID. The bridge socket authenticates each inbound connection with a per-run secret written to a 0600 lock file. |
| Protocol safety | Native-messaging frames cap at 1 MB outbound (Chrome's hard limit). All stdout writes are single-threaded and flushed per frame. A stderr panic hook prevents panic messages from corrupting the binary stream. |

## Debugging

- **`/mcp` menu in ZCode** — check the server connects; disconnect/reconnect.
- **Extension DevTools** — `chrome://extensions` → Browser Bridge → "Service
  Worker" link opens the SW console. Look for `[bb]` logs and disconnect/
  reconnect events.
- **Native host stderr** — captured into Chrome's internal log. Launch Chrome
  from a terminal (`/Applications/Google Chrome.app/Contents/MacOS/Google
  Chrome`) to see `[native-host]` / `[mcp]` stderr live.
- **Lock file** — `~/Library/Application Support/browser-bridge/run.lock`
  shows the current MCP server's port + pid. If it's stale (server crashed),
  the native host removes it on next failed connect.

## Project layout

```
browser-bridge/
├── Cargo.toml
├── src/
│   ├── main.rs          # mode dispatch (default = MCP server, --native-host)
│   ├── protocol.rs      # NM framing, MCP JSON-RPC, bridge envelope
│   ├── ipc.rs           # localhost TCP + lock file + hello auth
│   ├── native_host.rs   # stdin/stdout NM <-> TCP bridge
│   ├── mcp_server.rs    # JSON-RPC main loop + tools dispatch
│   ├── tools.rs         # tool schemas + handlers
│   └── session.rs       # connection + request/response correlation
├── extension/
│   ├── manifest.json
│   ├── background.js    # MV3 SW: native port + dispatch + allowlist
│   ├── content.js       # snapshot / click / fill / scroll / wait / toast
│   ├── toast.css
│   ├── popup.html / popup.js
│   └── icons/
├── install.sh
└── zcode-mcp-config.json
```

## Status

v0.1 — minimal viable bridge. The protocol layers (NM framing, MCP JSON-RPC,
TCP bridge) are covered by end-to-end tests. The DOM-side snapshot uses a
content-script approximation of the accessibility tree (no `chrome.debugger`
infobar); it covers ~90% of common interactions but will miss edge cases
(closed shadow DOM, complex ARIA). A debugger-based precise snapshot is
planned for a later phase.

## License

Private / unlicensed for now.
