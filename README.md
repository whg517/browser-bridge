# browser-bridge

Let any **MCP client** — Claude Code, Codex, or anything that speaks the Model
Context Protocol — operate **your real Chrome**: your tabs, your login
sessions, your bookmarks, through a Chrome extension + native messaging host.
No separate browser instance, no CDP debug port, no `--remote-debugging`
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
  - [0011 配置通过独立 Options 页管理](./docs/adr/0011-options-page-for-settings.md)
  - [0012 扩展改用 TypeScript + esbuild 构建](./docs/adr/0012-typescript-esbuild-extension-build.md)
  - [0013 CI 与工具链](./docs/adr/0013-ci-and-toolchain.md)
  - [0014 分级日志与类型化错误](./docs/adr/0014-leveled-logging.md)
  - [0015 Windows 本地运行与安装](./docs/adr/0015-windows-support.md)

开发与贡献:[开发指南](./docs/development.md) · [贡献指南](./CONTRIBUTING.md)

```
MCP client ──stdio MCP──▶ browser-bridge (MCP server, Rust)
(Claude Code,             │
 Codex, …)                │ localhost TCP (NDJSON)
                          ▼
                   browser-bridge --native-host  ◀── spawned by Chrome
                          │
                          │ chrome.runtime.connectNative
                          ▼
                   Browser Bridge extension (MV3) ──▶ your page
```

## How it works

One Rust binary, two modes:

- **Default (MCP server)** — launched by your MCP client as a stdio MCP server.
  Speaks JSON-RPC 2.0 over stdio (MCP, protocol version `2025-06-18`). Owns
  session state and a localhost TCP socket published via a lock file.
- **`--native-host`** — launched by Chrome via the native messaging host
  manifest. A thin bridge that translates Chrome's native-messaging frames
  (4-byte LE length prefix + JSON) to NDJSON lines on the TCP socket.

Why two processes and a socket? Chrome spawns the native host itself; the MCP
server is spawned by the MCP client. They aren't parent/child, so they need an
IPC.
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

Not implemented by design: cookie/storage *writes* (read-only by design — see
[ADR-0010](./docs/adr/0010-cookie-storage-readonly.md)). IndexedDB reads and a
skill layer for common workflows are still future work.

## Install

Google Chrome on macOS or Windows.

### Windows

Prerequisites: Rust and Node.js. Run from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer builds both components, installs the executable to
`%LOCALAPPDATA%\browser-bridge\browser-bridge.exe`, writes the native-host
manifest, and registers it under the current user's Chrome Native Messaging
registry key. Administrator privileges are not required.

For Codex, the corresponding configuration is:

```toml
[mcp_servers.browser-bridge]
command = "C:\\Users\\YOUR_NAME\\AppData\\Local\\browser-bridge\\browser-bridge.exe"
args = []
```

A prebuilt Windows archive can use the same command when it contains
`browser-bridge.exe` and `extension\dist`; source files being absent makes the
installer skip Rust and Node.js automatically.

### macOS

### Prebuilt (no Rust/Node) — recommended

Download the `…-macos-arm64` tarball (Apple Silicon) from the
[latest release](https://github.com/whg517/browser-bridge/releases/latest),
then:

```sh
tar xzf browser-bridge-*-macos-*.tar.gz
cd browser-bridge-*-macos-*
./install.sh
```

`install.sh` auto-detects the prebuilt tarball and installs the shipped binary +
extension directly — no toolchain needed.

### From source

Prereqs: Rust toolchain (`install.sh` finds cargo on PATH or at
`/opt/homebrew/bin/cargo`) and Node.js + npm.

```sh
./install.sh
```

Either way, `install.sh` installs the binary to `~/.browser-bridge/` and writes
the native messaging host manifest (`com.browser_bridge.host.json`) with the
**pinned extension ID** already trusted.

Then:

1. **Load the extension.** `chrome://extensions` → enable Developer mode →
   "Load unpacked" → select the **`extension/dist/`** directory (the build
   output, not `extension/` itself). The extension ID is **pinned** (via the
   `key` in the manifest) to `mkjjlmjbcljpcfkfadfmhblmmddkdihf`, which
   `install.sh` already trusted — **no ID to copy, nothing to patch.** To
   rebuild after editing the TypeScript sources: `cd extension && npm run build`
   (or `npm run watch`).

2. **Register the MCP server with your MCP client.** The server is the
   installed binary (`~/.browser-bridge/browser-bridge` on macOS or
   `%LOCALAPPDATA%\browser-bridge\browser-bridge.exe` on Windows) run with no arguments;
   it speaks MCP over stdio. Use an **absolute path** — most clients don't
   expand `~`. `mcp-config.example.json` has a ready-to-copy JSON snippet.

   - **Claude Code** (CLI):
     ```sh
     claude mcp add browser-bridge -- "$HOME/.browser-bridge/browser-bridge"
     ```
   - **Codex** (`~/.codex/config.toml`):
     ```toml
     [mcp_servers.browser-bridge]
     command = "/absolute/path/to/.browser-bridge/browser-bridge"
     args = []
     ```
   - **Generic MCP client** (`mcpServers` JSON — Claude Desktop, etc.): copy the
     `browser-bridge` entry from [`mcp-config.example.json`](./mcp-config.example.json)
     into your client's config.

   Then restart (or reconnect) your MCP client session.

3. **Restart Chrome** so it picks up the native messaging host manifest.

4. In your MCP client, try: *"list my browser tabs."* The first time you target
   a new site, the extension toolbar icon shows a badge — click it and approve.

## Security model

| Boundary | How it's enforced |
|----------|-------------------|
| Site allowlist | Stored in `chrome.storage.local`. A new origin triggers a popup prompt; approving it also calls `chrome.permissions.request` for that host (required for the content script to inject). |
| High-risk actions | Submit-button clicks and link navigations inject a confirmation toast in the page; 30 s auto-deny, 60 s grace window after approval for the same kind of action on the same origin. |
| `page_eval` | High-risk channel: enlarged confirmation toast per call, same-origin 60s grace window, return value masked (JWT/hex/numbers/secrets) by default. See [ADR-0008](./docs/adr/0008-page-eval-confirmation-channel.md). |
| Sensitive data | `page_text` masks `<input type=password>` and long digit runs. `page_fill` on a password field masks the value in the args echo. |
| Host impersonation | The host manifest's `allowed_origins` pins the extension ID. The bridge socket authenticates each inbound connection with a per-run secret written to a per-user lock file (mode 0600 on Unix). |
| Protocol safety | Native-messaging frames cap at 1 MB outbound (Chrome's hard limit). All stdout writes are single-threaded and flushed per frame. A stderr panic hook prevents panic messages from corrupting the binary stream. |

## Debugging

- **Your MCP client's server/connection UI** — check the server connects;
  disconnect/reconnect (e.g. `/mcp` in Claude Code).
- **Extension DevTools** — `chrome://extensions` → Browser Bridge → "Service
  Worker" link opens the SW console. Look for `[bb]` logs and disconnect/
  reconnect events.
- **Native host stderr** — captured into Chrome's internal log. Launch Chrome
  from a terminal (`/Applications/Google Chrome.app/Contents/MacOS/Google
  Chrome`) to see `[native-host]` / `[mcp]` stderr live.
- **Lock file** — `~/Library/Application Support/browser-bridge/run.lock` on
  macOS, or `%LOCALAPPDATA%\browser-bridge\run.lock` on Windows
  shows the current MCP server's port + pid. If it's stale (server crashed),
  the native host removes it on next failed connect.

## Testing

Independent suites across two languages (see [tests/README.md](./tests/README.md)
for why), run together with `./tests/run_all.sh`:

**Protocol layer** — `tests/e2e.py` (49 assertions). Drives the real release
binary as subprocesses: MCP server over JSON-RPC/stdio, `--native-host` mode
with real Native-Messaging framing, and a mock extension over the localhost
TCP bridge. Verifies the wire protocols (NM framing, MCP handshake, tools/list,
every tool's request/response round-trip, error codes).

**DOM layer** — `tests/dom_test.ts`. **Injects the real
`extension/content.js` into a headless Chrome page** via the DevTools
Protocol and exercises every content-script op against a real DOM: snapshot
(refs/roles/names/visibility), click (verifies real onclick fires), fill
(native setter + framework change events), eval (masking + serialization +
error handling), storage_get (JWT masking), page_wait_for navigation waits,
the high-risk Toast flow, plus
shadow-DOM/iframe limitations and dynamic-insertion + re-snapshot ref
stability (SPA case). This suite has caught two real bugs in content.js:
`isVisible` missing aria-hidden ancestors, and `assignRef` reusing refs that
collided with newly-inserted elements' refs on re-snapshot.

**Smoke** — `tests/ext_test.ts` (bun + puppeteer). Launches real Chrome with
`extension/dist/` loaded and checks the MV3 service worker boots.

**Real integration** (opt-in) — `tests/integration_e2e.ts`. Closes the seam the
others mock: the real MCP server ↔ real extension round-trip over native
messaging (MCP client → binary → native host → extension → `chrome.tabs` →
back). Run with `BB_REAL_E2E=1 bun tests/integration_e2e.ts` (or, on Windows
with Node 22.12+, `$env:BB_REAL_E2E=1; node tests/integration_e2e.ts`). Chrome
for Testing or Chromium is required because official Chrome 137+ ignores
`--load-extension`. See
[tests/README.md](./tests/README.md) for the language split and details.

Requirements: Rust (cargo) for the build, Python 3, and (for the browser
suites) bun + Chrome. `run_all.sh` skips browser tests gracefully if bun/Chrome
are missing.

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
│   ├── src/             # TypeScript sources (bundled by esbuild)
│   │   ├── background.ts # MV3 SW: native port + dispatch + allowlist
│   │   ├── content.ts    # snapshot / click / fill / scroll / wait / toast
│   │   ├── options.ts / popup.ts
│   ├── manifest.json    # copied into dist/ at build time
│   ├── toast.css / popup.html / options.html / icons/
│   ├── build.mjs        # esbuild driver (src/ → dist/)
│   ├── tsconfig.json / package.json
│   └── dist/            # build output — the load-unpacked target (gitignored)
├── tests/
│   ├── e2e.py            # protocol-layer tests (real subprocesses)
│   ├── dom_test.ts       # DOM-layer tests (bun + headless Chrome CDP)
│   ├── fixtures/page.html
│   └── run_all.sh        # runs both suites
├── install.sh / install.ps1
└── mcp-config.example.json
```

## Status

v0.1 + phase-two/three tools — the protocol layers (NM framing, MCP JSON-RPC,
TCP bridge) are covered by end-to-end tests. The default DOM-side snapshot uses
a content-script approximation of the accessibility tree; `page_snapshot_precise`
is available as an explicit debugger-based fallback for complex ARIA/shadow DOM
cases. Cookie/storage access is read-only and masked.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow and
[docs/development.md](./docs/development.md) for the build/test/release loop.

## License

[Apache-2.0](./LICENSE). Copyright the browser-bridge contributors.
