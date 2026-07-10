// Stable element refs. Each interactive element gets a `data-zcb-ref="eN"`
// attribute; refMap maps ref -> element for the most recent snapshot. Stale
// refs resolve via a DOM-attribute fallback, or error asking for a re-snapshot.

import type { OpArgs } from "../shared/types";

export const REF_ATTR = "data-zcb-ref";

let refCounter = 0;
// ref -> element, rebuilt on every snapshot. Stale refs (from a previous
// snapshot whose element has since gone) resolve to null and the caller gets a
// clear "ref not found, re-snapshot" error.
let refMap = new Map<string, HTMLElement>();

// Reset for a fresh, dense ref numbering (called at the start of a snapshot).
export function resetRefs() {
  refCounter = 0;
  refMap = new Map();
}

export function assignRef(el: HTMLElement): string {
  // Reuse an existing ref if the element already has one from a prior
  // snapshot (keeps refs stable across calls when the page hasn't changed).
  // When reusing, we MUST advance refCounter past the reused number —
  // otherwise a subsequently-inserted element (no prior ref) would get
  // e1, e2... and collide with the reused refs. This bug shows up on
  // re-snapshot of a page where some elements are new (SPA case).
  let ref = el.getAttribute(REF_ATTR);
  if (ref) {
    const reused = parseInt(ref.slice(1), 10);
    if (!Number.isNaN(reused) && reused > refCounter) refCounter = reused;
  } else {
    refCounter += 1;
    ref = `e${refCounter}`;
    el.setAttribute(REF_ATTR, ref);
  }
  refMap.set(ref, el);
  return ref;
}

export function resolveTarget(args: OpArgs): HTMLElement {
  if (args.ref) {
    // Prefer the live map from the most recent snapshot.
    let el = refMap.get(args.ref);
    if (!el) {
      // Fall back to a DOM query by attribute (covers SW-recycle cases where
      // the map was cleared but elements still carry the attr).
      el = document.querySelector<HTMLElement>(`[${REF_ATTR}="${args.ref}"]`) ?? undefined;
      if (el) refMap.set(args.ref, el);
    }
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
