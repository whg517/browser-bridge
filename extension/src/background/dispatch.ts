// Route an inbound BridgeReq to the code that should act on it: tab-level ops
// run here in the SW; page-level ops are forwarded to the target tab's content
// script (injecting it first).

import type { BridgeReq } from "../shared/types";
import { getSetting } from "../shared/settings";
import { ensureAllowed } from "./allowlist-store";
import { resolveTargetTab, injectIfNeeded, tabList, tabFocus, tabOpen, tabClose } from "./tabs";
import { snapshotPrecise } from "./precise";
import { cookieGet } from "./cookies";

export async function dispatch(req: BridgeReq): Promise<any> {
  const { op, args } = req;

  // Tool enable/disable gate: if the op is in the user's disabledTools list,
  // reject before doing anything. The op strings here mirror the tool names in
  // tools.rs and options.ts TOOLS — keep in sync.
  if (op) {
    const disabled = await getSetting("disabledTools");
    if (Array.isArray(disabled) && disabled.includes(op)) {
      throw new Error(`tool disabled in settings: ${op}`);
    }
  }

  // Tab-level ops handled directly here (no content script needed).
  switch (op) {
    case "tab_list":
      return await tabList();
    case "tab_focus":
      return await tabFocus(args.tabId);
    case "tab_open":
      return await tabOpen(args.url);
    case "tab_close":
      return await tabClose(args.tabId);
    case "page_snapshot_precise":
      // Handled in SW via chrome.debugger; does NOT go through content.js.
      return await snapshotPrecise(req.tabId, args);
    case "cookie_get":
      // chrome.cookies API is only available in SW context.
      return await cookieGet(req.tabId, args);
  }

  // Page-level ops need a content script in the target tab.
  const tab = await resolveTargetTab(req.tabId);
  await ensureAllowed(tab.url);
  await injectIfNeeded(tab.id!);
  // content.js listens for these and replies.
  const resp: any = await chrome.tabs.sendMessage(tab.id!, { op, args, tabId: tab.id });
  if (resp && resp.__error) throw new Error(resp.__error);
  return resp;
}
