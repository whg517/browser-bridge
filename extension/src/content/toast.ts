// In-page informational toast: a non-blocking notice (e.g. "the debugger is
// about to attach, the infobar will flash briefly"). It auto-proceeds after a
// short timeout unless the user presses Cancel.

// Body + button label are localized in the SW (the toast runs in the page world
// where reading the language setting is awkward); "Browser Bridge" is the brand.
export function showInfoToast(opts: { message: string; cancel?: string }) {
  return new Promise((resolve) => {
    const host = ensureToastHost();
    const card = document.createElement("div");
    card.className = "zcb-toast-card zcb-info-card";
    card.innerHTML = `
        <div class="zcb-info-title">Browser Bridge</div>
        <div class="zcb-info-text"></div>
        <div class="zcb-info-actions">
          <button class="zcb-info-cancel"></button>
        </div>`;
    card.querySelector(".zcb-info-text")!.textContent = opts.message;
    card.querySelector(".zcb-info-cancel")!.textContent = opts.cancel || "Cancel";
    host.appendChild(card);

    let done = false;
    // Resolve only AFTER the card leaves the DOM. Resolving first let the caller
    // resume during the 150ms exit animation, while this toast was still a real
    // element in the page — and page_snapshot_precise, which awaits this very
    // promise before reading the accessibility tree, captured its own Cancel
    // button as a page control on every call (#132). The exit animation is a
    // presentation detail; no caller should be able to observe the extension's
    // own UI as page content.
    const finish = (proceed: boolean) => {
      if (done) return;
      done = true;
      card.classList.add("zcb-toast-out");
      setTimeout(() => {
        card.remove();
        resolve(proceed);
      }, 150);
    };
    card.querySelector<HTMLElement>(".zcb-info-cancel")!.onclick = () => finish(false);
    // Auto-proceed after 8s (informational, not a confirmation gate).
    setTimeout(() => finish(true), 8000);
  });
}

function ensureToastHost() {
  let host = document.getElementById("__zcb_toast_host");
  if (!host) {
    host = document.createElement("div");
    host.id = "__zcb_toast_host";
    // Inline critical styles so it shows even if toast.css didn't load.
    host.style.cssText =
      "position:fixed;top:16px;right:16px;z-index:2147483647;" +
      "display:flex;flex-direction:column;gap:8px;pointer-events:none;";
    (document.body || document.documentElement).appendChild(host);
  }
  return host;
}
