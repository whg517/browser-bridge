// options.js — the extension's options page. Reads/writes chrome.storage.local.
//
// All settings live in chrome.storage.local as flat keys. Defaults MUST stay in
// sync with the DEFAULTS objects in background.js and content.js — any key added
// here must be added there too.

import type { Settings } from "./types";

// Default values for the configurable settings. Keep in sync with
// background.js DEFAULTS and content.js DEFAULTS.
const DEFAULTS: Settings = {
  pageEvalEnabled: true,
  evalMask: true,
  confirmHighRiskClick: true,
  warnPreciseSnapshot: true,
  confirmGraceMs: 60000,
  clickToastTimeoutMs: 30000,
  evalToastTimeoutMs: 45000,
  disabledTools: [], // string[] of tool/op names that are blocked
  allowAllSites: false,
};

// The full tool catalogue, with a short description for the UI. The `op` values
// mirror the `op` strings dispatched in background.js (keep in sync). Listing
// the toggleable subset — tab/page helpers that an admin may want to turn off.
const TOOLS = [
  { op: "tab_list", desc: "列出所有标签页" },
  { op: "tab_focus", desc: "切换到指定标签页" },
  { op: "tab_open", desc: "打开新标签页(需白名单)" },
  { op: "tab_close", desc: "关闭标签页(带确认)" },
  { op: "page_snapshot", desc: "快照页面可交互元素" },
  { op: "page_click", desc: "点击元素" },
  { op: "page_fill", desc: "填写表单字段" },
  { op: "page_text", desc: "读取页面可见文本" },
  { op: "page_screenshot", desc: "截取可视区域" },
  { op: "page_scroll", desc: "滚动页面" },
  { op: "page_wait_for", desc: "等待条件满足" },
  { op: "page_eval", desc: "执行任意 JS(高危)" },
  { op: "page_snapshot_precise", desc: "精确快照(走 debugger)" },
  { op: "cookie_get", desc: "读取 Cookie(脱敏)" },
  { op: "storage_get", desc: "读取 localStorage/sessionStorage(脱敏)" },
];

function $(id: string): any {
  return document.getElementById(id);
}

// ---- load / save settings -------------------------------------------------

async function loadSettings(): Promise<any> {
  const keys = Object.keys(DEFAULTS);
  const stored = await chrome.storage.local.get(keys);
  return { ...DEFAULTS, ...stored };
}

async function saveSetting(key: string, value: any) {
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
  input.addEventListener("change", (e: any) => {
    const checked = e.target.checked;
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
  input.addEventListener("change", async (e: any) => {
    const checked = e.target.checked;
    if (checked) {
      // Request the all-urls host permission. This must happen inside the
      // change handler (a user-gesture context) — MV3 forbids requesting
      // permissions from arbitrary async code.
      const granted = await chrome.permissions.request({
        origins: ["<all_urls>"],
      });
      if (!granted) {
        // User declined the OS prompt → roll back.
        e.target.checked = false;
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
  input.addEventListener("change", (e: any) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isNaN(v)) return;
    saveSetting(key, v);
  });
}

// ---- render: tools grid ---------------------------------------------------

function renderToolsGrid(disabledTools: any) {
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
  grid.querySelectorAll("input[type=checkbox]").forEach((cb: any) => {
    cb.addEventListener("change", async () => {
      const all = grid.querySelectorAll("input[type=checkbox]");
      const next: any[] = [];
      all.forEach((c: any) => {
        if (!c.checked) next.push(c.getAttribute("data-op"));
      });
      await saveSetting("disabledTools", next);
    });
  });
}

// ---- render: allowlist ----------------------------------------------------

async function refreshAllowlist() {
  const resp = await send({ type: "get_allowlist" });
  const list = resp?.list || [];
  const box = $("site-list");
  if (list.length === 0) {
    box.innerHTML = `<div class="empty">还没有允许任何站点。</div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (g: any) =>
        `<div class="item"><code>${escapeHtml(g)}</code>` +
        `<button class="danger" data-glob="${escapeAttr(g)}">移除</button></div>`
    )
    .join("");
  box.querySelectorAll("button").forEach((b: any) => {
    b.onclick = async () => {
      const glob = b.getAttribute("data-glob");
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
  const input = $("new-site");
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
      flashToast((resp && resp.error) || "添加失败");
    }
  }
  btn.onclick = add;
  input.addEventListener("keydown", (e: any) => {
    if (e.key === "Enter") add();
  });
}

// ---- helpers --------------------------------------------------------------

function send(msg: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}
function escapeHtml(s: any) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      (
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<
          string,
          string
        >
      )[c]
  );
}
function escapeAttr(s: any) {
  return escapeHtml(s);
}

// ---- init -----------------------------------------------------------------

(async function init() {
  const s = await loadSettings();

  // Boolean toggles.
  for (const key of [
    "pageEvalEnabled",
    "evalMask",
    "confirmHighRiskClick",
    "warnPreciseSnapshot",
  ]) {
    const input = $(key);
    input.checked = s[key] !== false;
    const warn = $(`${key}-warn`);
    if (warn) warn.style.display = input.checked ? "none" : "block";
    const card = $(`card-${key}`);
    if (card && warn) card.classList.toggle("danger", !input.checked);
    renderBool(key);
  }

  // "Allow all sites" toggle — special wiring (permission request on enable).
  // Derive the initial checkbox state from BOTH the stored setting and whether
  // the <all_urls> permission is actually held, so they can't drift apart.
  {
    const held = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    const effective = s.allowAllSites === true && held;
    const input = $("allowAllSites");
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
  for (const key of ["confirmGraceMs", "clickToastTimeoutMs", "evalToastTimeoutMs"]) {
    const input = $(key);
    input.value = s[key];
    renderNumber(key);
  }

  // Tools grid.
  renderToolsGrid(s.disabledTools);

  // Allowlist.
  await refreshAllowlist();
  wireAddSite();
})();

export {};
