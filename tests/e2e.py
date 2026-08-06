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
import atexit
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "target", "release", "browser-bridge" + (".exe" if os.name == "nt" else ""))

# Run the whole suite on a PRIVATE bridge, via the binary's BB_LOCK_DIR override.
#
# The lock file is otherwise a per-user singleton, and Session keeps exactly ONE
# native-host connection. On a developer machine that means a real, installed
# extension attaches to whichever server owns the lock — including this suite's —
# and REPLACES the mock's connection, answering the tool calls itself. That was
# not theoretical: a run was observed dispatching page_snapshot_precise to the
# developer's own browser (`outcome=ok` after 20s), attaching chrome.debugger to
# their real tabs. Whichever side wins is a race, so the corruption was silent
# and intermittent — the suite failed on a different test each run.
#
# Chrome spawns the real host WITHOUT this variable, so it resolves the default
# path and can never see the servers spawned here. Isolation by construction,
# rather than asking developers to quit their browser.
_LOCK_DIR = tempfile.mkdtemp(prefix="bb-e2e-lock-")
atexit.register(lambda: shutil.rmtree(_LOCK_DIR, ignore_errors=True))
LOCK = os.path.join(_LOCK_DIR, "browser-bridge", "run.lock")


def bb_env(extra=None):
    """Environment for every browser-bridge process this suite spawns."""
    env = dict(os.environ, BB_LOCK_DIR=_LOCK_DIR)
    if extra:
        env.update(extra)
    return env

_passed = 0
_failed = 0
# The ServerLog of the server the current test is driving. A failing check dumps
# it: every interesting failure here is a connection/handshake problem, and the
# server's log is the only place that is visible.
_current_log = None


def check(cond, label):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  PASS  {label}")
    else:
        _failed += 1
        print(f"  FAIL  {label}")
        if _current_log is not None:
            text = _current_log.text().strip()
            print("        --- server log ---")
            for line in (text or "(empty)").splitlines():
                print("        " + line)
            if text.count(AUTHED) > 1:
                print("        NOTE: more than one native host authenticated. The suite")
                print("              runs on a private BB_LOCK_DIR bridge precisely so a")
                print("              real extension cannot attach — if this fires, that")
                print("              isolation has regressed (see the BB_LOCK_DIR note).")


AUTHED = "native host connected and authenticated"


def _dump_log_on_crash(exc_type, exc, tb):
    """An exception escaping a test is almost always a connection problem, and
    the server's log says why. Print it before the traceback scrolls past."""
    if _current_log is not None:
        text = _current_log.text().strip()
        print("\n--- server log at crash ---")
        print(text or "(empty)")
    sys.__excepthook__(exc_type, exc, tb)


sys.excepthook = _dump_log_on_crash


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


class ServerLog:
    """Continuously drains a server's stderr so tests can wait on what it logged.

    Two reasons this exists rather than reading stderr on demand:

    1. A pipe read blocks until EOF, and EOF only arrives once EVERY holder of
       the write end has closed it — one lingering grandchild (a `--native-host`
       the server spawned) is enough to wedge the read forever. A daemon thread
       draining continuously can be abandoned at any time.
    2. It turns the server's own log into a synchronisation point. The bridge
       handshake has no ack the test can see: `mock_extension` fires its hello
       and, if the server rejects it, learns nothing — the socket just sits there
       until a later assertion fails with a confusing "BridgeReq never arrived".
       Waiting for "native host connected and authenticated" makes attachment an
       observed fact instead of a `sleep()` guess.
    """

    def __init__(self, proc):
        self.proc = proc
        self._buf = ""
        self._lock = threading.Lock()
        t = threading.Thread(target=self._drain, daemon=True)
        t.start()

    def _drain(self):
        try:
            for line in iter(self.proc.stderr.readline, ""):
                with self._lock:
                    self._buf += line
        except Exception:
            pass

    def text(self):
        with self._lock:
            return self._buf

    def wait_for(self, needle, timeout=10):
        """True once `needle` appears in the log; False on timeout."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            if needle in self.text():
                return True
            time.sleep(0.02)
        return False


def start_server(env=None):
    """Spawn an MCP server with its stderr drained. Returns (proc, ServerLog)."""
    global _current_log
    proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding="utf-8",
                            env=bb_env(env))
    log = ServerLog(proc)
    _current_log = log
    return proc, log


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


def _read_with_timeout(fn, timeout, what):
    """Run a blocking read on a daemon thread and give up after `timeout`.

    Every read in this file talks to a subprocess pipe, which has no timeout of
    its own: if the far end never writes, the read blocks forever and the suite
    hangs instead of failing (observed: a run wedged for 4h13m, holding two
    orphan processes). Raising keeps a stuck read to one clearly-labelled
    failure."""
    box = {}

    def run():
        try:
            box["v"] = fn()
        except Exception as e:  # noqa: BLE001 - surfaced via the timeout message
            box["e"] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout)
    if "e" in box:
        raise box["e"]
    if "v" not in box:
        raise TimeoutError(f"timed out after {timeout}s waiting for {what}")
    return box["v"]


def nm_read(p, timeout=15):
    def read():
        hdr = p.stdout.read(4)
        if len(hdr) < 4:
            return None
        (n,) = struct.unpack("<I", hdr)
        return json.loads(p.stdout.read(n))

    return _read_with_timeout(read, timeout, "a native-messaging frame from the host")


class McpClient:
    """Minimal MCP JSON-RPC client over stdio to the server subprocess."""

    def __init__(self, proc):
        self.proc = proc

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def recv(self, timeout=30):
        # Generous, because a tool call legitimately waits on the extension —
        # but bounded, because a server that never answers must fail the test
        # rather than hang the suite.
        line = _read_with_timeout(self.proc.stdout.readline, timeout, "an MCP response")
        if not line:
            raise AssertionError("MCP server closed stdout without responding")
        return json.loads(line)

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


def mock_extension(lf, responder, announce=None, log=None):
    """Connect to the bridge socket as the extension would, answer requests
    using `responder(req) -> dict`.

    `announce` (optional) is the payload the real extension posts right after
    connecting (shared/announce.ts). It rides the BridgeResp envelope on the
    reserved id 0; see src/peer.rs for why.

    `log` (a ServerLog) makes attachment an observed fact: the server validates
    the hello against the lock file it re-reads FROM DISK, so a lock that has
    been removed or replaced in the meantime silently refuses this connection.
    Without waiting on the log the test would sail on and fail much later with a
    misleading "BridgeReq never reached the extension"."""
    s = socket.create_connection(("127.0.0.1", lf["port"]), timeout=5)
    s.sendall((json.dumps({"hello": lf["secret"]}) + "\n").encode())
    if log is not None and not log.wait_for(AUTHED):
        raise AssertionError(
            "the mock extension's hello was never accepted — the server never "
            "logged an authenticated connection.\n"
            "--- server log ---\n" + (log.text() or "(empty)")
        )
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
    mcp, log = start_server()
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
    mcp, log = start_server()
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
    mcp, log = start_server()
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")

        def responder(req):
            assert req["op"] == "tab_list", f"unexpected op {req['op']}"
            return {"id": req["id"], "ok": True,
                    "data": [{"id": 7, "title": "E2E Tab", "url": "https://x", "active": True}]}

        s, serve = mock_extension(lf, responder, log=log)
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
    mcp, log = start_server()
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

        s, serve = mock_extension(lf, responder, log=log)
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
    mcp, log = start_server()
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

        s, serve = mock_extension(lf, responder, log=log)
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
    mcp, log = start_server()
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

        s, serve = mock_extension(lf, responder, log=log)
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
    mcp, log = start_server()
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

        s, serve = mock_extension(lf, responder, log=log)
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
    mcp, log = start_server()
    nh = None
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")
        # Launch --native-host the way Chrome would. Pass a fake origin as argv[1].
        # Binary mode (no text=True) since NM framing is raw bytes.
        nh = subprocess.Popen([BIN, "--native-host"], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=bb_env())
        # The real host connects over TCP and sends the hello; wait for the
        # server to say so rather than sleeping and hoping.
        if not log.wait_for(AUTHED):
            raise AssertionError(
                "the --native-host process never authenticated.\n"
                "--- server log ---\n" + (log.text() or "(empty)")
            )

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
    finally:
        # Unconditional: `nh` used to be killed on the happy path only, after the
        # last check, so any earlier failure leaked a live native host — which
        # then held the server's stderr pipe open and could wedge a later read.
        if nh is not None:
            nh.kill()
            try:
                nh.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        try:
            mcp.stdin.close()
        except Exception:
            pass
        try:
            mcp.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mcp.kill()


def test_server_takeover():
    print("\n[test] new MCP server supplants the previous server")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    first, _ = start_server()
    second = None
    try:
        first_lock = wait_lock(first)
        check(first_lock is not None, "first server wrote its lock file")
        second, _ = start_server()
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
    mcp, log = start_server()
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
    mcp, log = start_server(env)
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")

        def responder(req):
            return {"id": req["id"], "ok": True,
                    "data": [{"id": 1, "title": "T", "url": "https://x", "active": True}]}

        # A version that differs from any release, announced the way the real
        # extension does on connect.
        s, serve = mock_extension(lf, responder, log=log, announce={
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
        err = log.text()
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
    mcp, log = start_server(env)
    try:
        lf = wait_lock(mcp)
        check(lf is not None, "lock file written")

        def responder(req):
            return {"id": req["id"], "ok": True,
                    "data": [{"id": 3, "title": "STILL ALIVE", "url": "https://x",
                              "active": True}]}

        # data present, but no `announce` key -> not an announce.
        s, serve = mock_extension(lf, responder, log=log, announce=None)
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
        err = log.text()
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
