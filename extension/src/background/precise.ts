// page_snapshot_precise — Chrome's authoritative accessibility tree via the
// debugger API (CDP). More accurate than the content-script snapshot (shadow
// DOM, complex ARIA) but briefly shows the "Started debugging this browser"
// infobar on EVERY tab while attached. We attach → fetch tree → tag elements →
// detach within one handler so the infobar only flashes (~1s). The user is
// warned via an informational toast before attach. See ADR-0009.

import { getSetting } from "../shared/settings";
import { ensureAllowed } from "./allowlist-store";
import { resolveTargetTab, injectIfNeeded } from "./tabs";

// URLs the debugger cannot attach to. Filter before calling attach.
const NON_DEBUGGABLE = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^view-source:/i,
  /^about:/i,
  /^edge:\/\//i,
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
  "button",
  "link",
  "checkbox",
  "radio",
  "textbox",
  "searchbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "combobox",
  "listbox",
  "option",
  "switch",
  "treeitem",
  "menuItem",
  "spinButton",
  "slider",
]);

function axValue(v: any): any {
  // AXValue shapes: {type:"string", value:"..."} or plain value.
  if (v && typeof v === "object" && "value" in v) return v.value;
  return v;
}

export async function snapshotPrecise(maybeTabId: number | undefined, _args: any) {
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
    proceed = await chrome.tabs
      .sendMessage(tab.id!, {
        op: "_info_toast",
        args: {
          message: "即将精确扫描页面 — Chrome 顶部会显示『调试中』横幅,扫描后自动消失(约 1 秒)。",
        },
      })
      .catch(() => true /* content script missing → proceed anyway */);
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
      throw new Error(
        "该标签页已打开 DevTools,page_snapshot_precise 无法附加。请关闭 DevTools 后重试。"
      );
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
        selector: descriptor.tag ? descriptor.tag + descriptor.id : undefined,
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
