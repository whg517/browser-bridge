// Native-messaging port lifecycle. An MV3 service worker is terminated after
// ~30s of INACTIVITY — not on a fixed 5-minute schedule, as this comment used to
// say; the 5-minute figure in Chrome's docs is the cap on how long one event or
// API call may take, which is a different rule. Receiving an event or calling an
// extension API resets the idle timer, and an open native-messaging port counts,
// so a connected worker stays alive on its own.
//
// Chrome kills the host process whenever the port closes, so we reconnect
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
  // Disconnect before replacing. `background.ts` calls this from BOTH the
  // onInstalled listener and module top level, so a reload opens two ports and
  // Chrome spawns a host for each. That used to be self-healing — the surplus
  // host could not reach a server and exited on its own — but now that the host
  // waits instead of exiting, an abandoned port leaves a process waiting
  // forever. Observed as two resident hosts under one Chrome after a reload.
  if (port) {
    try {
      port.disconnect();
    } catch {
      // Already gone; nothing to release.
    }
    port = null;
    portOk = false;
  }
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    portOk = true;
    console.log("[bb] native host connected");
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onNativeDisconnect);
    // Tell the server which extension it just got, before any request arrives.
    // Every reconnect re-announces — that is a new connection generation on the
    // server, and the worker is recycled after ~30s idle, so it must not be
    // one-shot.
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
 * Cadence: one alarm at `periodInMinutes: 0.5` — the documented floor since
 * Chrome 120, and honoured (only values BELOW it are raised to 30s).
 *
 * v0.7.0 shipped TWO alarms on a 1-minute period offset by half of it, to work
 * around a clamp of 0.5 to a minute. That clamp does not exist. The belief came
 * from two samples showing first-connect times of ~50-60s, which cannot be a
 * clamp for two reasons: 0.5 is honoured on a packed extension, and the samples
 * were taken on an UNPACKED one, where the frequency limit does not apply at all.
 *
 * The real constraint is that Chrome fires alarms "at most once every 30 seconds
 * but may delay them arbitrarily more" — an unbounded tail that no alarm
 * configuration can close. Doubling the alarms cannot close it either, since the
 * delay comes from system-level throttling that would postpone both together.
 * What actually absorbs the tail is the host waiting a full cycle on the first
 * call of a session (see Session::call).
 *
 * Alarms can be dropped, and the docs recommend re-asserting them on every worker
 * start. `create()` with an existing name replaces it, so calling it here — on
 * every worker start — is that check, expressed as an unconditional write.
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
