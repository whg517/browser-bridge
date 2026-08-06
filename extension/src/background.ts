// background.ts — MV3 service worker entry point.
//
// Thin wiring only; the real logic lives in ./background/*:
//   - port.ts          native-messaging port lifecycle + reconnect
//   - dispatch.ts       route a BridgeReq to the right handler
//   - tabs.ts           tab resolution/injection + tab_* tools
//   - precise.ts        page_snapshot_precise (chrome.debugger / CDP)
//   - cookies.ts        cookie_get (chrome.cookies, SW-only)
//   - messages.ts       runtime message router (popup/options/screenshot)

import "./background/messages"; // registers the runtime.onMessage router
import { connectNative, installKeepalive } from "./background/port";
import { installCdpLifecycleListeners } from "./background/cdp/registry";
import { verifyExtensionId } from "./background/id-check";

// Loudly log if the running extension id ≠ the pinned id. A mismatch means the
// native host rejects this extension (allowed_origins pins the id) — the most
// common "won't connect" cause. Runs first so it's visible at the top of the log.
verifyExtensionId();

// CDP mode (ADR-0017): tear down debugger sessions when a tab closes, when
// Chrome detaches us, or when the user turns cdpMode off. Registered once here
// (not at module load) so the registry stays import-side-effect-free elsewhere.
installCdpLifecycleListeners();

chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
// A periodic alarm is the only thing that can wake a terminated worker: the
// reconnect timer in port.ts dies with the worker, and the host cannot reach in.
// See installKeepalive for why this is the normal path, not an edge case.
installKeepalive();
// Also connect eagerly when the SW wakes for any reason. connectNative is
// idempotent-ish: if a port already exists it creates a new one and the old
// is replaced.
connectNative();

export {};
