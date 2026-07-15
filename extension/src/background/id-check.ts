// Startup self-check: compare the running extension id to the pinned id and log
// the result. A mismatch means the native-messaging host (which pins the id in
// allowed_origins) will reject this extension — the single most common, and
// most confusing, reason browser-bridge "won't connect". Logging it at startup
// turns a silent rejection into an obvious `[bb]` console error.

import { diagnoseExtensionId } from "../shared/extension-id";

export function verifyExtensionId(): void {
  const d = diagnoseExtensionId(chrome.runtime.id);
  if (d.ok) {
    console.log("[bb]", d.message);
  } else {
    console.error("[bb] ⚠", d.message);
  }
}
