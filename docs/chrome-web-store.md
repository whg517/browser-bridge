# Publishing to the Chrome Web Store: Decision Checklist

> **Current state (2026-07-19): published and live.** For the decision record see
> [ADR-0019](./adr/0019-chrome-web-store-distribution.md); the store listing is
> [Browser Bridge](https://chromewebstore.google.com/detail/browser-bridge/dgccjfjjilfpkbdllclmkiicajndkfcd).
> The text below is kept as an archive of the original **decision checklist**; for the release method see "Manual release" at the end.

> This document is a **decision checklist**, not a statement that "we have decided to do it." Publishing removes the single largest current barrier to use (manually loading the
> unpacked extension), but it is a **product commitment**: a developer account, a privacy policy, review risk, plus a migration effort that affects the current "pinned extension ID" design.
> Whether to publish is an RFC/ADR-level decision under GOVERNANCE (it touches the distribution method and security boundaries); we recommend opening an issue/ADR to decide first,
> rather than going straight to a PR.

## ⚠️ The top pitfall: publishing changes the pinned extension ID

The entire install flow depends on a **fixed** ID — `mkjjlmjbcljpcfkfadfmhblmmddkdihf` (derived from
the `key` in [`extension/manifest.json`](../extension/manifest.json)).
[`install.sh`](../install/install.sh) / [`install.ps1`](../install/install.ps1)
write it into the native host manifest's `allowed_origins`.

**But on first upload the Chrome Web Store assigns an ID that the store controls, and the store ignores the `key` in the manifest.** As a result the published extension **almost certainly gets a different ID**, and Chrome will **reject the native messaging connection** because of an `allowed_origins`
mismatch — meaning even with the binary installed, the extension cannot connect.

**Mitigations that must be planned for:**

- After the first upload, take the store-assigned ID and add it to `allowed_origins` — ideally **trust both IDs at once**:
  the store ID (store users) + the current pinned ID (unpacked / developers).
- Update [`install.sh`](../install/install.sh)'s `PINNED_EXTENSION_ID`,
  [`install.ps1`](../install/install.ps1), and
  [`scripts/check-extension-id.mjs`](../scripts/check-extension-id.mjs) in sync so they trust both IDs.
- Optional: backfill the store listing's public key into the manifest `key` so that an unpacked load also gets the store ID — but this
  changes today's pinned ID, so weigh the trade-off.

## What it solves and what it does not

- ✅ **Removes "wall 1"**: no more developer-mode "Load unpacked" — one-click "Add to Chrome",
  it persists across Chrome restarts, and it is far friendlier for managed/enterprise Chrome.
- ❌ **Does not remove the installer**: the store only distributes the **extension**. Users still need to run `install.sh` / `install.ps1`
  to install the **native host binary + manifest**. So this "tears down one wall, not all of them."

## Prerequisites

- [ ] A Chrome Web Store **developer account** (a one-time **$5**; you must register it — I cannot create the account).
- [ ] A **privacy policy URL** (**required** for this project — the extension reads page content, cookies, and web storage).
      It can live under `docs/`.
- [ ] Store listing assets: 1–5 screenshots (1280×800 or 640×400), a 128px icon
      (already present at `extension/icons/icon128.png`), short + detailed descriptions, a category, and support/homepage URLs.

## Review-risk items specific to this extension

Google's review will focus on the following; prepare a written justification in advance:

- [ ] **`page_eval` (executing arbitrary JS)** — the highest rejection risk. Rationale: it is a developer tool that requires user confirmation
      on every call; consider **disabling it by default** in the store build.
- [ ] **`chrome.debugger`** (used by `page_snapshot_precise`) — a sensitive permission that needs explanation.
- [ ] **Broad host / optional permissions + native messaging** — explain the localhost-only,
      per-run secret bridge and the per-site approval model, and link to the [threat model](./security/threat-model.md).
- [ ] **Whether it "uses remote code"** — answer honestly: `page_eval` executes **user-provided** JS, not
      code fetched remotely; word the form precisely.

## Packaging and submission

- [x] Store zip: the **`browser-bridge-extension-<tag>-store.zip`** produced by the release pipeline (note the `-store`
      suffix) is already in the shape you can upload directly (`manifest.json` at the zip root, **with `key` removed**). The other
      `browser-bridge-extension-<tag>.zip` (**which keeps `key`**) is for developers using "Load unpacked" and
      **must not** be uploaded to the store.
- [ ] Confirm the `manifest.json` version matches Cargo (`scripts/check-version.sh` already enforces this).
- [x] The `key` field: **remove it** — the manifest of the published listing does **not contain `key`** (the store manages the signing key that derives the store ID);
      an update upload that carries `key` is rejected: "The value of the key field in the manifest does not match the current content" (see "Manual release").
- [ ] Upload, fill in the data-usage disclosure + privacy policy, and submit. Review is delayed **days to weeks**, and you **lose instant-update
      control** (every update goes through review).

## After publishing

- [ ] Wire the store ID into `allowed_origins` + both installers (see the top pitfall).
- [ ] Rewrite the README "Load the extension" → "Add from the Chrome Web Store", keeping unpacked as
      the developer/advanced path.
- [ ] Update `docs/`, and add an **ADR** recording the decision (per GOVERNANCE, the distribution method is a major change).
- [ ] Optional: automate the release with a CI step (something like `chrome-webstore-upload`), or keep it manual.

## Conclusion / recommendation

Publishing is the **single highest-payoff** usability improvement, but it is a product commitment: the $5 account, a privacy policy,
the review risk of `page_eval`/`chrome.debugger`, ongoing review delays, and the ID migration work above.
Because it touches the distribution method and security posture, under this project's [GOVERNANCE](../GOVERNANCE.md) it is an **RFC/ADR-level**
decision — we recommend opening an issue to discuss and decide first, then acting, rather than a quick PR.

## Manual release (no automation)

We evaluated CI auto-publishing via the CWS API, but issues like the maintenance cost of the OAuth refresh token and the fact that the `release: published`
trigger does not fire for releases created by `GITHUB_TOKEN` mean the payoff does not justify the complexity, so we **switched to manual upload**:

1. **Get the zip**: download **`browser-bridge-extension-<tag>-store.zip`** (with the `-store`
   suffix) from the release — it is already in the shape the store wants (`manifest.json` at the zip **root**, **with `key` removed**). You can also build it locally:
   ```sh
   cp -r extension/dist store-pkg
   node -e 'const fs=require("fs");const f="store-pkg/manifest.json";const m=JSON.parse(fs.readFileSync(f,"utf8"));delete m.key;fs.writeFileSync(f,JSON.stringify(m,null,2));'
   (cd store-pkg && zip -rX ../browser-bridge-extension-store.zip . -x ".*")
   ```
   ⚠️ **You must remove `key`** — the manifest of the published listing does **not contain `key`** (the store manages the signing key that derives the store ID);
   an update upload that carries `key` is rejected: "The value of the key field in the manifest does not match the current content." The zip without the `-store` suffix
   keeps `key` (for developers' "Load unpacked"), so **do not** upload it.
2. **Upload**: [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → Browser Bridge
   → **Package → Upload new package** → select that zip → **Submit for review**.
3. **Note**: the store rejects duplicate versions, so bump before publishing a new version (`scripts/check-version.sh` guarantees
   Cargo/manifest consistency); review takes days to weeks and cannot be skipped.

## See Also

- Decision record: [ADR-0019](./adr/0019-chrome-web-store-distribution.md).
- Security boundaries and threat model: [SECURITY.md](../SECURITY.md) ·
  [security/threat-model.md](./security/threat-model.md) ·
  [security/trust-boundaries.md](./security/trust-boundaries.md).
- Pinned ID and install artifacts: [architecture.md §4.3](./architecture.md#43-installation-artifacts).
- Release pipeline and extension zip: [release.md](./release.md).
