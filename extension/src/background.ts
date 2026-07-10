// background.ts — MV3 service worker entry point.
//
// Thin wiring only; the real logic lives in ./background/*:
//   - port.ts          native-messaging port lifecycle + reconnect
//   - dispatch.ts       route a BridgeReq to the right handler
//   - tabs.ts           tab resolution/injection + tab_* tools
//   - precise.ts        page_snapshot_precise (chrome.debugger / CDP)
//   - cookies.ts        cookie_get (chrome.cookies, SW-only)
//   - allowlist-store.ts  storage-backed allowlist + approval flow
//   - messages.ts       runtime message router (popup/options/screenshot)

import "./background/messages"; // registers the runtime.onMessage router
import { connectNative } from "./background/port";

chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
// Also connect eagerly when the SW wakes for any reason. connectNative is
// idempotent-ish: if a port already exists it creates a new one and the old
// is replaced.
connectNative();

export {};
