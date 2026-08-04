# Tests

Three suites across **two languages**. The language split is deliberate, not
historical accident:

| Suite | File | Runtime | Why this language |
|-------|------|---------|-------------------|
| **Protocol** | `e2e.py` | `python3` (stdlib only) | Drives the real release binary as a subprocess and speaks the wire protocols (Native-Messaging framing, MCP JSON-RPC, the TCP bridge) *from the outside*. A second, independent implementation of the protocols — in a different language with no deps — is what makes it good at catching framing/encoding bugs the Rust code and its own types would miss. |
| **DOM** | `dom_test.ts` | `bun` + Chrome (CDP) | Injects the built `extension/dist/content.js` into a real headless Chrome page and exercises every content-script op (snapshot, click, fill, eval, storage, toast). Needs a real browser DOM; TypeScript shares the extension's toolchain. |
| **Smoke** | `ext_test.ts` | `bun` + puppeteer-core | Launches Chrome with `extension/dist/` loaded and checks the MV3 service worker boots with its APIs. |
| **Integration** (opt-in) | `integration_e2e.ts` | `bun` or Node 22.12+ + puppeteer-core | The full real chain with nothing mocked — MCP client → real MCP server → native host → real extension → `chrome.tabs` → back. Closes the seam `e2e.py` mocks. |
| **Manual** | [`manual/canvas-embeddings/`](./manual/canvas-embeddings/README.md) | real Chrome + a human | Cross-frame allFrames reading across six iframe embeddings (inline / same-origin src / srcdoc / blob / cross-origin / sandbox). Not automatable here — the SW-side allFrames aggregation is out of `dom_test.ts`'s reach (ADR-0022) and the per-origin Allow needs a real click. Backs the `effectiveOriginGlob` units (ADR-0023). |

The two browser suites are **TypeScript run under bun** (matching the
extension). The protocol suite stays **Python on purpose** — rewriting it in
TS/JS would remove the independent-implementation value and add nothing.

## ⚠ Safety — never point browser tests at your daily Chrome

The smoke and integration tests launch a **non-headless Chrome with
`--load-extension`**. Driving your everyday Google Chrome this way can **capture
and then close your real browser session** (all tabs/windows) on cleanup. So:

- Browser tests require **`CHROME_BIN` set to an isolated browser** — a
  [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing) or
  Chromium binary that is **not** your daily browser.
- If `CHROME_BIN` is unset (or points at the standard `Google Chrome.app` /
  `chrome.exe`), the tests and `run_all.sh` **skip** instead of running — they
  will not touch your daily Chrome.
- The tests only ever terminate the browser instance they launched — never a
  broad/pattern process kill.

```sh
export CHROME_BIN="/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
```

If you don't have one, fetch a Chrome for Testing build into a cache **outside
the repo** (`@puppeteer/browsers` defaults to the working directory, which would
drop ~370 MB into the working tree):

```sh
npx @puppeteer/browsers install chrome@stable --path "$HOME/.cache/chrome-for-testing"
```

## Running

```sh
# Everything (builds the binary + extension first; skips browser tests if
# bun/Chrome are missing). This is what CI runs.
bash run_all.sh
CHROME_BIN="/path/to/chrome" bash run_all.sh   # override Chrome location

# Individually:
python3 e2e.py                 # protocol — no browser needed
npm run test:dom               # DOM     — bun + Chrome
npm run test:smoke             # smoke   — bun + Chrome (BB_EXT_DIR overrides the loaded dir)
```

The browser suites read the **built** bundle, so build the extension first
(`npm --prefix ../extension run build`); `run_all.sh` and `make` do this for you.

## Types

The `.ts` suites are type-checked (`bun`, `chrome`, and DOM types):

```sh
npm install        # puppeteer-core + type packages
npm run typecheck  # tsc --noEmit (CI gates this)
```

## Fixtures

`fixtures/*.html` are static pages the DOM suite navigates to (plain DOM,
shadow DOM, iframes, dynamic insertion) — see `dom_test.ts` for what each
exercises.

## Real integration test (opt-in)

`integration_e2e.ts` closes the one seam the others can't: the **real** MCP
server ↔ **real** extension round-trip over native messaging. It spawns the
release binary as the MCP server, launches Chrome (puppeteer) with a unique
copy of the extension, registers a native-messaging host manifest, and drives a
`tab_list` call all the way to `chrome.tabs.query` and back. It also asserts the
extension's **version announce** ([ADR-0027](../docs/adr/0027-version-announce-and-drift-advisory.md)) —
the only place that can be verified, since `e2e.py`'s extension is a mock.

```sh
BB_REAL_E2E=1 bun integration_e2e.ts     # macOS/Linux shell
$env:BB_REAL_E2E='1'; node integration_e2e.ts  # Windows PowerShell, Node 22.12+
```

- **Opt-in** (skips unless `BB_REAL_E2E=1`), macOS/Windows, and pops a
  non-headless window. Not in the default suite or CI. Use Chrome for Testing
  or Chromium: official Google Chrome 137+ ignores `--load-extension`.
- It always proves the round-trip (native host connects, `tab_list` returns
  real structured `chrome.tabs` data). One **extra** assertion — that the
  reply came from *our* throwaway profile — only holds when the launch is
  isolated. Set `CHROME_BIN` to the Chrome for Testing/Chromium executable.
- **Where the host manifest goes.** On macOS/Linux Chrome resolves user-level
  native-messaging manifests **relative to the user-data-dir**, not from a fixed
  per-brand path. `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`
  only works for the daily browser because that *is* its default user-data-dir;
  under `--user-data-dir=<throwaway>` Chrome looks inside the throwaway. The test
  therefore registers inside its own profile — which also means it touches
  nothing of yours (only Windows, a global registry key, needs backup/restore).
  Registering at the conventional path instead is worse than a no-op: the
  isolated browser reports `Specified native messaging host not found` and never
  connects, while your **daily** browser does read that path, connects to the
  test's server, and answers the assertions — a green "real extension connected"
  produced by the one browser this test exists to avoid. The tell is the
  fixture-tab hermeticity check failing while everything else passes.
- On failure (or with `BB_REAL_E2E_DEBUG=1`) it prints the MCP server log and the
  extension's service-worker console — a refused `connectNative` is invisible
  server-side, so without the latter such a failure is unactionable.

(Historical note: the smoke test's comment claimed Chrome *forbids*
`nativeMessaging` under automated launches — that was a misdiagnosis of a
puppeteer `worker.evaluate` quirk. This test demonstrates it works.)
