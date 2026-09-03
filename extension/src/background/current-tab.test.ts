// The per-client virtual-focus pointer (ADR-0028 Phase 1a/1c): what makes an
// agent's "current tab" survive service-worker recycles and survive NOTHING
// else — a browser restart invalidates tab ids, so storage.session is the
// durable-but-not-too-durable home. Keyed by client: two agents sharing one
// browser each keep their own focus.

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

describe("the per-client current tab", () => {
  beforeEach(() => withSessionStorage());

  test("unset reads as null", async () => {
    expect(await getCurrentTabId("solo")).toBeNull();
  });

  test("set then get round-trips", async () => {
    await setCurrentTabId("solo", 42);
    expect(await getCurrentTabId("solo")).toBe(42);
  });

  test("clients do not see each other's pointer", async () => {
    await setCurrentTabId("c1", 42);
    expect(await getCurrentTabId("c2")).toBeNull();
    await setCurrentTabId("c2", 7);
    expect(await getCurrentTabId("c1")).toBe(42);
    expect(await getCurrentTabId("c2")).toBe(7);
  });

  test("clear forgets only that client's pointer", async () => {
    await setCurrentTabId("c1", 42);
    await setCurrentTabId("c2", 7);
    await clearCurrentTabId("c1");
    expect(await getCurrentTabId("c1")).toBeNull();
    expect(await getCurrentTabId("c2")).toBe(7);
  });

  test("a non-number under the key reads as no pointer, not as a tab", async () => {
    withSessionStorage({ "bb_current_tab:solo": "42" });
    expect(await getCurrentTabId("solo")).toBeNull();
  });
});
