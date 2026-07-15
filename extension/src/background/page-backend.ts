// Strategy interface for running page-level ops, plus the selector that picks
// the backend based on the cdpMode setting (ADR-0017).
//
//   - cdpMode OFF (default) → ContentScriptBackend: inject content.js and
//     message it, exactly as before. Behavior is unchanged.
//   - cdpMode ON            → CdpBackend: run every op via chrome.debugger (CDP)
//     in the page's MAIN world, bypassing page CSP.
//
// Both backends receive the already-resolved target tab; ensureAllowed and any
// injection/attach happen inside the backend (preserving dispatch's ordering).

import type { OpArgs } from "../shared/types";
import { ContentScriptBackend } from "./backends/content-script";
import { CdpBackend } from "./backends/cdp";

export interface PageBackend {
  run(op: string, args: OpArgs, tab: chrome.tabs.Tab): Promise<unknown>;
}

const contentScriptBackend = new ContentScriptBackend();
const cdpBackend = new CdpBackend();

export function selectBackend(cdpMode: boolean): PageBackend {
  return cdpMode ? cdpBackend : contentScriptBackend;
}
