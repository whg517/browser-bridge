// ContentScriptBackend — the DEFAULT page backend (cdpMode off): inject the
// content script, message it, and surface `__error` as a throw.
//
// It also orchestrates allFrames reading (default-on): page_snapshot / page_text
// / page_links aggregate same-origin sub-frames, and page_click / page_fill
// route a frame-qualified ref (f<N>:e…) back to its frame. All frame logic lives
// here in the SW; the content script stays frame-agnostic (per-document).

import type { OpArgs, PageResponse } from "../../shared/types";
import { BridgeError } from "../../shared/bridge-error";
import type { PageBackend } from "../page-backend";
import { injectIfNeeded, injectAllFrames, enumerateFrames } from "../tabs";
import {
  TOP_FRAME,
  parseFrameRef,
  isPreciseRef,
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
    // tabId targeting (ADR-0028 Phase 1a) makes "target is not what the user
    // is looking at" a routine state, and this backend's page_screenshot goes
    // through chrome.tabs.captureVisibleTab — a WINDOW-global API that always
    // photographs whichever tab is visible, target or not. A silent picture of
    // the wrong tab is worse than an error, so refuse and name the way out.
    // The CDP backend screenshots its own tab via Page.captureScreenshot and
    // handles background tabs fine.
    if (op === "page_screenshot" && typeof tab.windowId === "number") {
      const [visible] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      // An empty answer fails open: captureVisibleTab will report its own
      // error, and this guard's job is the wrong-tab picture, not harness
      // edges where no visible tab is enumerable.
      if (visible && visible.id !== tab.id) {
        throw new BridgeError(
          "UNSUPPORTED_PAGE",
          "page_screenshot on a background tab needs CDP mode: the content-script path " +
            "uses chrome.tabs.captureVisibleTab, which can only capture the tab the user " +
            "is looking at."
        );
      }
    }
    await injectIfNeeded(tab.id!);
    const tabId = tab.id!;

    // A click/fill carrying a frame-qualified ref routes to that sub-frame.
    if (REF_OPS.has(op)) {
      const parsed = parseFrameRef(args.ref);
      if (parsed) return await this.runInFrame(tabId, op, args, parsed);
      if (isPreciseRef(args.ref)) return await this.runPreciseRef(tabId, op, args);
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

  /**
   * Route a click/fill carrying a PRECISE ref (`p7`) to whichever frame holds it.
   *
   * `page_snapshot_precise` tags elements through CDP, whose frame ids are
   * opaque strings from a different id space than the numeric ids
   * `chrome.tabs.sendMessage` wants — so a precise ref cannot be pre-qualified
   * with `f<N>:` the way content-script refs are. What it *can* rely on is that
   * the precise counter is global across frames, so `p7` names exactly one
   * element in the tab.
   *
   * So: try the top frame, then each sub-frame, and take the one that finds it.
   * Uniqueness makes that unambiguous. Before this, a precise ref was always
   * sent to the top frame, so anything the snapshot found inside an iframe was
   * listed but not actionable (#113).
   */
  private async runPreciseRef(tabId: number, op: string, args: OpArgs): Promise<unknown> {
    try {
      return await this.send(tabId, TOP_FRAME, op, args);
    } catch (topErr) {
      const frames = await enumerateFrames(tabId);
      const subs = frames.filter((f) => f.frameId !== TOP_FRAME);
      if (subs.length === 0) throw topErr;
      await injectAllFrames(tabId);
      for (const f of subs) {
        try {
          return await this.send(tabId, f.frameId, op, args);
        } catch {
          // Not in this frame either — keep looking.
        }
      }
      // Report the TOP frame's error: it is the one describing the ref itself
      // ("unknown ref"), rather than an incidental failure from the last frame.
      throw topErr;
    }
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
