// Dispatch an inbound { op, args } message to the right content-script handler.

import type { ContentMsg } from "../shared/types";
import { snapshot } from "./snapshot";
import { click, fill, text, screenshot, scroll } from "./actions";
import { waitFor } from "./wait";
import { runEval } from "./eval";
import { storageGet } from "./storage";
import { showToast, showInfoToast } from "./toast";

export async function handle(msg: ContentMsg) {
  const { op, args } = msg;
  switch (op) {
    case "ping":
      return { pong: true };
    case "page_snapshot":
      return snapshot();
    case "page_click":
      return await click(args);
    case "page_fill":
      return await fill(args);
    case "page_text":
      return text();
    case "page_screenshot":
      return await screenshot();
    case "page_scroll":
      return scroll(args);
    case "page_wait_for":
      return await waitFor(args);
    case "page_eval":
      return await runEval(args);
    case "storage_get":
      return storageGet(args);
    case "_info_toast":
      // Informational toast (e.g. "about to attach debugger, infobar will
      // flash"). Returns true unless the user cancels.
      return await showInfoToast(args.message || "");
    case "_confirm_toast":
      return { approved: await showToast(args.message || "Confirm action?") };
    default:
      throw new Error(`content: unknown op ${op}`);
  }
}
