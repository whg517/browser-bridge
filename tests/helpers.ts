/**
 * Shared harness bits for the browser test files (dom_test.ts, ext_test.ts,
 * integration_e2e.ts): assertion tallying, sleeping, path constants, and the
 * ONE copy of the isolated-browser safety guard.
 *
 * Must run under both bun (the Makefile suites) and node (integration_e2e.ts
 * documents a plain-node run), so no bun-only `import.meta.dir` here — the
 * repo root is resolved from this file's URL instead.
 */

import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

/** Repo root, resolved from this file's own location (tests/..). */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** file:// URL of a file in tests/fixtures/. */
export function fixtureUrl(name: string): string {
  return pathToFileURL(path.join(REPO, "tests", "fixtures", name)).href;
}

/**
 * The browser binary the tests drive. Defaults to the system Chrome — which
 * assertIsolatedBrowser then refuses — so the tests only ever run when
 * CHROME_BIN names an isolated Chrome for Testing / Chromium.
 */
export function resolveChromeBin(): string {
  return (
    process.env.CHROME_BIN ||
    (process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  );
}

/**
 * SAFETY (do not remove): the browser tests launch a NON-HEADLESS Chrome with
 * --load-extension. Pointed at your daily Google Chrome that can capture —
 * and on cleanup CLOSE — your real browser session. This actually happened:
 * on macOS, launching while Chrome is running forwards the flags to the
 * EXISTING instance, ignoring --user-data-dir. Refuse unless CHROME_BIN names
 * an isolated binary; see tests/README.md → Safety.
 */
export function assertIsolatedBrowser(bin: string): void {
  const isDailyMac = bin.includes("/Google Chrome.app/") && bin.endsWith("/Google Chrome");
  const isDailyWin = /\\Google\\Chrome\\Application\\chrome\.exe$/i.test(bin);
  if (!process.env.CHROME_BIN || isDailyMac || isDailyWin) {
    console.log(
      "SKIP: refusing to drive your daily Google Chrome — it can capture and\n" +
        "close your real session. Set CHROME_BIN to a Chrome for Testing /\n" +
        "Chromium binary (see tests/README.md → Safety) to run this test."
    );
    process.exit(0);
  }
}

let _pass = 0;
let _fail = 0;

/** Assert `cond`, recording the outcome under `label` (same style as e2e.py). */
export function check(cond: boolean, label: string): void {
  if (cond) {
    _pass++;
    console.log("  PASS  " + label);
  } else {
    _fail++;
    console.log("  FAIL  " + label);
  }
}

/** How many checks have failed so far (integration_e2e dumps logs on any). */
export function failedCount(): number {
  return _fail;
}

/** Print the tally and exit — non-zero when anything failed. `bar` is the
 * separator width, kept per-suite so each file's output stays as it was. */
export function finish(bar = 40): never {
  console.log(`\n${"=".repeat(bar)}\n${_pass} passed, ${_fail} failed`);
  process.exit(_fail > 0 ? 1 : 0);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
