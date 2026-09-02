// The virtual-focus pointer (ADR-0028 Phase 1a): what makes "the session's
// current tab" survive service-worker recycles and survive NOTHING else —
// a browser restart invalidates tab ids, so storage.session is the durable
//-but-not-too-durable home. These tests pin the read/write/clear contract and
// the defensive read (a non-number under the key reads as "no pointer").

import { beforeEach, describe, expect, test } from "bun:test";
import { clearCurrentTabId, getCurrentTabId, setCurrentTabId } from "./current-tab";

/** Install an in-memory chrome.storage.session stub. */
function withSessionStorage(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      session: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        remove: async (key: string) => {
          store.delete(key);
        },
      },
    },
  };
}

describe("the session's current tab", () => {
  beforeEach(() => withSessionStorage());

  test("unset reads as null", async () => {
    expect(await getCurrentTabId()).toBeNull();
  });

  test("set then get round-trips", async () => {
    await setCurrentTabId(42);
    expect(await getCurrentTabId()).toBe(42);
  });

  test("clear forgets the pointer", async () => {
    await setCurrentTabId(42);
    await clearCurrentTabId();
    expect(await getCurrentTabId()).toBeNull();
  });

  test("a non-number under the key reads as no pointer, not as a tab", async () => {
    withSessionStorage({ bb_current_tab_id: "42" });
    expect(await getCurrentTabId()).toBeNull();
  });
});
