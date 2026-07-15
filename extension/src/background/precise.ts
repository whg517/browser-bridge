// page_snapshot_precise — Chrome's authoritative accessibility tree via the
// debugger API (CDP). More accurate than the content-script snapshot (shadow
// DOM, complex ARIA) but briefly shows the "Started debugging this browser"
// infobar on EVERY tab while attached. We attach → fetch tree → tag elements →
// detach within one handler so the infobar only flashes (~1s). The user is
// warned via an informational toast before attach. See ADR-0009.

import type { OpArgs, PageResponse } from "../shared/types";
import { getSetting } from "../shared/settings";
import { ensureAllowed } from "./allowlist-store";
import { resolveTargetTab, injectIfNeeded } from "./tabs";
// The chrome.debugger primitives + the non-debuggable URL filter now live in
// the CdpSession facade (ADR-0017); precise.ts reuses them rather than keeping
// its own private copies.
import { dbgAttach, dbgDetach, dbgSend, isDebuggable } from "./cdp/session";
import { cdpRegistry } from "./cdp/registry";

// The subset of the CDP payloads we actually read (not the full protocol).
interface AXValueLike {
  value?: unknown;
}
interface AXNode {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: AXValueLike;
  name?: AXValueLike;
}
interface AXTreeResult {
  nodes?: AXNode[];
}
interface ResolveNodeResult {
  object?: { objectId?: string };
}
interface NodeDescriptor {
  tag?: string;
  id?: string;
  name?: string;
  value?: string;
}
interface CallFunctionResult {
  result?: { value?: NodeDescriptor };
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

function axValue(v: AXValueLike | undefined): unknown {
  // AXValue shapes: {type:"string", value:"..."} or plain value.
  if (v && typeof v === "object" && "value" in v) return v.value;
  return v;
}

export async function snapshotPrecise(maybeTabId: number | undefined, _args: OpArgs) {
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
  let proceed: boolean | PageResponse = true; // default: proceed (skip warning)
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
  if (proceed === false || (proceed && (proceed as PageResponse).__cancelled)) {
    return { cancelled: true };
  }
  if (proceed && (proceed as PageResponse).__error) {
    // Info toast failed (e.g. restricted page); proceed without warning.
    console.warn("[bb] info toast failed:", (proceed as PageResponse).__error);
  }

  // In CDP mode (ADR-0017) the registry may already hold a persistent debugger
  // attach on this tab. A second attach from the same extension would fail, so
  // reuse the existing one and do NOT detach it here (that would tear down the
  // persistent session). When CDP mode is off the registry is always empty, so
  // this branch is never taken and the attach/detach path below is byte-for-byte
  // the original behavior.
  const reusingAttach = cdpRegistry.hasSession(tab.id!);

  // Attach. On "another debugger attached" we surface a helpful error.
  if (!reusingAttach) {
    try {
      await dbgAttach(tab.id!);
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (/another debugger/i.test(msg)) {
        throw new Error(
          "该标签页已打开 DevTools,page_snapshot_precise 无法附加。请关闭 DevTools 后重试。",
          { cause: e }
        );
      }
      throw e;
    }
  }

  // From here on we MUST detach on every exit path (unless we're reusing the
  // registry's persistent attach).
  try {
    const tree = await dbgSend<AXTreeResult>(tab.id!, "Accessibility.getFullAXTree", {});
    const nodes = tree.nodes ?? [];

    // Filter: only interactive, non-ignored nodes with a DOM handle.
    const candidates = nodes.filter((n) => {
      if (n.ignored) return false;
      if (!n.backendDOMNodeId) return false; // virtual nodes (markers, root)
      const role = axValue(n.role);
      if (!role) return false;
      if (!PRECISE_INTERACTIVE_ROLES.has(role as string)) return false;
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
      let descriptor: NodeDescriptor;
      try {
        const resolved = await dbgSend<ResolveNodeResult>(tab.id!, "DOM.resolveNode", {
          backendNodeId: n.backendDOMNodeId,
        });
        const objectId = resolved.object?.objectId;
        if (!objectId) continue;
        // Tag the element AND read back a selector/id hint in one call.
        const callRes = await dbgSend<CallFunctionResult>(tab.id!, "Runtime.callFunctionOn", {
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
        descriptor = callRes.result?.value ?? {};
      } catch (e) {
        // Node may have been removed between getFullAXTree and resolve.
        console.warn("[bb] precise: skip node", ref, (e as Error).message);
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
    if (!reusingAttach) await dbgDetach(tab.id!);
  }
}

function truncateUrl(u: string | undefined) {
  return (u || "").slice(0, 80);
}
function truncateAx(s: unknown): unknown {
  if (typeof s !== "string") return s;
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}
