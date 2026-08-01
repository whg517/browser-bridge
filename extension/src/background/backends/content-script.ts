// ContentScriptBackend — the DEFAULT page backend (cdpMode off): inject the
// content script, message it, and surface `__error` as a throw.
//
// It also orchestrates allFrames reading (default-on): page_snapshot / page_text
// / page_links aggregate same-origin sub-frames, and page_click / page_fill
// route a frame-qualified ref (f<N>:e…) back to its frame. All frame logic lives
// here in the SW; the content script stays frame-agnostic (per-document).

import type { OpArgs, PageResponse } from "../../shared/types";
import type { PageBackend } from "../page-backend";
import { injectIfNeeded, injectAllFrames, enumerateFrames } from "../tabs";
import {
  TOP_FRAME,
  parseFrameRef,
  qualifyRefEcho,
  mergeSnapshot,
  mergeText,
  mergeLinks,
  type FrameResult,
} from "../frames";

const READ_OPS = new Set(["page_snapshot", "page_text", "page_links"]);
const REF_OPS = new Set(["page_click", "page_fill"]);

export class ContentScriptBackend implements PageBackend {
  async run(op: string, args: OpArgs, tab: chrome.tabs.Tab): Promise<unknown> {
    await injectIfNeeded(tab.id!);
    const tabId = tab.id!;

    // A click/fill carrying a frame-qualified ref routes to that sub-frame.
    if (REF_OPS.has(op)) {
      const parsed = parseFrameRef(args.ref);
      if (parsed) return await this.runInFrame(tabId, op, args, parsed);
      return await this.send(tabId, TOP_FRAME, op, args);
    }

    // Read ops aggregate sub-frames (default-on).
    if (READ_OPS.has(op)) {
      const merged = await this.runReadAcrossFrames(tabId, op, args);
      if (merged !== undefined) return merged;
    }

    // Everything else (and single-frame reads) → top frame only.
    return await this.send(tabId, TOP_FRAME, op, args);
  }

  // Send one op to exactly one frame. The frameId is ALWAYS explicit: omitting
  // it makes chrome.tabs.sendMessage broadcast to every frame in the tab and
  // resolve with whichever one answers first. Once a read op has run
  // injectAllFrames, every frame carries a listener, so a broadcast would run
  // the op N times and return an arbitrary frame's answer — page_screenshot
  // blew past Chrome's 2/sec captureVisibleTab throttle, page_scroll scrolled
  // sub-frames and reported their scrollY, and page_eval executed in every
  // frame. Keep this parameter required.
  private async send(
    tabId: number,
    frameId: number,
    op: string,
    args: OpArgs
  ): Promise<PageResponse> {
    const resp = (await chrome.tabs.sendMessage(
      tabId,
      { op, args, tabId },
      { frameId }
    )) as PageResponse;
    if (resp && resp.__error) throw new Error(resp.__error);
    return resp;
  }

  // Route a click/fill to the sub-frame named by an f<N>: ref.
  private async runInFrame(
    tabId: number,
    op: string,
    args: OpArgs,
    parsed: { frameId: number; bareRef: string }
  ): Promise<unknown> {
    const frames = await enumerateFrames(tabId);
    const frame = frames.find((f) => f.frameId === parsed.frameId);
    if (!frame) {
      throw new Error(`frame ${parsed.frameId} is not available — re-run page_snapshot`);
    }
    await injectAllFrames(tabId);
    const resp = await this.send(tabId, parsed.frameId, op, { ...args, ref: parsed.bareRef });
    // The frame answers with the bare ref it was handed ("e2"); echo back the
    // frame-qualified ref the caller passed ("f7:e2") so the reply names the
    // element that was actually acted on and not the top frame's "e2".
    return qualifyRefEcho(resp, parsed.frameId, parsed.bareRef);
  }

  // Run a read op in the top frame + every sub-frame, then merge. Returns
  // undefined when there are no readable sub-frames, so the caller falls back to
  // the plain top-frame path (no ref prefixing for a single-frame page).
  private async runReadAcrossFrames(
    tabId: number,
    op: string,
    args: OpArgs
  ): Promise<unknown | undefined> {
    const frames = await enumerateFrames(tabId);
    const subs = frames.filter((f) => f.frameId !== TOP_FRAME); // top handled separately
    if (subs.length === 0) return undefined;

    await injectAllFrames(tabId);
    const top = (await this.send(tabId, TOP_FRAME, op, args)) as unknown as FrameResult["data"];
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
