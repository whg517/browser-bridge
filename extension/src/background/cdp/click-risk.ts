// Pure high-risk-click helpers, factored out of the CDP click flow so they can
// be unit-tested without a browser. They operate on the descriptor returned by
// the `probeClickTarget` page function (which reads the DOM in the page), so
// the SW can decide gating without owning the DOM.
//
// The logic MUST match content/actions.ts (isHighRiskClick) and
// content/toast.ts (describeForToast / describeAction).

import { truncate } from "../../content/util";

export interface ClickTarget {
  tagName: string; // e.g. "A", "BUTTON" (uppercase, as DOM reports)
  role: string;
  type: string; // lowercased input type, "" if none
  hasHref: boolean;
  name: string;
}

// Mirror of content/actions.ts isHighRiskClick: submit buttons and navigating
// links are gated.
export function isHighRiskClick(t: ClickTarget): boolean {
  if (t.role === "button" && t.type === "submit") return true;
  if (t.tagName === "A" && t.hasHref) return true;
  if (t.role === "link") return true;
  return false;
}

// Mirror of content/toast.ts describeAction.
export function describeAction(t: ClickTarget, kind: string): string {
  if (kind === "click") {
    if (t.role === "link" || t.tagName === "A") return "navigate";
    if (t.role === "button") return "submit";
    return "click";
  }
  return kind;
}

// Mirror of content/toast.ts describeForToast.
export function describeForToast(t: ClickTarget): string {
  return truncate(t.name || t.role || t.tagName.toLowerCase(), 40);
}
