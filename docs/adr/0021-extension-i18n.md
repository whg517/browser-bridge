# ADR-0021: Extension UI internationalization (English + Simplified Chinese)

- **Status**: Accepted
- **Date**: 2026-07-27

## Context

The extension's user-facing surfaces (popup, options page, in-page toast,
manifest name/description) were English-only. We want the extension UI available
in **English and Simplified Chinese**, and — per product request — a **manual
language override** in the Options page so a user can force a language regardless
of their Chrome UI locale (e.g. a Chinese user on an English Chrome build).

Chrome's native `chrome.i18n` is the obvious mechanism, but it has one hard
limit: `chrome.i18n.getMessage` **always resolves against the browser UI
language** and cannot be pointed at a different locale at runtime. So native
i18n alone cannot satisfy the "force a language" requirement.

Only the extension's *own* UI is in scope. The MCP tool-contract descriptions
(`contracts/tools.json`), the agent kickstart prompt (`docs/agent-prompt.md`),
and host/Rust log strings are read by the **AI agent or developers**, not the
extension user, and stay English.

## Decision

**Keep `_locales/{en,zh_CN}/messages.json` (Chrome's native format) as the single
source of truth, and add a thin custom runtime layer (`src/shared/i18n.ts`) that
imports those same catalogues and selects the locale from a `language` setting.**

- **Catalogues**: `extension/_locales/en/messages.json` +
  `extension/_locales/zh_CN/messages.json` (~55 keys). `build.mjs` copies
  `_locales/` into `dist/`.
- **Manifest** name stays the literal brand "Browser Bridge"; `description`
  becomes `__MSG_app_desc__` with `default_locale: "en"`. This is resolved
  **natively by Chrome from the browser UI locale** — the manifest text is not
  runtime-controllable, which is fine (the store/extensions-page description
  reasonably follows the browser).
- **Runtime UI** (`shared/i18n.ts`): imports both JSON catalogues,
  `resolveLocale(setting)` (`"en"`/`"zh_CN"` force it; `"auto"` follows
  `chrome.i18n.getUILanguage()`), and a synchronous `t(key, subs?)` with an
  English fallback. `applyI18n()` fills the DOM from `data-i18n` /
  `data-i18n-html` / `data-i18n-placeholder` hooks (HTML can't use `__MSG__`
  substitution, so static strings are injected on load).
- **Language setting**: `language: "auto" | "en" | "zh_CN"` (default `"auto"`) in
  `shared/settings.ts`; a `<select>` in the Options page persists it and reloads
  the page so every rendered string refreshes.
- **In-page toast**: the content-script toast runs in the page world; its body
  and Cancel label are localized in the **service worker** (`precise.ts`, where
  the setting is easy to read) and passed through the `_info_toast` message, so
  the content script needs no i18n init.
- **Tool labels**: the 16 tool labels shown in the Options "Tool enablement"
  grid are localized via `tool_<op>` keys (English contract stays the AI-facing
  source of truth); the grid falls back to the English `ops.ts` label if a key
  is absent.

## Alternatives Considered

### Option A: Native `chrome.i18n` only (auto-detect, no toggle)
- **Pros**: zero custom code; standard.
- **Cons**: cannot force a locale — fails the manual-override requirement.
- **Not chosen**: the toggle was an explicit requirement.

### Option B: A third-party i18n library (i18next, etc.)
- **Pros**: interpolation, plurals, namespaces.
- **Cons**: a dependency + bundle weight for ~55 flat strings and no
  pluralization needs.
- **Not chosen**: over-engineered for this surface.

### Option C: Custom catalogues *instead of* `_locales/`
- **Cons**: loses native manifest name/description localization, and forks the
  catalogue from what Chrome reads.
- **Not chosen**: reusing `_locales/` as the SSOT gives both for free.

## Consequences

### Positive
- One catalogue drives both native manifest localization and the toggle-able UI.
- A unit test (`shared/i18n.test.ts`) asserts `en`/`zh_CN` key parity (no missing
  translations) and that every tool has a localized label.
- Adding a string = one key in both `messages.json` files + a `data-i18n` hook or
  `t()` call.

### Negative / trade-offs
- The manifest name/description follow the **browser** locale, not the in-app
  toggle (inherent to how Chrome resolves the manifest). The toggle governs the
  UI the user actually interacts with.
- The catalogues are inlined into the `background`/`options`/`popup` bundles
  (~a few KB each); the content bundle stays i18n-free (the toast is localized in
  the SW).

### Neutral
- Changing the language reloads the Options page rather than live-swapping
  strings — simplest and reliable, and the popup re-reads on next open.
