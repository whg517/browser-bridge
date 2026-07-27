// Runtime internationalization for the extension UI (English + Simplified
// Chinese).
//
// Why a custom layer instead of only `chrome.i18n`: chrome.i18n.getMessage
// always resolves against the BROWSER UI language and can't be overridden at
// runtime. We want an in-Options "Language" toggle (Auto / English / 中文), so
// this module carries the message catalogues itself and picks the locale from
// the `language` setting. The `_locales/*/messages.json` files stay the single
// source of truth — they're imported here AND used natively by Chrome for the
// manifest name/description (which do follow the browser locale, by design).

import en from "../../_locales/en/messages.json";
import zhCN from "../../_locales/zh_CN/messages.json";
import { getSetting } from "./settings";

export type Locale = "en" | "zh_CN";

type Catalog = Record<string, { message: string }>;
const CATALOGS: Record<Locale, Catalog> = {
  en: en as Catalog,
  zh_CN: zhCN as Catalog,
};

let active: Locale = "en";

// Resolve the effective locale from the `language` setting: an explicit
// "en"/"zh_CN" forces it; "auto" (or anything else) follows Chrome's UI
// language, defaulting to English.
export function resolveLocale(setting: string | undefined): Locale {
  if (setting === "en" || setting === "zh_CN") return setting;
  // `typeof chrome` guards the non-extension (unit-test) context.
  const ui = (
    (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage?.()) ||
    "en"
  ).toLowerCase();
  return ui.startsWith("zh") ? "zh_CN" : "en";
}

// Read the stored language setting and set the active locale. Call once per
// context (options / popup / SW) before rendering; t() is synchronous after.
export async function initI18n(): Promise<Locale> {
  let setting: string | undefined;
  try {
    setting = await getSetting("language");
  } catch {
    setting = undefined;
  }
  active = resolveLocale(setting);
  return active;
}

export function getLocale(): Locale {
  return active;
}

// Direct seam for the SW (which already knows the setting) and for tests.
export function setLocale(locale: Locale): void {
  active = locale;
}

// Look up a message in the active locale, falling back to English, then the key
// itself. (No placeholder interpolation yet — no shipped message needs it.)
export function t(key: string): string {
  const entry = CATALOGS[active]?.[key] || CATALOGS.en[key];
  return entry ? entry.message : key;
}

// Fill a DOM subtree from data-i18n hooks:
//   data-i18n="key"             → textContent
//   data-i18n-html="key"        → innerHTML (messages with inline markup)
//   data-i18n-placeholder="key" → placeholder attribute
// Catalogue values are trusted (bundled), so innerHTML is safe here.
export function applyI18n(root: ParentNode = document): void {
  // Keep the document language in sync with the active locale so screen readers
  // and language-specific rendering match what's shown (BCP-47 tags).
  if (typeof document !== "undefined") {
    document.documentElement.lang = active === "zh_CN" ? "zh-CN" : "en";
  }
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml!);
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  });
}
