# Architecture Document: browser-bridge

> This document describes browser-bridge's component structure, data flow, protocols, security model, and key constraints.
> For the "why" behind design decisions, see [adr/](./adr/).

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                     browser-bridge (Rust single binary)              │
│                                                                      │
│  ┌──────────────────────┐    localhost TCP    ┌──────────────────┐  │
│  │ MCP server (default) │  ◀──NDJSON JSON──▶  │ --native-host    │  │
│  │ - holds session state │  127.0.0.1:<random> │ (thin bridge)    │  │
│  │ - listens TCP, lockfile│                    │ - stdin NM frame→TCP│  │
│  │ - tool dispatch       │                     │ - TCP→stdout NM frame│  │
│  └──────────┬───────────┘                     └────────┬─────────┘  │
└─────────────┼─────────────────────────────────────────┼────────────┘
              ▲ stdio (NDJSON)                          ▲ stdin/stdout
              │ JSON-RPC 2.0                            │ NM frame (4B LE length+JSON)
              │                                         │
┌─────────────┴──────────────┐              ┌───────────┴──────────────┐
│  MCP client (Claude Code…) │              │  Chrome (spawns host)    │
│  client manages connection │              │                          │
└────────────────────────────┘              └────────────┬─────────────┘
                                                          │ chrome.runtime.connectNative
                                                          ▼
                                            ┌──────────────────────────┐
                                            │  Browser Bridge extension │
                                            │  (MV3)                   │
                                            │  background.js (SW):     │
                                            │   - native port + reconnect│
                                            │   - dispatch req to content│
                                            │   - allowlist management  │
                                            │  content.js:             │
                                            │   - snapshot/click/fill  │
                                            │   - Toast/redaction      │
                                            └────────────┬─────────────┘
                                                         │ chrome.tabs.sendMessage
                                                         ▼
                                            ┌──────────────────────────┐
                                            │  user's real page (logged in)│
                                            └──────────────────────────┘
```

## 2. The Three Processes

The system as a whole involves three independent processes; understanding their boundaries is the key to understanding the entire architecture.

| Process | Who starts it | Responsibilities | Lifecycle |
|------|---------|------|---------|
| **MCP server** | MCP client (spawned via its server config) | Holds session state, listens on TCP, tool logic dispatch | Tied to the client session |
| **native host** | Chrome (via host manifest) | Thin bridge between stdin/stdout NM frames ↔ TCP NDJSON | Tied to the Chrome extension's Port |
| **Chrome extension (SW + content)** | Chrome | Actual page operations, allowlist, Toast | SW restarts every 5 minutes; the extension is tied to the browser |

**Why three processes instead of one**: Chrome spawns the native host itself (via the manifest), and the MCP client spawns the MCP server itself. The two are **not in a parent-child relationship**, cannot share stdin/stdout, and therefore need an IPC channel between them. See [ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md) for details.

**Why the native host is extremely thin**: all logic lives in the MCP server. This way, neither an SW restart nor a host restart loses session state (the state is in the MCP server). The native host is merely a protocol translator.

## 3. Protocol Layer

The system involves three protocols, each with its own transport and frame format.

### 3.1 Native Messaging (extension ↔ native host)

Chrome's official protocol, defined at [developer.chrome.com/native-messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

- **Frame format**: `4-byte little-endian u32 length` + `UTF-8 JSON`
- **Length**: counts JSON bytes only, **excluding** the 4-byte prefix
- **Outbound (host→Chrome) hard limit**: **1 MB** (exceeding it makes Chrome close the Port outright)
- **Inbound (Chrome→host)**: 64 MB
- **Close signal**: **stdin EOF** (not SIGTERM); the host should exit gracefully when it reads EOF
- **stderr**: not shown to the user, but can be used for logging (recorded in Chrome's internal logs)
- **argv[1]**: Chrome passes in the caller's origin (e.g. `chrome-extension://<id>/`), which can be used to distinguish between multiple extensions

**Key pitfalls** (handled in the implementation):
- All stdout writes must be **single-threaded** + **flushed** per frame (concurrent writes corrupt frames because of pipe-buffer interleaving)
- A panic printed to stdout by default pollutes the stream → a **stderr panic hook** is mandatory
- When using `BufWriter`, you must explicitly flush after every frame
- `panic = "abort"` (Cargo profile) + stderr hook as a double safeguard

### 3.2 MCP JSON-RPC (MCP server ↔ MCP client)

Based on JSON-RPC 2.0, with NDJSON transport, defined at [modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-06-18).

- **Transport**: stdin/stdout, NDJSON (one message per line, LF-terminated)
- **No embedded newlines allowed** (serde serialization automatically escapes `\n`)
- **Protocol version**: locked to `2025-06-18`. See [ADR-0007](./adr/0007-mcp-protocol-version-2025-06-18.md) for details
- **Three-step handshake**: `initialize` (request/response) → `notifications/initialized` (notification, no response needed) → running
- **Tool errors**: use `isError: true` inside the result, **not** a JSON-RPC error (so the model sees the error text and reacts to it)
- **Must handle**: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`
- **Error codes**: unknown method `-32601`, parse error `-32700`

**Minimal viable message set** (v0.1 implementation): `initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`. Other methods return `-32601`.

### 3.3 Internal bridge protocol (MCP server ↔ native host)

Custom, over localhost TCP, with NDJSON transport.

```typescript
// Request: MCP server → native host → extension
interface BridgeReq {
  id: number;        // monotonically increasing, used to pair responses
  op: string;        // operation name, e.g. "tab_list", "page_click"
  tabId?: number;    // target tab (optional, default = currently active tab)
  args: any;         // operation arguments
}

// Response: extension → native host → MCP server
interface BridgeResp {
  id: number;        // matches BridgeReq.id
  ok: boolean;
  data?: any;        // return data on success
  error?: string;    // error message on failure
}
```

**Authentication**: when the connection is established, the native host first sends a line `{"hello": "<secret>"}`, and the MCP server validates it against the secret in the lockfile. See [ipc.rs](../src/ipc.rs) for details.

## 4. Component Details

### 4.1 Rust backend (`src/`)

| File | Responsibilities |
|------|------|
| `main.rs` | Mode dispatch: no arguments = MCP server, `--native-host` = native host, `doctor`/`status` = read-only self-check (see [cli.md](./cli.md)), `--help` = help |
| `protocol.rs` | Message types for the three protocols + read/write functions; stderr panic hook; SIGPIPE ignored |
| `ipc.rs` | localhost TCP listener + lockfile in the user directory + hello authentication + secret from the system random source |
| `native_host.rs` | `--native-host` mode: two threads (stdin→TCP, TCP→stdout), graceful exit on EOF |
| `mcp_server.rs` | Default mode: TCP accept thread + stdin JSON-RPC main loop + message dispatch |
| `tools/` | Schema definitions for 15 tools (`catalogue.rs`) + the `HANDLERS` registry (`{name, build_payload}` pure functions, `mod.rs`) + argument shaping (`handlers.rs`) → dispatch to session.call |
| `session.rs` | Connection management + request/response pairing by id (an mpsc channel per id) + a per-connection generation id (fixes the writer-clobber race, drains to `Disconnected` on disconnect) + 120s timeout |
| `error.rs` | Typed error `CallError` at the tool-call boundary (thiserror); Display is the model-visible text. See [ADR-0014](./adr/0014-leveled-logging.md) for details |
| `log.rs` | A leveled stderr logger controlled by `BB_LOG` (error/warn/info/debug, default info) + `log_*!` macros. See [ADR-0014](./adr/0014-leveled-logging.md) for details |

### 4.2 Chrome extension (`extension/`)

The extension source is written in **TypeScript** (strict) under `extension/src/*.ts`, bundled by **esbuild** into an IIFE in `extension/dist/`, with static assets (manifest/HTML/CSS/icons) copied in alongside; the **load-unpacked target is `extension/dist/`** (not `extension/`). After changing code you must run `npm run build` (or `make ext-build`) first. See [ADR-0012](./adr/0012-typescript-esbuild-extension-build.md) for details.

| Source file (`src/`) | Artifact (`dist/`) | Responsibilities |
|------|------|------|
| `manifest.json` (static, copied into dist) | `manifest.json` | MV3; permissions=[tabs,scripting,storage,nativeMessaging]; **no static host_permissions** (all requested on demand as optional) |
| `background.ts` | `background.js` | SW **entry point** (about 20 lines): registers the onMessage router + calls connectNative on startup. The real logic is in `src/background/*` (see below) |
| `content.ts` | `content.js` | content script **entry point** (about 30 lines): re-injection guard + onMessage listener → `handle`. The real logic is in `src/content/*` (see below) |
| `options.ts` + `options.html` | `options.js` + `options.html` | Standalone Options configuration page (see [ADR-0011](./adr/0011-options-page-for-settings.md) for details) |
| `popup.ts` + `popup.html` | `popup.js` + `popup.html` | Authorization UI: shows connection status, the allowlist (revocable), and Allow/Deny for pending authorization requests |
| `toast.css` (static, copied into dist) | `toast.css` | Styles for the high-risk confirmation Toast |

**Modular structure**: the two giant files have been split into cohesive modules; esbuild re-bundles the imports back into a single IIFE, so the runtime behavior is unchanged (verified by dom_test 77 / smoke / e2e).

- `src/shared/` (shared by both ends, pure logic, has unit tests) — `types` (bridge/message/settings types), `settings` (DEFAULTS + getSetting), `masking` (redaction pattern catalog), `allowlist` (glob matching / domain normalization), `ops` (tool catalog, unit-tested to stay consistent with `tools.rs`)
- `src/background/` — `port` (native port lifecycle), `dispatch` (BridgeReq routing + tool-disable gate), `tabs` (target tab resolution/injection + tab_* tools), `precise` (page_snapshot_precise / CDP), `cookies` (cookie_get), `allowlist-store` (allowlist storage + authorization flow), `messages` (runtime.onMessage routing)
- `src/content/` — `refs` (encapsulated ref state), `snapshot` (a11y tree), `actions` (click/fill/text/screenshot/scroll), `wait`, `eval`, `storage`, `toast`, `handle` (op dispatch)

The dependencies form an acyclic DAG: `shared/*` → `background/allowlist-store` → `tabs` → `precise`/`cookies` → `dispatch` → `port` → `messages`; on the content side `shared/*`/`util` → `refs`/`snapshot` → `toast` → `actions`/`eval` → `handle`. Unit tests (`src/shared/*.test.ts`, bun) cover the pure modules, including a cross-language guard (the op list must stay consistent with `tools.rs`).

### 4.3 Installation Artifacts

macOS:

```
~/.browser-bridge/
├── browser-bridge       # release binary (608KB)
└── run-host.sh          # wrapper: exec browser-bridge --native-host
                         # (works around the NM manifest's lack of an args field)

~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
└── com.browser_bridge.host.json   # host manifest, path points to run-host.sh
```

Windows:

```text
%LOCALAPPDATA%\browser-bridge\
├── browser-bridge.exe
└── com.browser_bridge.host.json

HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser_bridge.host
└── (Default) = the absolute path of the manifest above
```

Linux:

```text
${XDG_DATA_HOME:-~/.local/share}/browser-bridge/
├── browser-bridge
└── run-host.sh

${XDG_CONFIG_HOME:-~/.config}/google-chrome/NativeMessagingHosts/
└── com.browser_bridge.host.json

${XDG_CONFIG_HOME:-~/.config}/chromium/NativeMessagingHosts/
└── com.browser_bridge.host.json   # when choosing Chromium or --browser both
```

On Windows the manifest points directly to the EXE. When Chrome launches the native host it
appends the caller's extension origin, and the binary enters native-host mode accordingly;
on macOS/Linux the wrapper passes `--native-host` explicitly. On Linux the lockfile is
preferentially located at `$XDG_RUNTIME_DIR/browser-bridge/run.lock`, falling back to the
XDG cache when there is no runtime dir; see [ADR-0016](./adr/0016-linux-wsl-support.md) for details.

The extension itself is loaded **load-unpacked** from **`extension/dist/`** (the esbuild build artifact, produced by bundling `src/*.ts` + copying static assets), and `install.sh`/`install.ps1` build it first. dist/ is not committed, so after cloning you must run `npm run build` (or `make ext-build`) first. See [ADR-0012](./adr/0012-typescript-esbuild-extension-build.md) for details.

## 5. Key Data Flows

### 5.1 A full round trip of a single tool call (`page_click(ref="e3")`)

```
1. MCP client → MCP server (stdin NDJSON):
   {"jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{"name":"page_click","arguments":{"ref":"e3"}}}

2. mcp_server.handle() → tools.dispatch()
   → session.call("page_click", None, {"ref":"e3"})
   → allocate BridgeReq.id=1, write to TCP

3. native host reads TCP NDJSON → converts to NM frame → writes stdout

4. background.js Port.onMessage receives {op:"page_click",args:{ref:"e3"}}
   → resolveTargetTab(currently active tab)
   → ensureAllowed(tab.url)  // allowlist check; pops the popup if not authorized
   → injectIfNeeded(tab.id)  // dynamically inject content.js
   → chrome.tabs.sendMessage(tab.id, {op, args})

5. content.js handle()
   → resolveTarget({ref:"e3"}) // look up refMap → element
   → isHighRiskClick(el)? // if submit/link → confirmWithToast()
     → inject the Toast DOM; user clicks Allow → continue; Deny/timeout → throw
   → el.scrollIntoView() + el.click()

6. The result returns the same way:
   content → chrome.runtime.sendMessage response
   → background Port.postMessage({id:1,ok:true,data:{clicked:"e3"}})
   → native host reads NM frame → converts to NDJSON → writes TCP

7. session receives BridgeResp → finds the pending sender by id=1 → wakes it up
   → mcp_server returns the tools/call result → MCP client
```

### 5.2 native host reconnection flow

```
Chrome closes the extension Port → native host stdin EOF → host exits
The extension's background.js onDisconnect fires → scheduleReconnect(2s)
After 2s, connectNative() → Chrome respawns the host → host reads the lockfile → connects TCP → sends hello
MCP server accept → validate_hello → session.attach_connection(replaces the old connection)
```

## 6. Security Model

See the individual ADRs for details; here is the overview.

| Boundary | Mechanism | ADR |
|------|------|-----|
| Domain allowlist | chrome.storage.local + popup authorization + permissions.request | [0004](./adr/0004-allowlist-with-optional-host-permissions.md) |
| High-risk action confirmation | content script injects a Toast, rejects on 30s timeout, 60s confirmation-free window | [0006](./adr/0006-toast-confirmation-for-high-risk.md) |
| page_eval | Enlarged Toast with per-call confirmation + short same-origin window + return value redacted by default | [0008](./adr/0008-page-eval-confirmation-channel.md) |
| host authentication | allowed_origins hardcoded with the extension ID | [0002](./adr/0002-three-process-architecture-localhost-tcp.md) |
| bridge socket | per-run secret + lockfile in the user directory (Unix mode 0600) | [0002](./adr/0002-three-process-architecture-localhost-tcp.md) |
| redaction | page_text masks passwords + long numbers; page_fill echoes back the password redacted | — |
| protocol security | NM 1MB outbound limit; single-threaded writes + flush; stderr panic hook | — |
| configuration management | Standalone Options page centrally manages security toggles/timeouts/tool enablement/allowlist/allowAllSites | [0011](./adr/0011-options-page-for-settings.md) |

## 7. Key Constraints (pitfalls hit and handled during implementation)

### 7.1 MV3 Service Worker restarts every 5 minutes (Chromium #40733525)
**Constraint**: Chrome forcibly restarts the SW every 5 minutes, losing all in-memory state; the Port closes and the native host exits on receiving stdin EOF.
**Mitigation**:
- Store the allowlist in `chrome.storage.local` (not in memory)
- Automatically `connectNative()` to reconnect when the SW starts
- Keep session state (current tab, ref map) in the MCP server process, not in the SW
- Mark refs on the DOM element's `data-zcb-ref` attribute, so after the SW restarts the content script can rebuild the refMap from the DOM

### 7.2 chrome.debugger forces an infobar
**Constraint**: any `chrome.debugger.attach` forcibly displays a "Started debugging this browser" banner at the top of every tab, which cannot be dismissed (unless the `--silent-debugger-extension-api` launch flag is used, which brings back a special launch).
**Mitigation**: by default snapshot uses the content-script approximation and does not invoke the debugger; when an authoritative a11y tree is needed, explicitly call `page_snapshot_precise`, which attaches temporarily and detaches immediately. See [ADR-0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md) and [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md) for details.

### 7.3 The Native Messaging manifest has no args field
**Constraint**: the manifest's `path` must be an executable file and cannot carry arguments.
**Mitigation**: use the `run-host.sh` wrapper (a shebang script) that does `exec browser-bridge --native-host`.

### 7.4 chrome.permissions.request requires a user gesture
**Constraint**: `permissions.request` (requesting host permissions) must be called in a user-gesture context such as a popup/action click, and cannot be called in the service worker background.
**Mitigation**: the allowlist authorization flow is completed through the popup — when the user clicks Allow in the popup, host permissions are requested and the allowlist entry is recorded at the same time.

### 7.5 Static content_scripts matches conflict with optional permissions
**Constraint**: in MV3, a content_scripts `matches` declaration also needs host permissions in order to inject. If the initial `host_permissions: []`, the content script does not inject at all.
**Mitigation**: **do not use manifest content_scripts**; use `chrome.scripting.executeScript` for dynamic injection everywhere. Permissions follow `optional_host_permissions` — whichever domain is authorized is the one that gets injected.

### 7.6 Rust panic pollutes stdout
**Constraint**: a panic's default message is printed to stdout, which corrupts NM frames and MCP NDJSON and causes the connection to drop.
**Mitigation**:
- Set `panic = "abort"` in the Cargo release profile
- `install_stderr_panic_hook()` redirects the panic message to stderr
- A double safeguard

### 7.7 page_eval uses the Function constructor rather than eval()
**Constraint**: `page_eval` needs to execute arbitrary JS in the page's global scope, but content.js itself runs inside a strict-mode closure; a direct `eval(code)` cannot see the page's global variables, and under strict mode eval has its own separate scope.
**Mitigation**: use `new Function('"use strict"; return (async () => { <code> })()')()` — the Function constructor executes in the global scope and supports `return`/`await` (wrapped as an async IIFE).
**Known limitation**: it is hard to reliably set an execution timeout (JS is single-threaded and cannot be interrupted externally); the session layer's 120s timeout is the backstop, and an infinite loop will hang the page. Before the return value leaves the page it is safely processed by `serializeResult` (circular references / DOM / Error / BigInt / exotic types) and then redacted by `maskSensitive`. See [ADR-0008](./adr/0008-page-eval-confirmation-channel.md) for details.

### 7.8 chrome.debugger's infobar / restrictions / SW-only
**Constraints** (page_snapshot_precise):
- `chrome.debugger.attach` forcibly displays a "Started debugging this browser" banner at the top of **every tab**, which persists for the duration of the attach and cannot be dismissed; it disappears after `detach`.
- The `chrome.debugger` API can only be called from the **extension context (SW/popup)**; a content script is in the page context and cannot reach it.
- It cannot attach to `chrome://`, `chrome-extension://`, Chrome Web Store, `view-source:`, or `about:` pages.
- A tab can only have one debugger at a time (if DevTools is already open, attach fails: "Another debugger is already attached").

**Mitigation**:
- Execution is entirely in background.js (SW); only "pop the notification Toast" is delegated to the content script (the Toast has to be shown on the page)
- Within a single handler: attach → `getFullAXTree` → `resolveNode` + `callFunctionOn` to stamp refs → `detach`, so the infobar only flashes for about 1 second
- Before attaching, use the content script to pop an **informational Toast** (blue, continues by default, cancelable) to notify the user
- **`detach` must be on the finally path** — detach must happen on any error, otherwise the infobar stays forever
- A URL-scheme pre-check filters out pages that cannot be debugged
- Refs use a `p` prefix (precise) to isolate them from the content script's `e` prefix and avoid collisions; content.js's `resolveTarget` looks up by DOM attribute value, so the prefix is irrelevant

**Key chain**: `Accessibility.getFullAXTree` (each AXNode carries a `backendDOMNodeId`) → `DOM.resolveNode({backendNodeId})` → `RemoteObjectId` → `Runtime.callFunctionOn` to stamp `data-zcb-ref`. See [ADR-0009](./adr/0009-page-snapshot-precise-debugger.md) for details.

### 7.9 chrome.cookies is host-constrained / localStorage is same-origin / httpOnly is readable
**Constraints** (cookie_get / storage_get):
- The `chrome.cookies` API is **constrained by host_permissions**: `getAll({})` only returns cookies for authorized domains, **not** all browser cookies. The blast radius is consistent with the existing tools, reusing the allowlist.
- `chrome.cookies` is only available in the **SW/extension context** → cookie_get lives in background.js.
- A page's `localStorage`/`sessionStorage` is only readable from the **content script (page context, same origin)**; `chrome.storage` belongs to the extension itself, not to the page — the two are different. → storage_get lives in content.js.
- `chrome.cookies` **can read httpOnly cookies** (this is its core value relative to `document.cookie`, since session tokens are often stored here).
- The `cookies` permission has **no extra install warning** (debugger already triggers the maximum host warning).
- For unauthorized domains: getAll returns an **empty array rather than an error**, so it is impossible to distinguish "not authorized" from "genuinely no data"; the best that can be done is a friendly hint.

**Mitigation**:
- cookie_get lives in background, storage_get lives in content (each determined by its own data source)
- **Read-only**: no set/remove — cookie_set could forge httpOnly+Secure cookies (a session-fixation attack, something even XSS cannot do)
- Redaction: cookie values use the compact maskCookieValue; storage values use maskString. **storage_get always redacts** (not controlled by the evalMask toggle, because the token-leak risk of silent reads is equivalent to eval)
- Values are redacted but structural fields such as name/domain/httpOnly are preserved (diagnostic value)

See [ADR-0010](./adr/0010-cookie-storage-readonly.md) for details.

## 8. Technology Choices

| Dimension | Choice | Rationale |
|------|------|------|
| Backend language | Rust | Stable single-binary distribution; the host manifest uses an absolute path with no PATH dependency; good performance/memory. See [ADR-0001](./adr/0001-use-rust-single-binary.md) for details |
| Binary split | Single binary + subcommands | One codebase, one compilation, upgrade by replacing a single file. See [ADR-0001](./adr/0001-use-rust-single-binary.md) for details |
| IPC | localhost TCP + lockfile | Simple across processes; easy to debug; per-run secret authentication. See [ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md) for details |
| Rust dependencies | serde/serde_json + libc + thiserror | The protocol is still hand-written and tokio is still not used; beyond serde, `libc` (signals / low-level interaction) and `thiserror` (typed errors on the tool path) are added. This revises ADR-0001's old wording of "serde as the only dependency"; the minimal-dependency principle is unchanged. See [ADR-0014](./adr/0014-leveled-logging.md) for details |
| Extension toolchain | TypeScript + esbuild → dist/ | Strict types + a single dependency bundled into an IIFE; the load-unpacked target is `extension/dist/`. See [ADR-0012](./adr/0012-typescript-esbuild-extension-build.md) for details |
| Engineering gates | Makefile + GitHub Actions | A unified task entry point + CI (fmt/clippy -D warnings/eslint/prettier + tests); Cargo is the single source of the version. See [ADR-0013](./adr/0013-ci-and-toolchain.md) for details |
| Extension version | MV3 | Mandated by Chrome; the Service Worker model |
| snapshot implementation | content-script approximate a11y tree | No infobar; about 90% coverage, with the debugger fallback as backstop. See [ADR-0003](./adr/0003-content-script-snapshot-vs-chrome-debugger.md) for details |
| MCP version | 2025-06-18 | The current stable version; this is the version MCP clients commonly implement. See [ADR-0007](./adr/0007-mcp-protocol-version-2025-06-18.md) for details |

## 9. Known Limitations

1. **snapshot accuracy is about 90%**: when the content script recomputes a11y names it misses shadow DOM and complex ARIA; phase two adds the debugger fallback
2. **Cross-origin iframes**: the content script is bound by same-origin restrictions and cannot read the contents of cross-origin iframes
3. **Single-user machine**: although the bridge socket has secret authentication, the design assumes a single user
4. **Chrome platform scope**: supports Google Chrome on macOS/Windows/Linux and Chromium on Linux; Edge could work in theory but is untested
5. **Windows forced takeover**: on Windows, `TerminateProcess` takes over the old server, which cannot clean up after itself; the new server explicitly deletes and replaces the stale lockfile

## 10. Evolution Roadmap

See [requirements.md §7 Phasing](./requirements.md#7-phasing). Extension points reserved in the architecture:
- **Adding a new tool**: add a schema definition in `tools/catalogue.rs` + add a `HANDLERS` record in `tools/mod.rs` (the `build_payload` pure function), and extend background/content with handling for the corresponding op
- **page_eval**: needs a new high-risk confirmation channel (a stronger confirmation than the Toast)
- **debugger fallback**: add the `page_snapshot_precise` tool, with the SW temporarily attaching/detaching
- **Skill layer**: does not touch the architecture; purely adds skill files that teach the AI to combine existing tools

### 10.1 Engineering Standardization Overhaul

A round of engineering-standardization overhaul reshaped the build, test, and observability baseline without changing the tools' runtime behavior; the related decisions are:
- **[ADR-0012](./adr/0012-typescript-esbuild-extension-build.md)**: the extension switches to TypeScript, bundled by esbuild into `extension/dist/` (the new load-unpacked target).
- **[ADR-0013](./adr/0013-ci-and-toolchain.md)**: Makefile task entry point + GitHub Actions CI + rustfmt/clippy/eslint/prettier gates + Cargo-sourced version syncing.
- **[ADR-0014](./adr/0014-leveled-logging.md)**: `BB_LOG` leveled stderr logging + thiserror typed errors (adds the `libc` and `thiserror` dependencies).

## 11. Protocol Boundaries: Error Classification and Handshake

The cross-process contracts are centralized in [`contracts/`](../contracts/README.md) (a single source of truth), and runtime behavior is validated against it.
This section ties together the three contracts related to protocol boundaries.

### 11.1 Error classification (errors.json)

At the tool-call boundary, Rust's typed error `CallError` (see §4.1 `error.rs`) maps to the stable
`code` values in [`contracts/errors.json`](../contracts/errors.json); `cargo test` validates the mapping
against that file, and the extension side normalizes its own failures to the same set of `code` values.
The `code` is for programmatic decisions (including `category` and
`retryable`), while what the model/user sees is the `message`. This way the "three connection-layer failures"
(`NOT_CONNECTED` / `EXTENSION_NOT_READY` / `CONNECTION_LOST`) have unified semantics across the three processes,
rather than each speaking its own language.

### 11.2 Capability / version handshake (capabilities.json + protocol-version.json)

On top of the internal bridge protocol in §3.3, when the connection is established, beyond the `hello` secret
authentication of §3.3, there is also the **intent** to do one more step of capability + version negotiation:

- The native host / extension reports the internal protocol version it supports from
  [`protocol-version.json`](../contracts/protocol-version.json) (currently `1`) and the set of available
  capabilities (see [`capabilities.json`](../contracts/capabilities.json),
  where capabilities are conceptually derived from the `permission`/`scope` notions in `tools.json`).
- Version incompatibility → **fail fast**, returning `PROTOCOL_MISMATCH` (see errors.json) with a clear message,
  rather than accepting the connection and only exploding late with "unknown op" on some future `tools/call`.
- A tool's required capability not being advertised → reject that tool call up front, rather than dispatching an op the extension cannot handle.

Note the distinction between three "versions": the MCP JSON-RPC version `2025-06-18` (§3.2 / [ADR-0007](./adr/0007-mcp-protocol-version-2025-06-18.md)),
the internal bridge protocol version (an integer, protocol-version.json), and the extension release version (sourced from Cargo) — all different from one another.

> To troubleshoot these two chains at runtime (whether the connection is reachable, and whether the lockfile/port/manifest are in place), use the read-only
> `browser-bridge doctor`; see [cli.md](./cli.md).
