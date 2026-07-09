/**
 * DOM-layer tests for extension/content.js — runs the REAL content.js source
 * against a real headless Chrome page via the DevTools Protocol.
 *
 * What this validates (that tests/e2e.py cannot): the actual DOM logic —
 * TreeWalker snapshot, accessible-name computation, native-setter fill,
 * Function-constructor eval, localStorage reads, Toast injection — against
 * real browser DOM, not mocks.
 *
 * What this does NOT cover (lives in background.js, not content.js):
 * page_snapshot_precise (chrome.debugger), cookie_get (chrome.cookies).
 *
 * Run:  bun tests/dom_test.ts
 * Requires: Chrome (uses the system Chrome in headless mode), bun.
 */

import { spawn, ChildProcess } from "bun";
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(import.meta.dir, "..");
// The built bundle (esbuild strips TS types from src/content.ts). Run
// `npm --prefix extension run build` first; `run_all.sh` / `just` do this.
const CONTENT_JS = path.join(REPO, "extension", "dist", "content.js");
const FIXTURES_DIR = path.join(REPO, "tests", "fixtures");
const CHROME =
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Resolve a fixture filename to its file:// URL. */
function fixtureUrl(name: string): string {
  return "file://" + path.join(FIXTURES_DIR, name);
}

// ─── assertion helpers (same style as tests/e2e.py) ────────────────────────
let _pass = 0;
let _fail = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    _pass++;
    console.log("  PASS  " + label);
  } else {
    _fail++;
    console.log("  FAIL  " + label);
  }
}

// ─── headless Chrome process ───────────────────────────────────────────────
class Chrome {
  proc: ChildProcess;
  port: number;
  constructor(port = 9444) {
    this.port = port;
    this.proc = spawn({
      cmd: [
        CHROME,
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=" + port,
        "--remote-allow-origins=*",
        "about:blank",
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  async waitReady(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (r.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Chrome did not become ready on port " + this.port);
  }
  async stop(): Promise<void> {
    try {
      this.proc.kill();
    } catch {}
  }
}

// ─── minimal CDP client over WebSocket ─────────────────────────────────────
class Page {
  ws: WebSocket;
  sessionId: string;
  private id = 0;
  private pending = new Map<number, (v: any) => void>();
  private constructor(ws: WebSocket, sessionId: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    ws.onmessage = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      }
    };
  }
  static async connect(port: number): Promise<Page> {
    // Find the page target.
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = (await listRes.json()) as any[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    // Connect to the browser-level WS, then attach via flattened session.
    const verRes = await fetch(`http://127.0.0.1:${port}/json/version`);
    const ver = (await verRes.json()) as any;
    const wsUrl = ver.webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((r, rej) => {
      ws.onopen = () => r();
      ws.onerror = () => rej(new Error("ws open failed"));
    });
    // Attach to the page target to get a sessionId for flattened protocol.
    const attach = await Page.sendRaw(ws, "Target.attachToTarget", {
      targetId: page.id,
      flatten: true,
    });
    const sessionId = attach.result.sessionId;
    const inst = new Page(ws, sessionId);
    return inst;
  }
  private static sendRaw(
    ws: WebSocket,
    method: string,
    params: any
  ): Promise<any> {
    const id = ++Page._staticId;
    return new Promise((resolve) => {
      const onMsg = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string);
        if (msg.id === id) {
          ws.removeEventListener("message", onMsg as any);
          resolve(msg);
        }
      };
      ws.addEventListener("message", onMsg as any);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  private static _staticId = 0;
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }
  /** Evaluate an expression in the page, return the value (must be JSON via returnByValue). */
  /** Navigate the page to a URL. Enables switching fixtures per test. */
  async navigate(url: string, settleMs = 400): Promise<void> {
    await this.send("Page.enable", {});
    await this.send("Page.navigate", { url });
    // Give inline scripts time to run. CDP doesn't expose a clean "load done"
    // without listening to events; a short settle is reliable for our static
    // fixtures.
    await new Promise((r) => setTimeout(r, settleMs));
  }
  async evaluate(expr: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(
        "evaluate threw: " +
          JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
      );
    }
    return r.result?.result?.value;
  }
  /** Evaluate a function with arguments (safer for injecting big strings). */
  async callFunction(fnDecl: string, args: any[]): Promise<any> {
    const r = await this.send("Runtime.evaluate", {
      expression: `(${fnDecl})(${args
        .map((a) => JSON.stringify(a))
        .join(",")})`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(
        "callFunction threw: " +
          JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
      );
    }
    return r.result?.result?.value;
  }
}

// ─── content.js injection harness ──────────────────────────────────────────

/** Inject chrome.* stubs into the page before content.js loads.
 * Captures the onMessage listener so tests can drive it. */
async function injectStub(page: Page, opts: { evalMask?: boolean } = {}): Promise<void> {
  const evalMask = opts.evalMask ?? true;
  await page.evaluate(`
    (function(){
      window.__bbListeners = [];
      window.__bbLastResp = undefined;
      window.__bbRespSeq = 0;
      globalThis.chrome = globalThis.chrome || {};
      chrome.runtime = {
        onMessage: { addListener: function(fn){ window.__bbListeners.push(fn); } },
        sendMessage: function(msg, cb){
          // screenshot capture stub: respond with empty (tests don't check pixels)
          if (cb) cb({ dataUrl: "" });
        },
        lastError: undefined,
      };
      chrome.storage = {
        local: {
          get: function(key, cb){
            if (cb) cb({ evalMask: ${JSON.stringify(evalMask)} });
          },
        },
      };
    })();
  `);
}

/** Read and inject the real content.js source. Returns the number of
 * registered listeners (should be 1). Clears the load guard first so the
 * IIFE re-runs (enables per-test re-injection). */
async function loadContentJs(page: Page): Promise<void> {
  const src = fs.readFileSync(CONTENT_JS, "utf8");
  // Clear the load guard so the IIFE's `if (window.__browserBridgeLoaded) return`
  // doesn't short-circuit on re-injection between tests.
  await page.evaluate("delete window.__browserBridgeLoaded;");
  // Wrap in an IIFE-protecting eval so top-level `return` inside content.js's
  // own IIFE works. content.js is already an IIFE, so direct eval is fine.
  await page.evaluate(src);
}

/** Invoke a content.js op via the captured onMessage listener. Returns the
 * sendResponse payload (the op's result object). */
async function invoke(
  page: Page,
  op: string,
  args: any = {},
  timeoutMs = 8000
): Promise<any> {
  // Reset the response slot, then call the listener. The listener returns true
  // (async) and eventually calls sendResponse with the result.
  await page.evaluate(`
    (function(){
      window.__bbLastResp = undefined;
      window.__bbRespSeq++;
      var seq = window.__bbRespSeq;
      window.__bbWaitSeq = seq;
      var sendResponse = function(r){
        if (window.__bbWaitSeq === seq) window.__bbLastResp = r;
      };
      var listener = window.__bbListeners[0];
      if (!listener) throw new Error("no content.js listener registered");
      listener({ op: ${JSON.stringify(op)}, args: ${JSON.stringify(args)} }, {}, sendResponse);
    })();
  `);
  // Poll for the response (handler is async).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await page.evaluate("window.__bbLastResp");
    if (resp !== undefined && resp !== null) return resp;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`invoke('${op}') timed out after ${timeoutMs}ms`);
}

/** Click a Toast button (Allow/Deny/Cancel) in the page — for testing the
 * high-risk confirmation flow. */
async function clickToastButton(page: Page, selector: string): Promise<void> {
  await page.evaluate(`
    (function(){
      var btn = document.querySelector('${selector}');
      if (btn) btn.click();
    })();
  `);
}

// ─── tests ─────────────────────────────────────────────────────────────────
// (added in the next step)

async function main() {
  // Sanity: content.js source must exist.
  if (!fs.existsSync(CONTENT_JS)) {
    console.error("content.js not found at " + CONTENT_JS);
    process.exit(2);
  }
  if (!fs.existsSync(CHROME)) {
    console.error("Chrome not found at " + CHROME);
    process.exit(2);
  }

  console.log("starting headless Chrome…");
  const chrome = new Chrome(9444);
  try {
    await chrome.waitReady();
    const page = await Page.connect(9444);
    // Give the page's inline <script> (localStorage setup) time to run.
    await new Promise((r) => setTimeout(r, 300));

    await runAllTests(page);
  } finally {
    await chrome.stop();
  }
  console.log(`\n${"=".repeat(40)}\n${_pass} passed, ${_fail} failed`);
  process.exit(_fail > 0 ? 1 : 0);
}

async function runAllTests(page: Page): Promise<void> {
  await test_snapshot(page);
  await test_click(page);
  await test_fill(page);
  await test_text(page);
  await test_eval_masked(page);
  await test_eval_unmasked(page);
  await test_eval_error_and_serialize(page);
  await test_storage_get(page);
  await test_wait_for_nav(page);
  await test_high_risk_toast(page);
  await test_ping(page);
  await test_shadow_dom(page);
  await test_iframe(page);
  await test_dynamic_reload_snapshot(page);
}

/** Re-inject content.js fresh for each test so refCounter / refMap reset.
 * `fixture` selects which HTML file to load (default page.html). */
async function freshLoad(
  page: Page,
  opts: { evalMask?: boolean; fixture?: string } = {}
): Promise<void> {
  const name = opts.fixture || "page.html";
  const url = fixtureUrl(name);
  // Navigate (or reload) to wipe all DOM mutations (toasts, data-zcb-ref
  // attrs, onclick counts). Navigate works for about:blank→fixture and
  // also reloads if already on the same URL.
  await page.navigate(url);
  await injectStub(page, opts);
  await loadContentJs(page);
}

// ── test: page_snapshot ────────────────────────────────────────────────────
async function test_snapshot(page: Page): Promise<void> {
  console.log("\n[test] page_snapshot — refs, roles, names, visibility filter");
  await freshLoad(page);
  const resp = await invoke(page, "page_snapshot", {});
  check(!resp.__error, "snapshot returns without error: " + (resp.__error || "ok"));
  if (resp.__error) return;
  const nodes = resp.nodes || [];
  check(resp.refCount === nodes.length, "refCount matches nodes length");
  check(nodes.length > 0, "snapshot found interactive elements");

  const byId: Record<string, any> = {};
  for (const n of nodes) byId[n.ref] = n;

  // Role checks: input:text → textbox, button → button, link → link, checkbox, radio.
  const search = nodes.find((n: any) => n.selector && n.selector.includes("#search"));
  check(!!search, "snapshot includes #search input");
  check(search?.role === "textbox", "#search role is textbox (got " + search?.role + ")");
  check(search?.name === "Search box", "#search name from aria-label (got " + search?.name + ")");

  const go = nodes.find((n: any) => n.selector && n.selector.includes("#go"));
  check(go?.role === "button", "#go role is button");
  check(go?.name === "Search", "#go name from innerText");

  const link = nodes.find((n: any) => n.selector && n.selector.includes("#link1"));
  check(link?.role === "link", "#link1 role is link");

  const cb = nodes.find((n: any) => n.selector && n.selector.includes("#cb"));
  check(cb?.role === "checkbox", "#cb role is checkbox");

  // accessible-name via aria-labelledby.
  const email = nodes.find((n: any) => n.selector && n.selector.includes("#email"));
  check(email?.name === "Email address", "#email name via aria-labelledby (got " + email?.name + ")");

  // accessible-name via wrapping <label>.
  const user = nodes.find((n: any) => n.selector && n.selector.includes("#user"));
  check(user?.name === "Username", "#user name via wrapping <label> (got " + user?.name + ")");

  // Visibility filter: hidden buttons must NOT appear.
  const hiddenBtn = nodes.find((n: any) => n.selector && n.selector.includes("#hidden-btn"));
  check(!hiddenBtn, "display:none button excluded from snapshot");
  const axHiddenBtn = nodes.find((n: any) => n.selector && n.selector.includes("#ax-hidden-btn"));
  check(!axHiddenBtn, "aria-hidden subtree button excluded");

  // Refs are stable strings with the 'e' prefix.
  check(nodes.every((n: any) => /^e\d+$/.test(n.ref)), "all refs match e<number>");
}

// ── test: page_click ───────────────────────────────────────────────────────
async function test_click(page: Page): Promise<void> {
  console.log("\n[test] page_click — real DOM click + ref resolution");
  await freshLoad(page);
  // First snapshot to get refs assigned.
  const snap = await invoke(page, "page_snapshot", {});
  const plainBtn = snap.nodes.find((n: any) => n.selector && n.selector.includes("#plain-btn"));
  check(!!plainBtn, "snapshot has #plain-btn ref: " + plainBtn?.ref);

  // Click by ref — should actually trigger the page's onclick counter.
  const before = await page.evaluate("window.__plainClicks || 0");
  const clickResp = await invoke(page, "page_click", { ref: plainBtn.ref });
  check(!clickResp.__error, "click by ref succeeds: " + (clickResp.__error || "ok"));
  const after = await page.evaluate("window.__plainClicks || 0");
  check(after === before + 1, "click triggered real onclick (before=" + before + " after=" + after + ")");

  // Click by selector fallback (no ref).
  const before2 = await page.evaluate("window.__plainClicks || 0");
  const clickResp2 = await invoke(page, "page_click", { selector: "#plain-btn" });
  check(!clickResp2.__error, "click by selector succeeds");
  const after2 = await page.evaluate("window.__plainClicks || 0");
  check(after2 === before2 + 1, "selector click triggered onclick");

  // Non-existent ref → clear error.
  const bad = await invoke(page, "page_click", { ref: "e999" });
  check(!!bad.__error, "click on stale ref returns error");
}

// ── test: page_fill ────────────────────────────────────────────────────────
async function test_fill(page: Page): Promise<void> {
  console.log("\n[test] page_fill — native setter + framework change detection");
  await freshLoad(page);
  const resp = await invoke(page, "page_fill", { selector: "#fill-target", value: "hello" });
  check(!resp.__error, "fill succeeds: " + (resp.__error || "ok"));

  // Value actually set on the DOM input.
  const val = await page.evaluate(`document.getElementById("fill-target").value`);
  check(val === "hello", "fill set input.value to 'hello' (got " + val + ")");

  // Framework change detection: input + change events fired (recorded in event-log).
  const inputCount = await page.evaluate(`document.getElementById("event-log").dataset.input || "0"`);
  const changeCount = await page.evaluate(`document.getElementById("event-log").dataset.change || "0"`);
  check(parseInt(inputCount) >= 1, "fill dispatched input event (" + inputCount + ")");
  check(parseInt(changeCount) >= 1, "fill dispatched change event (" + changeCount + ")");
}

// ── test: page_text ────────────────────────────────────────────────────────
async function test_text(page: Page): Promise<void> {
  console.log("\n[test] page_text — password masking");
  await freshLoad(page);
  const resp = await invoke(page, "page_text", {});
  check(!resp.__error, "text returns without error");
  // The password field's real value "supersecret" must NOT appear.
  check(!resp.text.includes("supersecret"), "page_text masks password value");
  check(resp.text.includes("Test Fixture"), "page_text includes page heading");
}

/** Invoke an op that triggers the eval confirmation Toast, auto-approving it.
 * eval (and submit clicks) block on a Toast; this kicks off the invoke and
 * concurrently clicks Allow when the Toast appears. */
async function invokeWithEvalApproval(
  page: Page,
  op: string,
  args: any,
  timeoutMs = 8000
): Promise<any> {
  const clickP = invoke(page, op, args, timeoutMs);
  // Wait for the eval Toast to appear, then approve it.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 80));
    const has = await page.evaluate(
      `!!document.querySelector(".zcb-eval-card .zcb-toast-allow")`
    );
    if (has) {
      await clickToastButton(page, ".zcb-eval-card .zcb-toast-allow");
      break;
    }
  }
  return clickP;
}

// ── test: page_eval (masked) ───────────────────────────────────────────────
async function test_eval_masked(page: Page): Promise<void> {
  console.log("\n[test] page_eval — masked return (default)");
  await freshLoad(page, { evalMask: true });
  const resp = await invokeWithEvalApproval(page, "page_eval", {
    code: 'return localStorage.getItem("token");',
  });
  check(!resp.__evalError, "eval runs without JS error");
  check(typeof resp === "string", "eval returned a string");
  check(!resp.includes("eyJhbGciOiJI"), "masked: JWT prefix not in result");
  check(resp.includes("••••"), "masked: result contains mask marker");
}

// ── test: page_eval (unmasked) ─────────────────────────────────────────────
async function test_eval_unmasked(page: Page): Promise<void> {
  console.log("\n[test] page_eval — unmasked return (evalMask: false)");
  await freshLoad(page, { evalMask: false });
  const resp = await invokeWithEvalApproval(page, "page_eval", {
    code: "return 6 * 7;",
  });
  check(!resp.__evalError, "eval runs without JS error");
  check(resp === 42, "unmasked eval returns computed value 42 (got " + resp + ")");
}

// ── test: page_eval error + serialization ──────────────────────────────────
async function test_eval_error_and_serialize(page: Page): Promise<void> {
  console.log("\n[test] page_eval — error handling + serialization");
  await freshLoad(page, { evalMask: false });

  // Thrown error → structured __evalError, not a throw.
  const errResp = await invokeWithEvalApproval(page, "page_eval", {
    code: "throw new Error('boom');",
  });
  check(errResp.__evalError === true, "thrown error surfaces as __evalError");
  check(errResp.message === "boom", "error message preserved");

  // Circular reference → serialized as [Circular].
  const circResp = await invokeWithEvalApproval(page, "page_eval", {
    code: "var a = {x:1}; a.self = a; return a;",
  });
  check(circResp.self === "[Circular]", "circular ref serialized as [Circular]");

  // DOM element → short tag descriptor.
  const elResp = await invokeWithEvalApproval(page, "page_eval", {
    code: 'return document.getElementById("search");',
  });
  check(
    typeof elResp === "string" && elResp.includes("input"),
    "DOM element serialized as <input...> tag"
  );
}

// ── test: storage_get ──────────────────────────────────────────────────────
async function test_storage_get(page: Page): Promise<void> {
  console.log("\n[test] storage_get — localStorage read + masking");
  await freshLoad(page);

  // Single key with JWT — must be masked.
  const tokenResp = await invoke(page, "storage_get", { type: "local", key: "token" });
  check(tokenResp.found === true, "storage_get found token key");
  check(!tokenResp.value.includes("eyJhbGciOiJI"), "storage masks JWT value");
  check(tokenResp.value.includes("••••"), "masked value has marker");

  // Plain value — not masked (too short / no pattern).
  const plainResp = await invoke(page, "storage_get", { type: "local", key: "plain" });
  check(plainResp.value === "hello world", "plain value not masked");

  // Hex id — masked.
  const hexResp = await invoke(page, "storage_get", { type: "local", key: "hexid" });
  check(hexResp.value.includes("••••"), "long hex masked");

  // Missing key.
  const missingResp = await invoke(page, "storage_get", { key: "nonexistent" });
  check(missingResp.found === false, "missing key → found:false");

  // sessionStorage.
  const sessResp = await invoke(page, "storage_get", { type: "session", key: "stoken" });
  check(sessResp.found === true, "sessionStorage accessible");
}

// ── test: page_wait_for(nav) ───────────────────────────────────────────────
async function test_wait_for_nav(page: Page): Promise<void> {
  console.log("\n[test] page_wait_for — nav/load condition");
  await freshLoad(page);
  const resp = await invoke(page, "page_wait_for", { nav: true, timeoutMs: 1000 });
  check(!resp.__error, "nav wait returns without timeout");
  check(resp.nav === true, "nav wait result marks nav:true");
  check(resp.readyState === "complete", "nav wait sees complete readyState");
}

// ── test: high-risk Toast (page_click on submit) ──────────────────────────
async function test_high_risk_toast(page: Page): Promise<void> {
  console.log("\n[test] high-risk Toast — submit click prompts confirmation");
  await freshLoad(page);
  const snap = await invoke(page, "page_snapshot", {});
  const go = snap.nodes.find((n: any) => n.selector && n.selector.includes("#go"));
  check(go?.role === "button", "#go is the submit button");

  // Fire the click (will trigger Toast because it's type=submit). Don't await —
  // it blocks on Toast. Instead, kick it off, then approve via the Toast button.
  const clickP = invoke(page, "page_click", { ref: go.ref });

  // Wait for the Toast card to appear, then click Allow.
  await new Promise((r) => setTimeout(r, 200));
  const hasToast = await page.evaluate(`!!document.querySelector(".zcb-eval-card, .zcb-toast-card")`);
  check(hasToast, "high-risk click injected a Toast card");

  // Click Allow (the .zcb-toast-allow button inside any toast card).
  await clickToastButton(page, ".zcb-toast-card .zcb-toast-allow");
  const resp = await clickP;
  // #go has onclick counting via __clickCount.
  check(!resp.__error, "approved submit click proceeds: " + (resp.__error || "ok"));
  const count = await page.evaluate("window.__clickCount || 0");
  check(count >= 1, "approved submit click triggered onclick");
}

// ── test: ping ─────────────────────────────────────────────────────────────
async function test_ping(page: Page): Promise<void> {
  console.log("\n[test] ping op");
  await freshLoad(page);
  const resp = await invoke(page, "ping", {});
  check(resp.pong === true, "ping returns {pong:true}");
}

// ── test: shadow DOM (content-script limitation) ──────────────────────────
async function test_shadow_dom(page: Page): Promise<void> {
  console.log("\n[test] shadow DOM — snapshot does not cross shadow boundary");
  await freshLoad(page, { fixture: "shadow.html" });

  // Sanity: the fixture set up the shadow roots as expected.
  const openHasBtn = await page.evaluate(
    `!!window.__openRoot && !!window.__openRoot.querySelector("#shadow-btn")`
  );
  check(openHasBtn, "fixture: open shadow root has #shadow-btn");
  const closedHostShadow = await page.evaluate("window.__closedHostHasShadow");
  check(closedHostShadow === false, "fixture: closed shadow root unreachable via .shadowRoot");

  // snapshot must find the plain top-level button but NOT the shadow buttons.
  const resp = await invoke(page, "page_snapshot", {});
  check(!resp.__error, "snapshot runs without error");
  const plainFound = resp.nodes.some((n: any) => n.selector && n.selector.includes("#plain"));
  check(plainFound, "snapshot finds the plain (non-shadow) button");
  const shadowBtnFound = resp.nodes.some((n: any) => n.name === "In Open Shadow");
  check(!shadowBtnFound, "open shadow button NOT in snapshot (TreeWalker boundary)");
  const closedShadowBtnFound = resp.nodes.some((n: any) => n.name === "In Closed Shadow");
  check(!closedShadowBtnFound, "closed shadow button NOT in snapshot");

  // Clicking the plain button via its ref still works (content.js otherwise
  // functional on the top frame).
  const plainNode = resp.nodes.find((n: any) => n.selector && n.selector.includes("#plain"));
  const clickResp = await invoke(page, "page_click", { ref: plainNode.ref });
  check(!clickResp.__error, "click plain button via ref works");
}

// ── test: iframe (content-script top-frame-only limitation) ────────────────
async function test_iframe(page: Page): Promise<void> {
  console.log("\n[test] iframe — top-frame snapshot excludes iframe content");
  await freshLoad(page, { fixture: "iframe.html" });

  // Wait for the iframe to actually load.
  for (let i = 0; i < 20; i++) {
    const ready = await page.evaluate("window.__iframeReady === true");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const iframeReady = await page.evaluate("window.__iframeReady === true");
  check(iframeReady, "iframe finished loading");

  const resp = await invoke(page, "page_snapshot", {});
  check(!resp.__error, "snapshot runs without error");

  // Top-frame button IS in snapshot.
  const topFound = resp.nodes.some((n: any) => n.selector && n.selector.includes("#top-btn"));
  check(topFound, "snapshot finds top-frame #top-btn");

  // Iframe button is NOT in snapshot (content.js not injected into iframe).
  const iframeBtnFound = resp.nodes.some((n: any) => n.name === "In iframe");
  check(!iframeBtnFound, "iframe button NOT in top-frame snapshot (no all_frames)");

  // page_click targeting the iframe button via selector must fail (it's in a
  // different document; querySelector on the top document returns null).
  const badClick = await invoke(page, "page_click", { selector: "#iframe-btn" });
  check(!!badClick.__error, "click on iframe-resident selector fails as expected");
}

// ── test: dynamic insertion + re-snapshot ref stability ────────────────────
async function test_dynamic_reload_snapshot(page: Page): Promise<void> {
  console.log("\n[test] dynamic insertion — re-snapshot + ref stability");
  await freshLoad(page, { fixture: "dynamic.html" });

  // Snapshot #1: two interactive elements (button#btn-a + input#inp-a).
  const snap1 = await invoke(page, "page_snapshot", {});
  check(!snap1.__error, "snapshot #1 runs");
  const btnA1 = snap1.nodes.find((n: any) => n.selector && n.selector.includes("#btn-a"));
  const inpA1 = snap1.nodes.find((n: any) => n.selector && n.selector.includes("#inp-a"));
  check(!!btnA1 && !!inpA1, "snapshot #1 found #btn-a and #inp-a");
  const count1 = snap1.refCount;
  const btnARef = btnA1.ref;
  check(/^e\d+$/.test(btnARef), "snapshot #1 assigned an 'e' ref to #btn-a: " + btnARef);

  // Insert a new button dynamically.
  const added = await page.evaluate("window.__addButton()");
  check(added === true, "dynamic button inserted");

  // Snapshot #2: should now include the new button.
  const snap2 = await invoke(page, "page_snapshot", {});
  check(!snap2.__error, "snapshot #2 runs");
  const count2 = snap2.refCount;
  check(count2 === count1 + 1, "snapshot #2 refCount grew by 1 (" + count1 + "→" + count2 + ")");

  // CRITICAL: #btn-a's ref must be STABLE across snapshots (assignRef reuses
  // the data-zcb-ref attribute).
  const btnA2 = snap2.nodes.find((n: any) => n.selector && n.selector.includes("#btn-a"));
  check(
    !!btnA2 && btnA2.ref === btnARef,
    "#btn-a ref stable across snapshots (" + btnARef + " → " + btnA2?.ref + ")"
  );

  // The new button got a ref.
  const dynBtn = snap2.nodes.find((n: any) => n.selector && n.selector.includes("#dyn-btn"));
  check(!!dynBtn, "snapshot #2 includes the dynamically inserted #dyn-btn");

  // Both refs must still be clickable (refMap → DOM resolution).
  const before = await page.evaluate("window.__aClicks || 0");
  const clickA = await invoke(page, "page_click", { ref: btnARef });
  check(!clickA.__error, "click #btn-a via its (stable) ref works");
  const after = await page.evaluate("window.__aClicks || 0");
  check(after === before + 1, "stable-ref click actually fired onclick (" + before + "→" + after + ")");

  const beforeDyn = await page.evaluate("window.__dynClicks || 0");
  const clickDyn = await invoke(page, "page_click", { ref: dynBtn.ref });
  check(!clickDyn.__error, "click #dyn-btn via its new ref works");
  const afterDyn = await page.evaluate("window.__dynClicks || 0");
  check(afterDyn === beforeDyn + 1, "new-ref click actually fired onclick");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
