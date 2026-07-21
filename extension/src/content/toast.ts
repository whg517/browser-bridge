// In-page confirmation UI (ADR-0006 / ADR-0008): the high-risk click toast,
// the enlarged page_eval toast, and the informational toast. Also owns the
// same-origin grace window shared by click and eval confirmations.

import { getSetting } from "../shared/settings";
import { truncate } from "./util";
import { roleOf, nameOf } from "./snapshot";

// Short-circuit window: a 60s window during which the same kind of high-risk
// action on the same origin doesn't re-prompt.
let lastConfirmed: { key: string | null; until: number } = { key: null, until: 0 };

export async function confirmWithToast(question: string, actionDesc: string) {
  const key = `${location.origin}:${actionDesc}`;
  const graceMs = await getSetting("confirmGraceMs");
  if (graceMs > 0 && lastConfirmed.key === key && Date.now() < lastConfirmed.until) {
    return; // within the grace window
  }
  const approved = await showToast(question);
  if (!approved) throw new Error(`user denied: ${actionDesc}`);
  lastConfirmed = { key, until: Date.now() + graceMs };
}

// Eval confirmation: enlarged Toast with the full code shown. Shares the same
// lastConfirmed grace window as click/etc. The key is `origin:eval`. Risk note
// (ADR-0008): within the 60s window, ANY new eval code on the same origin runs
// silently — accept this because eval is not meant for high-frequency use.
export async function confirmWithEvalToast(code: string) {
  const key = `${location.origin}:eval`;
  const graceMs = await getSetting("confirmGraceMs");
  if (graceMs > 0 && lastConfirmed.key === key && Date.now() < lastConfirmed.until) {
    return; // within grace window
  }
  const approved = await showEvalToast(code, location.href, document.title);
  if (!approved) throw new Error("user denied page_eval");
  lastConfirmed = { key, until: Date.now() + graceMs };
}

export function describeForToast(el: HTMLElement) {
  return truncate(nameOf(el) || roleOf(el) || el.tagName.toLowerCase(), 40);
}

export function describeAction(el: HTMLElement, kind: string) {
  const role = roleOf(el);
  if (kind === "click") {
    if (role === "link" || el.tagName === "A") return "navigate";
    if (role === "button") return "submit";
    return "click";
  }
  return kind;
}

function showToast(question: string) {
  return new Promise((resolve) => {
    const host = ensureToastHost();
    const card = document.createElement("div");
    card.className = "zcb-toast-card zcb-danger";
    card.innerHTML = `
        <div class="zcb-toast-title">⚠ Browser Bridge</div>
        <div class="zcb-toast-q"></div>
        <div class="zcb-toast-actions">
          <button class="zcb-toast-deny">Deny</button>
          <button class="zcb-toast-allow">Allow</button>
        </div>`;
    card.querySelector(".zcb-toast-q")!.textContent = question;
    host.appendChild(card);

    let done = false;
    const finish = (val: boolean) => {
      if (done) return;
      done = true;
      card.classList.add("zcb-toast-out");
      setTimeout(() => card.remove(), 150);
      resolve(val);
    };
    card.querySelector<HTMLElement>(".zcb-toast-allow")!.onclick = () => finish(true);
    card.querySelector<HTMLElement>(".zcb-toast-deny")!.onclick = () => finish(false);
    // Auto-deny so the tool call doesn't hang forever. Timeout is configurable
    // via settings (default 30s).
    getSetting("clickToastTimeoutMs").then((ms) => setTimeout(() => finish(false), ms));
  });
}

// Enlarged, warning-styled Toast for page_eval. Shows the full code in a
// scrollable <pre>, plus the target URL and tab title so the user knows
// exactly what runs where.
function showEvalToast(code: string, url: string, tabTitle: string) {
  return new Promise((resolve) => {
    const host = ensureToastHost();
    const card = document.createElement("div");
    card.className = "zcb-toast-card zcb-danger zcb-eval-card";
    card.innerHTML = `
        <div class="zcb-toast-title">⚠ Browser Bridge: Confirm execution</div>
        <div class="zcb-eval-meta"></div>
        <pre class="zcb-eval-code"></pre>
        <div class="zcb-eval-warn">The code above will run on this page as you, and may read tokens / cookies / make requests.</div>
        <div class="zcb-toast-actions">
          <button class="zcb-toast-deny">Deny</button>
          <button class="zcb-toast-allow">Allow and run</button>
        </div>`;
    // Use textContent for any value to prevent injection from code strings.
    card.querySelector(".zcb-eval-meta")!.textContent =
      `${truncate(url || "", 60)} · "${truncate(tabTitle || "Untitled", 40)}"`;
    card.querySelector(".zcb-eval-code")!.textContent = code;
    host.appendChild(card);

    let done = false;
    const finish = (val: boolean) => {
      if (done) return;
      done = true;
      card.classList.add("zcb-toast-out");
      setTimeout(() => card.remove(), 150);
      resolve(val);
    };
    card.querySelector<HTMLElement>(".zcb-toast-allow")!.onclick = () => finish(true);
    card.querySelector<HTMLElement>(".zcb-toast-deny")!.onclick = () => finish(false);
    // Esc key also denies, for keyboard users.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        finish(false);
      }
    };
    card.addEventListener("keydown", onKey);
    // Auto-deny (longer than click's — user needs time to read code).
    // Timeout is configurable via settings (default 45s).
    getSetting("evalToastTimeoutMs").then((ms) =>
      setTimeout(() => {
        finish(false);
      }, ms)
    );
  });
}

// Informational toast (blue) for non-high-risk notices, e.g. "debugger is
// about to attach, infobar will flash briefly." Unlike the eval/click toasts
// this defaults to PROCEED (resolve true) after a timeout — the user must
// actively press Cancel to abort.
export function showInfoToast(message: string) {
  return new Promise((resolve) => {
    const host = ensureToastHost();
    const card = document.createElement("div");
    card.className = "zcb-toast-card zcb-info-card";
    card.innerHTML = `
        <div class="zcb-info-title">Browser Bridge</div>
        <div class="zcb-info-text"></div>
        <div class="zcb-info-actions">
          <button class="zcb-info-cancel">Cancel</button>
        </div>`;
    card.querySelector(".zcb-info-text")!.textContent = message;
    host.appendChild(card);

    let done = false;
    const finish = (proceed: boolean) => {
      if (done) return;
      done = true;
      card.classList.add("zcb-toast-out");
      setTimeout(() => card.remove(), 150);
      resolve(proceed);
    };
    card.querySelector<HTMLElement>(".zcb-info-cancel")!.onclick = () => finish(false);
    // Auto-proceed after 8s (informational, not a confirmation gate).
    setTimeout(() => finish(true), 8000);
  });
}

// Export showToast for the _confirm_toast op (tab-close confirmation).
export { showToast };

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
