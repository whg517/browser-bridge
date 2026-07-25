// page_wait_for — resolve when a selector appears, text appears, or the page
// finishes navigating, or reject on timeout.

import type { OpArgs } from "../shared/types";

export function waitFor(args: OpArgs) {
  const timeoutMs = args.timeoutMs ?? 30000;
  // Readiness level for `nav`: "load" (default, full page load — back-compat) or
  // "domcontentloaded" (DOM parsed). domcontentloaded fixes nav waits that hung
  // on heavy pages that are usable long before `load` fires (#79).
  const until = args.until === "domcontentloaded" ? "domcontentloaded" : "load";
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let done = false;
    const navResult = () => ({
      matched: true,
      nav: true,
      url: location.href,
      readyState: document.readyState,
    });
    const onReady = () => finish(resolve, navResult());
    const finish = (fn: any, value: any) => {
      if (done) return;
      done = true;
      window.removeEventListener("load", onReady, true);
      document.removeEventListener("DOMContentLoaded", onReady, true);
      fn(value);
    };
    if (args.nav) {
      if (until === "domcontentloaded") {
        if (document.readyState !== "loading") return finish(resolve, navResult());
        document.addEventListener("DOMContentLoaded", onReady, true);
      } else {
        if (document.readyState === "complete") return finish(resolve, navResult());
        window.addEventListener("load", onReady, true);
      }
    }
    const tick = () => {
      if (done) return;
      if (args.selector) {
        if (document.querySelector(args.selector)) {
          return finish(resolve, { matched: true, selector: args.selector });
        }
      }
      if (args.text) {
        if ((document.body?.innerText || "").includes(args.text)) {
          return finish(resolve, { matched: true, text: args.text });
        }
      }
      if (Date.now() - start > timeoutMs) {
        return finish(reject, new Error(`wait_for timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}
