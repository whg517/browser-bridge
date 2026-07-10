// Direct DOM actions: click, fill, text, screenshot, scroll.

import { getSetting } from "../shared/settings";
import { truncate } from "./util";
import { resolveTarget } from "./refs";
import { roleOf } from "./snapshot";
import { confirmWithToast, describeForToast, describeAction } from "./toast";

export async function click(args: any) {
  const el = resolveTarget(args);
  const highRisk = isHighRiskClick(el);
  if (highRisk) {
    // The confirmation gate can be disabled by the user in settings. This is
    // dangerous (ADR-0006) but offered as an explicit opt-in.
    const confirmEnabled = await getSetting("confirmHighRiskClick");
    if (confirmEnabled !== false) {
      await confirmWithToast(`Click "${describeForToast(el)}"?`, describeAction(el, "click"));
    }
  }
  el.scrollIntoView({ block: "center" });
  el.focus?.();
  el.click();
  return { clicked: args.ref || args.selector, role: roleOf(el) };
}

function isHighRiskClick(el: any) {
  // Submit buttons, and links that navigate, are gated.
  const role = roleOf(el);
  if (role === "button") {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "submit") return true;
  }
  if (el.tagName === "A" && el.hasAttribute("href")) return true;
  if (role === "link") return true;
  return false;
}

export async function fill(args: any) {
  const el = resolveTarget(args);
  const value = args.value ?? "";
  // Use the native setter path so frameworks (React, Vue) pick it up.
  await setNativeValue(el, value);
  return { filled: args.ref || args.selector };
}

// Setting el.value directly doesn't trigger React/Vue change detection. Use the
// well-known trick of getting the native setter from the proto.
function setNativeValue(el: any, value: any) {
  return new Promise<void>((resolve, reject) => {
    try {
      el.focus?.();
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
        el.value = value;
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
  // Mask password fields.
  const cloneSrc = document.body.cloneNode(true) as HTMLElement;
  cloneSrc
    .querySelectorAll<HTMLInputElement>("input[type=password]")
    .forEach((i) => (i.value = "••••••"));
  // Mask long digit runs that look like card numbers.
  const txt = (cloneSrc.innerText || "").replace(/\b\d{12,19}\b/g, "••••••");
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

export function scroll(args: any) {
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
