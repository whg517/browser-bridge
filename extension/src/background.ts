// background.js — MV3 Service Worker.
//
// Responsibilities:
//   - Maintain a native-messaging Port to the browser-bridge host.
//   - Reconnect automatically (MV3 SWs are killed ~every 5 min, and the host
//     process is killed by Chrome whenever the Port closes — we must
//     re-establish both on startup and after any disconnect).
//   - Dispatch inbound BridgeReq messages to the right tab's content script,
//     and route the content script's response back through the Port.
//   - Enforce the domain allowlist: an op targeting a non-allowlisted origin
//     is rejected with a clear error, and the popup is asked to prompt the
//     user.
//
// State kept in chrome.storage.local (survives SW restarts):
//   - allowlist: string[] of origin globs like "https://example.com/*"

import type { Settings, BridgeReq } from "./types";

const NATIVE_HOST = "com.zcode.browser_bridge";

// Default values for the configurable settings managed by the options page.
// KEEP IN SYNC with options.js DEFAULTS and content.js DEFAULTS.
const DEFAULTS: Settings = {
  pageEvalEnabled: true,
  evalMask: true,
  confirmHighRiskClick: true,
  warnPreciseSnapshot: true,
  confirmGraceMs: 60000,
  clickToastTimeoutMs: 30000,
  evalToastTimeoutMs: 45000,
  disabledTools: [],
  allowAllSites: false,
};

// Read a setting with its default. Resolves a single key.
function getSetting(key: keyof Settings): Promise<any> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (r) => {
      const v = r[key];
      resolve(v === undefined ? DEFAULTS[key] : v);
    });
  });
}

// ---- native port lifecycle ------------------------------------------------

let port: chrome.runtime.Port | null = null;       // current chrome.runtime.Port to the native host
let portOk = false;    // did the most recent connect succeed?
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectNative() {
  // Tear down any previous handle first.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    portOk = true;
    console.log("[bb] native host connected");
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onNativeDisconnect);
  } catch (e) {
    portOk = false;
    console.error("[bb] connectNative threw", e);
    scheduleReconnect();
  }
}

function onNativeDisconnect(p: chrome.runtime.Port) {
  portOk = false;
  port = null;
  const err = chrome.runtime.lastError;
  console.warn("[bb] native host disconnected:", err?.message || "unknown");
  // Chrome kills the host process when the Port drops. Reconnect so a fresh
  // host is spawned — but back off to avoid a tight loop if the host is
  // genuinely unavailable (e.g. install not finished).
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, 2000);
}

// ---- inbound requests from the host (→ forwarded to content scripts) -----

function onNativeMessage(msg: any) {
  // Each message is a BridgeReq: { id, op, tabId?, args }.
  if (!msg || typeof msg.id === "undefined" || !msg.op) {
    console.warn("[bb] malformed BridgeReq", msg);
    return;
  }
  dispatch(msg).then(
    (data) => sendResponse(msg.id, true, data),
    (err) => sendResponse(msg.id, false, undefined, String(err?.message || err || "error"))
  );
}

function sendResponse(id: any, ok: boolean, data?: any, error?: string) {
  if (!port) return; // host gone; nothing to do
  try {
    port.postMessage({ id, ok, data, error: ok ? undefined : error });
  } catch (e) {
    // Port likely closed; the disconnect handler will reconnect.
    console.warn("[bb] postMessage failed", e);
  }
}

// ---- dispatch: route an op to the tab that should act ---------------------

async function dispatch(req: BridgeReq): Promise<any> {
  const { op, args } = req;

  // Tool enable/disable gate: if the op is in the user's disabledTools list,
  // reject before doing anything. The op strings here mirror the tool names in
  // tools.rs and options.js TOOLS — keep in sync.
  if (op) {
    const disabled = await getSetting("disabledTools");
    if (Array.isArray(disabled) && disabled.includes(op)) {
      throw new Error(`tool disabled in settings: ${op}`);
    }
  }

  // Tab-level ops handled directly here (no content script needed).
  switch (op) {
    case "tab_list":
      return await tabList();
    case "tab_focus":
      return await tabFocus(args.tabId);
    case "tab_open":
      return await tabOpen(args.url);
    case "tab_close":
      return await tabClose(args.tabId);
    case "page_snapshot_precise":
      // Handled in SW via chrome.debugger; does NOT go through content.js.
      return await snapshotPrecise(req.tabId, args);
    case "cookie_get":
      // chrome.cookies API is only available in SW context.
      return await cookieGet(req.tabId, args);
  }

  // Page-level ops need a content script in the target tab.
  const tab = await resolveTargetTab(req.tabId);
  await ensureAllowed(tab.url);
  await injectIfNeeded(tab.id!);
  // content.js listens for these and replies.
  const resp: any = await chrome.tabs.sendMessage(tab.id!, { op, args, tabId: tab.id });
  if (resp && resp.__error) throw new Error(resp.__error);
  return resp;
}

// ---- tab-level operations -------------------------------------------------

async function tabList() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
  }));
}

async function tabFocus(tabId: number) {
  const t = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
  return { focused: tabId };
}

async function tabOpen(url: string) {
  await ensureAllowed(url);
  const t = await chrome.tabs.create({ url });
  return { opened: t.id, url };
}

async function tabClose(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  await confirmTabClose(tab);
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

async function confirmTabClose(tab: chrome.tabs.Tab) {
  if (!tab || !tab.id) throw new Error("tab not found");
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error("tab_close can only close http(s) tabs because the close confirmation must be shown in the page");
  }
  await ensureAllowed(tab.url);
  await injectIfNeeded(tab.id);
  const resp: any = await chrome.tabs.sendMessage(tab.id, {
    op: "_confirm_toast",
    args: { message: `Close tab "${tab.title || tab.url}"?` },
  });
  if (resp && resp.__error) throw new Error(resp.__error);
  if (!resp || resp.approved !== true) {
    throw new Error("user denied tab_close");
  }
}

// ---- page_snapshot_precise (chrome.debugger / CDP) ------------------------
//
// Captures Chrome's authoritative accessibility tree via the debugger API.
// More accurate than the content-script snapshot (shadow DOM, complex ARIA)
// but briefly shows the "Started debugging this browser" infobar on EVERY
// tab while attached. We attach → fetch tree → tag elements → detach within
// one handler so the infobar only flashes (~1s). The user is warned via an
// informational toast before attach. See ADR-0009.

// URLs the debugger cannot attach to. Filter before calling attach.
const NON_DEBUGGABLE = [
  /^chrome:\/\//i, /^chrome-extension:\/\//i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^view-source:/i, /^about:/i, /^edge:\/\//i,
];

function isDebuggable(url: string | undefined) {
  if (!url) return false;
  return !NON_DEBUGGABLE.some((re) => re.test(url));
}

// Promisified chrome.debugger primitives.
function dbgAttach(tabId: number) {
  return new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}
function dbgDetach(tabId: number) {
  return new Promise<void>((resolve) => {
    // detach must never throw — used in finally. Swallow errors.
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}
function dbgSend(tabId: number, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

// AXNode roles worth exposing (mirror of content.js INTERACTIVE set, plus
// a few structural ones that are useful context).
const PRECISE_INTERACTIVE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "textbox", "searchbox", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "combobox", "listbox",
  "option", "switch", "treeitem", "menuItem", "spinButton", "slider",
]);

function axValue(v: any): any {
  // AXValue shapes: {type:"string", value:"..."} or plain value.
  if (v && typeof v === "object" && "value" in v) return v.value;
  return v;
}

async function snapshotPrecise(maybeTabId: number | undefined, args: any) {
  const tab = await resolveTargetTab(maybeTabId);
  await ensureAllowed(tab.url);

  if (!isDebuggable(tab.url)) {
    throw new Error(
      `page_snapshot_precise cannot debug this page (URL scheme not allowed): ${truncateUrl(tab.url)}`
    );
  }

  // Warn the user via an informational toast in the page. Proceed unless
  // they actively cancel within the timeout. Skippable via settings.
  const warnPrecise = await getSetting("warnPreciseSnapshot");
  await injectIfNeeded(tab.id!);
  let proceed: any = true; // default: proceed (skip warning)
  if (warnPrecise) {
    proceed = await chrome.tabs.sendMessage(tab.id!, {
      op: "_info_toast",
      args: { message: "即将精确扫描页面 — Chrome 顶部会显示『调试中』横幅,扫描后自动消失(约 1 秒)。" },
    }).catch(() => true /* content script missing → proceed anyway */);
  }
  if (proceed === false || (proceed && proceed.__cancelled)) {
    return { cancelled: true };
  }
  if (proceed && proceed.__error) {
    // Info toast failed (e.g. restricted page); proceed without warning.
    console.warn("[bb] info toast failed:", proceed.__error);
  }

  // Attach. On "another debugger attached" we surface a helpful error.
  try {
    await dbgAttach(tab.id!);
  } catch (e: any) {
    const msg = String(e.message || e);
    if (/another debugger/i.test(msg)) {
      throw new Error("该标签页已打开 DevTools,page_snapshot_precise 无法附加。请关闭 DevTools 后重试。");
    }
    throw e;
  }

  // From here on we MUST detach on every exit path.
  try {
    const tree = await dbgSend(tab.id!, "Accessibility.getFullAXTree", {});
    const nodes = (tree && tree.nodes) || [];

    // Filter: only interactive, non-ignored nodes with a DOM handle.
    const candidates = nodes.filter((n: any) => {
      if (n.ignored) return false;
      if (!n.backendDOMNodeId) return false; // virtual nodes (markers, root)
      const role = axValue(n.role);
      if (!role) return false;
      if (!PRECISE_INTERACTIVE_ROLES.has(role)) return false;
      return true;
    });

    // Tag each element with a stable ref and collect its descriptor. Refs
    // use a `p` prefix to avoid colliding with content-script `e` refs.
    // We batch resolveNode+callFunctionOn per node; for very large pages
    // this is N round-trips, acceptable since interactive nodes are few.
    const out = [];
    let idx = 0;
    for (const n of candidates) {
      idx += 1;
      const ref = `p${idx}`;
      let descriptor: any;
      try {
        const resolved = await dbgSend(tab.id!, "DOM.resolveNode", {
          backendNodeId: n.backendDOMNodeId,
        });
        const objectId = resolved && resolved.object && resolved.object.objectId;
        if (!objectId) continue;
        // Tag the element AND read back a selector/id hint in one call.
        const callRes = await dbgSend(tab.id!, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration:
            "function(ref) {" +
            "  this.setAttribute('data-zcb-ref', ref);" +
            "  var id = this.id ? '#' + this.id : '';" +
            "  var tag = (this.tagName || '').toLowerCase();" +
            "  return { tag: tag, id: id, name: this.getAttribute('name') || '', " +
            "    value: (this.value !== undefined ? String(this.value).slice(0,60) : undefined) };" +
            "}",
          arguments: [{ value: ref }],
          returnByValue: true,
        });
        descriptor = (callRes && callRes.result && callRes.result.value) || {};
      } catch (e: any) {
        // Node may have been removed between getFullAXTree and resolve.
        console.warn("[bb] precise: skip node", ref, e.message);
        continue;
      }
      out.push({
        ref,
        role: axValue(n.role),
        name: truncateAx(axValue(n.name)),
        selector: descriptor.tag ? (descriptor.tag + descriptor.id) : undefined,
        value: descriptor.value,
      });
    }

    return {
      refCount: out.length,
      nodes: out,
      url: tab.url,
      title: tab.title,
      precise: true,
    };
  } finally {
    await dbgDetach(tab.id!);
  }
}

function truncateUrl(u: string | undefined) {
  return (u || "").slice(0, 80);
}
function truncateAx(s: any): any {
  if (typeof s !== "string") return s;
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

// ---- cookie_get (chrome.cookies API, SW-only) ----------------------------
//
// Read-only access to cookies for allowlisted hosts. chrome.cookies is
// naturally scoped by host_permissions, so the blast radius is the same as
// the existing tools. httpOnly cookies are readable here — that's the whole
// point (session tokens live there). Values are masked before leaving the
// extension context (see ADR-0010). No set/remove: write would allow forging
// httpOnly cookies (session fixation), which even page XSS cannot do.

async function cookieGet(maybeTabId: number | undefined, args: any) {
  // If the caller didn't pass url/domain, default to the active tab's URL so
  // "cookie_get {}" means "cookies for the page I'm looking at".
  let { url, domain, name } = args || {};
  if (!url && !domain) {
    const tab = await resolveTargetTab(maybeTabId);
    await ensureAllowed(tab.url);
    url = tab.url;
  } else if (url) {
    await ensureAllowed(url);
  }
  if (domain) {
    await ensureDomainAllowed(domain);
  }

  const filter: any = {};
  if (url) filter.url = url;
  if (domain) filter.domain = domain;
  if (name) filter.name = name;

  const cookies = await chrome.cookies.getAll(filter);
  if (!cookies || cookies.length === 0) {
    return {
      cookies: [],
      count: 0,
      hint: "No cookies matched. If you expected some, verify the host is in the allowlist (popup → Allowed sites).",
    };
  }
  // Mask the value only; keep name/domain/httpOnly etc. for diagnostics.
  const out = cookies.map((c) => ({
    name: c.name,
    value: maskCookieValue(c.value),
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    session: c.session,
    expirationDate: c.expirationDate,
  }));
  return { cookies: out, count: out.length };
}

// Mask a cookie value. Same pattern catalogue as content.js maskString
// (ADR-0008): JWT, long hex, long numbers, credential-like strings.
function maskCookieValue(v: any): any {
  if (typeof v !== "string") return v;
  if (v.length < 8) return v;
  let out = v;
  out = out.replace(/ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "••••[jwt]");
  out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, "••••[hex]");
  out = out.replace(/\b\d{12,}\b/g, "••••[num]");
  out = out.replace(/(?:bearer|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "••••[redacted]");
  return out;
}

// ---- target tab resolution ------------------------------------------------

async function resolveTargetTab(maybeTabId: number | undefined): Promise<chrome.tabs.Tab> {
  if (maybeTabId) {
    return await chrome.tabs.get(maybeTabId);
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new Error("no active tab");
  return active;
}

async function injectIfNeeded(tabId: number) {
  // Content scripts are injected dynamically after the user grants the host
  // permission for this origin. Ping first so repeated tool calls stay cheap.
  try {
    await chrome.tabs.sendMessage(tabId, { op: "ping" });
  } catch (e) {
    // Not injected yet — inject now (requires scripting permission + host).
    // `tab` is fetched for its side effect (rejects if the tab is gone); the
    // result is intentionally unused. Comment is stripped from the bundle.
    // @ts-ignore -- noUnusedLocals: value fetched only for its side effect
    const tab = await chrome.tabs.get(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["toast.css"],
      });
    } catch (_) {
      // CSS injection can fail on some pages; not fatal.
    }
  }
}

// ---- allowlist enforcement ------------------------------------------------

const STORAGE_KEY = "allowlist";
// @ts-ignore -- noUnusedLocals: reserved list, intentionally unreferenced in v0.1
const SENSITIVE_HOSTS = [
  // High-risk domains where we always require confirmation, never auto-allow.
  // Kept minimal for v0.1; extend as needed.
];

async function getAllowlist(): Promise<string[]> {
  const { [STORAGE_KEY]: list } = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(list) ? list : [];
}

async function setAllowlist(list: string[]) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

function originGlobOf(url: string | undefined) {
  try {
    const u = new URL(url!);
    return `${u.protocol}//${u.host}/*`;
  } catch (_) {
    return null;
  }
}

function hostFromOriginGlob(glob: string) {
  try {
    return new URL(glob.replace(/\*$/, "")).host.toLowerCase();
  } catch (_) {
    return null;
  }
}

function normalizeCookieDomain(domain: any): string | null {
  if (typeof domain !== "string") return null;
  let d = domain.trim().toLowerCase();
  if (!d || d.includes("://") || d.includes("/") || d.includes("*")) return null;
  while (d.startsWith(".")) d = d.slice(1);
  return d || null;
}

async function ensureDomainAllowed(domain: any) {
  const host = normalizeCookieDomain(domain);
  if (!host) throw new Error(`invalid cookie domain: ${domain}`);
  // Global bypass: if the user opted into "allow all sites", skip the
  // per-site check entirely.
  if ((await getSetting("allowAllSites")) === true) return;
  const list = await getAllowlist();
  const allowed = list.some((glob) => hostFromOriginGlob(glob) === host);
  if (!allowed) {
    throw new Error(`cookie domain not allowed by user: ${domain}. Use a URL for the active allowlisted origin, or approve that exact host first.`);
  }
}

function matchesAny(glob: string, list: string[]) {
  return list.some((pattern) => simpleMatch(pattern, glob));
}

// Minimal glob match: supports trailing * only. Good enough for "host/*".
function simpleMatch(pattern: string, target: string) {
  if (pattern === target) return true;
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2); // drop "/*"
    return target === base || target.startsWith(base + "/");
  }
  if (pattern.endsWith("*")) {
    return target.startsWith(pattern.slice(0, -1));
  }
  return false;
}

async function ensureAllowed(url: string | undefined) {
  const glob = originGlobOf(url);
  if (!glob) throw new Error(`cannot parse url: ${url}`);
  // Global bypass: if the user opted into "allow all sites", skip the
  // per-site prompt entirely. The <all_urls> host permission must have been
  // granted when they enabled the toggle (see options.js), so content-script
  // injection works on any origin.
  if ((await getSetting("allowAllSites")) === true) return;
  const list = await getAllowlist();
  if (matchesAny(glob, list)) return;
  // Not allowlisted → ask the user via the popup. We open the popup by
  // setting a badge and storing a pending request; the popup, when opened,
  // reads it. If the popup isn't opened within the timeout, we reject.
  const allowed = await promptUserForAllow(glob);
  if (!allowed) {
    throw new Error(`origin not allowed by user: ${glob}`);
  }
}

// Ask the user to approve a new origin. We surface a notification badge; the
// popup handles the actual yes/no. Resolves true/false.
function promptUserForAllow(glob: string): Promise<boolean> {
  return new Promise((resolve) => {
    const reqId = `allow_${Date.now()}`;
    pendingAllowRequests.set(reqId, { glob, resolve });
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#d9534f" });
    chrome.storage.local.set({ pendingAllow: { id: reqId, glob } });
    // Auto-reject after 60s.
    setTimeout(() => {
      if (pendingAllowRequests.has(reqId)) {
        pendingAllowRequests.delete(reqId);
        chrome.storage.local.remove("pendingAllow");
        maybeClearBadge();
        resolve(false);
      }
    }, 60000);
  });
}

const pendingAllowRequests = new Map<string, { glob: string; resolve: (v: boolean) => void }>();

function maybeClearBadge() {
  if (pendingAllowRequests.size === 0) {
    chrome.action.setBadgeText({ text: "" });
  }
}

// The popup calls this (via runtime message) to resolve a pending allow.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "resolve_allow") {
    const { id, allow } = msg;
    const pending = pendingAllowRequests.get(id);
    if (pending) {
      pendingAllowRequests.delete(id);
      chrome.storage.local.remove("pendingAllow");
      maybeClearBadge();
      if (allow) {
        getAllowlist().then((list) => {
          if (!list.includes(pending.glob)) list.push(pending.glob);
          setAllowlist(list).then(() => {
            pending.resolve(true);
            sendResponse({ ok: true });
          });
        });
        return true; // async
      } else {
        pending.resolve(false);
        sendResponse({ ok: true });
        return false;
      }
    }
    sendResponse({ ok: false, error: "no such pending request" });
    return false;
  }
  if (msg?.type === "get_allowlist") {
    getAllowlist().then((list) => sendResponse({ list }));
    return true;
  }
  if (msg?.type === "add_allow") {
    // Manual add from the options page. We only persist the glob here — MV3
    // forbids chrome.permissions.request outside a user-gesture action
    // context, so the actual host permission is requested on first visit via
    // ensureAllowed().
    const glob = msg.glob;
    if (typeof glob !== "string" || !glob) {
      sendResponse({ ok: false, error: "missing glob" });
      return false;
    }
    getAllowlist().then((list) => {
      if (!list.includes(glob)) list.push(glob);
      setAllowlist(list).then(() => sendResponse({ ok: true, list }));
    });
    return true;
  }
  if (msg?.type === "remove_allow") {
    getAllowlist().then((list) => {
      const next = list.filter((g) => g !== msg.glob);
      setAllowlist(next).then(() => {
        const pattern = globToPermissionPattern(msg.glob);
        if (!pattern) {
          sendResponse({ ok: true, list: next, permissionRemoved: false });
          return;
        }
        chrome.permissions.remove({ origins: [pattern] }, (removed) => {
          sendResponse({
            ok: true,
            list: next,
            permissionRemoved: Boolean(removed),
            permissionError: chrome.runtime.lastError?.message,
          });
        });
      });
    });
    return true;
  }
  if (msg?.type === "get_status") {
    sendResponse({ nativeConnected: portOk });
    return false;
  }
  if (msg?.type === "capture_visible_tab") {
    // Content scripts can't call chrome.tabs.captureVisibleTab; proxy here.
    chrome.tabs.captureVisibleTab(undefined as any, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // async
  }
});

function globToPermissionPattern(glob: string): string | null {
  if (typeof glob !== "string" || !glob) return null;
  return glob.endsWith("/*") ? glob : glob + "*";
}

// ---- startup ---------------------------------------------------------------

chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
// Also connect eagerly when the SW wakes for any reason. connectNative is
// idempotent-ish: if a port already exists it creates a new one and the old
// is replaced.
connectNative();

export {};
