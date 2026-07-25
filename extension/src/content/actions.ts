// Direct DOM actions: click, fill, text, screenshot, scroll.

import type { OpArgs } from "../shared/types";
import { truncate } from "./util";
import { resolveTarget } from "./refs";
import { roleOf } from "./snapshot";

export async function click(args: OpArgs) {
  const el = resolveTarget(args);
  // Clicks run directly — the high-risk-click confirmation was removed in
  // ADR-0020; the per-site allowlist is the remaining gate.
  el.scrollIntoView({ block: "center" });
  el.focus?.();
  el.click();
  return { clicked: args.ref || args.selector, role: roleOf(el) };
}

export async function fill(args: OpArgs) {
  const el = resolveTarget(args);
  const value = args.value ?? "";
  // Use the native setter path so frameworks (React, Vue) pick it up.
  await setNativeValue(el, value);
  return { filled: args.ref || args.selector };
}

// Setting el.value directly doesn't trigger React/Vue change detection. Use the
// well-known trick of getting the native setter from the proto.
function setNativeValue(el: HTMLElement, value: string) {
  return new Promise<void>((resolve, reject) => {
    try {
      el.focus?.();
      const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const proto =
        el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : el.tagName === "SELECT"
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        field.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

export function text() {
  // innerText on the LIVE document reflects what's actually rendered: it
  // excludes <script>/<style> (incl. @keyframes), display:none / visibility:
  // hidden / [hidden] / aria-hidden subtrees, and the options of unopened
  // <select>s. Reading it off a DETACHED body.cloneNode() degraded to
  // textContent, which leaked all of that as noise (#79). Password input
  // *values* never appear in innerText, so no separate masking is needed.
  // Mask long digit runs that look like card numbers.
  const txt = (document.body?.innerText || "").replace(/\b\d{12,19}\b/g, "••••••");
  return { text: truncate(txt, 20000), url: location.href };
}

export async function screenshot() {
  // Content scripts can't take screenshots directly; ask background.
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "capture_visible_tab" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.dataUrl) {
        reject(new Error(chrome.runtime.lastError?.message || "capture failed"));
      } else {
        resolve({ image: resp.dataUrl.split(",", 2)[1], mimeType: "image/png" });
      }
    });
  });
}

export function scroll(args: OpArgs) {
  if (typeof args.pixels === "number") {
    window.scrollBy(0, args.pixels);
  } else if (args.direction) {
    const dh = window.innerHeight * 0.9;
    switch (args.direction) {
      case "down":
        window.scrollBy(0, dh);
        break;
      case "up":
        window.scrollBy(0, -dh);
        break;
      case "top":
        window.scrollTo(0, 0);
        break;
      case "bottom":
        window.scrollTo(0, document.body.scrollHeight);
        break;
    }
  } else {
    throw new Error("scroll needs `direction` or `pixels`");
  }
  return { scrollY: window.scrollY, scrollX: window.scrollX };
}
