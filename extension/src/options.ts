// options.ts — the extension's options page. Reads/writes chrome.storage.local.
//
// All settings live in chrome.storage.local as flat keys. DEFAULTS is the single
// source of truth in shared/settings.ts — background/content/options all import
// it; add a new setting there (and to the Settings type), not in three places.

import type { Settings } from "./shared/types";
import { DEFAULTS } from "./shared/settings";
import { TOOLS } from "./shared/ops";

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
  flashToast("已保存");
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

// ---- render: boolean cards ------------------------------------------------

function renderBool(key: string) {
  const input = $(key);
  const warn = $(`${key}-warn`);
  const card = $(`card-${key}`);
  input.addEventListener("change", (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked;
    if (warn) warn.style.display = checked ? "none" : "block";
    if (card) card.classList.toggle("danger", !!warn && !checked);
    saveSetting(key, checked);
  });
}

// The "allow all sites" toggle is special: enabling it MUST also grant the
// <all_urls> optional host permission (via a user-gesture permissions.request),
// otherwise content-script injection silently fails on non-allowlisted origins.
// If the user declines the permission prompt, roll the checkbox back to off.
function wireAllowAllSites() {
  const input = $("allowAllSites");
  const warn = $("allowAllSites-warn");
  const card = $("card-allowAllSites");
  input.addEventListener("change", async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const checked = target.checked;
    if (checked) {
      // Request the all-urls host permission. This must happen inside the
      // change handler (a user-gesture context) — MV3 forbids requesting
      // permissions from arbitrary async code.
      const granted = await chrome.permissions.request({
        origins: ["<all_urls>"],
      });
      if (!granted) {
        // User declined the OS prompt → roll back.
        target.checked = false;
        flashToast("未授权 <所有网址>,已保持逐站点审批");
        return;
      }
    } else {
      // Turning off: release the host permission too.
      await chrome.permissions.remove({ origins: ["<all_urls>"] });
    }
    if (warn) warn.style.display = checked ? "block" : "none";
    if (card) card.classList.toggle("danger", checked);
    await saveSetting("allowAllSites", checked);
    flashToast(checked ? "已允许所有站点" : "已恢复逐站点审批");
  });
}

// ---- render: number fields ------------------------------------------------

function renderNumber(key: string) {
  const input = $(key);
  input.addEventListener("change", (e: Event) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    if (Number.isNaN(v)) return;
    saveSetting(key, v);
  });
}

// ---- render: tools grid ---------------------------------------------------

function renderToolsGrid(disabledTools: string[]) {
  const grid = $("tools-grid");
  const disabled = new Set(Array.isArray(disabledTools) ? disabledTools : []);
  grid.innerHTML = TOOLS.map((t) => {
    const checked = disabled.has(t.op) ? "" : "checked";
    return (
      `<label class="tool">` +
      `<input type="checkbox" data-op="${escapeAttr(t.op)}" ${checked} />` +
      `<div><div class="name">${escapeHtml(t.op)}</div>` +
      `<div class="tdesc">${escapeHtml(t.desc)}</div></div>` +
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

// ---- render: allowlist ----------------------------------------------------

async function refreshAllowlist() {
  const resp = await send({ type: "get_allowlist" });
  const list = (resp?.list as string[]) || [];
  const box = $("site-list");
  if (list.length === 0) {
    box.innerHTML = `<div class="empty">还没有允许任何站点。</div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (g) =>
        `<div class="item"><code>${escapeHtml(g)}</code>` +
        `<button class="danger" data-glob="${escapeAttr(g)}">移除</button></div>`
    )
    .join("");
  box.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.onclick = async () => {
      const glob = b.getAttribute("data-glob")!;
      await send({ type: "remove_allow", glob });
      refreshAllowlist();
      flashToast("已移除");
    };
  });
}

// Manual add. We only write to storage here — MV3 forbids
// chrome.permissions.request outside a user-gesture action context, so the
// actual host permission is requested on first visit via ensureAllowed().
function wireAddSite() {
  const input = $<HTMLInputElement>("new-site");
  const btn = $("add-site");
  async function add() {
    const v = input.value.trim();
    if (!v) return;
    if (!/^https?:\/\/[^/]+\//.test(v) && !/^https?:\/\/[^/]+$/.test(v)) {
      flashToast("格式应为 https://域名/*");
      return;
    }
    // Normalize to an origin glob: https://host/*
    let glob;
    try {
      const u = new URL(v);
      glob = `${u.protocol}//${u.host}/*`;
    } catch (_) {
      flashToast("URL 解析失败");
      return;
    }
    const resp = await send({ type: "add_allow", glob });
    if (resp && resp.ok) {
      input.value = "";
      refreshAllowlist();
      flashToast("已添加");
    } else {
      flashToast((resp?.error as string) || "添加失败");
    }
  }
  btn.onclick = add;
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") add();
  });
}

// ---- helpers --------------------------------------------------------------

function send(msg: object): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

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
  const s = await loadSettings();

  // Boolean toggles. These are all PROTECTIONS: safe when on, warned when off,
  // so the warning/danger styling shows while UNCHECKED.
  for (const key of [
    "pageEvalEnabled",
    "evalMask",
    "confirmHighRiskClick",
    "warnPreciseSnapshot",
  ] as (keyof Settings)[]) {
    const input = $<HTMLInputElement>(key);
    input.checked = s[key] !== false;
    const warn = $(`${key}-warn`);
    if (warn) warn.style.display = input.checked ? "none" : "block";
    const card = $(`card-${key}`);
    if (card && warn) card.classList.toggle("danger", !input.checked);
    renderBool(key);
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

  // "Allow all sites" toggle — special wiring (permission request on enable).
  // Derive the initial checkbox state from BOTH the stored setting and whether
  // the <all_urls> permission is actually held, so they can't drift apart.
  {
    const held = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    const effective = s.allowAllSites === true && held;
    const input = $<HTMLInputElement>("allowAllSites");
    input.checked = effective;
    // Persist the effective value in case they had drifted.
    if (effective !== (s.allowAllSites === true)) {
      await chrome.storage.local.set({ allowAllSites: effective });
    }
    const warn = $("allowAllSites-warn");
    if (warn) warn.style.display = effective ? "block" : "none";
    const card = $("card-allowAllSites");
    if (card) card.classList.toggle("danger", effective);
    wireAllowAllSites();
  }

  // Number fields.
  for (const key of [
    "confirmGraceMs",
    "clickToastTimeoutMs",
    "evalToastTimeoutMs",
  ] as (keyof Settings)[]) {
    const input = $<HTMLInputElement>(key);
    input.value = String(s[key]);
    renderNumber(key);
  }

  // Tools grid.
  renderToolsGrid(s.disabledTools);

  // Allowlist.
  await refreshAllowlist();
  wireAddSite();
})();

export {};
