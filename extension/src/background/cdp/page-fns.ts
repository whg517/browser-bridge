// Portable page functions for CDP mode.
//
// Each exported function here is STRINGIFIED (via Function.prototype.toString)
// and evaluated in the page's MAIN world through Runtime.evaluate. That means:
//
//   - NO imports and NO references to module scope (constants, other helpers) —
//     anything a function needs must be a parameter or declared inside it.
//   - Values a function needs from the SW (the ref-attribute name, op args) are
//     passed as arguments (JSON-serialized into the evaluate expression).
//
// The DOM work mirrors the content-script modules exactly (content/snapshot.ts,
// actions.ts, wait.ts, storage.ts, refs.ts, util.ts, toast.ts) so refs and
// behavior stay cross-compatible between the content-script and CDP backends.
//
// tsc type-checks these against the DOM lib; they never actually run in the SW.

// The ref attribute name. MUST match REF_ATTR in content/refs.ts — the CDP and
// content-script snapshots tag the SAME attribute so refs interoperate.
export const REF_ATTR = "data-zcb-ref";

// --- page_snapshot ---------------------------------------------------------
// A content-script-equivalent a11y-ish tree of interactive elements. Runs the
// SAME DOM walk as content/snapshot.ts (not the CDP AX-tree — that is
// page_snapshot_precise), so the `eN` refs match the content path.
export function pageSnapshot(refAttr: string): {
  refCount: number;
  nodes: Array<{
    ref: string;
    role: string;
    name: string;
    selector: string;
    value: string | undefined;
  }>;
  url: string;
  title: string;
} {
  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  const INTERACTIVE_TAGS = new Set([
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "details",
    "label",
    "option",
    "optgroup",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "textbox",
    "searchbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "combobox",
    "listbox",
    "option",
    "switch",
    "treeitem",
  ]);
  function isInteractive(el: HTMLElement): boolean {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.tabIndex >= 0) return true;
    return false;
  }
  function roleOf(el: HTMLElement): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "listbox";
    if (tag === "summary") return "button";
    return tag;
  }
  function nameOf(el: HTMLElement): string {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n): n is HTMLElement => n !== null)
        .map((n) => n.innerText || n.textContent || "")
        .join(" ")
        .trim();
      if (parts) return truncate(parts, 120);
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return truncate(aria.trim(), 120);
    const labelFor = el.id ? document.querySelector<HTMLElement>(`label[for="${el.id}"]`) : null;
    if (labelFor) {
      const t = (labelFor.innerText || "").trim();
      if (t) return truncate(t, 120);
    }
    const wrapping = el.closest("label");
    if (wrapping && wrapping !== labelFor) {
      const t = (wrapping.innerText || "").trim();
      if (t) return truncate(t, 120);
    }
    if (el.title && el.title.trim()) return truncate(el.title.trim(), 120);
    const txt = (el.innerText || el.textContent || "").trim();
    if (txt) return truncate(txt, 120);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return truncate(placeholder, 120);
    const alt = el.getAttribute("alt");
    if (alt) return truncate(alt, 120);
    return "";
  }
  function previewValue(el: HTMLElement): string | undefined {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const v = field.value || "";
      if (field.type === "password") return v ? "••••••" : "";
      return truncate(v, 60);
    }
    return undefined;
  }
  function isVisible(el: HTMLElement): boolean {
    if (!el || !el.getClientRects) return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    let cur: HTMLElement | null = el;
    while (cur && cur.nodeType === 1) {
      if (cur.getAttribute("aria-hidden") === "true") return false;
      cur = cur.parentElement;
    }
    return true;
  }
  function cssSelectorOf(el: HTMLElement): string {
    const parts: string[] = [];
    let cur: HTMLElement | null = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += `#${cur.id}`;
        parts.unshift(part);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const tag = cur.tagName;
        const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === tag);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }
  // Stateless ref assignment: reuse an element's existing attribute (refs stay
  // stable across snapshots because the attribute persists in the DOM) and
  // advance past reused numbers so freshly-inserted elements never collide.
  let refCounter = 0;
  function assignRef(el: HTMLElement): string {
    let ref = el.getAttribute(refAttr);
    if (ref) {
      const reused = parseInt(ref.slice(1), 10);
      if (!Number.isNaN(reused) && reused > refCounter) refCounter = reused;
    } else {
      refCounter += 1;
      ref = `e${refCounter}`;
      el.setAttribute(refAttr, ref);
    }
    return ref;
  }

  const out: Array<{
    ref: string;
    role: string;
    name: string;
    selector: string;
    value: string | undefined;
  }> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (el) =>
      isInteractive(el as HTMLElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const el = node as HTMLElement;
    if (!isVisible(el)) continue;
    const ref = assignRef(el);
    out.push({
      ref,
      role: roleOf(el),
      name: nameOf(el),
      selector: cssSelectorOf(el),
      value: previewValue(el),
    });
  }
  return { refCount: out.length, nodes: out, url: location.href, title: document.title };
}

// --- page_text -------------------------------------------------------------
export function pageText(): { text: string; url: string } {
  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  const cloneSrc = document.body.cloneNode(true) as HTMLElement;
  cloneSrc
    .querySelectorAll<HTMLInputElement>("input[type=password]")
    .forEach((i) => (i.value = "••••••"));
  const txt = (cloneSrc.innerText || "").replace(/\b\d{12,19}\b/g, "••••••");
  return { text: truncate(txt, 20000), url: location.href };
}

// --- page_scroll -----------------------------------------------------------
export function pageScroll(args: { pixels?: number; direction?: string }): {
  scrollY: number;
  scrollX: number;
} {
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

// --- page_wait_for ---------------------------------------------------------
// Returns a Promise; the backend evaluates this with awaitPromise:true.
export function pageWaitFor(args: {
  nav?: boolean;
  selector?: string;
  text?: string;
  timeoutMs?: number;
}): Promise<unknown> {
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
    const finish = (fn: (v: unknown) => void, value: unknown) => {
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

// --- storage_get -----------------------------------------------------------
// Returns RAW values; the SW masks them (reusing shared/masking) before they
// leave the extension. storage_get masking is always-on, independent of the
// eval mask toggle (ADR-0010).
export function readStorage(args: { type?: string; key?: string }):
  | { key: string; found: false }
  | { key: string; found: true; value: string }
  | {
      type: string;
      entries: Record<string, string>;
      count: number;
      truncated: boolean;
      totalKeys: number;
    } {
  const type = args.type === "session" ? "session" : "local";
  const key = args.key;
  let store: Storage;
  try {
    store = type === "session" ? window.sessionStorage : window.localStorage;
  } catch (e) {
    throw new Error(`storage unavailable: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  if (key !== undefined && key !== null && key !== "") {
    const raw = store.getItem(key);
    if (raw === null) return { key, found: false };
    return { key, found: true, value: raw };
  }
  const entries: Record<string, string> = {};
  let count = 0;
  const MAX = 500;
  for (let i = 0; i < store.length && count < MAX; i++) {
    const k = store.key(i);
    if (k === null) continue;
    try {
      entries[k] = store.getItem(k) || "";
    } catch {
      entries[k] = "[unreadable]";
    }
    count++;
  }
  const truncated = store.length > MAX;
  return { type, entries, count, truncated, totalKeys: store.length };
}

// --- page_click (probe + act) ----------------------------------------------
// Probe the target so the SW can decide high-risk gating without owning the
// DOM. Mirrors resolveTarget + roleOf/nameOf from the content path.
export function probeClickTarget(
  refAttr: string,
  args: { ref?: string; selector?: string }
): { tagName: string; role: string; type: string; hasHref: boolean; name: string } {
  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function resolveTarget(): HTMLElement {
    if (args.ref) {
      const el = document.querySelector<HTMLElement>(`[${refAttr}="${args.ref}"]`);
      if (!el) throw new Error(`ref not found: ${args.ref} — call page_snapshot again`);
      return el;
    }
    if (args.selector) {
      const el = document.querySelector<HTMLElement>(args.selector);
      if (!el) throw new Error(`selector matched nothing: ${args.selector}`);
      return el;
    }
    throw new Error("click/fill needs `ref` or `selector`");
  }
  function roleOf(el: HTMLElement): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "listbox";
    if (tag === "summary") return "button";
    return tag;
  }
  function nameOf(el: HTMLElement): string {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return truncate(aria.trim(), 120);
    const labelFor = el.id ? document.querySelector<HTMLElement>(`label[for="${el.id}"]`) : null;
    if (labelFor) {
      const t = (labelFor.innerText || "").trim();
      if (t) return truncate(t, 120);
    }
    if (el.title && el.title.trim()) return truncate(el.title.trim(), 120);
    const txt = (el.innerText || el.textContent || "").trim();
    if (txt) return truncate(txt, 120);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return truncate(placeholder, 120);
    return "";
  }
  const el = resolveTarget();
  return {
    tagName: el.tagName,
    role: roleOf(el),
    type: (el.getAttribute("type") || "").toLowerCase(),
    hasHref: el.tagName === "A" && el.hasAttribute("href"),
    name: nameOf(el),
  };
}

export function doClick(
  refAttr: string,
  args: { ref?: string; selector?: string }
): { clicked: string | undefined; role: string } {
  function resolveTarget(): HTMLElement {
    if (args.ref) {
      const el = document.querySelector<HTMLElement>(`[${refAttr}="${args.ref}"]`);
      if (!el) throw new Error(`ref not found: ${args.ref} — call page_snapshot again`);
      return el;
    }
    if (args.selector) {
      const el = document.querySelector<HTMLElement>(args.selector);
      if (!el) throw new Error(`selector matched nothing: ${args.selector}`);
      return el;
    }
    throw new Error("click/fill needs `ref` or `selector`");
  }
  function roleOf(el: HTMLElement): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "listbox";
    if (tag === "summary") return "button";
    return tag;
  }
  const el = resolveTarget();
  el.scrollIntoView({ block: "center" });
  el.focus?.();
  el.click();
  return { clicked: args.ref || args.selector, role: roleOf(el) };
}

// --- page_fill -------------------------------------------------------------
export function doFill(
  refAttr: string,
  args: { ref?: string; selector?: string; value?: string }
): { filled: string | undefined } {
  function resolveTarget(): HTMLElement {
    if (args.ref) {
      const el = document.querySelector<HTMLElement>(`[${refAttr}="${args.ref}"]`);
      if (!el) throw new Error(`ref not found: ${args.ref} — call page_snapshot again`);
      return el;
    }
    if (args.selector) {
      const el = document.querySelector<HTMLElement>(args.selector);
      if (!el) throw new Error(`selector matched nothing: ${args.selector}`);
      return el;
    }
    throw new Error("click/fill needs `ref` or `selector`");
  }
  const el = resolveTarget();
  const value = args.value ?? "";
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
  return { filled: args.ref || args.selector };
}

// --- confirmation toasts (no content script) -------------------------------
// Both return a Promise<boolean>; the backend evaluates them with
// awaitPromise:true. Styles are inlined because toast.css is never injected in
// CDP mode. Markup/behavior mirror content/toast.ts.
export function confirmToast(question: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;";
    const card = document.createElement("div");
    // High-risk confirmation → red danger theme, 360px (matches toast.css).
    card.style.cssText =
      "box-sizing:border-box;pointer-events:auto;background:#fffbfb;color:#1f2937;" +
      "border:1.5px solid #dc2626;border-left:4px solid #dc2626;border-radius:12px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.16);padding:14px 16px;width:360px;" +
      "font-family:-apple-system,system-ui,sans-serif;font-size:13px;line-height:1.5;";
    const title = document.createElement("div");
    title.textContent = "⚠ Browser Bridge";
    title.style.cssText = "font-weight:700;margin-bottom:6px;color:#b91c1c;";
    const q = document.createElement("div");
    q.textContent = question;
    q.style.cssText = "margin-bottom:12px;word-break:break-word;color:#374151;";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    deny.style.cssText =
      "padding:6px 14px;border-radius:8px;border:1px solid #d1d5db;color:#374151;background:#fff;cursor:pointer;font-size:12px;font-weight:600;";
    const allow = document.createElement("button");
    allow.textContent = "Allow";
    allow.style.cssText =
      "padding:6px 14px;border-radius:8px;border:1px solid #dc2626;background:#dc2626;color:#fff;cursor:pointer;font-size:12px;font-weight:600;";
    actions.appendChild(deny);
    actions.appendChild(allow);
    card.appendChild(title);
    card.appendChild(q);
    card.appendChild(actions);
    host.appendChild(card);
    (document.body || document.documentElement).appendChild(host);

    let done = false;
    const finish = (val: boolean) => {
      if (done) return;
      done = true;
      host.remove();
      resolve(val);
    };
    allow.onclick = () => finish(true);
    deny.onclick = () => finish(false);
    setTimeout(() => finish(false), timeoutMs);
  });
}

export function evalToast(
  code: string,
  url: string,
  tabTitle: string,
  timeoutMs: number
): Promise<boolean> {
  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;";
    const card = document.createElement("div");
    // Highest-risk confirmation → red danger theme, 360px (matches toast.css).
    card.style.cssText =
      "box-sizing:border-box;pointer-events:auto;background:#fffbfb;color:#1f2937;" +
      "border:1.5px solid #dc2626;border-left:4px solid #dc2626;border-radius:12px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.16);padding:14px 16px;width:360px;" +
      "font-family:-apple-system,system-ui,sans-serif;font-size:13px;line-height:1.5;";
    const title = document.createElement("div");
    title.textContent = "⚠ Browser Bridge: Execution confirmation (CDP)";
    title.style.cssText = "font-weight:700;color:#b91c1c;margin-bottom:6px;";
    const meta = document.createElement("div");
    meta.textContent = `${truncate(url || "", 60)} · "${truncate(tabTitle || "Untitled", 40)}"`;
    meta.style.cssText =
      "font-size:11px;color:#6b7280;margin-bottom:8px;font-family:ui-monospace,monospace;word-break:break-all;";
    const pre = document.createElement("pre");
    pre.textContent = code;
    pre.style.cssText =
      "margin:0 0 10px;padding:8px 10px;max-height:200px;overflow:auto;background:#f9fafb;" +
      "border:1px solid #e5e7eb;border-radius:8px;font-family:ui-monospace,monospace;font-size:12px;" +
      "line-height:1.45;white-space:pre;color:#111827;";
    const warn = document.createElement("div");
    warn.textContent =
      "The code above will run on this page as you, and may read tokens / Cookies / make requests.";
    warn.style.cssText = "font-size:11px;color:#b91c1c;margin-bottom:12px;line-height:1.4;";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    deny.style.cssText =
      "padding:6px 14px;border-radius:8px;border:1px solid #d1d5db;color:#374151;background:#fff;cursor:pointer;font-size:12px;font-weight:600;";
    const allow = document.createElement("button");
    allow.textContent = "Allow";
    allow.style.cssText =
      "padding:6px 14px;border-radius:8px;border:1px solid #dc2626;background:#dc2626;color:#fff;cursor:pointer;font-size:12px;font-weight:600;";
    actions.appendChild(deny);
    actions.appendChild(allow);
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(pre);
    card.appendChild(warn);
    card.appendChild(actions);
    host.appendChild(card);
    (document.body || document.documentElement).appendChild(host);

    let done = false;
    const finish = (val: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      resolve(val);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };
    document.addEventListener("keydown", onKey, true);
    allow.onclick = () => finish(true);
    deny.onclick = () => finish(false);
    setTimeout(() => finish(false), timeoutMs);
  });
}
