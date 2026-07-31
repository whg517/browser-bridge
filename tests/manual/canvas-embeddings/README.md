# Manual QA — AI "Canvas" / preview readability across iframe embeddings

Regression runbook for **ADR-0022** (allFrames reading) + **ADR-0023**
(effective-origin gating for inherited-origin sub-frames + permission-drift
recovery).

**Question under test:** can browser-bridge read + operate an *AI canvas* — an
interactive artifact an agent renders into the page (job preview, mini-app,
dashboard) — regardless of **how it's embedded**?

This is a **manual** suite: the SW-side allFrames aggregation isn't reachable by
the headless `dom_test.ts` harness (which drives the content script in a single
document — see ADR-0022), and the per-origin approval flow needs a real click.
The *pure* gate logic (`effectiveOriginGlob`) is covered by unit tests in
`extension/src/shared/allowlist.test.ts` and is CI-gated; this kit covers the
end-to-end multi-frame behavior those units can't.

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

## Embeddings (frame URL → how it's gated)

| # | Label | Embedding | frame URL | Effective origin |
|---|-------|-----------|-----------|------------------|
| 1 | INLINE | rendered into the top DOM | (top) | top |
| 2 | SAMEORIGIN_SRC | `<iframe src=artifact.html?…>` | `…:8000/artifact.html` | own (`:8000`) |
| 3 | SRCDOC | `iframe.srcdoc = …` | `about:srcdoc` | **top** (inherited) |
| 4 | BLOB | `iframe.src = blob:…` | `blob:http://…:8000/…` | **inner** (`:8000`) |
| 5 | CROSSORIGIN | `<iframe src=http://…:8001/…>` | `…:8001/artifact.html` | own (`:8001`) |
| 6 | SANDBOX | `sandbox="allow-scripts"` | `…:8000/artifact.html?…` | own (`:8000`) |

## Expected (post ADR-0023)

- **"allow all sites" ON** → all 6 read (**18 refs**); the gate is bypassed.
- **Per-site grant of `http://localhost:8000/*` only, all-sites OFF** →
  **15 refs**: INLINE + SAMEORIGIN_SRC + SANDBOX + **SRCDOC + BLOB**; CROSSORIGIN
  (`:8001`) skipped until its origin is granted too. This is the key regression —
  srcdoc/blob (the usual preview embeddings) read via the effective-origin gate.
- **Pre-fix baseline** (for reference) was **9 refs** — srcdoc/blob skipped
  (`about:srcdoc`→`about:///*`, `blob:`→`blob:///*` never matched).

## Checklist

- **A. snapshot** — `page_snapshot`: count refs + each node's `frame`.
  Per-site → 15 (srcdoc `about:srcdoc`, blob `blob:…` present; `:8001` absent).
- **B. cross-frame click/fill** — an `f<N>:` ref inside the srcdoc/blob frame:
  `page_click {ref}` flips its button to `已投递 ✓ [<label>]`;
  `page_fill {ref,value}` sets its input. Confirms ref-routing spans frames.
- **C. text/links** — `page_text` shows every `【CANVAS-BODY::<label>】` under a
  `--- frame f<N> (url) ---` marker; `page_links` merges each `hr-<label>` mailto.
- **D. permission-drift recovery (Fix B)** — allowlist an origin, then strip its
  host permission (disable "allow all sites"). The next call must **re-prompt**
  (badge `!` → Allow), not fail with `Cannot access`.
- **E. cross-origin gate** — `:8001` stays skipped until granted; grant it (or
  enable all-sites) → its `f<N>:` nodes appear.

## Gotchas

- Serve over **http**, not `file://` (same-origin iframes need a real origin).
- Page tools hit the **active tab of the last-focused window**; with multiple
  windows, `tab_focus {tabId}` the QA tab right before a call.
- The per-site Allow prompt blocks ~60s — click the toolbar icon → Allow → accept
  Chrome's native dialog within the window.
- `data:` iframes are intentionally NOT remapped (opaque origin); add one if you
  want to confirm it stays skipped.
