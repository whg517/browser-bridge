// Tab resolution, content-script injection, and the tab-level tools
// (tab_list / tab_focus / tab_open / tab_close).

import { TOP_FRAME } from "./frames";

export async function resolveTargetTab(maybeTabId: number | undefined): Promise<chrome.tabs.Tab> {
  if (maybeTabId) {
    return await chrome.tabs.get(maybeTabId);
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new Error("no active tab");
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
  // @types/chrome >=0.1 types tabs.update as `Tab | undefined` (no tab for the id).
  const t = await chrome.tabs.update(tabId, { active: true });
  if (!t) throw new Error(`tab ${tabId} not found`);
  await chrome.windows.update(t.windowId, { focused: true });
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
  // Closes the tab directly. `get` first so a bad id fails with Chrome's clear
  // "No tab with id" error rather than a bare remove rejection.
  await chrome.tabs.get(tabId);
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}
