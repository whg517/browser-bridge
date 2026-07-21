# ADR-0002: Three-Process Architecture + localhost TCP Bridge

- **Status**: Accepted
- **Date**: 2026-07-07

## Context

browser-bridge involves two independent "hosts":

- The **MCP client** (such as Claude Code or Codex) spawns a process to act as the MCP server (stdio JSON-RPC)
- **Chrome** spawns a process to act as the native messaging host (stdio NM frames)

These two hosts **each spawn their own process independently**; they are not in a parent-child relationship and cannot share stdin/stdout. Therefore, some form of IPC is required to let the MCP server process and the native host process exchange messages.

In addition, MV3's Service Worker is force-restarted by Chrome every 5 minutes (Chromium #40733525). On restart, all in-memory state is lost, and the extension's native Port is also closed. This means that any "session state" (the currently focused tab, the ref mapping of the most recent snapshot) must not live inside the SW or the native host.

## Decision

**Adopt a three-process architecture, using localhost TCP + a lock file as the IPC:**

1. **MCP server process** (spawned by the MCP client, long-lived): holds all session state, listens on `127.0.0.1:0` (random port), and writes the port + a per-run secret to a 0600 lock file
2. **native host process** (spawned by Chrome, tied to the Port lifecycle): extremely thin, only performing protocol translation between stdin NM frames and TCP NDJSON
3. **Chrome extension** (SW + content): the actual page operations

When the native host connects to the MCP server, it first sends a line `{"hello": "<secret>"}` to authenticate; the connection is accepted only if it matches the secret in the lock file.

## Alternatives Considered

### Option A: Merge the MCP server and native host into a single process
- **Not feasible**: the two hosts (the MCP client and Chrome) each spawn their own process, the processes are not in a parent-child relationship, and stdin/stdout are not shared. This would require a mechanism such as socket activation, but Chrome's native messaging does not support it.

### Option B: Unix domain socket (instead of TCP)
- **Pros**: file permissions can be restricted to 0600, so only the current user can connect, giving a smaller attack surface
- **Cons**:
  - Not supported on Windows (we currently only target macOS, so this does not matter)
  - Path management is slightly cumbersome (you have to handle `/tmp` vs. the user directory)
- **Reason not selected**: at decision time the user chose localhost TCP (convenient to debug, can be telnet'd). TCP combined with a per-run secret + 0600 lock file is secure enough on a single-user machine

### Option C: File IPC (the MCP server and host do not communicate directly; both read and write the same file)
- **Cons**: poor concurrency/timeliness; unsuitable for interactive control (a round trip is needed for every tool call)
- **Excluded**: the user explicitly marked it "not recommended" among the options

### Option D: The native host holds the session state (rather than the MCP server)
- **Problem**: the native host is tied to the Chrome Port lifecycle and is lost when the SW restarts; moreover, the native host is "passive" (spawned by Chrome), making it unsuitable as the coordinator
- **Excluded**: state must reside in the most stable process (the MCP server)

## Consequences

### Positive
- **Stable session state**: the MCP server process does not lose state when the SW/Chrome restarts
- **Extremely thin host**: the native host only does protocol translation, with all logic in the MCP server, making it easy to test and maintain
- **Debuggable**: localhost TCP can be connected to manually with telnet/nc for debugging
- **Authentication**: per-run secret + 0600 lock file, preventing accidental connections from other users/processes on the same machine

### Negative
- **One extra IPC layer**: in theory this adds one round of serialization/deserialization overhead (in practice, local TCP is < 1ms, negligible)
- **Lock file management**: the MCP server must clean up the lock file on exit; a stale lock file causes the host connection to fail (already handled: if the host cannot connect, it deletes the lock file)
- **Random port**: the port differs each time the MCP server starts, so the lock file is the only discovery mechanism
- **In theory, other users on the same machine could connect**: the secret protection relies on the lock file being 0600; this is not secure on a multi-user machine (this project is designed on the premise of a single user)

### Neutral
- localhost TCP is supported on macOS/Linux/Windows, so it is cross-platform without obstacles (although v0.1 is only tested on macOS)

## Authentication Details

- **Lock file**: `~/Library/Application Support/browser-bridge/run.lock` (macOS), permissions 0600
- **Contents**: `{port, secret, pid}`, where the secret is 128 bits of entropy (/dev/urandom)
- **Writing**: atomic rename (tmp file → final file), preventing the host from reading a half-written file
- **Validation flow**: after the host connects, its first line sends `{"hello": secret}`; the MCP server compares it against the secret in the lock file and rejects the connection if it does not match
- **Stale handling**: when the host fails to connect, it proactively deletes the lock file so that the next MCP server startup can begin cleanly

## Implementation

- `src/ipc.rs`: `listen()` (bind + generate LockFile), `connect()` (read lock + connect + send hello), `validate_hello()`
- `src/session.rs`: `attach_connection()` (validate hello + start a reader thread to dispatch BridgeResp), `call()` (register a pending sender → send BridgeReq → wait for response, 120s timeout)
- `src/native_host.rs`: two threads, stdin→TCP and TCP→stdout
- Delete the lock file when the MCP server exits (`stdin EOF`)

## Verified

End-to-end tests PASS:
1. mock host connects → hello authentication passes → tool call round trip succeeds
2. `--native-host` mode: real NM frames flow bidirectionally + full round trip
