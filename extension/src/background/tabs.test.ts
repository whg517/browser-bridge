// chrome.tabs.get/update/remove REJECT for a stale id — they do not resolve
// with undefined. Classifying only the `if (!t)` guard therefore tagged a branch
// Chrome never takes, and tab_focus / tab_close kept reporting a closed tab as
// EXECUTION_FAILED: "the op ran and failed", non-retryable, for what is really
// the caller naming a tab that is not there.
//
// Verified against Chrome 151: `tab_focus {"tabId": 999999999}` came back as
// EXECUTION_FAILED with Chrome's own "No tab with id: 999999999." text.

import { beforeEach, describe, expect, test } from "bun:test";
import { resolveTargetTab, tabClose, tabFocus, tabOpen } from "./tabs";
import { getCurrentTabId, setCurrentTabId } from "./current-tab";

const NO_SUCH_TAB = "No tab with id: 999999999.";

type Calls = { get: number[]; update: number[]; remove: number[] };
let calls: Calls;

/** Install a chrome.tabs stub whose lookups reject the way Chrome's do, plus
 * the storage.session stub the current-tab pointer lives in. */
function withTabs(opts: { existing?: number[]; getFails?: Error; activeId?: number } = {}) {
  const existing = opts.existing ?? [];
  const activeId = opts.activeId ?? existing[0];
  calls = { get: [], update: [], remove: [] };
  const lookup = (id: number) => {
    if (opts.getFails) return Promise.reject(opts.getFails);
    if (!existing.includes(id)) return Promise.reject(new Error(NO_SUCH_TAB));
    return Promise.resolve({ id, windowId: 1, active: id === activeId });
  };
  (globalThis as Record<string, unknown>).chrome = {
    tabs: {
      get: (id: number) => (calls.get.push(id), lookup(id)),
      update: (id: number) => (calls.update.push(id), lookup(id)),
      remove: (id: number) => (calls.remove.push(id), lookup(id).then(() => undefined)),
      create: (q: { url: string }) => Promise.resolve({ id: 55, windowId: 1, ...q }),
      query: (q: { active?: boolean }) =>
        Promise.resolve(
          q.active
            ? existing
                .filter((id) => id === activeId)
                .map((id) => ({ id, windowId: 1, active: true }))
            : existing.map((id) => ({ id, windowId: 1, active: id === activeId }))
        ),
    },
    windows: { update: () => Promise.resolve({}) },
  };
  // Same in-memory stub current-tab.test.ts uses; resolveTargetTab and the
  // tab-level tools read/write the pointer, so every test here needs it.
  const store = new Map<string, unknown>();
  const session = {
    get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    remove: async (key: string) => {
      store.delete(key);
    },
  };
  (globalThis as Record<string, unknown>).chrome = {
    ...((globalThis as Record<string, unknown>).chrome as Record<string, unknown>),
    storage: { session },
  };
}

async function codeOfThrown(work: () => Promise<unknown>) {
  try {
    await work();
    return "(did not throw)";
  } catch (e) {
    return (e as { code?: string }).code ?? "(no code)";
  }
}

describe("tab lookups classify a missing tab", () => {
  beforeEach(() => withTabs({ existing: [7] }));

  test("tab_focus on a stale id is TAB_NOT_FOUND, not EXECUTION_FAILED", async () => {
    expect(await codeOfThrown(() => tabFocus(999999999))).toBe("TAB_NOT_FOUND");
  });

  test("tab_close on a stale id is TAB_NOT_FOUND", async () => {
    expect(await codeOfThrown(() => tabClose(999999999))).toBe("TAB_NOT_FOUND");
  });

  test("resolveTargetTab — the path every page op takes", async () => {
    expect(await codeOfThrown(() => resolveTargetTab(999999999))).toBe("TAB_NOT_FOUND");
  });

  test("tab_close checks before it removes, so a bad id destroys nothing", async () => {
    await codeOfThrown(() => tabClose(999999999));
    expect(calls.get).toEqual([999999999]);
    expect(calls.remove).toEqual([]);
  });

  test("a tab that exists is untouched by any of this", async () => {
    expect(await tabFocus(7)).toEqual({ focused: 7 });
    expect(await tabClose(7)).toEqual({ closed: 7 });
    expect((await resolveTargetTab(7)).id).toBe(7);
  });

  test("an unrelated failure keeps its own identity", async () => {
    // Blanket-relabelling every rejection would turn a permission problem into
    // "that tab is gone", sending the agent to look in the wrong place.
    withTabs({ getFails: new Error("Cannot access contents of the page") });
    expect(await codeOfThrown(() => resolveTargetTab(7))).toBe("(no code)");
    expect(await codeOfThrown(() => tabFocus(7))).toBe("(no code)");
  });
});

// ADR-0028 Phase 1a: "the active tab" was a global concept — whatever the
// human is looking at. The session's current tab is the virtual focus that
// makes tools land where the CONVERSATION left off.
describe("the session's current tab (virtual focus)", () => {
  beforeEach(() => withTabs({ existing: [7, 9], activeId: 7 }));

  test("an explicit tabId both resolves AND becomes current", async () => {
    expect((await resolveTargetTab(9)).id).toBe(9);
    // The active tab is 7, but the session now works in 9.
    expect(await resolveTargetTab(undefined).then((t) => t.id)).toBe(9);
  });

  test("a dangling pointer falls back to the active tab and clears itself", async () => {
    await setCurrentTabId(999);
    expect(await resolveTargetTab(undefined).then((t) => t.id)).toBe(7);
    expect(await getCurrentTabId()).toBeNull();
  });

  test("tab_focus makes the focused tab current", async () => {
    await tabFocus(9);
    expect(await getCurrentTabId()).toBe(9);
  });

  test("tab_open makes the opened tab current", async () => {
    await tabOpen("https://example.test");
    expect(await getCurrentTabId()).toBe(55);
  });

  test("closing the current tab clears the pointer", async () => {
    await setCurrentTabId(7);
    await tabClose(7);
    expect(await getCurrentTabId()).toBeNull();
  });

  test("closing some other tab leaves the pointer alone", async () => {
    await setCurrentTabId(7);
    await tabClose(9);
    expect(await getCurrentTabId()).toBe(7);
  });
});
