# Chrome Web Store Release (Manual Upload)

> **Status: published and live.** The extension is listed as
> [Browser Bridge](https://chromewebstore.google.com/detail/browser-bridge/dgccjfjjilfpkbdllclmkiicajndkfcd).
> Why we distribute through the store — and the dual-ID / pinned-`key`
> trade-offs it forces — is recorded in
> [ADR-0019](./adr/0019-chrome-web-store-distribution.md).

Store publishing is **manual** — there is no CI auto-publish. We evaluated the
CWS API but the OAuth refresh-token maintenance, plus the fact that the
`release: published` trigger does not fire for releases created by
`GITHUB_TOKEN`, meant the payoff did not justify the complexity.

## Upload a new version

1. **Get the zip.** Download **`browser-bridge-extension-<tag>-store.zip`** (note
   the `-store` suffix) from the GitHub release — it is already in the shape the
   store wants: `manifest.json` at the zip **root**, **with `key` removed**. You
   can also build it locally — but **stamp a version first**, because the repo
   permanently carries the `0.0.0` placeholder and the store will not accept
   a `0.0.0` package ([ADR-0026](./adr/0026-release-time-version-stamping.md)):
   ```sh
   make stamp-version VERSION=0.6.0 && make ext-build
   cp -r extension/dist store-pkg
   node -e 'const fs=require("fs");const f="store-pkg/manifest.json";const m=JSON.parse(fs.readFileSync(f,"utf8"));delete m.key;fs.writeFileSync(f,JSON.stringify(m,null,2));'
   (cd store-pkg && zip -rX ../browser-bridge-extension-store.zip . -x ".*")
   make stamp-version              # reset the tree to 0.0.0
   ```
   ⚠️ **You must remove `key`.** The published listing's manifest does **not**
   contain `key` (the store manages the signing key that derives the store ID).
   An update upload that still carries `key` is rejected with "The value of the
   key field in the manifest does not match the current content." The zip
   **without** the `-store` suffix keeps `key` for developers' "Load unpacked",
   so **do not** upload that one.
2. **Upload.** [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   → Browser Bridge → **Package → Upload new package** → select the store zip →
   **Submit for review**.
3. **Tag first.** The store rejects duplicate versions, and the version now comes
   from the git tag: cut a release (`git tag vX.Y.Z && git push --tags`) and
   upload *that* release's `-store.zip`. Note the store reads the numeric
   `version` field, so two prereleases sharing a core (`v0.6.0-rc.1`,
   `-rc.2`) look identical to it — never upload a prerelease. Review takes days
   to weeks and cannot be skipped, so you lose instant-update control — every
   update goes through review.

## See Also

- Decision record (why the store, dual ID): [ADR-0019](./adr/0019-chrome-web-store-distribution.md).
- Privacy policy (required for the listing): [privacy-policy.md](./privacy-policy.md).
- Security boundaries and threat model: [SECURITY.md](../SECURITY.md) ·
  [security/threat-model.md](./security/threat-model.md) ·
  [security/trust-boundaries.md](./security/trust-boundaries.md).
- Release pipeline and the two extension zips: [release.md](./release.md).
