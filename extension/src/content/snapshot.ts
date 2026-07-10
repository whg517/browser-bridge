// page_snapshot — an accessibility-style tree of *interactive* elements, each
// tagged with a stable ref. A content-script approximation of a real a11y tree
// (see README for why we avoid chrome.debugger's infobar by default).

import { truncate } from "./util";
import { resetRefs, assignRef } from "./refs";

export function snapshot() {
  resetRefs();

  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (el) => (isInteractive(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });

  let el: Node | null = walker.currentNode;
  // TreeWalker's first nextNode() walks from currentNode; start from root.
  while ((el = walker.nextNode())) {
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

function isInteractive(el: any) {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = el.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.hasAttribute("onclick")) return true;
  if (el.tabIndex >= 0) return true;
  return false;
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

export function roleOf(el: any) {
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

export function nameOf(el: any) {
  // Simplified accessible-name computation (accname-1.2 subset).
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id: any) => document.getElementById(id))
      .filter(Boolean)
      .map((n: any) => n.innerText || n.textContent || "")
      .join(" ")
      .trim();
    if (parts) return truncate(parts, 120);
  }
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return truncate(aria.trim(), 120);
  // <label for> or wrapping <label>
  const labelFor = document.querySelector<HTMLElement>(`label[for="${el.id}"]`);
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
  // Fallbacks by content
  const txt = (el.innerText || el.textContent || "").trim();
  if (txt) return truncate(txt, 120);
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return truncate(placeholder, 120);
  const alt = el.getAttribute("alt");
  if (alt) return truncate(alt, 120);
  return "";
}

function previewValue(el: any): any {
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
    const v = el.value || "";
    if (el.type === "password") return v ? "••••••" : "";
    return truncate(v, 60);
  }
  return undefined;
}

function isVisible(el: any) {
  if (!el || !el.getClientRects) return false;
  const rects = el.getClientRects();
  if (rects.length === 0) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (parseFloat(style.opacity) === 0) return false;
  // aria-hidden hides the element AND its entire subtree. An element may be
  // visibly styled itself but still hidden from the a11y tree because an
  // ancestor is aria-hidden — walk up to catch that case.
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (cur.getAttribute && cur.getAttribute("aria-hidden") === "true") return false;
    cur = cur.parentElement;
  }
  return true;
}

// A cheap, *best-effort* CSS selector. Not guaranteed unique — the AI should
// prefer `ref`. Used only as a fallback diagnostic.
function cssSelectorOf(el: any) {
  const parts: string[] = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.body) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      part += `#${cur.id}`;
      parts.unshift(part);
      break;
    }
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c: any) => c.tagName === cur.tagName);
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
