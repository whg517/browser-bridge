// Shared type declarations for the browser-bridge MV3 extension.
//
// This module exports interfaces only — no runtime values — and is imported
// with `import type` by background/content/options/popup. esbuild erases those
// type-only imports entirely, so the emitted bundles are unaffected.

import type { BridgeCommand } from "./ops";

// The configurable settings persisted in chrome.storage.local. The DEFAULTS
// objects in background.ts, options.ts (full) and content.ts (a subset, via
// Pick) must stay in sync with these keys.
export interface Settings {
  pageEvalEnabled: boolean;
  evalMask: boolean;
  confirmHighRiskClick: boolean;
  confirmPageEval: boolean;
  confirmTabClose: boolean;
  warnPreciseSnapshot: boolean;
  confirmGraceMs: number;
  clickToastTimeoutMs: number;
  evalToastTimeoutMs: number;
  disabledTools: string[];
  allowAllSites: boolean;
  cdpMode: boolean;
}

// A request from the native host, forwarded to the right tab's content script.
// Shape on the wire: { id, op, tabId?, args }. `op` + `args` come from the
// generated BridgeCommand union (one arm per tool, args typed to that tool's
// inputSchema), intersected with the request envelope so consumers can narrow
// on `op` and get exactly the args that tool accepts. The intersection
// distributes over the union, so BridgeReq stays a discriminated union.
export type BridgeReq = BridgeCommand & { id: number | string; tabId?: number };

// The response posted back to the native host over the Port.
export interface BridgeResp {
  id: number | string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// The loose args bag carried across the service-worker → content-script
// boundary (ContentMsg). Every field is optional — each handler reads the ones
// it needs (and validates them at runtime; the Rust side enforces the required
// ones per each tool's JSON schema). BridgeReq itself is now precisely typed via
// the generated BridgeCommand union; this stays wide because ContentMsg also
// carries internal ops (ping / _confirm_toast / _info_toast) not in the
// contract, and the content handlers read fields generically.
export interface OpArgs {
  ref?: string;
  selector?: string;
  value?: string;
  code?: string;
  direction?: string;
  pixels?: number;
  timeoutMs?: number;
  text?: string;
  nav?: boolean;
  type?: string;
  key?: string;
  message?: string;
  // tab-level / cookie ops (service worker)
  tabId?: number;
  url?: string;
  domain?: string;
  name?: string;
  frameId?: string;
}

// The { op, args } envelope content.ts receives via chrome.runtime.onMessage.
export interface ContentMsg {
  op: string;
  args: OpArgs;
  tabId?: number;
}

// The reply a content-script op sends back. Ops return varied payloads, so the
// known control fields are typed and the rest is left open.
export interface PageResponse {
  __error?: string;
  __cancelled?: boolean;
  approved?: boolean;
  [key: string]: unknown;
}

// Messages the service worker receives from the popup / options page and the
// content-script screenshot proxy (chrome.runtime.onMessage).
export type RuntimeMsg =
  | { type: "resolve_allow"; id: string; allow: boolean }
  | { type: "get_allowlist" }
  | { type: "add_allow"; glob: string }
  | { type: "remove_allow"; glob: string }
  | { type: "get_status" }
  | { type: "capture_visible_tab" };
