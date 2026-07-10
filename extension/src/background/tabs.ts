// Tab resolution, content-script injection, and the tab-level tools
// (tab_list / tab_focus / tab_open / tab_close).

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
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
  }));
}

export async function tabFocus(tabId: number) {
  const t = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
  return { focused: tabId };
}

export async function tabOpen(url: string) {
  await ensureAllowed(url);
  const t = await chrome.tabs.create({ url });
  return { opened: t.id, url };
}

export async function tabClose(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  await confirmTabClose(tab);
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
  const resp: any = await chrome.tabs.sendMessage(tab.id, {
    op: "_confirm_toast",
    args: { message: `Close tab "${tab.title || tab.url}"?` },
  });
  if (resp && resp.__error) throw new Error(resp.__error);
  if (!resp || resp.approved !== true) {
    throw new Error("user denied tab_close");
  }
}
