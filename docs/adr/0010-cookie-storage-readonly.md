# ADR-0010: Read-Only Cookie/Storage Access

- **Status**: Accepted
- **Date**: 2026-07-08
- **Implementation**: Phase 3, first batch

## Background

User scenario: "Let the AI read the session token of a site I'm already logged into, for use elsewhere (local scripts, cross-tool calls, debugging APIs)."

The core value of this requirement lies in **httpOnly Cookies** — many sites (production environments especially) store session/JWT/refresh tokens in httpOnly Cookies, which **page JS's `document.cookie` cannot read** (this is exactly the security design of httpOnly). Only the `chrome.cookies` API can read them.

At the same time, many frontend frameworks (Auth0/NextAuth/Firebase) store tokens in `localStorage`/`sessionStorage`, which content scripts can read.

## Decision

**Add two read-only tools, `cookie_get` + `storage_get`, with no writes of any kind:**

| Dimension | Implementation |
|------|------|
| Scope | **Read-only** — `cookie_get` + `storage_get`; **no** cookie_set/cookie_remove/storage_set |
| Confirmation | Silent execution (same as page_snapshot/page_text), no Toast popup |
| host constraints | Reuses the existing allowlist; Cookies are naturally constrained by host_permissions, storage is constrained by same-origin |
| Output redaction | Reuses the `maskSensitive` from [ADR-0008](./0008-page-eval-confirmation-channel.md) (JWT/long hex/long numbers/sensitive keys) |
| httpOnly | Reads include httpOnly Cookies (the core value) |

## Key Research Findings (the facts that drove the design)

1. **The `chrome.cookies` API is constrained by host_permissions**: `getAll({})` returns only the Cookies of authorized domains, **not** all browser Cookies. The blast radius is consistent with existing tools, reusing the existing allowlist ([ADR-0004](./0004-allowlist-with-optional-host-permissions.md)).
2. **It can read httpOnly Cookies**: the API exposes the `httpOnly` field and returns httpOnly Cookies normally — this is the core value relative to `document.cookie`.
3. **Page localStorage must be read from a content script** (same-origin restriction); `chrome.storage` is the extension's own and unrelated to the page — the two are different. So `storage_get` lives in content.js, and `cookie_get` lives in background.js.
4. **The `cookies` permission adds no extra install warning** (we already have debugger, which triggers the maximum host warning, so adding `cookies` costs nothing).
5. **`cookie_set` can forge httpOnly+Secure Cookies** (a session fixation attack vector, something even page XSS cannot do) → **not implemented**.

## Tool Design

### `cookie_get(details)` — runs in background.js
- Parameters (all optional, at least one needed to locate):
  - `url` (string) — returns Cookies that would be sent to that URL
  - `domain` (string) — matches that domain and its subdomains
  - `name` (string) — exact match on the Cookie name
- Implementation: call `chrome.cookies.getAll({url, domain, name})` → redact value (preserving the name/domain/httpOnly structure) → return
- Return: `[{name, value(redacted), domain, path, httpOnly, secure, sameSite, session, expirationDate?}]`
- Friendly hint: on empty results, check "whether the domain is authorized" (Chrome returns an empty array rather than an error when not authorized)

### `storage_get(details)` — runs in content.js
- Parameters:
  - `type` ("local" | "session", default "local")
  - `key` (string, optional) — specifies a key; if omitted, returns everything (redacted)
- Implementation: read from `window.localStorage` / `window.sessionStorage` → redact → return
- Return: single key `{key, value(redacted)}`; everything `{type, entries: {k:v(redacted)}, count}`

## Why We Don't Implement cookie_set (risk restated)

`chrome.cookies.set` can forge **httpOnly+Secure** Cookies — something that even page XSS cannot do (page JS cannot set httpOnly Cookies).

Consequence: if the AI is induced (prompt injection), it could plant an **attacker-controlled session ID** into a site the user is already logged into (session fixation attack). Even with a confirmation UI, a single mistaken approval plants it successfully, and it's very hard for the user to notice — Cookies aren't visible the way clicks/form-fills are.

Reading covers 90% of scenarios (grabbing the login state for use elsewhere), while writing is rarely necessary. **Not implementing = the minimal attack surface**, consistent with the security-first principle.

## Rationale for Not Implementing cookie_remove
- Safer than set (can only log out/clear), but its actual use is narrow (clearing login state to retry)
- Adding remove would require adding confirmation (users would ask "why did you delete my Cookie"), increasing complexity
- Not implemented in v0.1, left for the future (if there's genuine demand, remove is safer than set and can be added later)

## Alternatives Considered

### Option A: Do both read and write (cookie_set behind high-risk confirmation)
- **Pros**: the most complete capability
- **Cons**: cookie_set can forge httpOnly Cookies (session fixation attack); even with a confirmation UI, a single mistaken approval plants a malicious session
- **Excluded**: the user chose read-only, the smallest attack surface

### Option B: Read + cookie_remove (no set)
- **Pros**: safer than full read-write; remove can only clear, not forge
- **Cons**: narrow use; requires adding a confirmation UI
- **Not chosen**: the user chose pure read-only

### Option C: Confirmation on every read
- **Pros**: the safest
- **Cons**: read actions are frequent (grabbing tokens, checking state), and confirming each one interrupts the flow
- **Excluded**: the user chose silent (consistent with page_snapshot/page_text)

## Consequences

### Positive
- **Fills the core scenario**: reading httpOnly Cookies / localStorage tokens for cross-tool calls
- **Zero new attack surface**: read-only + redacted + constrained by the existing allowlist; blast radius equivalent to page_text
- **No install-warning cost**: the cookies permission is silent, and debugger already triggers the maximum warning
- **Reuses redaction**: no new code, directly using page_eval's maskSensitive

### Negative
- **Empty-result ambiguity**: not authorized vs. genuinely no data — Chrome doesn't distinguish, so we can only hint
- **Redaction may over-mask**: normal long values such as base64 config get masked (shares the evalMask switch; can be refined later)
- **No IndexedDB support**: some frameworks (Airbnb LiteSet, etc.) store tokens in IndexedDB, which this approach doesn't cover

### Neutral
- Tool count 13 → 15

## Known Limitations

1. **localStorage is subject to same-origin restrictions**: a content script can only read the origin of the page it's currently injected into; cross-origin iframes can't be read
2. **Empty-result ambiguity**: the Chrome cookies API returns an empty array rather than an error when not authorized
3. **Redaction switch granularity**: currently `evalMask` affects both page_eval and cookie/storage; in the future it can be split into independent switches

## Relationship to Other ADRs

- **Reuses [ADR-0004](./0004-allowlist-with-optional-host-permissions.md)**: the allowlist is the site-level first line of defense; Cookie/Storage is automatically constrained by it
- **Reuses [ADR-0008](./0008-page-eval-confirmation-channel.md)**: the `maskSensitive` redaction function, with a pattern library for JWT/hex/numbers/sensitive keys
- **Differs from [ADR-0008](./0008-page-eval-confirmation-channel.md)**: eval is execution (requires high-risk confirmation), while Cookie/Storage is read-only (silent). Both use redaction, but the confirmation strength differs
- **Complements the capability boundary of [ADR-0003](./0003-content-script-snapshot-vs-chrome-debugger.md)**: content scripts read localStorage (same-origin), and chrome.debugger can also read it but is too heavy; a content script suffices here
