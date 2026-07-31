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
