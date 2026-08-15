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
  disabledTools: string[];
  cdpMode: boolean;
  // UI language for the extension's own surfaces: "auto" follows the browser,
  // "en"/"zh_CN" force a language (see shared/i18n.ts).
  language: "auto" | "en" | "zh_CN";
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
  /** Stable taxonomy code from contracts/errors.json, when the failure is one
   *  the extension can name. Absent means "unclassified" and the Rust side
   *  reports EXECUTION_FAILED. */
  code?: string;
}

// The loose args bag carried across the service-worker → content-script
// boundary (ContentMsg). Every field is optional — each handler reads the ones
// it needs (and validates them at runtime; the Rust side enforces the required
// ones per each tool's JSON schema). BridgeReq itself is now precisely typed via
// the generated BridgeCommand union; this stays wide because ContentMsg also
// carries internal ops (ping / _info_toast) not in the contract, and the
// content handlers read fields generically.
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
  // readiness level for nav; normalized at runtime (anything != "domcontentloaded" → "load")
  until?: string;
  // page_wait_for: with `selector`, resolve once this many match (default 1)
  minCount?: number;
  // page_wait_for: resolve when the DOM stops mutating for ~500ms (SPA-friendly)
  settled?: boolean;
  // page_text: "visible" (default, rendered only) | "full" (include hidden/inactive-tab text)
  mode?: string;
  type?: string;
  key?: string;
  message?: string;
  // _info_toast: localized Cancel-button label (built in the SW; the toast runs
  // in the page world where reading the language setting is awkward)
  toastCancel?: string;
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
export type RuntimeMsg = { type: "get_status" } | { type: "capture_visible_tab" };
