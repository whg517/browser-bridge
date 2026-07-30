// ContentScriptBackend — the DEFAULT page backend (cdpMode off): inject the
// content script, message it, and surface `__error` as a throw.
//
// It also orchestrates allFrames reading (default-on): page_snapshot / page_text
// / page_links aggregate same-origin sub-frames, and page_click / page_fill
// route a frame-qualified ref (f<N>:e…) back to its frame. All frame logic lives
// here in the SW; the content script stays frame-agnostic (per-document).

import type { OpArgs, PageResponse } from "../../shared/types";
import type { PageBackend } from "../page-backend";
import { ensureAllowed, isAllowed } from "../allowlist-store";
import { injectIfNeeded, injectAllFrames, enumerateFrames } from "../tabs";
import { parseFrameRef, mergeSnapshot, mergeText, mergeLinks, type FrameResult } from "../frames";

const READ_OPS = new Set(["page_snapshot", "page_text", "page_links"]);
const REF_OPS = new Set(["page_click", "page_fill"]);

export class ContentScriptBackend implements PageBackend {
  async run(op: string, args: OpArgs, tab: chrome.tabs.Tab): Promise<unknown> {
    await ensureAllowed(tab.url); // gates the TOP origin (may prompt)
    await injectIfNeeded(tab.id!);
    const tabId = tab.id!;

    // A click/fill carrying a frame-qualified ref routes to that sub-frame.
    if (REF_OPS.has(op)) {
      const parsed = parseFrameRef(args.ref);
      if (parsed) return await this.runInFrame(tabId, op, args, parsed);
      return await this.send(tabId, undefined, op, args);
    }

    // Read ops aggregate same-origin sub-frames (default-on).
    if (READ_OPS.has(op)) {
      const merged = await this.runReadAcrossFrames(tabId, op, args);
      if (merged !== undefined) return merged;
    }

    // Everything else (and single-frame reads) → top frame only.
    return await this.send(tabId, undefined, op, args);
  }

  // Send one op to one frame (undefined frameId = top frame).
  private async send(
    tabId: number,
    frameId: number | undefined,
    op: string,
    args: OpArgs
  ): Promise<PageResponse> {
    const opts = frameId === undefined ? {} : { frameId };
    const resp = (await chrome.tabs.sendMessage(tabId, { op, args, tabId }, opts)) as PageResponse;
    if (resp && resp.__error) throw new Error(resp.__error);
    return resp;
  }

  // Route a click/fill to the sub-frame named by an f<N>: ref. Defense in depth:
  // only act in a frame whose origin is allowlisted (a snapshot only emits refs
  // for gated frames, but don't trust a fabricated ref).
  private async runInFrame(
    tabId: number,
    op: string,
    args: OpArgs,
    parsed: { frameId: number; bareRef: string }
  ): Promise<unknown> {
    const frames = await enumerateFrames(tabId);
    const frame = frames.find((f) => f.frameId === parsed.frameId);
    if (!frame || !(await isAllowed(frame.url))) {
      throw new Error(
        `frame ${parsed.frameId} is not available or not allowlisted — re-run page_snapshot`
      );
    }
    await injectAllFrames(tabId);
    return await this.send(tabId, parsed.frameId, op, { ...args, ref: parsed.bareRef });
  }

  // Run a read op in the top frame + every allowlisted sub-frame, then merge.
  // Returns undefined when there are no readable sub-frames, so the caller falls
  // back to the plain top-frame path (no ref prefixing for a single-frame page).
  private async runReadAcrossFrames(
    tabId: number,
    op: string,
    args: OpArgs
  ): Promise<unknown | undefined> {
    const frames = await enumerateFrames(tabId);
    const subs: Array<{ frameId: number; url: string }> = [];
    for (const f of frames) {
      if (f.frameId === 0) continue; // top handled separately
      if (await isAllowed(f.url)) subs.push(f);
    }
    if (subs.length === 0) return undefined;

    await injectAllFrames(tabId);
    const top = (await this.send(tabId, 0, op, args)) as unknown as FrameResult["data"];
    const results: FrameResult[] = [];
    for (const f of subs) {
      try {
        results.push({
          frameId: f.frameId,
          url: f.url,
          data: (await this.send(tabId, f.frameId, op, args)) as unknown as FrameResult["data"],
        });
      } catch {
        // Frame vanished or refused injection between enumerate and send → skip.
      }
    }
    if (op === "page_snapshot") return mergeSnapshot(top, results);
    if (op === "page_text") return mergeText(top, results);
    return mergeLinks(top, results);
  }
}
