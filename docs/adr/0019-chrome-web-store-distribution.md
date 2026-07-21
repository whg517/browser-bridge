# ADR-0019: Distributing the Extension via the Chrome Web Store (Dual ID)

- **Status**: Accepted
- **Date**: 2026-07-19

## Context

Until now, the only way to install the extension was "Load unpacked" — users had to enable
developer mode in `chrome://extensions` and manually select `extension/dist/`. This was the
biggest barrier to use: developer mode is unfamiliar to ordinary users, is often disabled on
managed/enterprise Chrome, and may re-prompt after a restart.

The entire installation path depends on a **pinned extension ID** `mkjjlmjbcljpcfkfadfmhblmmddkdihf`
(derived from the `key` in [`extension/manifest.json`](../../extension/manifest.json)), which the
installer writes into the native messaging host's `allowed_origins`.

**However, when the extension is published to the Chrome Web Store it is assigned an ID controlled
by the store** (ignoring the manifest's `key`). The one this project received is
`dgccjfjjilfpkbdllclmkiicajndkfcd` — different from the pinned ID. If the host trusts only one of
them, the other installation path gets rejected by Chrome at `connectNative`, and the extension will
install but fail to connect.

Publishing to the store is a change to **the distribution method and security boundary**, and per
[GOVERNANCE](../../GOVERNANCE.md) it is an ADR-level decision.

## Decision

**Publish to the Chrome Web Store as the recommended installation method; keep unpacked as the
developer path.**

1. **Dual-ID trust (core)**: the native host's `allowed_origins` **trusts both** the store ID and
   the pinned ID **by default**, so either installation path can connect. `install.sh` /
   `install.ps1` write both origins by default; `--extension-id` / `-ExtensionId` can narrow this to
   a single one. The three copies of the ID (the two installers plus
   [`extension-id.ts`](../../extension/src/shared/extension-id.ts)) are kept consistent by the CI gate
   [`scripts/check-extension-id.mjs`](../../scripts/check-extension-id.mjs), which also verifies that
   the store ID ≠ the pinned (key-derived) ID.

2. **The store upload package drops the `key`**: the manifest of the published listing **does not
   contain a `key`** (verified by downloading the live CRX) — the store assigns and controls the
   signing key that derives the store ID on first upload, and does not preserve the `key` in the
   manifest. Therefore subsequent update uploads **must also omit the `key`**, otherwise it reports
   "The value of the 'key' field in the manifest does not match the current content." The store zip =
   the source `extension/dist` with `manifest.key` removed, `manifest.json` placed at the **root** of
   the zip, and `description` ≤ 132 characters. The release pipeline produces **two** zips:
   `browser-bridge-extension-<tag>-store.zip` (**`key` removed**, for uploading to the store) and
   `browser-bridge-extension-<tag>.zip` (**`key` retained**, so developers get the pinned ID via
   "Load unpacked"). The two paths have opposite requirements for `key` and **cannot be merged into
   one**.

3. **Privacy policy**: because the extension reads page content, cookies, and web storage, the store
   requires a privacy policy URL — see [`docs/privacy-policy.md`](../privacy-policy.md).

4. **Release method: manual upload**. Upload `browser-bridge-extension-<tag>-store.zip` (**`key`
   removed**, manifest at the root) through the store dashboard, go through review, and publish;
   **no automation**.
   (Automated CI publishing via the CWS API was evaluated, but the OAuth refresh-token maintenance
   cost, the fact that the `release: published` trigger does not fire for releases created by
   `GITHUB_TOKEN`, and similar issues meant the benefit did not outweigh the complexity, so manual
   was chosen.)

## Alternatives Considered

### Option A: Backfill the store public key into the manifest `key` so both paths share one ID
- **Pros**: only one ID needs to be trusted, making `allowed_origins` simpler
- **Cons**: changes the current pinned ID, so every developer environment with unpacked installed
  would need to reinstall
- **Not chosen**: dual-ID trust is cheaper and causes zero breakage for existing users

### Option B: Enable "Verified CRX uploads"
- **Pros**: accepts only uploads signed with your own private key, adding a layer of account security
- **Cons**: every update requires signing a `.crx`; a lost private key requires contacting support
  (up to a week); for a single/small maintainer set this is a net burden
- **Not chosen**: leave it **off** by default; reassess later if multiple maintainers become
  concerned about account compromise

### Option C: Bring in a third-party Action (e.g. `chrome-webstore-upload-action`) to publish
- **Cons**: yet another third-party supply-chain dependency requiring a pinned SHA
- **Not chosen**: the CWS API can be covered with `curl` + `jq` alone, adding zero new dependencies,
  which fits this project's minimal-dependency posture

## Consequences

### Positive
- Removes the biggest barrier, "developer mode Load unpacked"; one-click Add to Chrome, friendly to
  managed Chrome
- Dual-ID trust lets store users and developers share a single installer with zero breakage

### Negative / Trade-offs
- **Does not remove the installer**: the store distributes only the **extension**; users still need
  to run `install.sh` / `install.ps1` to install the native host binary + manifest
- **Loss of instant update control**: every store update must go through review (days to weeks)
- Permission/tool changes (such as `page_eval`, `chrome.debugger`, `tabGroups`) trigger a store
  re-review and re-authorization by users
- One more ID that is controlled by the store and cannot be derived on your own, which must be kept
  consistent via a CI gate

## Relationship to Other ADRs

- Orthogonal to [ADR-0004](./0004-allowlist-with-optional-host-permissions.md): the distribution
  method does not change the allowlist/authorization model
- Related to [ADR-0005](./0005-page-eval-disabled-by-default.md) and
  [ADR-0009](./0009-page-snapshot-precise-debugger.md): `page_eval` and `chrome.debugger` are the key
  risk items in the store review
- See [release.md](../release.md) for release pipeline details; see
  [chrome-web-store.md](../chrome-web-store.md) for the publishing decision checklist
