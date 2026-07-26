// page_wait_for — resolve when a selector appears, text appears, or the page
// finishes navigating, or reject on timeout.

import type { OpArgs } from "../shared/types";

export function waitFor(args: OpArgs) {
  const timeoutMs = args.timeoutMs ?? 30000;
  // Readiness level for `nav`: "load" (default, full page load — back-compat) or
  // "domcontentloaded" (DOM parsed). domcontentloaded fixes nav waits that hung
  // on heavy pages that are usable long before `load` fires (#79).
  const until = args.until === "domcontentloaded" ? "domcontentloaded" : "load";
  // With `selector`, resolve once at least this many match (default 1) — lets an
  // agent wait for a list/grid to populate, not just its first row (#88).
  const minCount = args.minCount && args.minCount > 0 ? args.minCount : 1;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let done = false;
    let observer: MutationObserver | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
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
      if (observer) observer.disconnect();
      clearTimeout(quietTimer);
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
    // `settled`: resolve once the DOM stops mutating for a quiet window. The
    // portable SPA/lazy-content signal when no selector/text/nav is known — a
    // hash route fires no navigation but does mutate the DOM (#88).
    if (args.settled) {
      const QUIET_MS = 500;
      const onSettled = () => finish(resolve, { matched: true, settled: true, url: location.href });
      observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(onSettled, QUIET_MS);
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      quietTimer = setTimeout(onSettled, QUIET_MS); // resolve if already quiet
    }
    const tick = () => {
      if (done) return;
      if (args.selector) {
        const matches = document.querySelectorAll(args.selector);
        if (matches.length >= minCount) {
          return finish(resolve, {
            matched: true,
            selector: args.selector,
            count: matches.length,
          });
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
