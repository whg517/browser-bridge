# browser-bridge

Let any **MCP client** — Claude Code, Claude Desktop, Codex, or anything that
speaks the Model Context Protocol — drive **your real Chrome**: your tabs, your
logged-in sessions, your cookies, through a Chrome extension + a native
messaging host. No second browser, no CDP debug port, no `--remote-debugging`
flag.

Because it operates the browser you're already signed into, an agent can do
things that a fresh headless browser can't: read a page behind your auth,
click through an app you're logged into, pull a token your framework stashed in
`localStorage`. That power is also the risk — see **Security** below before you
install.

---

## 🔒 Security first — read this

browser-bridge drives a **real, authenticated Chrome**. It can read page
content, cookies (including `httpOnly`), and web storage, and can run
JavaScript in your pages. The guardrails that keep that safe:

- **Approve every site.** A new origin triggers a popup prompt; nothing runs on
  a site you haven't approved (which also grants the host permission the content
  script needs).
- **Confirm high-risk actions.** Submit-button clicks, link navigations, tab
  close, and **every `page_eval`** pop an on-page confirmation you must approve
  (with a short same-origin grace window).
- **Read-only credentials.** Cookies and storage can be *read* (always masked —
  JWTs, long hex, long digit runs), never written. There is no `cookie_set` /
  `storage_set` by design.
- **Authenticated bridge.** The localhost TCP socket authenticates each
  connection with a per-run secret in a `0600` lock file; the native-host
  manifest pins the extension ID.

Full details: **[SECURITY.md](./SECURITY.md)** ·
[threat model](./docs/security/threat-model.md) ·
[trust boundaries](./docs/security/trust-boundaries.md) ·
[per-tool risk matrix](./docs/security/tool-risk-matrix.md).

---

## Quickstart (≈60 seconds)

**Prereqs:** Google Chrome (or Chromium on Linux). The **prebuilt** path below
needs *no Rust and no Node.js*.

### 1. Get the binary + extension

Download the archive for your platform from the
**[latest release](https://github.com/whg517/browser-bridge/releases/latest)**,
then run the bundled installer. `install.sh` auto-detects the prebuilt tarball
and installs the shipped binary + extension directly.

<details open>
<summary><b>macOS (Apple Silicon) / Linux x64</b></summary>

```sh
tar xzf browser-bridge-*-macos-arm64.tar.gz   # or -linux-x64
cd browser-bridge-*-macos-arm64
./install.sh
```

Installs the binary to `~/.browser-bridge/` (macOS) or
`~/.local/share/browser-bridge/` (Linux) and writes the native-messaging host
manifest with the pinned extension ID already trusted.

> **macOS Gatekeeper:** the prebuilt binary is not yet notarized, so a
> browser-downloaded archive may be quarantined ("cannot be verified"). Clear it
> once after extracting — `xattr -dr com.apple.quarantine .` inside the
> extracted folder — then re-run `./install.sh`.
</details>

<details>
<summary><b>Windows x64</b></summary>

```powershell
Expand-Archive browser-bridge-*-windows-x64.zip -DestinationPath .
cd browser-bridge-*-windows-x64
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Installs `browser-bridge.exe` to `%LOCALAPPDATA%\browser-bridge\` and registers
the host under your user's Chrome Native Messaging registry key. No admin rights
needed.

> **SmartScreen:** the prebuilt exe is unsigned, so SmartScreen may warn on first
> run — choose **More info → Run anyway**.
</details>

<details>
<summary><b>Build from source (needs Rust + Node.js/npm)</b></summary>

```sh
git clone https://github.com/whg517/browser-bridge && cd browser-bridge
./install/install.sh            # Linux: --browser chrome|chromium|both
```

`install/install.sh` builds the Rust binary and the extension bundle, then installs both.
See [docs/development.md](./docs/development.md) for the full build/test loop.
</details>

> Only need the extension (binary already installed)? Grab
> `browser-bridge-extension-<tag>.zip` from the same release and unzip it — it
> contains a top-level `dist/` you can load directly.

### 2. Load the extension

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
the **`extension/dist/`** directory (the build output, *not* `extension/`).

The extension ID is **pinned** to `mkjjlmjbcljpcfkfadfmhblmmddkdihf` (via the
manifest `key`), which the installer already trusted — **nothing to copy, nothing
to patch.**

### 3. Register the MCP server

Point your client at the installed binary (run with no args — it speaks MCP over
stdio). Use an **absolute path**; most clients don't expand `~`.

- **Claude Code (CLI):**
  ```sh
  claude mcp add browser-bridge -- "$HOME/.browser-bridge/browser-bridge"
  ```
- **Claude Desktop / generic (`mcpServers` JSON):** copy the `browser-bridge`
  entry from [`mcp-config.example.json`](./install/mcp-config.example.json).
- **Codex (`~/.codex/config.toml`):**
  ```toml
  [mcp_servers.browser-bridge]
  command = "/absolute/path/to/browser-bridge"
  args = []
  ```

### 4. Restart Chrome & try it

Restart Chrome so it loads the native-host manifest, then reconnect your MCP
client and ask: **"list my browser tabs."** The first time you target a new
site, click the Browser Bridge toolbar icon and approve it.

> On **WSL**: if your everyday browser is Windows Chrome, install on Windows and
> point the WSL client at the `.exe` via `/mnt/c` — don't install a Linux host.
> If Chrome runs under WSLg, install natively in Linux. See the
> [WSL guide](./docs/wsl.md).

---

## What you can do — 15 tools

Grouped from the single source of truth,
[`contracts/tools.json`](./contracts/tools.json):

### Tabs
| Tool | Does | Risk |
|------|------|------|
| `tab_list` | List open tabs (id, title, url, active) | low |
| `tab_focus` | Bring a tab to the foreground | low |
| `tab_open` | Open a URL in a new tab (host must be allowlisted) | medium |
| `tab_close` | Close a tab (on-page confirmation) | high |

### Inspect a page
| Tool | Does | Risk |
|------|------|------|
| `page_snapshot` | Accessibility-style tree of interactive elements, each with a stable `ref` | low |
| `page_snapshot_precise` | Authoritative a11y tree via `chrome.debugger` (shadow DOM / complex ARIA); refs use a `p` prefix | medium |
| `page_text` | Visible page text (passwords & card-like numbers masked) | medium |
| `page_screenshot` | Visible viewport as a PNG | medium |

### Drive a page
| Tool | Does | Risk |
|------|------|------|
| `page_click` | Click by `ref` or `selector`; submit/link clicks require confirmation | high |
| `page_fill` | Type into a field (native setter, so React/Vue detect it) | high |
| `page_scroll` | Up / down / top / bottom / N pixels | low |
| `page_wait_for` | Wait for a selector, text, or navigation | low |

### Run code (highest risk)
| Tool | Does | Risk |
|------|------|------|
| `page_eval` | ⚠ Execute arbitrary JS. **Every call** shows the full code in a confirmation prompt; return value masked by default. Prefer the tools above. | critical |

### Read credentials (read-only, always masked)
| Tool | Does | Risk |
|------|------|------|
| `cookie_get` | Read cookies for the active tab, incl. `httpOnly`; allowlisted hosts only | high |
| `storage_get` | Read the page's `localStorage` / `sessionStorage` (same-origin) | high |

*No write tools by design — cookie/storage writes are out of scope
([ADR-0010](./docs/adr/0010-cookie-storage-readonly.md)).*

---

## How it works

One Rust binary, two modes, joined by a localhost socket:

```
MCP client ──stdio MCP──▶ browser-bridge (MCP server, Rust)
(Claude Code,             │
 Codex, …)                │ localhost TCP (NDJSON, per-run secret auth)
                          ▼
                   browser-bridge --native-host  ◀── spawned by Chrome
                          │
                          │ chrome.runtime.connectNative
                          ▼
                   Browser Bridge extension (MV3) ──▶ your page
```

- **MCP server (default mode)** — launched by your MCP client over stdio.
  Speaks JSON-RPC 2.0 (MCP protocol `2025-06-18`). Owns session state and the
  TCP socket, published via a lock file.
- **`--native-host`** — launched *by Chrome* via the host manifest. A thin
  bridge translating Chrome's native-messaging frames (4-byte LE length + JSON)
  to NDJSON on the socket.

Why two processes? Chrome spawns the native host; the MCP client spawns the
server — they aren't parent/child, so they need an IPC. The native host stays
dumb so that MV3 service-worker recycling (~every 5 min) and host restarts don't
lose session state.

Deep dive: [docs/architecture.md](./docs/architecture.md) ·
[ADR-0002](./docs/adr/0002-three-process-architecture-localhost-tcp.md).

---

## Compatibility

| | Supported |
|---|---|
| **macOS** | Apple Silicon (arm64) prebuilt. Intel via Rosetta 2 or from source. |
| **Linux** | x64 prebuilt; Google Chrome or Chromium. |
| **Windows** | x64 prebuilt (native, no admin). |
| **Browser** | Chrome / Chromium, Manifest V3 |
| **MCP protocol** | `2025-06-18` ([ADR-0007](./docs/adr/0007-mcp-protocol-version-2025-06-18.md)) |
| **Internal bridge protocol** | `1` (see [contracts/protocol-version.json](./contracts/protocol-version.json)) |

Prebuilt targets come from the tag-driven [release workflow](./.github/workflows/release.yml);
see [docs/compatibility.md](./docs/compatibility.md).

## Configuration

Environment variables read at launch (source: `src/log.rs`, [docs/cli.md](./docs/cli.md)):

| Var | Values | Default | Effect |
|-----|--------|---------|--------|
| `BB_LOG` | `error` \| `warn` \| `info` \| `debug` | `info` | stderr log / audit threshold. `warn`/`error` silences audit lines. |
| `BB_LOG_FORMAT` | `text` \| `json` | `text` | Audit-line format; `json` emits one object per line for machine collection. |

## Troubleshooting

Run the built-in read-only self-check first:

```sh
browser-bridge doctor    # or: browser-bridge status
```

It reports whether the server is reachable, the lock-file port/pid, and common
misconfigurations. Then check your MCP client's server UI (reconnect via `/mcp`
in Claude Code) and the extension's Service Worker console at
`chrome://extensions` (look for `[bb]` logs). Full runbook:
[docs/cli.md](./docs/cli.md) · [docs/operations.md](./docs/operations.md).

---

## Docs map

| Doc | What's in it |
|-----|--------------|
| [docs/requirements.md](./docs/requirements.md) | 目标、用户故事、功能/非功能需求、范围边界 |
| [docs/architecture.md](./docs/architecture.md) | 组件、数据流、协议、安全模型、关键约束 |
| [docs/security/](./docs/security/) | 威胁模型、信任边界、工具风险矩阵、事件响应 |
| [docs/cli.md](./docs/cli.md) | `doctor`/`status` 自检、故障排查 |
| [docs/operations.md](./docs/operations.md) | 两种二进制模式、日志/审计、锁文件、重连 |
| [docs/compatibility.md](./docs/compatibility.md) | 版本纪律与能力/协议握手 |
| [docs/release.md](./docs/release.md) | tag 驱动发布、预编译 tarball + 校验和、SBOM |
| [docs/wsl.md](./docs/wsl.md) | Windows Chrome interop 与 WSLg 两种模式 |
| [docs/adr/](./docs/adr/) | 架构决策记录 (ADR) — 每个"为什么这么选" |
| [contracts/](./contracts/README.md) | 工具目录、错误码、能力、协议版本(跨进程契约信源) |

<details>
<summary>Testing & project layout</summary>

Independent suites across two languages, run together with
`./tests/run_all.sh`:

- **Protocol layer** — `tests/e2e.py` drives the real binary (MCP over stdio,
  `--native-host` framing, mock extension over the TCP bridge).
- **DOM layer** — `tests/dom_test.ts` injects the real content script into
  headless Chrome via CDP and exercises every op against a real DOM.
- **Smoke** — `tests/ext_test.ts` boots real Chrome with `extension/dist/`.
- **Real integration** (opt-in) — `tests/integration_e2e.ts`; run with
  `BB_REAL_E2E=1`. Needs Chrome for Testing / Chromium.

See [tests/README.md](./tests/README.md). Rough source layout: `src/` (Rust:
`main.rs` mode dispatch, `protocol.rs`, `ipc.rs`, `native_host.rs`,
`mcp_server.rs`, `tools/`, `session.rs`), `extension/src/` (TypeScript →
`dist/` via esbuild), `contracts/` (cross-process contracts), `docs/`.
</details>

---

## Project status

**v0.1.0** ([Cargo.toml](./Cargo.toml)) plus phase-two/three tools. Protocol
layers (NM framing, MCP JSON-RPC, TCP bridge) are covered by end-to-end tests.
The default snapshot is a content-script approximation of the a11y tree;
`page_snapshot_precise` is the debugger-based fallback for complex ARIA/shadow
DOM. Cookie/storage access is read-only and masked. See
[CHANGELOG.md](./CHANGELOG.md).

## Contributing & governance

[CONTRIBUTING.md](./CONTRIBUTING.md) (workflow) ·
[GOVERNANCE.md](./GOVERNANCE.md) (how changes get made) ·
[SECURITY.md](./SECURITY.md) (reporting + review bar) ·
[docs/development.md](./docs/development.md) (build/test/release loop).

## License

[Apache-2.0](./LICENSE). Copyright the browser-bridge contributors.
