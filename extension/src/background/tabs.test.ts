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
import { rememberAgentGroup } from "./workspace";

const NO_SUCH_TAB = "No tab with id: 999999999.";

type Calls = { get: number[]; update: number[]; remove: number[] };
let calls: Calls;

/** Install chrome.tabs/tabGroups/storage stubs: lookups reject the way
 * Chrome's do, tabs carry `groups[id] ?? -1` as their groupId, and every
 * group mutation is recorded for assertions. */
function withTabs(
  opts: {
    existing?: number[];
    getFails?: Error;
    activeId?: number;
    groups?: Record<number, number>;
  } = {}
) {
  const existing = opts.existing ?? [];
  const activeId = opts.activeId ?? existing[0];
  const groups = opts.groups ?? {};
  calls = { get: [], update: [], remove: [] };
  const lookup = (id: number) => {
    if (opts.getFails) return Promise.reject(opts.getFails);
    if (!existing.includes(id)) return Promise.reject(new Error(NO_SUCH_TAB));
    return Promise.resolve({ id, windowId: 1, active: id === activeId, groupId: groups[id] ?? -1 });
  };
  const session = {
    get: async (key: string) => {
      const store = (globalThis as { __bbStore?: Map<string, unknown> }).__bbStore ?? new Map();
      return store.has(key) ? { [key]: store.get(key) } : {};
    },
    set: async (items: Record<string, unknown>) => {
      const store =
        (globalThis as { __bbStore?: Map<string, unknown> }).__bbStore ??
        ((globalThis as { __bbStore?: Map<string, unknown> }).__bbStore = new Map());
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    remove: async (key: string) => {
      ((globalThis as { __bbStore?: Map<string, unknown> }).__bbStore ?? new Map()).delete(key);
    },
  };
  (globalThis as Record<string, unknown>).chrome = {
    tabs: {
      get: (id: number) => (calls.get.push(id), lookup(id)),
      update: (id: number) => (calls.update.push(id), lookup(id)),
      remove: (id: number) => (calls.remove.push(id), lookup(id).then(() => undefined)),
      create: (q: { url: string }) => Promise.resolve({ id: 55, windowId: 1, groupId: -1, ...q }),
      group: async (o: { tabIds: number[]; groupId?: number }) => o.groupId ?? 90,
      query: (q: { active?: boolean }) =>
        Promise.resolve(
          q.active
            ? existing
                .filter((id) => id === activeId)
                .map((id) => ({ id, windowId: 1, active: true, groupId: groups[id] ?? -1 }))
            : existing.map((id) => ({
                id,
                windowId: 1,
                active: id === activeId,
                groupId: groups[id] ?? -1,
              }))
        ),
    },
    tabGroups: {
      get: async (id: number) => ({ id, title: "Browser Bridge · c1" }),
      query: async () => [],
      update: async (id: number, patch: { title?: string }) => ({ id, ...patch }),
    },
    windows: { update: () => Promise.resolve({}) },
    storage: { session },
  };
  (globalThis as { __bbStore?: unknown }).__bbStore = new Map();
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
    expect(await codeOfThrown(() => tabFocus(999999999, "solo"))).toBe("TAB_NOT_FOUND");
  });

  test("tab_close on a stale id is TAB_NOT_FOUND", async () => {
    expect(await codeOfThrown(() => tabClose(999999999, "solo"))).toBe("TAB_NOT_FOUND");
  });

  test("resolveTargetTab — the path every page op takes", async () => {
    expect(await codeOfThrown(() => resolveTargetTab(999999999, "solo"))).toBe("TAB_NOT_FOUND");
  });

  test("tab_close checks before it removes, so a bad id destroys nothing", async () => {
    await codeOfThrown(() => tabClose(999999999, "solo"));
    expect(calls.get).toEqual([999999999]);
    expect(calls.remove).toEqual([]);
  });

  test("a tab that exists is untouched by any of this", async () => {
    expect(await tabFocus(7, "solo")).toEqual({ focused: 7 });
    expect(await tabClose(7, "solo")).toEqual({ closed: 7 });
    expect((await resolveTargetTab(7, "solo")).id).toBe(7);
  });

  test("an unrelated failure keeps its own identity", async () => {
    // Blanket-relabelling every rejection would turn a permission problem into
    // "that tab is gone", sending the agent to look in the wrong place.
    withTabs({ getFails: new Error("Cannot access contents of the page") });
    expect(await codeOfThrown(() => resolveTargetTab(7, "solo"))).toBe("(no code)");
    expect(await codeOfThrown(() => tabFocus(7, "solo"))).toBe("(no code)");
  });
});

// ADR-0028 Phase 1a: "the active tab" was a global concept — whatever the
// human is looking at. The current tab is the virtual focus that makes tools
// land where the CONVERSATION left off.
describe("the session's current tab (virtual focus)", () => {
  beforeEach(() => withTabs({ existing: [7, 9], activeId: 7 }));

  test("an explicit tabId both resolves AND becomes current", async () => {
    expect((await resolveTargetTab(9, "solo")).id).toBe(9);
    // The active tab is 7, but the session now works in 9.
    expect(await resolveTargetTab(undefined, "solo").then((t) => t.id)).toBe(9);
  });

  test("a dangling pointer falls back to the active tab and clears itself", async () => {
    await setCurrentTabId("solo", 999);
    expect(await resolveTargetTab(undefined, "solo").then((t) => t.id)).toBe(7);
    expect(await getCurrentTabId("solo")).toBeNull();
  });

  test("tab_focus makes the focused tab current", async () => {
    await tabFocus(9, "solo");
    expect(await getCurrentTabId("solo")).toBe(9);
  });

  test("tab_open makes the opened tab current", async () => {
    await tabOpen("https://example.test", "solo");
    expect(await getCurrentTabId("solo")).toBe(55);
  });

  test("closing the current tab clears the pointer", async () => {
    await setCurrentTabId("solo", 7);
    await tabClose(7, "solo");
    expect(await getCurrentTabId("solo")).toBeNull();
  });

  test("closing some other tab leaves the pointer alone", async () => {
    await setCurrentTabId("solo", 7);
    await tabClose(9, "solo");
    expect(await getCurrentTabId("solo")).toBe(7);
  });
});

// ADR-0028 Phase 1c: an explicitly targeted tab must be in the calling
// agent's own workspace. Other agents' tabs — and the user's ungrouped tabs —
// are out of reach.
describe("workspace scoping", () => {
  beforeEach(() => withTabs({ existing: [7, 9, 10], activeId: 7, groups: { 9: 42, 10: 43 } }));

  test("a tab in the agent's own group resolves and becomes current", async () => {
    await rememberAgentGroup("c1", 42);
    expect((await resolveTargetTab(9, "c1")).id).toBe(9);
    expect(await getCurrentTabId("c1")).toBe(9);
  });

  test("another agent's group is TAB_OUT_OF_SCOPE", async () => {
    await rememberAgentGroup("c1", 42);
    expect(await codeOfThrown(() => resolveTargetTab(10, "c1"))).toBe("TAB_OUT_OF_SCOPE");
  });

  test("the user's ungrouped tabs are out of scope for explicit targeting", async () => {
    await rememberAgentGroup("c1", 42);
    expect(await codeOfThrown(() => resolveTargetTab(7, "c1"))).toBe("TAB_OUT_OF_SCOPE");
  });

  test("an agent with no workspace has nothing to target explicitly", async () => {
    expect(await codeOfThrown(() => resolveTargetTab(9, "c9"))).toBe("TAB_OUT_OF_SCOPE");
  });

  test("tab_focus and tab_close enforce the same boundary", async () => {
    await rememberAgentGroup("c1", 42);
    expect(await codeOfThrown(() => tabFocus(10, "c1"))).toBe("TAB_OUT_OF_SCOPE");
    expect(await codeOfThrown(() => tabClose(10, "c1"))).toBe("TAB_OUT_OF_SCOPE");
    // The unsanctioned close destroyed nothing.
    expect(calls.remove).toEqual([]);
    // Inside the boundary everything works as before.
    expect(await tabFocus(9, "c1")).toEqual({ focused: 9 });
    expect(await tabClose(9, "c1")).toEqual({ closed: 9 });
  });

  test("solo keeps the old unrestricted behavior", async () => {
    // No remembered group, targeting an ungrouped tab: the single-user path
    // is exactly what it was before Phase 1c.
    expect((await resolveTargetTab(7, "solo")).id).toBe(7);
    expect(await tabFocus(10, "solo")).toEqual({ focused: 10 });
    expect(await tabClose(10, "solo")).toEqual({ closed: 10 });
  });

  test("tab_list labels ownership", async () => {
    const { tabList } = await import("./tabs");
    await rememberAgentGroup("c1", 42);
    const tabs = await tabList("c1");
    const byId = Object.fromEntries(tabs.map((t) => [t.id, t.owner]));
    expect(byId[9]).toBe("you"); // my workspace
    expect(byId[10]).toBe("agent"); // another agent's workspace
    expect(byId[7]).toBe("user"); // ungrouped
  });
});
