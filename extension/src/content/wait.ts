// page_wait_for — resolve when a selector appears, text appears, or the page
// finishes navigating, or reject on timeout.

export function waitFor(args: any) {
  const timeoutMs = args.timeoutMs ?? 30000;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let done = false;
    const onLoad = () => {
      if (args.nav) {
        finish(resolve, {
          matched: true,
          nav: true,
          url: location.href,
          readyState: document.readyState,
        });
      }
    };
    const finish = (fn: any, value: any) => {
      if (done) return;
      done = true;
      window.removeEventListener("load", onLoad, true);
      fn(value);
    };
    if (args.nav) {
      if (document.readyState === "complete") {
        return finish(resolve, {
          matched: true,
          nav: true,
          url: location.href,
          readyState: document.readyState,
        });
      }
      window.addEventListener("load", onLoad, true);
    }
    const tick = () => {
      if (done) return;
      if (args.selector) {
        if (document.querySelector(args.selector)) {
          return finish(resolve, { matched: true, selector: args.selector });
        }
      }
      if (args.text) {
        if ((document.body.innerText || "").includes(args.text)) {
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
