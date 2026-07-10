// content.ts — injected into each page by background.ts. Receives { op, args }
// from the service worker via chrome.runtime.onMessage and runs the DOM
// operation, replying with JSON-serializable data or { __error }.
//
// This entry stays intentionally tiny: the re-injection guard and the message
// listener MUST live here (module top-level code in ./content/* runs at bundle
// eval time, before the guard). All real logic lives in ./content/*:
//   refs / snapshot / actions / wait / eval / storage / toast / handle

import { handle } from "./content/handle";

declare global {
  interface Window {
    __browserBridgeLoaded?: boolean;
  }
}

(() => {
  if (window.__browserBridgeLoaded) return; // guard against double-inject
  window.__browserBridgeLoaded = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handle(msg)
      .then((data) => sendResponse(data || {}))
      .catch((e) => sendResponse({ __error: String(e?.message || e) }));
    return true; // keep the channel open for the async response
  });
})();

export {};
