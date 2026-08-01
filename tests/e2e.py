#!/usr/bin/env python3
"""End-to-end integration tests for browser-bridge.

These tests drive the release binary as real subprocesses:
  - MCP server mode (default), spoken to over JSON-RPC/stdio
  - --native-host mode, spoken to with real Chrome Native-Messaging frames
  - a mock "extension" that connects over the localhost TCP bridge socket

They cover the protocol layers (NM framing, MCP JSON-RPC, TCP bridge) and
the request/response correlation, including the new page_eval tool path.

Run:
    python3 tests/e2e.py
Exits 0 on success, 1 on any failure. Requires the release binary at
target/release/browser-bridge (will build it if missing via cargo).

This is an orchestration test (not a Rust #[test]) on purpose: it exercises
the full process boundary the way an MCP client and Chrome would, which a unit
test inside the crate cannot.
"""
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "target", "release", "browser-bridge" + (".exe" if os.name == "nt" else ""))
# Mirror the binary's LockFile::path() (src/ipc.rs).
_XDG = os.environ.get("XDG_RUNTIME_DIR")
if os.name == "nt":
    _LOCAL = os.environ.get("LOCALAPPDATA", os.path.expanduser("~/AppData/Local"))
    LOCK = os.path.join(_LOCAL, "browser-bridge", "run.lock")
elif sys.platform == "darwin":
    LOCK = (
        os.path.join(_XDG, "browser-bridge", "run.lock")
        if _XDG
        else os.path.expanduser("~/Library/Application Support/browser-bridge/run.lock")
    )
else:
    _CACHE = os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache"))
    LOCK = os.path.join(_XDG, "browser-bridge", "run.lock") if _XDG else os.path.join(
        _CACHE, "browser-bridge", "run.lock"
    )

_passed = 0
_failed = 0


def check(cond, label):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  PASS  {label}")
    else:
        _failed += 1
        print(f"  FAIL  {label}")


def ensure_binary():
    if os.path.exists(BIN):
        return
    print("[setup] release binary missing, building…")
    cargo = "/opt/homebrew/bin/cargo"
    if not os.path.exists(cargo):
        cargo = "cargo"
    env = dict(os.environ, PATH="/opt/homebrew/bin:" + os.environ.get("PATH", ""))
    subprocess.check_call([cargo, "build", "--release", "--manifest-path",
                           os.path.join(REPO, "Cargo.toml")], env=env)


def wait_lock(proc=None, timeout=8):
    """Wait for the lock file and return its contents. If `proc` is given,
    require the lock to belong to it (lock["pid"] == proc.pid) — this ignores a
    stale lock from a previous test's server that hasn't finished exiting, which
    would otherwise point us at a dead port. Tolerates transient read errors."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with open(LOCK) as f:
                lf = json.load(f)
            if proc is None or lf.get("pid") == proc.pid:
                return lf
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.05)
    return None


def nm_write(p, obj):
    data = json.dumps(obj).encode()
    p.stdin.write(struct.pack("<I", len(data)) + data)
    p.stdin.flush()


def nm_read(p):
    hdr = p.stdout.read(4)
    if len(hdr) < 4:
        return None
    (n,) = struct.unpack("<I", hdr)
    return json.loads(p.stdout.read(n))


class McpClient:
    """Minimal MCP JSON-RPC client over stdio to the server subprocess."""

    def __init__(self, proc):
        self.proc = proc

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def recv(self):
        return json.loads(self.proc.stdout.readline())

    def initialize(self):
        self.send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                              "clientInfo": {"name": "e2e", "version": "0.1"}}})
        r = self.recv()
        return r

    def initialized(self):
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def ping(self, _id=99):
        self.send({"jsonrpc": "2.0", "id": _id, "method": "ping"})
        return self.recv()

    def tools_list(self, _id=2):
        self.send({"jsonrpc": "2.0", "id": _id, "method": "tools/list"})
        return self.recv()

    def call(self, name, args, _id=3):
        self.send({"jsonrpc": "2.0", "id": _id, "method": "tools/call",
                   "params": {"name": name, "arguments": args}})
        return self.recv()


def read_stderr(proc, timeout=5):
    """Drain a finished process's stderr without ever blocking indefinitely.

    A plain `proc.stderr.read()` blocks until EOF, and EOF only arrives once
    EVERY holder of the pipe's write end has closed it — including any child
    that inherited the fd, such as a `--native-host` the server spawned or an
    orphan left by an earlier test. One lingering grandchild is therefore enough
    to hang the whole suite forever (observed: a run wedged for 4h), which in CI
    means burning the job's entire timeout instead of failing.

    So: read on a daemon thread and abandon it on timeout. Losing the log text
    costs one assertion; hanging costs the run."""
    out = []
    t = threading.Thread(target=lambda: out.append(proc.stderr.read()), daemon=True)
    t.start()
    t.join(timeout)
    return (out[0] if out else "") or ""


def mock_extension(lf, responder, announce=None):
    """Connect to the bridge socket as the extension would, answer requests
    using `responder(req) -> dict`.

    `announce` (optional) is the payload the real extension posts right after
    connecting (shared/announce.ts). It rides the BridgeResp envelope on the
    reserved id 0; see src/peer.rs for why."""
    s = socket.create_connection(("127.0.0.1", lf["port"]), timeout=5)
    s.sendall((json.dumps({"hello": lf["secret"]}) + "\n").encode())
    if announce is not None:
        frame = {"id": 0, "ok": True, "data": {"announce": announce}}
        s.sendall((json.dumps(frame) + "\n").encode())
    buf = bytearray()

    def readline():
        nonlocal buf
        while b"\n" not in buf:
            d = s.recv(4096)
            if not d:
                return None
            buf += d
        line, _, buf = buf.partition(b"\n")
        return line

    def serve_one():
        line = readline()
        if line is None:
            return None
        req = json.loads(line)
        resp = responder(req)
        s.sendall((json.dumps(resp) + "\n").encode())
        return req

    return s, serve_one


def test_mcp_handshake_and_tools():
    print("\n[test] MCP handshake + tools/list + ping")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written on startup")
        c = McpClient(mcp)
        init = c.initialize()
        check(init.get("result", {}).get("protocolVersion") == "2025-06-18",
              "initialize returns protocolVersion 2025-06-18")
        check("tools" in init.get("result", {}).get("capabilities", {}),
              "capabilities advertises tools")
        c.initialized()
        ping = c.ping()
        check(ping.get("result") == {}, "ping returns empty result")
        tools = c.tools_list()
        names = [t["name"] for t in tools["result"]["tools"]]
        check("tab_list" in names, "tools/list includes tab_list")
        check("page_eval" in names, "tools/list includes page_eval")
        check("page_snapshot_precise" in names, "tools/list includes page_snapshot_precise")
        # page_eval description must carry a HIGH RISK warning
        ev = next(t for t in tools["result"]["tools"] if t["name"] == "page_eval")
        check("HIGH RISK" in ev["description"], "page_eval description warns HIGH RISK")
        check(ev["inputSchema"]["required"] == ["code"], "page_eval requires code arg")
        # precise snapshot description must warn about the debugger banner
        ps = next(t for t in tools["result"]["tools"] if t["name"] == "page_snapshot_precise")
        check("debugger" in ps["description"].lower(),
              "page_snapshot_precise description mentions debugger")
        check("cookie_get" in names, "tools/list includes cookie_get")
        check("storage_get" in names, "tools/list includes storage_get")
        # cookie_get description must mention httpOnly + read-only
        ck = next(t for t in tools["result"]["tools"] if t["name"] == "cookie_get")
        check("httpOnly" in ck["description"], "cookie_get description mentions httpOnly")
        check("masked" in ck["description"].lower(), "cookie_get description mentions masking")
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)


def test_stale_lock_is_replaced():
    print("\n[test] stale lock file is replaced on startup")
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    with open(LOCK, "w", encoding="utf-8") as f:
        json.dump({"port": 9, "secret": "0" * 32, "pid": 4294967295}, f)
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        lock = wait_lock(mcp)
        check(lock is not None and lock.get("pid") == mcp.pid,
              "server replaced a dead process's lock file")
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)


def test_tab_list_round_trip():
    print("\n[test] tab_list round-trip via mock extension (TCP bridge)")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")

        def responder(req):
            assert req["op"] == "tab_list", f"unexpected op {req['op']}"
            return {"id": req["id"], "ok": True,
                    "data": [{"id": 7, "title": "E2E Tab", "url": "https://x", "active": True}]}

        s, serve = mock_extension(lf, responder)
        c = McpClient(mcp)
        c.initialize()
        c.initialized()
        time.sleep(0.1)  # let the mock connect + hello authenticate
        # serve the single tab_list request the call below will trigger
        served = []
        t = threading.Thread(target=lambda: served.append(serve()))
        t.start()

        r = c.call("tab_list", {}, _id=5)
        t.join(timeout=3)
        check(bool(served), "mock extension received the tab_list BridgeReq")
        content = r["result"]["content"][0]["text"]
        data = json.loads(content)
        check(data[0]["title"] == "E2E Tab", "tab_list result carries mock data")
        check(r["result"].get("isError") is False, "tab_list isError=false")
        s.close()
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)


def test_page_eval_round_trip():
    print("\n[test] page_eval round-trip (op reaches extension)")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")

        captured = {}

        def responder(req):
            captured["req"] = req
            # Echo back a typical eval result after masking would have been
            # applied by the (real) content script. Here we just verify the
            # op + code were forwarded correctly.
            return {"id": req["id"], "ok": True,
                    "data": {"result": 42, "masked": "••••[jwt]"}}

        s, serve = mock_extension(lf, responder)
        c = McpClient(mcp)
        c.initialize()
        c.initialized()
        time.sleep(0.1)
        served = []
        t = threading.Thread(target=lambda: served.append(serve()))
        t.start()

        r = c.call("page_eval", {"code": "return 1 + 41"}, _id=7)
        t.join(timeout=3)
        check(bool(served), "page_eval BridgeReq reached extension")
        check(captured.get("req", {}).get("op") == "page_eval",
              "forwarded op is page_eval")
        check(captured.get("req", {}).get("args", {}).get("code") == "return 1 + 41",
              "forwarded args.code matches input")
        content = json.loads(r["result"]["content"][0]["text"])
        check(content.get("result") == 42, "eval result data returned to client")
        s.close()
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)


def test_page_snapshot_precise_round_trip():
    print("\n[test] page_snapshot_precise round-trip (op reaches extension)")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")
        captured = {}

        def responder(req):
            captured["req"] = req
            # Mirror what a real SW would return after the CDP round-trip:
            # refs with the 'p' prefix, precise: true.
            return {"id": req["id"], "ok": True, "data": {
                "refCount": 2,
                "nodes": [
                    {"ref": "p1", "role": "textbox", "name": "Search",
                     "selector": "input#q", "value": ""},
                    {"ref": "p2", "role": "button", "name": "Submit",
                     "selector": "button#go", "value": None},
                ],
                "url": "https://example.com",
                "title": "Example",
                "precise": True,
            }}

        s, serve = mock_extension(lf, responder)
        c = McpClient(mcp)
        c.initialize()
        c.initialized()
        time.sleep(0.1)
        served = []
        t = threading.Thread(target=lambda: served.append(serve()))
        t.start()

        r = c.call("page_snapshot_precise", {}, _id=9)
        t.join(timeout=3)
        check(bool(served), "page_snapshot_precise BridgeReq reached extension")
        check(captured.get("req", {}).get("op") == "page_snapshot_precise",
              "forwarded op is page_snapshot_precise")
        content = json.loads(r["result"]["content"][0]["text"])
        check(content.get("precise") is True, "result carries precise:true flag")
        check(content["nodes"][0]["ref"] == "p1", "precise refs use 'p' prefix")
        check(len(content["nodes"]) == 2, "both nodes returned")
        s.close()
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)


def test_cookie_get_round_trip():
    print("\n[test] cookie_get round-trip (op + args reach extension)")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")
        captured = {}

        def responder(req):
            captured["req"] = req
            # Mirror what background.js cookieGet returns: cookies with masked
            # values but preserved structure fields.
            return {"id": req["id"], "ok": True, "data": {
                "cookies": [
                    {"name": "session", "value": "••••[jwt]", "domain": ".example.com",
                     "path": "/", "httpOnly": True, "secure": True,
                     "sameSite": "lax", "session": False},
                ],
                "count": 1,
            }}

        s, serve = mock_extension(lf, responder)
        c = McpClient(mcp)
        c.initialize()
        c.initialized()
        time.sleep(0.1)
        served = []
        t = threading.Thread(target=lambda: served.append(serve()))
        t.start()

        r = c.call("cookie_get", {"url": "https://example.com"}, _id=10)
        t.join(timeout=3)
        check(bool(served), "cookie_get BridgeReq reached extension")
        check(captured.get("req", {}).get("op") == "cookie_get",
              "forwarded op is cookie_get")
        check(captured["req"]["args"].get("url") == "https://example.com",
              "forwarded args.url matches")
        content = json.loads(r["result"]["content"][0]["text"])
        check(content["cookies"][0]["httpOnly"] is True,
              "cookie structure (httpOnly) preserved")
        check("••••" in content["cookies"][0]["value"],
              "cookie value is masked")
        s.close()
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)


def test_storage_get_round_trip():
    print("\n[test] storage_get round-trip (op reaches extension)")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")
        captured = {}

        def responder(req):
            captured["req"] = req
            return {"id": req["id"], "ok": True, "data": {
                "key": "auth_token",
                "found": True,
                "value": "••••[jwt]",
            }}

        s, serve = mock_extension(lf, responder)
        c = McpClient(mcp)
        c.initialize()
        c.initialized()
        time.sleep(0.1)
        served = []
        t = threading.Thread(target=lambda: served.append(serve()))
        t.start()

        r = c.call("storage_get", {"type": "local", "key": "auth_token"}, _id=11)
        t.join(timeout=3)
        check(bool(served), "storage_get BridgeReq reached extension")
        check(captured.get("req", {}).get("op") == "storage_get",
              "forwarded op is storage_get")
        check(captured["req"]["args"].get("key") == "auth_token",
              "forwarded args.key matches")
        content = json.loads(r["result"]["content"][0]["text"])
        check(content.get("found") is True, "storage result has found:true")
        check("••••" in content.get("value", ""), "storage value is masked")
        s.close()
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)


def test_native_host_mode():
    print("\n[test] --native-host mode with real NM framing")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")
        # Launch --native-host the way Chrome would. Pass a fake origin as argv[1].
        # Binary mode (no text=True) since NM framing is raw bytes.
        nh = subprocess.Popen([BIN, "--native-host"], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(0.3)  # let it connect + send hello

        c = McpClient(mcp)
        c.initialize()
        c.initialized()

        # Send the tools/call request ourselves (don't read the response yet).
        c.send({"jsonrpc": "2.0", "id": 8, "method": "tools/call",
                "params": {"name": "tab_list", "arguments": {}}})

        # The MCP server forwards it over TCP -> native host -> stdout as NM frame.
        frame = nm_read(nh)
        check(frame is not None and frame.get("op") == "tab_list",
              "native host emits BridgeReq as NM frame to extension")

        # Extension replies: write NM frame to native host stdin -> TCP -> MCP.
        nm_write(nh, {"id": frame["id"], "ok": True,
                      "data": [{"id": 1, "title": "NM Round Trip", "url": "y", "active": True}]})

        # Now the MCP server resolves and writes the tools/call response to stdout.
        r = c.recv()
        content = json.loads(r["result"]["content"][0]["text"])
        check(content[0]["title"] == "NM Round Trip",
              "extension reply traveled host -> MCP -> client")
        nh.kill()
        nh.wait(timeout=3)
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=5)


def test_server_takeover():
    print("\n[test] new MCP server supplants the previous server")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    first = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, encoding="utf-8")
    second = None
    try:
        first_lock = wait_lock(first)
        check(first_lock is not None, "first server wrote its lock file")
        second = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, encoding="utf-8")
        second_lock = wait_lock(second)
        check(second_lock is not None, "second server replaced the lock file")
        first.wait(timeout=8)
        check(first.poll() is not None, "previous server was terminated")
    finally:
        if first.poll() is None:
            first.kill()
        if second is not None:
            try:
                second.stdin.close()
            except Exception:
                pass
            second.wait(timeout=3)


def test_unknown_method_returns_32601():
    print("\n[test] unknown method returns JSON-RPC -32601")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        c = McpClient(mcp)
        c.initialize()
        c.initialized()
        c.send({"jsonrpc": "2.0", "id": 11, "method": "resources/list"})
        r = c.recv()
        check(r.get("error", {}).get("code") == -32601,
              "unknown method -> error code -32601")
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)


def test_announce_is_absorbed_not_routed():
    """The extension's announce frame must reach the server without disturbing
    anything else on the connection.

    It rides the BridgeResp envelope on the reserved id 0 precisely so an older
    server can't choke on it (a frame that fails to deserialize kills the reader
    loop and drops the connection). This asserts the *new* server's half: the
    announce is consumed and recorded, and the very next tool call still works.

    Note on coverage: the drift advisory itself cannot fire here. This binary is
    built from the repo, so it reports the 0.0.0 placeholder (ADR-0026), and the
    policy is deliberately silent whenever either side is a local build. The
    positive advisory path is covered by the Rust unit tests in src/peer.rs,
    src/session.rs and src/mcp_server.rs; what this proves is the wiring that
    gets an announce from the wire into the session, plus the guarantee that a
    mismatched pairing never *breaks* the bridge."""
    print("\n[test] version announce is absorbed, not routed")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    env = dict(os.environ, BB_LOG="info")
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8", env=env)
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")

        def responder(req):
            return {"id": req["id"], "ok": True,
                    "data": [{"id": 1, "title": "T", "url": "https://x", "active": True}]}

        # A version that differs from any release, announced the way the real
        # extension does on connect.
        s, serve = mock_extension(lf, responder, announce={
            "protocolVersion": 1,
            "version": "9.9.9",
            "browser": {"name": "Chrome", "version": "141.0.7390.55"},
        })
        c = McpClient(mcp)
        c.initialize()
        c.initialized()
        time.sleep(0.2)  # let hello + announce land

        t = threading.Thread(target=serve)
        t.start()
        r = c.call("tab_list", {}, _id=20)
        t.join(timeout=5)

        # The announce must not have been mistaken for a reply to a request, nor
        # have consumed the response the real call is waiting for — a payload
        # coming back proves both.
        check(r["result"].get("isError") is False, "tool call succeeded")
        blocks = r["result"]["content"]
        check(len(blocks) == 1,
              "no advisory block in a 0.0.0 dev build (drift policy is dev-quiet)")
        check(json.loads(blocks[0]["text"])[0]["title"] == "T",
              "the tool's own payload is untouched")
        s.close()
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)
        err = read_stderr(mcp)
        # Proves the frame was parsed and recorded, not silently dropped.
        check("extension v9.9.9" in err,
              "server logged the announced extension version")
        check("no pending caller for id 0" not in err,
              "announce was absorbed, not routed as a stray response")


def test_unknown_id_zero_frame_does_not_break_the_loop():
    """A frame on id 0 that ISN'T an announce falls through to normal routing.

    Defensive: nothing sends this today, but the announce interception must not
    swallow arbitrary id-0 traffic, and an unroutable frame must leave the
    connection usable rather than tearing it down."""
    print("\n[test] a non-announce id-0 frame leaves the bridge usable")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    env = dict(os.environ, BB_LOG="info")
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8", env=env)
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")

        def responder(req):
            return {"id": req["id"], "ok": True,
                    "data": [{"id": 3, "title": "STILL ALIVE", "url": "https://x",
                              "active": True}]}

        # data present, but no `announce` key -> not an announce.
        s, serve = mock_extension(lf, responder, announce=None)
        s.sendall((json.dumps({"id": 0, "ok": True, "data": {"junk": 1}}) + "\n").encode())

        c = McpClient(mcp)
        c.initialize()
        c.initialized()
        time.sleep(0.2)
        # Deliberately no assertion on the serve thread itself: the tool call
        # below can only return a payload if the server's reader survived the
        # stray frame, delivered the BridgeReq and matched the reply — which is
        # the whole property under test, without depending on thread timing.
        t = threading.Thread(target=serve)
        t.start()
        r = c.call("tab_list", {}, _id=21)
        t.join(timeout=5)
        check(r["result"].get("isError") is False, "tool call succeeded")
        check(json.loads(r["result"]["content"][0]["text"])[0]["title"] == "STILL ALIVE",
              "bridge still round-trips after a stray id-0 frame")
        s.close()
    finally:
        try:
            mcp.stdin.close()
        except Exception:
            pass
        mcp.wait(timeout=3)
        err = read_stderr(mcp)
        # A frame that isn't an announce must fall through to ordinary routing
        # (and be reported as unroutable) rather than being silently swallowed.
        check("no pending caller for id 0" in err,
              "a non-announce id-0 frame falls through to normal routing")


def main():
    ensure_binary()
    print(f"binary: {BIN}")
    test_stale_lock_is_replaced()
    test_mcp_handshake_and_tools()
    test_announce_is_absorbed_not_routed()
    test_unknown_id_zero_frame_does_not_break_the_loop()
    test_tab_list_round_trip()
    test_page_eval_round_trip()
    test_page_snapshot_precise_round_trip()
    test_cookie_get_round_trip()
    test_storage_get_round_trip()
    test_native_host_mode()
    test_server_takeover()
    test_unknown_method_returns_32601()
    print(f"\n{'='*40}\n{_passed} passed, {_failed} failed")
    sys.exit(0 if _failed == 0 else 1)


if __name__ == "__main__":
    main()
