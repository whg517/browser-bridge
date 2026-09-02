// Tab resolution, content-script injection, and the tab-level tools
// (tab_list / tab_focus / tab_open / tab_close).

import { BridgeError } from "../shared/bridge-error";
import { TOP_FRAME } from "./frames";
import { clearCurrentTabId, getCurrentTabId, setCurrentTabId } from "./current-tab";

/**
 * Run a chrome.tabs call, classifying "that tab is gone" as TAB_NOT_FOUND.
 *
 * chrome.tabs.get/update/remove REJECT with "No tab with id: N" for a closed or
 * made-up id — they do not resolve with undefined, which is what a `if (!t)`
 * guard would catch. Tagging only that guard left tab_focus and tab_close
 * reporting a stale id as EXECUTION_FAILED, the generic "the op ran and failed"
 * code, which is the case #134 used as its own example.
 *
 * Only that rejection is reclassified. Anything else — a windows.update
 * failure, a permission problem — keeps its own identity rather than being
 * relabelled as a missing tab.
 */
async function asTabLookup<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!/no tab with id/i.test(String((e as Error)?.message || e))) throw e;
    throw new BridgeError("TAB_NOT_FOUND", `tab ${tabId} not found — call tab_list again`, {
      cause: e,
    });
  }
}

/**
 * Resolve the tab a page-level op should act on (ADR-0028 Phase 1a).
 *
 * 1. An explicit `tabId` wins — and becomes the session's current tab, because
 *    targeting a tab is how a conversation says "work here".
 * 2. Otherwise the session's current tab (the virtual-focus pointer), as long
 *    as it still exists. A pointer at a closed tab is cleared rather than
 *    failing forever: the next call falls back to the active tab.
 * 3. Otherwise the active tab, exactly as before the pointer existed.
 *
 * The fallback to active on a dead pointer is deliberately broad: pointer
 * restoration is best-effort — an explicit `tabId` still gets the strict
 * TAB_NOT_FOUND classification via `asTabLookup`.
 */
export async function resolveTargetTab(maybeTabId: number | undefined): Promise<chrome.tabs.Tab> {
  if (maybeTabId) {
    const tab = await asTabLookup(maybeTabId, () => chrome.tabs.get(maybeTabId));
    await setCurrentTabId(maybeTabId);
    return tab;
  }
  const current = await getCurrentTabId();
  if (current !== null) {
    try {
      return await chrome.tabs.get(current);
    } catch {
      await clearCurrentTabId();
    }
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new BridgeError("TAB_NOT_FOUND", "no active tab in the current window");
  return active;
}

export async function injectIfNeeded(tabId: number) {
  // Content scripts are injected dynamically after the user grants the host
  // permission for this origin. Ping first so repeated tool calls stay cheap.
  try {
    // Probe the TOP frame specifically: an unqualified sendMessage reaches every
    // frame, so a sub-frame's pong could mask a top frame that has no content
    // script yet and skip the injection below.
    await chrome.tabs.sendMessage(tabId, { op: "ping" }, { frameId: TOP_FRAME });
  } catch {
    // Not injected yet — inject now (requires scripting permission + host).
    // Fetch the tab purely for its side effect: rejects if the tab is gone.
    await chrome.tabs.get(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["toast.css"],
      });
    } catch (_) {
      // CSS injection can fail on some pages; not fatal.
    }
  }
}

// Inject content.js into EVERY reachable frame (idempotent — content.ts's
// window-scoped load guard prevents double listeners). Best-effort: frames
// without host permission simply reject.
export async function injectAllFrames(tabId: number) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
  } catch {
    // Some frames may not be injectable; the per-frame dispatch tolerates gaps.
  }
}

// Enumerate the frames the extension can reach as [{frameId, url}]. Uses a
// func-injection rather than chrome.webNavigation.getAllFrames so we don't have
// to request the "read your browsing history" (webNavigation) permission.
// Frames without host permission are absent from the results (executeScript
// skips them), which naturally scopes reading to permitted origins.
export async function enumerateFrames(
  tabId: number
): Promise<Array<{ frameId: number; url: string }>> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href,
    });
    return results
      .filter((r) => typeof r.result === "string")
      .map((r) => ({ frameId: r.frameId, url: r.result as string }));
  } catch {
    return [{ frameId: 0, url: "" }]; // fall back to the top frame only
  }
}

export async function tabList() {
  const tabs = await chrome.tabs.query({});
  // groupId is -1 (chrome.tabGroups.TAB_GROUP_ID_NONE) for ungrouped tabs;
  // normalize that to undefined so the response only carries real group ids.
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
    groupId: typeof t.groupId === "number" && t.groupId >= 0 ? t.groupId : undefined,
  }));
}

export async function tabFocus(tabId: number) {
  // @types/chrome >=0.1 types tabs.update as `Tab | undefined` (no tab for the id),
  // but in practice a bad id REJECTS rather than resolving undefined — so the
  // rejection is where the classification has to happen. The guard stays for the
  // shape the types describe.
  const t = await asTabLookup(tabId, () => chrome.tabs.update(tabId, { active: true }));
  if (!t) throw new BridgeError("TAB_NOT_FOUND", `tab ${tabId} not found — call tab_list again`);
  await chrome.windows.update(t.windowId, { focused: true });
  // Focusing a tab makes it the session's current tab (ADR-0028 Phase 1a).
  await setCurrentTabId(tabId);
  return { focused: tabId };
}

// Name + color of the tab group browser-bridge collects its tabs into, so the
// AI's tabs are visually separated from the user's and can be collapsed/closed
// as a unit. See ADR-0018.
const WORKSPACE_TITLE = "Browser Bridge";
const WORKSPACE_COLOR = "blue";

export async function tabOpen(url: string) {
  const t = await chrome.tabs.create({ url });
  // Tabs the AI opens are always collected into the "Browser Bridge" group
  // (ADR-0018). The groupTabs toggle was removed — grouping is unconditional.
  let groupId: number | undefined;
  if (typeof t.id === "number") {
    // Opening a tab makes it the session's current tab (ADR-0028 Phase 1a) —
    // the agent's very next page op should hit the tab it just created.
    await setCurrentTabId(t.id);
    groupId = await addToWorkspaceGroup(t.id, t.windowId);
  }
  return { opened: t.id, url, groupId };
}

// Add a tab to the "Browser Bridge" workspace group in its window, creating the
// group (named + colored) if it doesn't exist yet. Best-effort: grouping is a
// UX nicety, so a failure here never fails the underlying tab_open.
async function addToWorkspaceGroup(
  tabId: number,
  windowId: number | undefined
): Promise<number | undefined> {
  try {
    const groups = await chrome.tabGroups.query(windowId != null ? { windowId } : {});
    const existing = groups.find((g) => g.title === WORKSPACE_TITLE);
    if (existing) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: existing.id });
      return existing.id;
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: WORKSPACE_TITLE, color: WORKSPACE_COLOR });
    return groupId;
  } catch (e) {
    console.warn("[bb] tab grouping failed:", (e as Error)?.message || e);
    return undefined;
  }
}

export async function tabClose(tabId: number) {
  // Closes the tab directly. `get` first so a bad id fails before anything is
  // removed, and so the failure is classified rather than surfacing as a bare
  // remove rejection.
  await asTabLookup(tabId, () => chrome.tabs.get(tabId));
  await asTabLookup(tabId, () => chrome.tabs.remove(tabId));
  // Closing the session's current tab leaves the pointer dangling; clear it so
  // the next op falls back to the active tab instead of a dead id.
  if ((await getCurrentTabId()) === tabId) {
    await clearCurrentTabId();
  }
  return { closed: tabId };
}
