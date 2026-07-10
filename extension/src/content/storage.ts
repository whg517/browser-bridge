// storage_get — read-only access to the PAGE's Web Storage (localStorage /
// sessionStorage, not chrome.storage). Must run in the content script (page
// context, same-origin). Frameworks like Auth0/NextAuth/Firebase store tokens
// here. Values are ALWAYS masked (independent of the eval mask toggle) because
// storage reads are silent. See ADR-0010.

import type { OpArgs } from "../shared/types";
import { maskString } from "../shared/masking";

export function storageGet(args: OpArgs) {
  const type = args.type === "session" ? "session" : "local";
  const key = args.key;
  let store: Storage;
  try {
    store = type === "session" ? window.sessionStorage : window.localStorage;
  } catch (e: any) {
    throw new Error(`storage unavailable: ${e.message}`);
  }
  if (key !== undefined && key !== null && key !== "") {
    const raw = store.getItem(key);
    if (raw === null) return { key, found: false };
    return { key, found: true, value: maskString(raw) };
  }
  // No key → dump all entries (masked). Cap to avoid huge payloads.
  const entries: Record<string, string> = {};
  let count = 0;
  const MAX = 500;
  for (let i = 0; i < store.length && count < MAX; i++) {
    const k = store.key(i);
    if (k === null) continue;
    try {
      entries[k] = maskString(store.getItem(k) || "");
    } catch {
      entries[k] = "[unreadable]";
    }
    count++;
  }
  const truncated = store.length > MAX;
  return { type, entries, count, truncated, totalKeys: store.length };
}
