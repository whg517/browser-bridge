// options.ts — the extension's options page. Reads/writes chrome.storage.local.
//
// All settings live in chrome.storage.local as flat keys. DEFAULTS is the single
// source of truth in shared/settings.ts — background/content/options all import
// it; add a new setting there (and to the Settings type), not in three places.

import type { Settings } from "./shared/types";
import { DEFAULTS } from "./shared/settings";
import { TOOLS } from "./shared/ops";
import { t, applyI18n, initI18n } from "./shared/i18n";

// Elements are declared in options.html; `$` asserts presence (the page owns
// its own DOM). Pass a subtype when you need element-specific fields.
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ---- load / save settings -------------------------------------------------

async function loadSettings(): Promise<Settings> {
  const keys = Object.keys(DEFAULTS);
  const stored = await chrome.storage.local.get(keys);
  return { ...DEFAULTS, ...stored };
}

async function saveSetting(key: string, value: unknown) {
  await chrome.storage.local.set({ [key]: value });
  flashToast(t("toast_saved"));
}

// ---- toast feedback -------------------------------------------------------

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function flashToast(msg: string) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1200);
}

// ---- render: tools grid ---------------------------------------------------

function renderToolsGrid(disabledTools: string[]) {
  const grid = $("tools-grid");
  const disabled = new Set(Array.isArray(disabledTools) ? disabledTools : []);
  grid.innerHTML = TOOLS.map((tool) => {
    const checked = disabled.has(tool.op) ? "" : "checked";
    // Localized label (tool_<op>); fall back to the English contract label if a
    // key is ever missing (the i18n parity test guards against that).
    const key = "tool_" + tool.op;
    const localized = t(key);
    const label = localized === key ? tool.desc : localized;
    return (
      `<label class="tool">` +
      `<input type="checkbox" data-op="${escapeAttr(tool.op)}" ${checked} />` +
      `<div><div class="name">${escapeHtml(tool.op)}</div>` +
      `<div class="tdesc">${escapeHtml(label)}</div></div>` +
      `</label>`
    );
  }).join("");
  grid.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const all = grid.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
      const next: string[] = [];
      all.forEach((c) => {
        if (!c.checked) next.push(c.getAttribute("data-op")!);
      });
      await saveSetting("disabledTools", next);
    });
  });
}

// ---- helpers --------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
function escapeAttr(s: string) {
  return escapeHtml(s);
}

// ---- init -----------------------------------------------------------------

(async function init() {
  // Resolve the UI language and fill every static [data-i18n] element first.
  await initI18n();
  applyI18n();

  const s = await loadSettings();

  // Language selector: "auto" follows the browser, "en"/"zh_CN" force it.
  // Changing it reloads the page so every rendered string (incl. the tools
  // grid, which is built in JS) refreshes.
  {
    const sel = $<HTMLSelectElement>("language");
    sel.value = s.language;
    sel.addEventListener("change", async () => {
      await chrome.storage.local.set({ language: sel.value });
      location.reload();
    });
  }

  // cdpMode is the inverse: DANGEROUS when ON (persistent debugger attach, CSP
  // bypassed), so its warning/danger styling shows while CHECKED. Default off.
  {
    const input = $<HTMLInputElement>("cdpMode");
    const warn = $("cdpMode-warn");
    const card = $("card-cdpMode");
    const sync = (on: boolean) => {
      if (warn) warn.style.display = on ? "block" : "none";
      if (card) card.classList.toggle("danger", on);
    };
    input.checked = s.cdpMode === true;
    sync(input.checked);
    input.addEventListener("change", (e: Event) => {
      const on = (e.target as HTMLInputElement).checked;
      sync(on);
      saveSetting("cdpMode", on);
    });
  }

  // Tools grid.
  renderToolsGrid(s.disabledTools);
})();

export {};
