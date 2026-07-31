// Runtime message router: handles requests from the popup / options page
// (connection status) and the content script's screenshot proxy. Registering
// this module installs the listener.

import type { RuntimeMsg } from "../shared/types";
import { isNativeConnected } from "./port";

chrome.runtime.onMessage.addListener((msg: RuntimeMsg, _sender, sendResponse) => {
  if (msg?.type === "get_status") {
    sendResponse({ nativeConnected: isNativeConnected() });
    return false;
  }
  if (msg?.type === "capture_visible_tab") {
    // Content scripts can't call chrome.tabs.captureVisibleTab; proxy here.
    // The (options, callback) overload captures the active tab of the current
    // window — no windowId needed.
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // async
  }
});
