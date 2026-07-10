// Runtime message router: handles requests from the popup / options page
// (allowlist approve/add/remove/list, connection status) and the content
// script's screenshot proxy. Registering this module installs the listener.

import { getAllowlist, resolvePendingAllow, addAllow, removeAllow } from "./allowlist-store";
import { isNativeConnected } from "./port";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "resolve_allow") {
    resolvePendingAllow(msg.id, msg.allow).then((r) => sendResponse(r));
    return true; // async
  }
  if (msg?.type === "get_allowlist") {
    getAllowlist().then((list) => sendResponse({ list }));
    return true;
  }
  if (msg?.type === "add_allow") {
    const glob = msg.glob;
    if (typeof glob !== "string" || !glob) {
      sendResponse({ ok: false, error: "missing glob" });
      return false;
    }
    addAllow(glob).then((list) => sendResponse({ ok: true, list }));
    return true;
  }
  if (msg?.type === "remove_allow") {
    removeAllow(msg.glob).then((r) => sendResponse({ ok: true, ...r }));
    return true;
  }
  if (msg?.type === "get_status") {
    sendResponse({ nativeConnected: isNativeConnected() });
    return false;
  }
  if (msg?.type === "capture_visible_tab") {
    // Content scripts can't call chrome.tabs.captureVisibleTab; proxy here.
    chrome.tabs.captureVisibleTab(undefined as any, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // async
  }
});
