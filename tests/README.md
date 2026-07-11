# Tests

Three suites across **two languages**. The language split is deliberate, not
historical accident:

| Suite | File | Runtime | Why this language |
|-------|------|---------|-------------------|
| **Protocol** | `e2e.py` | `python3` (stdlib only) | Drives the real release binary as a subprocess and speaks the wire protocols (Native-Messaging framing, MCP JSON-RPC, the TCP bridge) *from the outside*. A second, independent implementation of the protocols — in a different language with no deps — is what makes it good at catching framing/encoding bugs the Rust code and its own types would miss. |
| **DOM** | `dom_test.ts` | `bun` + Chrome (CDP) | Injects the built `extension/dist/content.js` into a real headless Chrome page and exercises every content-script op (snapshot, click, fill, eval, storage, toast). Needs a real browser DOM; TypeScript shares the extension's toolchain. |
| **Smoke** | `ext_test.ts` | `bun` + puppeteer-core | Launches Chrome with `extension/dist/` loaded and checks the MV3 service worker boots with its APIs. |

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
(`npm --prefix ../extension run build`); `run_all.sh` / `just` / `make` do this
for you.

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

## Scope note

The smoke test cannot verify the native-messaging bridge end-to-end: Chrome
forbids `nativeMessaging` under automated `--load-extension` launches. Full
bridge verification is a manual step (see the repo README → Testing).
