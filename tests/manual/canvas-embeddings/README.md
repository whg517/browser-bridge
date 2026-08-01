# Manual QA — AI "Canvas" / preview readability across iframe embeddings

Regression runbook for **ADR-0022** (allFrames reading). Since **ADR-0024**
removed the per-site allowlist, sub-frames are read **unconditionally** — there
is no origin gate and no approval prompt; the extension holds `<all_urls>` at
install.

**Question under test:** can browser-bridge read + operate an *AI canvas* — an
interactive artifact an agent renders into the page (job preview, mini-app,
dashboard) — regardless of **how it's embedded**?

This stays a **manual** suite: the SW-side allFrames aggregation isn't reachable
by the headless `dom_test.ts` harness (which drives the content script in a
single document — see ADR-0022), so the end-to-end multi-frame behavior is
verified here.

## Layout

One identical "职位预览" artifact is rendered **six ways** so a single
`page_snapshot` shows exactly which embeddings the tools reach. Each copy carries
a unique label (`INLINE`, `SAMEORIGIN_SRC`, `SRCDOC`, `BLOB`, `CROSSORIGIN`,
`SANDBOX`) in its heading, `【CANVAS-BODY::<label>】` marker, button/input names,
and `mailto:hr-<label>@…` link.

| file | role |
|------|------|
| `index.html` | embeds the artifact all six ways |
| `artifact.html?label=…` | the artifact page (src / cross-origin / sandbox cases) |
| `card.js` | shared markup; also builds the srcdoc/blob documents |
| `serve.sh` | starts `:8000` (main) + `:8001` (cross-origin); Ctrl-C stops both |

## Run

```sh
cd tests/manual/canvas-embeddings
./serve.sh                      # :8000 + :8001, Ctrl-C to stop
```
Open **http://localhost:8000/index.html** in real Chrome with the extension
loaded (unpacked `extension/dist`, or the store build). Drive tools from your MCP
client, or headless from the repo root:
`./target/release/browser-bridge call page_snapshot`.

## Embeddings

| # | Label | Embedding | frame URL |
|---|-------|-----------|-----------|
| 1 | INLINE | rendered into the top DOM | (top) |
| 2 | SAMEORIGIN_SRC | `<iframe src=artifact.html?…>` | `…:8000/artifact.html` |
| 3 | SRCDOC | `iframe.srcdoc = …` | `about:srcdoc` |
| 4 | BLOB | `iframe.src = blob:…` | `blob:http://…:8000/…` |
| 5 | CROSSORIGIN | `<iframe src=http://…:8001/…>` | `…:8001/artifact.html` |
| 6 | SANDBOX | `sandbox="allow-scripts"` | `…:8000/artifact.html?…` |

## Expected (post ADR-0024 — no gate)

- `page_snapshot` → **18 refs**: all six embeddings ×3 controls, **including
  cross-origin `:8001`, `about:srcdoc`, and `blob:`** — read unconditionally, with
  **no approval prompt** and no "allow all sites" toggle.
- Opening a **brand-new arbitrary origin** (e.g. `https://example.com`) and
  calling any page op returns immediately — no per-site prompt.

> Historical note: before ADR-0024 this was gated (per-site allowlist; srcdoc/blob
> needed the ADR-0023 effective-origin gate; cross-origin needed its own grant).
> That machinery is gone — see ADR-0024.

## Checklist

- **A. snapshot** — `page_snapshot` → **18 refs**; every node's `frame` present
  (top + the five sub-frames incl. `about:srcdoc`, `blob:…`, `:8001`).
- **B. cross-frame click/fill** — an `f<N>:` ref inside the srcdoc/blob frame:
  `page_click {ref}` flips its button to `已投递 ✓ [<label>]`;
  `page_fill {ref,value}` sets its input. Confirms ref-routing spans frames.
- **C. text/links** — `page_text` shows every `【CANVAS-BODY::<label>】` under a
  `--- frame f<N> (url) ---` marker; `page_links` merges each `hr-<label>` mailto.
- **D. no approval / no gate** — a page op on a fresh origin returns immediately
  (no badge, no Allow prompt); the whole `:8001` cross-origin frame is present in
  the snapshot without any grant.
- **E. masking still on** — `storage_get`/`cookie_get`/`page_eval` results redact
  secret-shaped values (`••••[sensitive]`). Removing the allowlist did not touch
  masking or the per-tool disable.

## Gotchas

- Serve over **http**, not `file://` (same-origin iframes need a real origin).
- Page tools hit the **active tab of the last-focused window**; with multiple
  windows, `tab_focus {tabId}` the QA tab right before a call.
- `data:` iframes get an opaque origin and were never remapped; they still read
  via allFrames like any other frame now (no gate to skip them).

## Regression log

- **2026-08-01** — full live regression of the post-ADR-0024 build (main
  `feat!: remove the per-site allowlist`, manifest `host_permissions:["<all_urls>"]`),
  real Chrome via `browser-bridge call`. **16/16 tools green.**
  - Fresh origin `https://example.com` → `page_snapshot` returned with **zero
    approval prompt** (old build would time out on an Allow prompt).
  - Six-embedding page → **18 refs** (INLINE + SAMEORIGIN_SRC + SANDBOX + SRCDOC
    + BLOB + CROSSORIGIN `:8001`), all ungated.
  - Cross-frame `page_click`/`page_fill` into the `srcdoc` frame landed
    (`f<N>:` routing); `page_text` 6 markers / 5 frame sections; `page_links` 6
    mailto merged; `page_eval`, `page_scroll`, `page_wait_for` (5 iframes),
    `page_screenshot` (~260 KB PNG), `page_snapshot_precise` (CDP), `tab_*` all OK.
  - `storage_get` value masked `••••[sensitive]`; `cookie_get` returned structure
    (masking is selective — secret-shaped values only).

  > **Superseded the same day — "16/16 green" was too generous.** A second
  > sweep on the same build, this time asserting each result against the DOM
  > fixture rather than eyeballing the payload, found four defects the pass
  > above missed. Cross-frame reading really is solid; the tools *around* it
  > were not. See the entry below.

- **2026-08-01 (second sweep)** — same build, all 16 tools re-run against
  `tests/fixtures/page.html` plus the six-embedding page, every result checked
  against known-good expectations. **12/16 clean, 4 defects**, all fixed in
  `fix/frame-scoped-ops-and-masking`:
  - **`page_screenshot` dies on any page with ≥2 iframes.** Deterministic on one
    tab: screenshot-first succeeds (54 KB PNG), then one `page_snapshot` runs
    `injectAllFrames` and every later screenshot fails with `capture failed`.
    Root cause was `chrome.tabs.sendMessage` without a `frameId`, which
    broadcasts to every frame — N frames each called `captureVisibleTab` and
    blew past Chrome's 2/sec throttle. 1 iframe stayed under the limit, which is
    why the first sweep (`page_screenshot` before any read op) didn't see it.
  - **Same broadcast made `page_scroll` answer from a random frame** — a single
    `direction:bottom` on a ~2500 px page reported `scrollY: 61.5`, the scroll
    limit of a 300 px iframe, while `down` reported the top frame's 1001. It
    also scrolled the sub-frames. `page_eval` ran once per frame for the same
    reason.
  - **`page_snapshot_precise` returned `input#pw` as `supersecret`** while
    `page_snapshot` returned `••••••` — the precise path never had the password
    mask the other two snapshot paths carry.
  - **Masking never consulted key names**: `session_apikey` = `sk-proj-…` and a
    cookie named `csrftoken` both came back in cleartext, because only the value
    was pattern-matched.
  - Also: unknown `page_scroll` directions silently "succeeded"; unchecked
    checkboxes reported `value:"on"` with no `checked` field; cross-frame
    click/fill echoed the bare ref (`e2` for `f7:e2`); a missing required arg
    surfaced as `EXECUTION_FAILED` rather than `INVALID_ARGUMENT`.
  - **`page_eval` was blocked on every page tested** (localhost fixture and
    `https://example.com`, neither sending a CSP) by a globally-injected
    `script-src` without `'unsafe-eval'` — environment-specific to that Chrome
    profile. The product gap was that `new Function` has no fallback and the
    failure returned exit 0 with a soft error object; it now fails loudly and
    names CDP mode as the remedy.

- **2026-08-01 (acceptance of `fix/frame-scoped-ops-and-masking`)** — same
  method, same fixtures, asserting each result. **14/14 green**, plus all 16
  tools re-run clean:
  - `page_screenshot` now survives `injectAllFrames` on a 4-iframe page
    (before / after / again all return a PNG).
  - `direction:bottom` on the six-embedding page reports 1724 and re-reads
    identically, instead of a 300 px iframe's 61.5; `direction:"sideways"`
    exits 1; cross-frame reading still returns **18 refs**.
  - `page_click {f<N>:e2}` echoes `f<N>:e2`; `page_snapshot_precise` returns
    `••••••` for `input#pw`; an unchecked box reports `checked:false` with no
    `value`; `session_apikey` and cookies named `csrftoken` / `qa_session`
    return `••••[sensitive]` while `qa_plain` stays readable; a missing
    required arg returns `INVALID_ARGUMENT`.
  - `page_eval` under the injected CSP now exits 1 with the CDP-mode remedy
    (it returned exit 0 and a soft error object before).
  - **Mind which backend you are testing.** The first acceptance attempt ran
    with **CDP mode on**, so `page_screenshot` / `page_scroll` / `page_eval`
    went through `backends/cdp.ts` and proved nothing about the content-script
    fixes — and it surfaced a real gap: the CDP copy of `pageScroll` had the
    same missing `default` case, fixed here too. Probe the active backend by
    running any page op against a `chrome://` tab: CDP mode says "CDP mode
    cannot control this page", the content script says "Cannot access a
    chrome:// URL".
  - Serve fixtures with a cache-busting query (`?v=…`) after editing them —
    Chrome served a stale `page.html` and made a masking check look like a
    failure.
