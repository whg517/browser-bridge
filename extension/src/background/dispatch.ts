// Route an inbound BridgeReq to the code that should act on it: tab-level ops
// run here in the SW; page-level ops are forwarded to the target tab's content
// script (injecting it first).

import type { BridgeReq } from "../shared/types";
import { getSetting } from "../shared/settings";
import { TOOL_META } from "../shared/ops";
import { decide } from "./policy";
import { resolveTargetTab, tabList, tabFocus, tabOpen, tabClose } from "./tabs";
import { snapshotPrecise } from "./precise";
import { cookieGet } from "./cookies";
import { selectBackend } from "./page-backend";

/**
 * The disable gate, factored out for testability. Routes through the pure
 * policy `decide()` but preserves dispatch's original behavior exactly:
 *
 * - Only *known* tools (present in TOOL_META) are consulted, because `decide()`
 *   fail-closes unknown ops. Unknown/empty ops pass through untouched — the Rust
 *   side validates tool names upstream, and the switch handles the rest.
 * - A known, disabled tool throws `tool disabled in settings: <op>` — the same
 *   message the old inline check produced (`decision.reason` is
 *   "tool disabled in settings").
 */
export function assertNotDisabled(op: string | undefined, disabledTools: string[]): void {
  if (!op || !(op in TOOL_META)) return;
  const decision = decide(op, { disabledTools });
  if (!decision.allowed && decision.reason === "tool disabled in settings") {
    throw new Error(`${decision.reason}: ${op}`);
  }
}

export async function dispatch(req: BridgeReq): Promise<unknown> {
  const { op } = req;

  // Tool enable/disable gate: if the op is in the user's disabledTools list,
  // reject before doing anything. The op strings here mirror the tool names in
  // tools.rs and options.ts TOOLS — keep in sync.
  const disabled = await getSetting("disabledTools");
  assertNotDisabled(op, Array.isArray(disabled) ? disabled : []);

  // Tab-level ops handled directly here (no content script needed). Switching on
  // `req.op` narrows `req.args` to that tool's schema (BridgeCommand), so the
  // required args (e.g. tabId, url) are typed non-optional — no `!` needed.
  switch (req.op) {
    case "tab_list":
      return await tabList();
    case "tab_focus":
      return await tabFocus(req.args.tabId);
    case "tab_open":
      return await tabOpen(req.args.url);
    case "tab_close":
      return await tabClose(req.args.tabId);
    case "page_snapshot_precise":
      // Handled in SW via chrome.debugger; does NOT go through content.js.
      return await snapshotPrecise(req.tabId, req.args);
    case "cookie_get":
      // chrome.cookies API is only available in SW context.
      return await cookieGet(req.tabId, req.args);
  }

  // Page-level ops. Resolve the target tab, then run through the selected
  // backend: the content script (default) or CDP / chrome.debugger when the
  // user turned cdpMode on (ADR-0017). The backend owns ensureAllowed +
  // injection/attach, so dispatch's ordering (resolve tab → ensureAllowed →
  // run) is preserved either way.
  const tab = await resolveTargetTab(req.tabId);
  const cdpMode = (await getSetting("cdpMode")) === true;
  const backend = selectBackend(cdpMode);
  return await backend.run(op, req.args, tab);
}
