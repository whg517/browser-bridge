// Shared type declarations for the browser-bridge MV3 extension.
//
// This module exports interfaces only — no runtime values — and is imported
// with `import type` by background/content/options/popup. esbuild erases those
// type-only imports entirely, so the emitted bundles are unaffected.

// The configurable settings persisted in chrome.storage.local. The DEFAULTS
// objects in background.ts, options.ts (full) and content.ts (a subset, via
// Pick) must stay in sync with these keys.
export interface Settings {
  pageEvalEnabled: boolean;
  evalMask: boolean;
  confirmHighRiskClick: boolean;
  warnPreciseSnapshot: boolean;
  confirmGraceMs: number;
  clickToastTimeoutMs: number;
  evalToastTimeoutMs: number;
  disabledTools: string[];
  allowAllSites: boolean;
}

// A request from the native host, forwarded to the right tab's content script.
// Shape: { id, op, tabId?, args }.
export interface BridgeReq {
  id: number | string;
  op: string;
  tabId?: number;
  args: any;
}

// The response posted back to the native host over the Port.
export interface BridgeResp {
  id: number | string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// Arguments an op may carry. Every field is optional — each handler reads the
// ones it needs (and validates them at runtime). Covers both content-script and
// tab-level ops.
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
}

// The { op, args } envelope content.ts receives via chrome.runtime.onMessage.
export interface ContentMsg {
  op: string;
  args: OpArgs;
  tabId?: number;
}
