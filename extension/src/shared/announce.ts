// The announce frame the extension sends the moment it connects to the native
// host, so the MCP server knows which extension it is actually talking to.
//
// The host binary and this extension are upgraded through completely separate
// channels — the binary by hand, the extension automatically by the Chrome Web
// Store — so drifting apart is the normal state after any release, not an edge
// case. Without this frame the server has no way to know, and a mismatch reaches
// the agent as an unexplained "unknown op" instead of "ask the user to update".
//
// ## Why it wears the BridgeResp envelope
//
// "Old binary + new extension" is exactly the drift being reported, so the frame
// must be harmless to a server that has never heard of it. The Rust side reads
// every inbound line as a BridgeResp, whose `id`/`ok` are required: a bare
// `{ type: "announce" }` line would fail to deserialize, and that error kills the
// reader loop and drops the connection — the extension would then reconnect-loop
// forever against any older host.
//
// So the announce IS a BridgeResp, on the reserved id 0. The server's request ids
// start at 1, so it can never collide with a real reply; a server that predates
// this simply finds no pending caller for id 0, logs that, and carries on. See
// src/peer.rs for the receiving end.

import { PROTOCOL_VERSION } from "./ops";
import type { BridgeResp } from "./types";

/** The reserved BridgeResp id an announce rides on. Never a real request id. */
export const ANNOUNCE_ID = 0;

export interface Announce {
  protocolVersion: number;
  /** This extension's release version, from the manifest. */
  version: string;
  browser: { name: string; version: string };
}

/**
 * Best-effort Chrome version out of a user-agent string.
 *
 * The UA is the only version source available to an MV3 service worker —
 * `navigator.userAgentData` exposes only a major version without an async
 * `getHighEntropyValues()` call, and there is no `chrome.runtime.getBrowserInfo`
 * outside Firefox. Chromium forks are matched too (Edg/OPR/Brave), preferring
 * the fork's own token over the "Chrome/" one they all also carry, since that is
 * what a user would recognise. Falls back to "unknown" rather than throwing:
 * this is diagnostic context, never a reason to fail a connection.
 */
export function parseBrowser(userAgent: string): { name: string; version: string } {
  const forks: [RegExp, string][] = [
    [/\bEdg(?:A|iOS)?\/([\d.]+)/, "Edge"],
    [/\bOPR\/([\d.]+)/, "Opera"],
    [/\bBrave\/([\d.]+)/, "Brave"],
    [/\bChrome\/([\d.]+)/, "Chrome"],
    [/\bChromium\/([\d.]+)/, "Chromium"],
  ];
  for (const [re, name] of forks) {
    const m = re.exec(userAgent);
    if (m) return { name, version: m[1] };
  }
  return { name: "unknown", version: "unknown" };
}

/** The announce payload for this extension in this browser. */
export function buildAnnounce(version: string, userAgent: string): Announce {
  return {
    protocolVersion: PROTOCOL_VERSION,
    version,
    browser: parseBrowser(userAgent),
  };
}

/** Wrap an announce in the BridgeResp envelope that actually goes on the wire. */
export function announceFrame(announce: Announce): BridgeResp {
  return { id: ANNOUNCE_ID, ok: true, data: { announce } };
}
