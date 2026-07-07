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
the full process boundary the way ZCode and Chrome would, which a unit test
inside the crate cannot.
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
BIN = os.path.join(REPO, "target", "release", "browser-bridge")
LOCK = os.path.expanduser("~/Library/Application Support/browser-bridge/run.lock")

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


def wait_lock(timeout=5):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(LOCK):
            with open(LOCK) as f:
                return json.load(f)
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


def mock_extension(lf, responder):
    """Connect to the bridge socket as the extension would, answer requests
    using `responder(req) -> dict`."""
    s = socket.create_connection(("127.0.0.1", lf["port"]), timeout=5)
    s.sendall((json.dumps({"hello": lf["secret"]}) + "\n").encode())
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
                           stderr=subprocess.PIPE, text=True)
    try:
        lf = wait_lock()
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
        # page_eval description must carry a HIGH RISK warning
        ev = next(t for t in tools["result"]["tools"] if t["name"] == "page_eval")
        check("HIGH RISK" in ev["description"], "page_eval description warns HIGH RISK")
        check(ev["inputSchema"]["required"] == ["code"], "page_eval requires code arg")
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
                           stderr=subprocess.PIPE, text=True)
    try:
        lf = wait_lock()
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
                           stderr=subprocess.PIPE, text=True)
    try:
        lf = wait_lock()
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


def test_native_host_mode():
    print("\n[test] --native-host mode with real NM framing")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True)
    try:
        lf = wait_lock()
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


def test_unknown_method_returns_32601():
    print("\n[test] unknown method returns JSON-RPC -32601")
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass
    mcp = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True)
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


def main():
    ensure_binary()
    print(f"binary: {BIN}")
    test_mcp_handshake_and_tools()
    test_tab_list_round_trip()
    test_page_eval_round_trip()
    test_native_host_mode()
    test_unknown_method_returns_32601()
    print(f"\n{'='*40}\n{_passed} passed, {_failed} failed")
    sys.exit(0 if _failed == 0 else 1)


if __name__ == "__main__":
    main()
