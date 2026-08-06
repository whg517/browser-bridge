// Native-messaging port lifecycle. MV3 service workers are killed ~every 5 min
// and Chrome kills the host process whenever the port closes, so we reconnect
// automatically on startup and after any disconnect.

import type { BridgeReq } from "../shared/types";
import { announceFrame, buildAnnounce } from "../shared/announce";
import { dispatch } from "./dispatch";

const NATIVE_HOST = "com.browser_bridge.host";
const WAKE_ALARM = "bb-reconnect";

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

/**
 * Periodically wake the service worker so it can (re)connect on its own.
 *
 * `scheduleReconnect` above only covers a dropped PORT. It cannot cover a
 * terminated WORKER: its `setTimeout` lives inside the worker and dies with it.
 * MV3 recycles an idle worker after ~30s, and the only registered wake events
 * were `onStartup` / `onInstalled` — browser start and install. So after a short
 * idle the bridge was simply unreachable, and no amount of retrying from the
 * host could fix it: native messaging is extension-initiated, so a running MCP
 * server has no channel to signal a dormant worker. Recovery required the user
 * to click the toolbar icon.
 *
 * That window is not exotic — it is the normal flow. The user types a prompt
 * into their MCP client while the browser sits idle; by the time the agent
 * issues its first tool call the worker is long gone. The very first call of a
 * session was the one most likely to fail.
 *
 * An alarm is the sanctioned MV3 remedy: firing it wakes the worker, which
 * re-runs this module's top level and reconnects. Once a port is open it keeps
 * the worker alive by itself, so the alarm only matters while nothing is
 * connected — the cost when a server IS running is zero.
 *
 * 30s is the floor Chrome enforces (older builds clamp sub-minute periods up to
 * 1 min; either is far better than never). The host waits up to 12s for a
 * connection on the first call, so a wake may still land after that window —
 * one retry then succeeds, versus never succeeding before.
 */
export function installKeepalive() {
  chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name !== WAKE_ALARM) return;
    // Waking is most of the point; only reconnect when we actually need to, so
    // a live port is never torn down and replaced for no reason.
    if (!isNativeConnected()) connectNative();
  });
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
