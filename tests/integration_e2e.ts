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
 * OPT-IN, macOS/Windows + Chrome for Testing (or Chromium). Pops a non-headless
 * window and temporarily registers a native-messaging host manifest (backing
 * up/restoring any existing registration). Not part of the default suite or CI.
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
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const IS_WINDOWS = process.platform === "win32";
const BIN = path.join(REPO, "target", "release", "browser-bridge" + (IS_WINDOWS ? ".exe" : ""));
const DIST = path.join(REPO, "extension", "dist");
const CHROME =
  process.env.CHROME_BIN ||
  (IS_WINDOWS
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const NM_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Google/Chrome/NativeMessagingHosts"
);
const HOST_NAME = "com.browser_bridge.host";
const MANIFEST = path.join(NM_DIR, HOST_NAME + ".json");
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const LOCK = IS_WINDOWS
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "browser-bridge/run.lock")
  : path.join(os.homedir(), "Library/Application Support/browser-bridge/run.lock");
const FIXTURE = pathToFileURL(path.join(REPO, "tests", "fixtures", "page.html")).href;

// ── preflight (opt-in) ─────────────────────────────────────────────────────
if (process.env.BB_REAL_E2E !== "1") {
  console.log("SKIP: set BB_REAL_E2E=1 to run the real Chrome integration test.");
  process.exit(0);
}
if (process.platform !== "darwin" && !IS_WINDOWS) {
  console.log("SKIP: real integration test supports macOS and Windows only.");
  process.exit(0);
}
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  if (!IS_WINDOWS) {
    const wrapper = path.join(work, "run-host.sh");
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${BIN}" --native-host\n`);
    fs.chmodSync(wrapper, 0o755);
    hostPath = wrapper;
  }

  // Back up any existing host registration so a real install is untouched.
  let backup: string | null = null;
  if (IS_WINDOWS) {
    backup = readWindowsRegistration();
  } else if (fs.existsSync(MANIFEST)) {
    backup = MANIFEST + ".bb-e2e-backup";
    fs.renameSync(MANIFEST, backup);
  }
  try {
    fs.rmSync(LOCK);
  } catch {}

  const mcp = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
  let connected = false;
  mcp.stderr.on("data", (chunk: Buffer) => {
    if (chunk.toString("utf8").includes("native host connected and authenticated")) {
      connected = true;
    }
  });

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
  try {
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(LOCK)) break;
      await sleep(50);
    }
    check(fs.existsSync(LOCK), "MCP server wrote the lock file");

    // Host manifest authorizes ONLY our throwaway extension id. Written before
    // launch so connectNative succeeds on the first try.
    const testManifest = IS_WINDOWS ? path.join(work, HOST_NAME + ".json") : MANIFEST;
    if (!IS_WINDOWS) fs.mkdirSync(NM_DIR, { recursive: true });
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
  } finally {
    if (browser) await browser.close().catch(() => {});
    mcp.kill();
    if (IS_WINDOWS) {
      removeWindowsRegistration();
      if (backup) writeWindowsRegistration(backup);
    } else {
      try {
        fs.rmSync(MANIFEST);
      } catch {}
      if (backup) fs.renameSync(backup, MANIFEST);
    }
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }

  console.log(`\n${"=".repeat(40)}\n${_pass} passed, ${_fail} failed`);
  process.exit(_fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
