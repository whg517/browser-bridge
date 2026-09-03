// page_snapshot_precise — Chrome's authoritative accessibility tree via the
// debugger API (CDP). More accurate than the content-script snapshot (shadow
// DOM, complex ARIA) but briefly shows the "Started debugging this browser"
// infobar on EVERY tab while attached. We attach → fetch tree → tag elements →
// detach within one handler so the infobar only flashes (~1s). The user is
// warned via an informational toast before attach. See ADR-0009.

import type { OpArgs, PageResponse } from "../shared/types";
import { resolveTargetTab, injectIfNeeded } from "./tabs";
// The chrome.debugger primitives + the non-debuggable URL filter now live in
// the CdpSession facade (ADR-0017); precise.ts reuses them rather than keeping
// its own private copies.
import { assertDrivable, dbgAttach, dbgDetach, dbgSend } from "./cdp/session";
import { cdpRegistry } from "./cdp/registry";
import { t, initI18n } from "../shared/i18n";
import { flattenFrameTree, type CdpFrame, type CdpFrameTree } from "./frames";

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
interface FrameTreeResult {
  frameTree?: CdpFrameTree;
}
interface ResolveNodeResult {
  object?: { objectId?: string };
}
interface NodeDescriptor {
  tag?: string;
  id?: string;
  name?: string;
  value?: string;
  checked?: boolean;
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

// Runs in the page (via Runtime.callFunctionOn) against one resolved element:
// tags it with its ref and reports the descriptor fields the snapshot needs.
// Exported as a string so it can be unit-tested without a debugger session.
//
// Masking happens HERE, in the page, so a password never crosses back into the
// extension at all — matching the content-script (content/snapshot.ts) and CDP
// (cdp/page-fns.ts) snapshots, which have always masked it.
export const NODE_DESCRIPTOR_FN =
  "function(ref) {" +
  "  this.setAttribute('data-zcb-ref', ref);" +
  "  var id = this.id ? '#' + this.id : '';" +
  "  var tag = (this.tagName || '').toLowerCase();" +
  "  var type = String(this.type || '').toLowerCase();" +
  "  var value;" +
  "  if (type === 'password') { value = this.value ? '••••••' : ''; }" +
  // A checkbox/radio's `value` is the submit payload ("on" by default), not its
  // state — reporting it reads as "checked". Report `checked` instead.
  "  else if (type === 'checkbox' || type === 'radio') { value = undefined; }" +
  "  else if (this.value !== undefined) { value = String(this.value).slice(0,60); }" +
  "  return { tag: tag, id: id, name: this.getAttribute('name') || '', value: value," +
  "    checked: (type === 'checkbox' || type === 'radio') ? !!this.checked : undefined };" +
  "}";

function axValue(v: AXValueLike | undefined): unknown {
  // AXValue shapes: {type:"string", value:"..."} or plain value.
  if (v && typeof v === "object" && "value" in v) return v.value;
  return v;
}

export async function snapshotPrecise(
  maybeTabId: number | undefined,
  _args: OpArgs,
  client = "solo"
) {
  const tab = await resolveTargetTab(maybeTabId, client);

  assertDrivable(tab.url, "page_snapshot_precise cannot debug this page");

  // Warn the user via an informational toast in the page. Proceed unless they
  // actively cancel within the timeout. (Always shown — the toggle was removed.)
  await injectIfNeeded(tab.id!);
  await initI18n(); // resolve the UI language for the toast strings
  const proceed: boolean | PageResponse = await chrome.tabs
    .sendMessage(tab.id!, {
      op: "_info_toast",
      args: {
        message: t("toast_precise_body"),
        toastCancel: t("btn_cancel"),
      },
    })
    .catch(() => true /* content script missing → proceed anyway */);
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
          "This tab has DevTools open, so page_snapshot_precise cannot attach. Please close DevTools and try again.",
          { cause: e }
        );
      }
      throw e;
    }
  }

  // From here on we MUST detach on every exit path (unless we're reusing the
  // registry's persistent attach).
  try {
    // Walk every frame, not just the top document. Without this the CDP backend
    // silently returns a fraction of a framed page (#113).
    let frames: CdpFrame[] = [];
    try {
      const ft = await dbgSend<FrameTreeResult>(tab.id!, "Page.getFrameTree", {});
      frames = flattenFrameTree(ft.frameTree);
    } catch (e) {
      console.warn("[bb] precise: frame tree unavailable, top frame only:", (e as Error).message);
    }
    if (frames.length === 0) frames = [{ id: "", url: tab.url }];

    const out: Array<Record<string, unknown>> = [];
    let idx = 0;
    const skipped: string[] = [];

    for (const [i, frame] of frames.entries()) {
      const isTop = i === 0;
      let tree: AXTreeResult;
      try {
        // Omit frameId for the top frame: that is the long-standing call shape,
        // and it keeps single-frame pages byte-for-byte as before.
        tree = await dbgSend<AXTreeResult>(
          tab.id!,
          "Accessibility.getFullAXTree",
          isTop || !frame.id ? {} : { frameId: frame.id }
        );
      } catch (e) {
        // A cross-origin frame is an out-of-process target (OOPIF); a tab-level
        // attach cannot read it. Skip it and SAY SO rather than silently
        // returning a short tree — being quietly incomplete is the whole bug.
        skipped.push(frame.url || frame.id);
        console.warn("[bb] precise: skip frame", frame.url, (e as Error).message);
        continue;
      }
      idx = await collectFrame(tab.id!, tree, out, idx, isTop ? undefined : frame.url);
    }

    return {
      refCount: out.length,
      nodes: out,
      url: tab.url,
      title: tab.title,
      precise: true,
      ...(skipped.length
        ? {
            note:
              `${skipped.length} frame(s) could not be read (cross-origin/out-of-process): ` +
              `${skipped.slice(0, 3).join(", ")}. Their elements are missing from this ` +
              `snapshot — page_snapshot reads those frames and may be more complete here.`,
          }
        : {}),
    };
  } finally {
    if (!reusingAttach) await dbgDetach(tab.id!);
  }
}

/**
 * Tag one frame's interactive nodes and append them to `out`.
 * Returns the updated ref counter, so refs stay unique across frames.
 *
 * `frameUrl` is undefined for the top frame; sub-frame nodes carry it in
 * `frame`, matching the shape the content-script backend merges (frames.ts).
 */
async function collectFrame(
  tabId: number,
  tree: AXTreeResult,
  out: Array<Record<string, unknown>>,
  startIdx: number,
  frameUrl: string | undefined
): Promise<number> {
  // Filter: only interactive, non-ignored nodes with a DOM handle.
  const candidates = (tree.nodes ?? []).filter((n) => {
    if (n.ignored) return false;
    if (!n.backendDOMNodeId) return false; // virtual nodes (markers, root)
    const role = axValue(n.role);
    if (!role) return false;
    if (!PRECISE_INTERACTIVE_ROLES.has(role as string)) return false;
    return true;
  });

  // Tag each element with a stable ref and collect its descriptor. Refs use a
  // `p` prefix to avoid colliding with content-script `e` refs, and the counter
  // is threaded across frames so `p7` names exactly one element in the tab —
  // that global uniqueness is what lets a click find it without knowing which
  // frame it lives in (see ContentScriptBackend's precise-ref fallback).
  // We batch resolveNode+callFunctionOn per node; for very large pages this is
  // N round-trips, acceptable since interactive nodes are few.
  let idx = startIdx;
  for (const n of candidates) {
    idx += 1;
    const ref = `p${idx}`;
    let descriptor: NodeDescriptor;
    try {
      const resolved = await dbgSend<ResolveNodeResult>(tabId, "DOM.resolveNode", {
        backendNodeId: n.backendDOMNodeId,
      });
      const objectId = resolved.object?.objectId;
      if (!objectId) continue;
      // Tag the element AND read back a selector/id hint in one call.
      const callRes = await dbgSend<CallFunctionResult>(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: NODE_DESCRIPTOR_FN,
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
      checked: descriptor.checked,
      // Mirrors the content-script merge (frames.ts): sub-frame nodes name the
      // frame they came from; top-frame nodes omit the field entirely.
      ...(frameUrl ? { frame: frameUrl } : {}),
    });
  }
  return idx;
}

function truncateAx(s: unknown): unknown {
  if (typeof s !== "string") return s;
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}
