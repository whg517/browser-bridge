# CLI and Troubleshooting: browser-bridge

> This document covers the subcommands of the `browser-bridge` binary and common troubleshooting paths.
> For components and process boundaries, see [architecture.md](./architecture.md); for install artifact paths, see [architecture.md §4.3](./architecture.md#43-installation-artifacts).

## Subcommands at a glance

`browser-bridge` is a single binary with subcommand dispatch (see [ADR-0001](./adr/0001-use-rust-single-binary.md)):

| Invocation | Mode | Description |
|------|------|------|
| `browser-bridge` (no arguments) | MCP server | Default mode: listens on TCP, holds session state, dispatches tools. Spawned by the MCP client. |
| `browser-bridge tools [--json]` | Self-describing | Prints the tool catalog (name + description + parameters). `--json` has the same shape as MCP `tools/list`. **Does not start the bridge; no side effects.** |
| `browser-bridge call <tool> [json]` | One-shot tool call | For non-MCP callers (scripts / agents): runs one tool, prints its **raw result**, and exits. See below. |
| `browser-bridge --native-host` | native host | Thin bridge: stdin/stdout NM frames ↔ TCP NDJSON. Spawned by Chrome (via a wrapper). |
| `browser-bridge doctor` (alias `status`) | Read-only diagnostics | Prints environment and connection self-checks; does not start the server or change any state. |
| `browser-bridge --help` | Help | Usage information. |

## `tools`: self-describing (capability discovery for non-MCP agents)

MCP clients rely on `tools/list` to learn "which tools exist and how to call them"; a non-MCP agent (such as OpenClaw)
cannot see it. `tools` emits the same capability list directly, **without a browser and without starting the bridge**:

```sh
browser-bridge tools          # human-readable: each tool's name, description, and parameters (name/type/required/description)
browser-bridge tools --json   # machine-readable: { "tools": [ { name, description, inputSchema } ] },
                              #        exactly the same shape as MCP tools/list; an agent can parse it directly
```

**The integration loop for non-MCP agents**: first `tools --json` to learn the capabilities → then `call <tool> '<json>'` to execute.
Tell your agent these two steps (or write them into its tool instructions), and it can use browser-bridge on its own, without implementing MCP.

## `call`: one-shot tool call for non-MCP callers

Scripts / agents that do not want to implement the MCP handshake (initialize → tools/call → parsing nested JSON) can directly:

```sh
browser-bridge call tab_list
browser-bridge call tab_open '{"url":"https://example.com"}'
browser-bridge call page_fill '{"selector":"#kw","value":"hello"}'
browser-bridge call page_text
```

Internally it starts a bridge, waits for the extension to connect, runs this **single** tool, writes the result to **stdout** (the tool's raw JSON,
**not** wrapped in MCP's `{content:[{text}]}`), then exits. Diagnostics/logs go to stderr (controlled by `BB_LOG`),
so stdout stays clean and pipeable. `page_screenshot` prints a base64 PNG.

**Exit codes**: `0` success · `1` tool error · `2` bad arguments/tool name · `3` timed out waiting for the extension to connect (15s) ·
`4` an active MCP server already holds the bridge.

**Single-bridge limitation**: `call` **shares the same bridge connection** as your MCP client. When it detects an active MCP server,
`call` **explicitly refuses (exit 4)** instead of bumping it offline — stop the MCP client first, or have the client initiate the
call directly. A daemon (`daemon`) / HTTP mode would require connection-layer multiplexing (see issue #45), which is out of scope for now.

## `doctor` / `status`: read-only self-check

`doctor` (equivalent alias `status`) is a **read-only** subcommand: it does not listen on a port, write a lock file, or spawn
any child process; it only probes the current environment and prints its conclusions, to answer "why can't it connect".

It reports:

- **Version / platform**: the binary version (sourced from Cargo, see [ADR-0013](./adr/0013-ci-and-toolchain.md)) and the running platform (macOS/Windows).
- **Lock file**: whether the bridge lock file exists under the user directory, and the **port / pid** recorded in it
  (for the lock-file mechanism, see [ADR-0002](./adr/0002-three-process-architecture-localhost-tcp.md)).
- **MCP server reachability**: performs a localhost probe against the `127.0.0.1:<port>` from the lock file,
  reporting whether the server is listening (`reachable` / `not reachable`).
- **native host manifest**: whether Chrome's native messaging host manifest
  (`com.browser_bridge.host.json`) is in place (for the path, see [architecture.md §4.3](./architecture.md#43-installation-artifacts)).

### How to interpret "server not reachable"

"server not reachable" means `doctor` read the port from the lock file, but the localhost probe against that port failed.
Common causes and remedies:

1. **The MCP server is not running**: the MCP server is spawned by the MCP client (such as Claude Code) within its session.
   If the client is not started or the server is not configured/not launched, no one is listening on the port. → Confirm the client has loaded
   browser-bridge's MCP server configuration and is in a running session.
2. **Stale lock file**: the previous server exited abnormally but the lock file remains (its port/pid are no longer valid). On startup, a new server
   detects and replaces the stale lock file (see [architecture.md §9](./architecture.md#9-known-limitations));
   if there is currently no live server, `doctor` reporting not reachable is expected. → Simply bring the client session back up.
3. **Port occupied / blocked by a firewall**: the localhost loopback usually does not involve a firewall, but local security software may block it.
   → Check whether another process is occupying the port.

> `doctor` only probes; it does not repair: it **will not** kill processes, delete lock files, or restart the server. When you see not reachable,
> the correct action is to go back to the MCP client side and re-establish the session, rather than manually intervening in processes.

If the **manifest is missing**, the extension-side native host cannot be spawned by Chrome (Chrome cannot find the host declaration).
→ Re-run the install script (`install.sh` / `install.ps1`) to write the manifest.

## Logging and auditing (`BB_LOG` / `BB_LOG_FORMAT`)

Diagnostics for both modes are written to **stderr** (stdout is occupied by protocol frames). Two environment variables control the output:

| Variable | Values | Effect |
|------|------|------|
| `BB_LOG` | `error` \| `warn` \| `info` (default) \| `debug` | Log threshold. `info` and above prints audit lines; setting `warn`/`error` silences auditing. |
| `BB_LOG_FORMAT` | `text` (default) \| `json` | Format of audit lines. `json` outputs one JSON object per line, convenient for machine collection. |
| `BB_LOCK_DIR` | Absolute directory | Overrides the directory containing the lock file. When the MCP server and the native host run in **different user contexts** (e.g., Windows automation running as SYSTEM while Chrome runs as the desktop user), set the **same value** on both sides so both can find the bridge lock file (see issue #57). |

**Audit events**: the MCP server emits one audit line for each `tools/call` it handles, with fields for each call including
`req` (monotonic request id), `tool` (tool name), `outcome` (`ok`/`error`), `code` (on error, the stable error code from
[errors.json](../contracts/errors.json), otherwise `-`), and `dur_ms` (duration).

```text
# BB_LOG_FORMAT default (text)
[AUDIT] ts=1721000000000 req=7 tool=page_click outcome=ok code=- dur_ms=12
# BB_LOG_FORMAT=json
{"kind":"audit","ts":1721000000000,"req":"7","tool":"page_eval","outcome":"error","code":"EXECUTION_FAILED","dur_ms":8}
```

For error codes and error classification, see [architecture.md §11.1](./architecture.md#111-error-classification-errorsjson).

## See Also

- Connection lifecycle and disconnect/reconnect semantics: [architecture.md §5.2](./architecture.md#52-native-host-reconnection-flow).
- Error classification (`NOT_CONNECTED` / disconnect class): [architecture.md §11.1](./architecture.md#111-error-classification-errorsjson).
