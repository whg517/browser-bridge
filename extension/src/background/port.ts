// Native-messaging port lifecycle. MV3 service workers are killed ~every 5 min
// and Chrome kills the host process whenever the port closes, so we reconnect
// automatically on startup and after any disconnect.

import type { BridgeReq } from "../shared/types";
import { announceFrame, buildAnnounce } from "../shared/announce";
import { dispatch } from "./dispatch";

const NATIVE_HOST = "com.browser_bridge.host";

let port: chrome.runtime.Port | null = null;
let portOk = false; // did the most recent connect succeed?
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function isNativeConnected(): boolean {
  return portOk;
}

export function connectNative() {
  // Tear down any previous handle first.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    portOk = true;
    console.log("[bb] native host connected");
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onNativeDisconnect);
    // Tell the server which extension it just got, before any request arrives.
    // Every reconnect re-announces — that is a new connection generation on the
    // server, and the SW is recycled every ~5 min, so it must not be one-shot.
    announce();
  } catch (e) {
    portOk = false;
    console.error("[bb] connectNative threw", e);
    scheduleReconnect();
  }
}

/**
 * Send the version announce. Best-effort by design: it is diagnostic context,
 * so a failure here must never keep the bridge from carrying real tool calls —
 * an older host that ignores the frame, or a port that dies in the same tick,
 * both just mean the server treats this extension as an unknown version.
 */
function announce() {
  if (!port) return;
  try {
    const { version } = chrome.runtime.getManifest();
    port.postMessage(announceFrame(buildAnnounce(version, navigator.userAgent)));
  } catch (e) {
    console.warn("[bb] announce failed", e);
  }
}

function onNativeDisconnect(_p: chrome.runtime.Port) {
  portOk = false;
  port = null;
  const err = chrome.runtime.lastError;
  console.warn("[bb] native host disconnected:", err?.message || "unknown");
  // Chrome kills the host process when the Port drops. Reconnect so a fresh
  // host is spawned — but back off to avoid a tight loop if the host is
  // genuinely unavailable (e.g. install not finished).
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, 2000);
}

function onNativeMessage(msg: BridgeReq) {
  // Each message is a BridgeReq: { id, op, tabId?, args }. Guard defensively —
  // it crosses the native-messaging boundary.
  if (!msg || typeof msg.id === "undefined" || !msg.op) {
    console.warn("[bb] malformed BridgeReq", msg);
    return;
  }
  dispatch(msg).then(
    (data) => sendResponse(msg.id, true, data),
    (err) => sendResponse(msg.id, false, undefined, String(err?.message || err || "error"))
  );
}

function sendResponse(id: number | string, ok: boolean, data?: unknown, error?: string) {
  if (!port) return; // host gone; nothing to do
  try {
    port.postMessage({ id, ok, data, error: ok ? undefined : error });
  } catch (e) {
    // Port likely closed; the disconnect handler will reconnect.
    console.warn("[bb] postMessage failed", e);
  }
}
