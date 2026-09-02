/**
 * Real end-to-end integration test — the seam e2e.py deliberately mocks.
 *
 * Exercises the FULL chain with nothing stubbed: MCP client (this) -> real MCP
 * server (release binary) -> localhost TCP bridge -> real native host (release
 * binary, spawned by Chrome) -> real extension (background.js) ->
 * chrome.tabs.query -> back. If tab_list returns the isolated profile's own
 * fixture tab, the whole native-messaging path e2e.py can't reach is proven.
 *
 * Isolation matters: a raw Chrome launch merges into an already-running Chrome
 * (and would query your real session). puppeteer launches a truly isolated
 * instance. If the manifest has a pinned public key, the test derives the
 * pinned extension id; otherwise it derives the id from the throwaway path.
 *
 * The host manifest is registered INSIDE the throwaway user-data-dir, because
 * that is where Chrome actually looks (see the write site for why this is
 * load-bearing, not a detail). On macOS/Linux that means the test touches
 * nothing of yours; only Windows, whose registration is a global registry key,
 * needs a backup/restore.
 *
 * The whole chain runs on a PRIVATE BB_LOCK_DIR bridge, so the test can neither
 * supplant (kill) an MCP server you have running nor be answered by your daily
 * browser — the same treatment e2e.py gives every binary it spawns. This needs
 * the wrapper trick described at the hostPath write site: the native host is
 * spawned by Chrome, so it does not inherit this test's environment.
 *
 * OPT-IN, macOS/Windows/Linux + Chrome for Testing (or Chromium). Pops a
 * non-headless window, so Linux needs a display (WSLg counts). Not part of the
 * default suite or CI.
 *
 * Run:  BB_REAL_E2E=1 node tests/integration_e2e.ts
 */
import puppeteer from "puppeteer-core";
import { execFileSync, spawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createInterface } from "readline";
import {
  REPO,
  assertIsolatedBrowser,
  check,
  failedCount,
  finish,
  fixtureUrl,
  resolveChromeBin,
  sleep,
} from "./helpers";

const IS_WINDOWS = process.platform === "win32";
const BIN = path.join(REPO, "target", "release", "browser-bridge" + (IS_WINDOWS ? ".exe" : ""));
const DIST = path.join(REPO, "extension", "dist");
const CHROME = resolveChromeBin();
const HOST_NAME = "com.browser_bridge.host";
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;

/** Where the server writes run.lock, mirroring `LockFile::path()` in src/ipc.rs.
 *
 *  The BB_LOCK_DIR override is checked first, exactly as the Rust side does —
 *  this test always runs the bridge on a private lock dir (see main), so that
 *  is the branch that matters here.
 *
 *  Linux follows XDG (ADR-0016) rather than the macOS location, and the fallback
 *  order matters: a WSL or container session often has no XDG_RUNTIME_DIR, and
 *  guessing the wrong directory here makes the test report "the MCP server never
 *  wrote a lock file" for a server that started perfectly well. */
function lockPath(): string {
  if (process.env.BB_LOCK_DIR) {
    return path.join(process.env.BB_LOCK_DIR, "browser-bridge", "run.lock");
  }
  if (IS_WINDOWS) {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"),
      "browser-bridge/run.lock"
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/browser-bridge/run.lock");
  }
  const dir =
    (process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, "browser-bridge")) ||
    (process.env.XDG_CACHE_HOME && path.join(process.env.XDG_CACHE_HOME, "browser-bridge")) ||
    path.join(os.homedir(), ".cache/browser-bridge");
  return path.join(dir, "run.lock");
}
const FIXTURE = fixtureUrl("page.html");

// ── preflight (opt-in) ─────────────────────────────────────────────────────
if (process.env.BB_REAL_E2E !== "1") {
  console.log("SKIP: set BB_REAL_E2E=1 to run the real Chrome integration test.");
  process.exit(0);
}
if (process.platform !== "darwin" && !IS_WINDOWS && process.platform !== "linux") {
  console.log(`SKIP: real integration test does not support ${process.platform}.`);
  process.exit(0);
}
// SAFETY (do not remove): this launches a NON-HEADLESS Chrome with
// --load-extension. Driving your daily Google Chrome can capture and then CLOSE
// your real browser session. Require an ISOLATED Chrome for Testing / Chromium
// binary via CHROME_BIN — never the everyday browser.
assertIsolatedBrowser(CHROME);
for (const [label, p] of [
  ["release binary", BIN],
  ["extension dist", DIST],
  ["Chrome", CHROME],
] as const) {
  if (!fs.existsSync(p)) {
    console.log(`SKIP: missing ${label}: ${p}`);
    process.exit(0);
  }
}

/** Chrome derives an extension id from its public key when pinned, or from the
 * unpacked extension's absolute path otherwise. */
function extIdFromPath(p: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(p, "manifest.json"), "utf8"));
  if (typeof manifest.key === "string") {
    const h = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
    return [...h.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  }
  const h = createHash("sha256").update(p).digest("hex");
  return [...h.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function readWindowsRegistration(): string | null {
  try {
    const out = execFileSync("reg.exe", ["query", REG_KEY, "/ve"], { encoding: "utf8" });
    return out.match(/REG_SZ\s+(.+)\r?$/m)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function writeWindowsRegistration(manifestPath: string): void {
  execFileSync("reg.exe", ["add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
    stdio: "ignore",
  });
}

function removeWindowsRegistration(): void {
  try {
    execFileSync("reg.exe", ["delete", REG_KEY, "/f"], { stdio: "ignore" });
  } catch {}
}

async function main(): Promise<void> {
  // Use a throwaway copy/profile so the test never operates on the real session.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-e2e-"));
  fs.cpSync(DIST, path.join(work, "ext"), { recursive: true });
  const extDir = fs.realpathSync(path.join(work, "ext"));
  const extId = extIdFromPath(extDir);
  console.log("[e2e] extension id:", extId);

  let hostPath = BIN;
  // Run everything on a PRIVATE bridge: lock file, both spawned servers, and
  // the native host all live under this dir, so the test can neither supplant
  // (kill) an MCP server the developer has running nor be answered by their
  // daily browser — the two ways sharing the default lock used to bite (#151).
  // e2e.py gives every binary it spawns the same override.
  const lockDir = path.join(work, "lock");
  process.env.BB_LOCK_DIR = lockDir;
  const LOCK = lockPath();

  // The native host is spawned BY CHROME from the manifest, so it does NOT
  // inherit this test's environment — pinning BB_LOCK_DIR only on the servers
  // would leave the host looking for (and finding!) the default bridge. The
  // manifest therefore points at a wrapper that sets it before exec'ing the
  // binary, the same shape install.sh writes.
  if (IS_WINDOWS) {
    const wrapper = path.join(work, "run-host.bat");
    fs.writeFileSync(
      wrapper,
      `@echo off\r\nset "BB_LOCK_DIR=${lockDir}"\r\n"${BIN}" --native-host\r\n`
    );
    hostPath = wrapper;
  } else {
    const wrapper = path.join(work, "run-host.sh");
    fs.writeFileSync(wrapper, `#!/bin/sh\nBB_LOCK_DIR="${lockDir}" exec "${BIN}" --native-host\n`);
    fs.chmodSync(wrapper, 0o755);
    hostPath = wrapper;
  }

  // Windows resolves native-messaging hosts through a GLOBAL registry key, so any
  // real registration has to be saved and put back. On macOS nothing outside the
  // throwaway profile is touched at all — see the manifest write below.
  let backup: string | null = null;
  if (IS_WINDOWS) {
    backup = readWindowsRegistration();
  }
  try {
    fs.rmSync(LOCK);
  } catch {}

  const mcp = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
  let connected = false;
  // Keep the whole log: the extension's announce (ADR-0027) is only observable
  // here, because the server absorbs that frame instead of routing it anywhere a
  // client could see. This is also the ONLY place the announce can be verified
  // at all — tests/e2e.py drives a mock extension, so it proves the server's
  // half but never that the real background.js actually sends the frame.
  let stderrLog = "";
  mcp.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrLog += text;
    if (text.includes("native host connected and authenticated")) {
      connected = true;
    }
  });
  /** Wait until the accumulated server log matches, or give up. */
  async function waitForLog(re: RegExp, ms = 10_000): Promise<boolean> {
    for (let i = 0; i < ms / 100; i++) {
      if (re.test(stderrLog)) return true;
      await sleep(100);
    }
    return false;
  }

  const outputLines = createInterface({ input: mcp.stdout });
  const queuedLines: string[] = [];
  const lineWaiters: Array<(line: string) => void> = [];
  outputLines.on("line", (line) => {
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line);
    else queuedLines.push(line);
  });
  async function recv(): Promise<any> {
    const line = queuedLines.shift() || (await new Promise<string>((resolve) => lineWaiters.push(resolve)));
    return JSON.parse(line);
  }
  function send(obj: unknown): void {
    mcp.stdin.write(JSON.stringify(obj) + "\n");
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bb-e2e-profile-"));
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  const swLog: string[] = [];
  let registeredAt: string | null = null;
  let supplanter: ReturnType<typeof spawn> | null = null;
  try {
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(LOCK)) break;
      await sleep(50);
    }
    check(fs.existsSync(LOCK), "MCP server wrote the lock file");

    // Host manifest authorizes ONLY our throwaway extension id. Written before
    // launch so connectNative succeeds on the first try.
    //
    // On macOS/Linux the user-level manifest directory is resolved RELATIVE TO
    // THE USER-DATA-DIR, not from a fixed per-brand path. The conventional
    // `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` only
    // works because that IS the daily browser's default user-data-dir — under
    // `--user-data-dir=<throwaway>` Chrome looks inside the throwaway instead.
    //
    // This is load-bearing for the test's premise. Registering at the
    // conventional path while launching Chrome for Testing means the isolated
    // browser reports "Specified native messaging host not found" and never
    // connects — while the DAILY browser, which does read that path, connects to
    // this test's server and answers the assertions. The suite then reports a
    // passing "real extension connected" produced by the very browser it exists
    // to stay away from. (Symptom: the fixture-tab hermeticity check fails while
    // everything else passes.)
    //
    // Writing into the profile also means this test touches nothing of the
    // user's on macOS/Linux: no backup, and nothing left behind if it is killed.
    const nmDir = path.join(profile, "NativeMessagingHosts");
    const testManifest = IS_WINDOWS
      ? path.join(work, HOST_NAME + ".json")
      : path.join(nmDir, HOST_NAME + ".json");
    if (!IS_WINDOWS) fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(
      testManifest,
      JSON.stringify({
        name: HOST_NAME,
        description: "browser-bridge integration test",
        path: hostPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extId}/`],
      })
    );
    registeredAt = testManifest;
    if (IS_WINDOWS) writeWindowsRegistration(testManifest);

    // puppeteer launches a TRULY isolated instance (unlike a raw subprocess).
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: false,
      dumpio: process.env.BB_REAL_E2E_DEBUG === "1",
      userDataDir: profile,
      ignoreDefaultArgs: [
        "--disable-extensions",
        "--enable-automation",
        "--disable-component-extensions-with-background-pages",
      ],
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      defaultViewport: null,
    });
    // The extension's own console is the only place a failed connectNative is
    // explained (a refused native host is silent on the server side — it never
    // hears from anyone). Capture it before anything else can happen.
    browser.on("targetcreated", async (t) => {
      if (t.type() !== "service_worker") return;
      const w = await t.worker().catch(() => null);
      w?.on("console", (m) => swLog.push(`[sw] ${m.type()}: ${m.text()}`));
    });

    const page = await browser.newPage();
    await page.goto(FIXTURE).catch(() => {});
    await sleep(1000);

    const expectedWorkerUrl = `chrome-extension://${extId}/background.js`;
    const extensionLoaded = browser.targets().some((target) => target.url() === expectedWorkerUrl);
    if (!extensionLoaded) {
      throw new Error(
        `test extension did not load (expected ${expectedWorkerUrl}). ` +
          "Official Google Chrome 137+ ignores --load-extension; point CHROME_BIN " +
          "to Chrome for Testing or Chromium."
      );
    }

    if (process.env.BB_REAL_E2E_DEBUG === "1") {
      console.log(
        "[e2e] Chrome targets:",
        browser.targets().map((target) => `${target.type()} ${target.url()}`)
      );
    }

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    await recv();
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    for (let i = 0; i < 300; i++) {
      if (connected) break;
      await sleep(100);
    }
    check(connected, "real extension connected via native host to the MCP server");

    // ── the version announce (ADR-0027) ──────────────────────────────────────
    // The real background.js must post its announce frame on connect, and the
    // server must absorb and record it. e2e.py can only prove the receiving half
    // (its extension is a mock that sends whatever the test tells it to); this is
    // where the sending half — and the whole native-messaging path it travels —
    // is actually exercised.
    const announced = await waitForLog(/generation \d+: extension v/);
    check(announced, "real extension announced its version on connect");
    const announce = /generation \d+: (extension v[^\n]*)/.exec(stderrLog)?.[1] || "";
    if (announced) console.log(`        announced: ${announce}`);
    // The manifest version, the protocol integer from contracts/protocol-version.json,
    // and a browser identified from the user agent must all have survived the trip.
    const manifestVersion = JSON.parse(
      fs.readFileSync(path.join(DIST, "manifest.json"), "utf8")
    ).version;
    check(
      announce.includes(`extension v${manifestVersion}`),
      `announced version matches the loaded manifest (${manifestVersion})`
    );
    check(announce.includes("protocol 1"), "announced the contract's protocol version");
    check(
      /Chrome(?: for Testing)? \d+\.\d+/.test(announce) || /Chromium \d+/.test(announce),
      "announced a real browser name + version parsed from the user agent"
    );

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tab_list", arguments: {} },
    });
    const r = await recv();
    if (r.result?.isError === true) {
      check(false, `tab_list failed: ${r.result.content?.[0]?.text || "unknown error"}`);
      throw new Error("tab_list failed through the real native-messaging chain");
    }
    const tabs = JSON.parse(r.result.content[0].text);
    // The real proof: structured chrome.tabs data crossed the entire chain.
    const first = Array.isArray(tabs) && tabs.length >= 1 ? tabs[0] : undefined;
    check(
      !!first && typeof first.id === "number" && typeof first.url === "string",
      "tab_list returned structured real chrome.tabs data (full round-trip works)"
    );
    check(r.result.isError === false, "tool call not an error");

    // Both halves are built from this repo, so both report the 0.0.0 placeholder
    // (ADR-0026) and the drift policy is deliberately silent. Proving the quiet
    // case in a real browser matters as much as the loud one: an advisory bolted
    // onto every result of every local dev session would be pure noise.
    check(
      r.result.content.length === 1,
      "no drift advisory when both sides are the 0.0.0 local build"
    );

    // Bonus hermeticity check: only holds when this launch is truly isolated.
    // If your normal Chrome is running, it captures --load-extension and the
    // extension answers from THAT session instead of our throwaway profile.
    const hermetic = tabs.some((t: { url?: string }) => (t.url || "").includes("page.html"));
    if (hermetic) {
      check(true, "isolated: our fixture tab present (fully hermetic)");
    } else {
      console.log(
        "  NOTE: fixture tab not seen — a running Chrome captured the extension\n" +
          "        load, so tab_list reflected that session. The round-trip above is\n" +
          "        still real. For full isolation, quit Chrome or point CHROME_BIN at a\n" +
          "        separate Chromium/Canary before running."
      );
    }

    // ── the announce survives a reconnect ────────────────────────────────────
    // MV3 recycles the service worker every ~5 min, so the announce must be sent
    // on EVERY connect, not once per install — otherwise the server forgets which
    // extension it is talking to after the first recycle and silently stops
    // reporting drift. Reloading the extension is the deterministic way to force
    // that path: it tears the worker down and re-runs background.js top level,
    // which is the same connectNative() a natural recycle calls. (It is a
    // superset of a recycle, not a simulation of one — a real idle recycle is not
    // triggerable on demand.)
    // Starting a second server supplants the first (it kills the prior pid and
    // takes the lock), so Chrome's host process dies and the extension's
    // reconnect loop attaches to the NEW server — the same path a service-worker
    // recycle takes, but triggerable on demand. `chrome.runtime.reload()` is not
    // a usable trigger here: MV3 starts a worker lazily, so a reloaded extension
    // with nothing to wake it simply stays dormant and never reconnects.
    //
    // A fresh server has an empty peer record, so if the announce were sent only
    // once per install it would never learn this extension's version and would
    // silently stop reporting drift for the rest of the session.
    const mcp2 = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    supplanter = mcp2;
    let stderr2 = "";
    mcp2.stderr.on("data", (chunk: Buffer) => {
      stderr2 += chunk.toString("utf8");
    });
    let reannounced = false;
    for (let i = 0; i < 300; i++) {
      if (/generation \d+: extension v/.test(stderr2)) {
        reannounced = true;
        break;
      }
      await sleep(100);
    }
    check(reannounced, "extension re-announces to a freshly started server (reconnect path)");
    if (!reannounced) console.log("\n── supplanting server log ──\n" + (stderr2 || "(empty)"));
  } finally {
    if (browser) await browser.close().catch(() => {});
    mcp.kill();
    supplanter?.kill();
    if (IS_WINDOWS) {
      removeWindowsRegistration();
      if (backup) writeWindowsRegistration(backup);
    }
    // On macOS/Linux the registration lives inside `profile`, so removing the
    // throwaway dirs below is the whole cleanup — nothing of the user's was
    // touched, and a hard kill leaves no broken registration behind.
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
    // The server's log is the only window into the connection and announce
    // handshake; without it a failure here is unactionable, since the browser and
    // its profile are gone by the time anything is printed.
    if (failedCount() > 0 || process.env.BB_REAL_E2E_DEBUG === "1") {
      console.log(`\n── host manifest registered at ──\n${registeredAt || "(never written)"}`);
      console.log("\n── MCP server log ──\n" + (stderrLog || "(empty)"));
      console.log("\n── extension service-worker log ──\n" + (swLog.join("\n") || "(empty)"));
    }
  }

  finish();
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
