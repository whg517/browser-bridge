// chrome.tabs.get/update/remove REJECT for a stale id — they do not resolve
// with undefined. Classifying only the `if (!t)` guard therefore tagged a branch
// Chrome never takes, and tab_focus / tab_close kept reporting a closed tab as
// EXECUTION_FAILED: "the op ran and failed", non-retryable, for what is really
// the caller naming a tab that is not there.
//
// Verified against Chrome 151: `tab_focus {"tabId": 999999999}` came back as
// EXECUTION_FAILED with Chrome's own "No tab with id: 999999999." text.

import { beforeEach, describe, expect, test } from "bun:test";
import { resolveTargetTab, tabClose, tabFocus } from "./tabs";

const NO_SUCH_TAB = "No tab with id: 999999999.";

type Calls = { get: number[]; update: number[]; remove: number[] };
let calls: Calls;

/** Install a chrome.tabs stub whose lookups reject the way Chrome's do. */
function withTabs(opts: { existing?: number[]; getFails?: Error } = {}) {
  const existing = opts.existing ?? [];
  calls = { get: [], update: [], remove: [] };
  const lookup = (id: number) => {
    if (opts.getFails) return Promise.reject(opts.getFails);
    if (!existing.includes(id)) return Promise.reject(new Error(NO_SUCH_TAB));
    return Promise.resolve({ id, windowId: 1 });
  };
  (globalThis as Record<string, unknown>).chrome = {
    tabs: {
      get: (id: number) => (calls.get.push(id), lookup(id)),
      update: (id: number) => (calls.update.push(id), lookup(id)),
      remove: (id: number) => (calls.remove.push(id), lookup(id).then(() => undefined)),
      query: () => Promise.resolve(existing.map((id) => ({ id, windowId: 1 }))),
    },
    windows: { update: () => Promise.resolve({}) },
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
