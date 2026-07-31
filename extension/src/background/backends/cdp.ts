// CdpBackend — the page backend used when cdpMode is on (ADR-0017). page_eval
// (plus scroll / wait / screenshot / storage) run through a persistent
// CdpSession (chrome.debugger) in the page's MAIN world via Runtime.evaluate,
// which bypasses page CSP.
//
// Reads (page_snapshot / page_text / page_links) and ref-based page_click /
// page_fill do NOT need the CSP bypass — reading/clicking the DOM works from a
// content script even on strict-CSP sites — and the content-script backend
// reads across same-origin sub-frames (ADR-0022). So those ops are delegated to
// it even in cdpMode, so iframe content works here too. Only page_eval
// genuinely needs CDP.

import type { OpArgs } from "../../shared/types";
import type { PageBackend } from "../page-backend";
import { maskSensitive, maskString } from "../../shared/masking";
import { truncate } from "../../content/util";
import { isDebuggable, type CdpSession, type EvaluateResponse } from "../cdp/session";
import { cdpRegistry } from "../cdp/registry";
import { pageScroll, pageWaitFor, readStorage } from "../cdp/page-fns";
import { ContentScriptBackend } from "./content-script";

// DOM read/act ops that don't need CDP's CSP bypass; delegated to the
// content-script backend so they span same-origin sub-frames (ADR-0022).
const FRAME_AWARE_OPS = new Set([
  "page_snapshot",
  "page_text",
  "page_links",
  "page_click",
  "page_fill",
]);
// Stateless; a private instance avoids a circular import with page-backend.ts.
const contentScriptReads = new ContentScriptBackend();

export class CdpBackend implements PageBackend {
  async run(op: string, args: OpArgs, tab: chrome.tabs.Tab): Promise<unknown> {
    // Reads + ref click/fill: delegate so they work across sub-frames (they
    // don't need CDP, and this reuses the content-script allFrames path).
    if (FRAME_AWARE_OPS.has(op)) {
      return await contentScriptReads.run(op, args, tab);
    }

    if (!isDebuggable(tab.url)) {
      throw new Error(
        `CDP mode cannot control this page (URL scheme not allowed): ${(tab.url || "").slice(0, 80)}`
      );
    }
    const session = await cdpRegistry.get(tab.id!);

    switch (op) {
      case "page_scroll":
        return await session.evaluate(pageScroll, [
          { direction: args.direction, pixels: args.pixels },
        ]);

      case "page_wait_for":
        try {
          return await session.evaluate(
            pageWaitFor,
            [
              {
                nav: args.nav,
                selector: args.selector,
                text: args.text,
                timeoutMs: args.timeoutMs,
                until: args.until,
                minCount: args.minCount,
                settled: args.settled,
              },
            ],
            { awaitPromise: true }
          );
        } catch (e) {
          // A successful navigation destroys the MAIN-world execution context,
          // which rejects the pending Runtime.evaluate. For a nav wait that IS
          // the success signal, so report it as matched (mirrors the content
          // path's { matched: true, nav: true }) instead of surfacing an error.
          const msg = String((e as Error)?.message || e);
          if (
            args.nav &&
            /context was destroyed|Cannot find context|Execution context/i.test(msg)
          ) {
            return { matched: true, nav: true };
          }
          throw e;
        }

      case "page_screenshot":
        return await session.screenshot();

      case "storage_get":
        return await this.storageGet(session, args);

      case "page_eval":
        return await this.pageEval(session, args);

      default:
        throw new Error(`CDP backend: unsupported op ${op}`);
    }
  }

  // storage_get: read raw values in the page, mask in the SW (always-on).
  private async storageGet(session: CdpSession, args: OpArgs): Promise<unknown> {
    const raw = (await session.evaluate(readStorage, [{ type: args.type, key: args.key }])) as
      | { key: string; found: false }
      | { key: string; found: true; value: string }
      | {
          type: string;
          entries: Record<string, string>;
          count: number;
          truncated: boolean;
          totalKeys: number;
        };
    if ("entries" in raw) {
      const masked: Record<string, string> = {};
      for (const k of Object.keys(raw.entries)) masked[k] = maskString(raw.entries[k]);
      return { ...raw, entries: masked };
    }
    if (raw.found) return { ...raw, value: maskString(raw.value) };
    return raw;
  }

  // page_eval: run in the MAIN world (gated by the per-tool disable; the
  // page_eval-specific toggle and per-call confirmation were removed).
  private async pageEval(session: CdpSession, args: OpArgs): Promise<unknown> {
    const code = args.code;
    if (typeof code !== "string" || !code.trim()) {
      throw new Error("page_eval needs non-empty `code`");
    }

    // Run the code as an async IIFE in the MAIN world. Unlike the content path
    // this does NOT use `new Function` (blocked by strict CSP) — CDP evaluates
    // it directly, which is the whole point of CDP mode.
    const expression = `(async () => {\n${code}\n})()`;
    const res: EvaluateResponse = await session.rawEvaluate(expression, { awaitPromise: true });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception;
      const description = ex?.description || res.exceptionDetails.text || "Error";
      return {
        __evalError: true,
        name: ex?.className || "Error",
        message: description.split("\n")[0],
        stack: truncate(description, 2000),
      };
    }
    // Always mask token-like values (the mask toggle was removed).
    return maskSensitive(res.result?.value);
  }
}
