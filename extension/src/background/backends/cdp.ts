// CdpBackend — the page backend used when cdpMode is on (ADR-0017). Every
// page-level op runs through a persistent CdpSession (chrome.debugger) in the
// page's MAIN world via Runtime.evaluate, which bypasses page CSP. The DOM work
// is the portable functions in cdp/page-fns.ts; settings gates and masking are
// handled here in the SW so they match the content-script path.

import type { OpArgs } from "../../shared/types";
import type { PageBackend } from "../page-backend";
import { maskSensitive, maskString, maskPatterns } from "../../shared/masking";
import { truncate } from "../../content/util";
import { ensureAllowed } from "../allowlist-store";
import { isDebuggable, type CdpSession, type EvaluateResponse } from "../cdp/session";
import { cdpRegistry } from "../cdp/registry";
import {
  REF_ATTR,
  pageSnapshot,
  pageText,
  pageLinks,
  pageScroll,
  pageWaitFor,
  readStorage,
  doClick,
  doFill,
} from "../cdp/page-fns";

export class CdpBackend implements PageBackend {
  async run(op: string, args: OpArgs, tab: chrome.tabs.Tab): Promise<unknown> {
    // Preserve dispatch's ordering: allowlist check, then do the work.
    await ensureAllowed(tab.url);
    if (!isDebuggable(tab.url)) {
      throw new Error(
        `CDP mode cannot control this page (URL scheme not allowed): ${(tab.url || "").slice(0, 80)}`
      );
    }
    const session = await cdpRegistry.get(tab.id!);

    switch (op) {
      case "page_snapshot":
        // Now async (settle+retry when empty), so await the page-side promise.
        return await session.evaluate(pageSnapshot, [REF_ATTR], { awaitPromise: true });

      case "page_text":
        return await session.evaluate(pageText, [{ mode: args.mode }]);

      case "page_links":
        return await this.pageLinks(session, args);

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

      case "page_fill":
        return await session.evaluate(doFill, [
          REF_ATTR,
          { ref: args.ref, selector: args.selector, value: args.value },
        ]);

      case "page_click":
        return await this.click(session, args);

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

  // page_links: read raw hrefs in the page, mask them in the SW with the
  // credential-pattern catalogue (tokens/JWT/long-hex redacted; emails/phones
  // preserved), mirroring the content path's use of maskPatterns.
  private async pageLinks(session: CdpSession, args: OpArgs): Promise<unknown> {
    const raw = (await session.evaluate(pageLinks, [args.type])) as {
      links: Array<{ text: string; href: string; type: string }>;
      count: number;
      url: string;
    };
    return {
      ...raw,
      links: raw.links.map((l) => ({ ...l, href: maskPatterns(l.href) })),
    };
  }

  // page_click runs directly; the per-site allowlist (checked in run()) is the
  // gate.
  private async click(session: CdpSession, args: OpArgs): Promise<unknown> {
    return await session.evaluate(doClick, [REF_ATTR, { ref: args.ref, selector: args.selector }]);
  }

  // page_eval: run in the MAIN world (gated by the per-tool disable + allowlist;
  // the page_eval-specific toggle and per-call confirmation were removed).
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
