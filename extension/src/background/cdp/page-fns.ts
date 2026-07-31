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
export async function pageSnapshot(refAttr: string): Promise<{
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
  note?: string;
}> {
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
    // Frames/embeds are natively focusable (tabIndex 0); the catch-all below
    // would flag a covering marketing iframe as a target and collapse the whole
    // snapshot to it (#79). They're a separate document we can't act on here.
    if (tag === "iframe" || tag === "frame" || tag === "object" || tag === "embed") return false;
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
      // Mirror content/snapshot.ts: a checkbox/radio reports `checked`, not the
      // "on" submit payload that reads like a state.
      if (field.type === "checkbox" || field.type === "radio") return undefined;
      const v = field.value || "";
      if (field.type === "password") return v ? "••••••" : "";
      return truncate(v, 60);
    }
    return undefined;
  }
  function checkedState(el: HTMLElement): boolean | undefined {
    if (el.tagName !== "INPUT") return undefined;
    const field = el as HTMLInputElement;
    if (field.type !== "checkbox" && field.type !== "radio") return undefined;
    return !!field.checked;
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
  function walk() {
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
      checked: boolean | undefined;
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
        checked: checkedState(el),
      });
    }
    return { refCount: out.length, nodes: out, url: location.href, title: document.title };
  }

  // Mirror content/snapshot.ts: lazy / heavy-JS pages often haven't mounted
  // their interactive DOM yet, so settle briefly and retry when the walk is
  // empty; annotate a persistently-empty result so the agent knows why (#88).
  let result = walk();
  for (let i = 0; result.refCount === 0 && i < 4; i++) {
    await new Promise((r) => setTimeout(r, 300));
    result = walk();
  }
  if (result.refCount === 0) {
    return {
      ...result,
      note: "No interactive elements found — the page may still be loading, or its content lives in an iframe / shadow DOM. Try page_wait_for {settled:true} (or {selector}) then snapshot again, or page_snapshot_precise for shadow-DOM / complex ARIA.",
    };
  }
  return result;
}

// --- page_text -------------------------------------------------------------
export function pageText(args: { mode?: string }): { text: string; url: string; mode: string } {
  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  // "full": clone the body, drop script/style/noscript/template, read
  // textContent — keeps hidden / inactive-tab text that innerText drops (#88).
  function fullText(): string {
    const clone = document.body?.cloneNode(true) as HTMLElement | null;
    if (!clone) return "";
    clone.querySelectorAll("script,style,noscript,template").forEach((n) => n.remove());
    return (clone.textContent || "")
      .replace(/[^\S\n]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  // "visible" (default): live innerText reflects rendered content only —
  // excludes script/style, hidden/aria-hidden subtrees, and unopened <select>
  // option lists. Reading a detached clone degraded to textContent and leaked
  // all of that (#79).
  const full = args && args.mode === "full";
  const raw = full ? fullText() : document.body?.innerText || "";
  const txt = raw.replace(/\b\d{12,19}\b/g, "••••••");
  return { text: truncate(txt, 20000), url: location.href, mode: full ? "full" : "visible" };
}

// --- page_links ------------------------------------------------------------
// Returns RAW hrefs; the SW masks them with the credential-pattern catalogue
// (mirrors the storage_get raw/mask split). Every <a href> as {text, href,
// type}; optional `filter` narrows to one type.
export function pageLinks(filter: string | undefined): {
  links: Array<{ text: string; href: string; type: string }>;
  count: number;
  url: string;
} {
  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  const origin = location.origin;
  const out: Array<{ text: string; href: string; type: string }> = [];
  const seen = new Set<string>();
  const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
  for (const a of anchors) {
    const href = a.href;
    if (!href) continue;
    const rawHref = (a.getAttribute("href") || "").trim();
    let type: string;
    if (/^mailto:/i.test(rawHref)) type = "mailto";
    else if (/^tel:/i.test(rawHref)) type = "tel";
    else if (rawHref.startsWith("#")) type = "anchor";
    // Same-origin (any scheme, so a relative link matches even under file://) is
    // internal; other http(s) is external; everything else is an anchor.
    else if (a.origin === origin) type = "internal";
    else if (/^https?:/i.test(href)) type = "external";
    else type = "anchor";
    if (filter && type !== filter) continue;
    const key = type + " " + href;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = (a.textContent || a.getAttribute("aria-label") || a.title || "")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ text: truncate(label, 120), href, type });
    if (out.length >= 500) break;
  }
  return { links: out, count: out.length, url: location.href };
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
      default:
        // Same rejection as the content-script path (content/actions.ts): an
        // unhandled direction must not fall through and report coordinates as
        // though it had scrolled. This function is stringified into the page,
        // so it can't import the shared list.
        throw new Error(`scroll: unknown direction "${args.direction}" (use up|down|top|bottom)`);
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
  until?: string;
  minCount?: number;
  settled?: boolean;
}): Promise<unknown> {
  const timeoutMs = args.timeoutMs ?? 30000;
  const until = args.until === "domcontentloaded" ? "domcontentloaded" : "load";
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
    const finish = (fn: (v: unknown) => void, value: unknown) => {
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
    // `settled`: resolve once the DOM stops mutating for a quiet window — the
    // portable SPA/lazy-content signal when no selector/text/nav is known (#88).
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
      quietTimer = setTimeout(onSettled, QUIET_MS);
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

// --- page_click ------------------------------------------------------------
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
