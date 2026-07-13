# Tests

Three suites across **two languages**. The language split is deliberate, not
historical accident:

| Suite | File | Runtime | Why this language |
|-------|------|---------|-------------------|
| **Protocol** | `e2e.py` | `python3` (stdlib only) | Drives the real release binary as a subprocess and speaks the wire protocols (Native-Messaging framing, MCP JSON-RPC, the TCP bridge) *from the outside*. A second, independent implementation of the protocols — in a different language with no deps — is what makes it good at catching framing/encoding bugs the Rust code and its own types would miss. |
| **DOM** | `dom_test.ts` | `bun` + Chrome (CDP) | Injects the built `extension/dist/content.js` into a real headless Chrome page and exercises every content-script op (snapshot, click, fill, eval, storage, toast). Needs a real browser DOM; TypeScript shares the extension's toolchain. |
| **Smoke** | `ext_test.ts` | `bun` + puppeteer-core | Launches Chrome with `extension/dist/` loaded and checks the MV3 service worker boots with its APIs. |
| **Integration** (opt-in) | `integration_e2e.ts` | `bun` or Node 22.12+ + puppeteer-core | The full real chain with nothing mocked — MCP client → real MCP server → native host → real extension → `chrome.tabs` → back. Closes the seam `e2e.py` mocks. |

The two browser suites are **TypeScript run under bun** (matching the
extension). The protocol suite stays **Python on purpose** — rewriting it in
TS/JS would remove the independent-implementation value and add nothing.

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
copy of the extension, registers a native-messaging host manifest (backing up
and restoring any existing one), and drives a `tab_list` call all the way to
`chrome.tabs.query` and back.

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

(Historical note: the smoke test's comment claimed Chrome *forbids*
`nativeMessaging` under automated launches — that was a misdiagnosis of a
puppeteer `worker.evaluate` quirk. This test demonstrates it works.)
