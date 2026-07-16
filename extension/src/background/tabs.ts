// Tab resolution, content-script injection, and the tab-level tools
// (tab_list / tab_focus / tab_open / tab_close).

import type { PageResponse } from "../shared/types";
import { getSetting } from "../shared/settings";
import { ensureAllowed } from "./allowlist-store";

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
    await chrome.tabs.sendMessage(tabId, { op: "ping" });
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
  await ensureAllowed(url);
  const t = await chrome.tabs.create({ url });
  let groupId: number | undefined;
  if ((await getSetting("groupTabs")) !== false && typeof t.id === "number") {
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
  const tab = await chrome.tabs.get(tabId);
  // The "Close tab?" confirmation can be turned off (confirmTabClose=false) for
  // hands-off automation; on by default.
  if ((await getSetting("confirmTabClose")) !== false) {
    await confirmTabClose(tab);
  }
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

async function confirmTabClose(tab: chrome.tabs.Tab) {
  if (!tab || !tab.id) throw new Error("tab not found");
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error(
      "tab_close can only close http(s) tabs because the close confirmation must be shown in the page"
    );
  }
  await ensureAllowed(tab.url);
  await injectIfNeeded(tab.id);
  const resp = (await chrome.tabs.sendMessage(tab.id, {
    op: "_confirm_toast",
    args: { message: `Close tab "${tab.title || tab.url}"?` },
  })) as PageResponse;
  if (resp && resp.__error) throw new Error(resp.__error);
  if (!resp || resp.approved !== true) {
    throw new Error("user denied tab_close");
  }
}
