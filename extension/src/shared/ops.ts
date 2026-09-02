// GENERATED from contracts/tools.json + contracts/protocol-version.json by
// scripts/gen-ops.mjs — DO NOT EDIT.
// Edit the contract, then run `make gen` (or `node scripts/gen-ops.mjs`).
//
// The tool catalogue, JS side: op names + Chinese UI labels for the options
// page, policy metadata (risk / scope / permission / confirmation), and the
// per-tool request shapes (BridgeCommand, derived from each inputSchema).
// tools.rs is verified against the same contract in `cargo test`.

// The internal bridge protocol version, advertised in the announce frame
// (shared/announce.ts). Bumped only when the wire contract changes
// incompatibly; src/peer.rs asserts the same value against the same contract.
export const PROTOCOL_VERSION = 1;

export interface ToolInfo {
  op: string;
  desc: string;
}

export const TOOLS: ToolInfo[] = [
  { op: "tab_list", desc: "List all tabs" },
  { op: "tab_focus", desc: "Switch to a tab" },
  { op: "tab_open", desc: "Open a new tab" },
  { op: "tab_close", desc: "Close a tab" },
  { op: "page_snapshot", desc: "Snapshot interactive elements" },
  { op: "page_click", desc: "Click an element" },
  { op: "page_fill", desc: "Fill a form field" },
  { op: "page_text", desc: "Read page text" },
  { op: "page_links", desc: "Extract links (mailto/tel/href)" },
  { op: "page_screenshot", desc: "Capture the viewport" },
  { op: "page_scroll", desc: "Scroll the page" },
  { op: "page_wait_for", desc: "Wait for a condition" },
  { op: "page_eval", desc: "Execute arbitrary JS (high-risk)" },
  { op: "page_snapshot_precise", desc: "Precise snapshot (via debugger)" },
  { op: "cookie_get", desc: "Read cookies (redacted)" },
  { op: "storage_get", desc: "Read localStorage/sessionStorage (redacted)" },
];

// All op names, for enumeration / consistency checks.
export const OP_NAMES: string[] = TOOLS.map((t) => t.op);

// Policy metadata, mirrored from the contract. Consumed by the policy layer
// (background/policy.ts) — kept as plain data so it stays import-side-effect-free.
export type Risk = "critical" | "high" | "low" | "medium";
export type Scope = "page" | "tab";
export type Permission = "cookies" | "debugger" | "scripting" | "tabs";
export type Confirmation = "none" | "warn";

export interface ToolMeta {
  risk: Risk;
  scope: Scope;
  permission: Permission;
  confirmation: Confirmation;
}

export const TOOL_META: Record<string, ToolMeta> = {
  tab_list: {
    risk: "low",
    scope: "tab",
    permission: "tabs",
    confirmation: "none",
  },
  tab_focus: {
    risk: "low",
    scope: "tab",
    permission: "tabs",
    confirmation: "none",
  },
  tab_open: {
    risk: "medium",
    scope: "tab",
    permission: "tabs",
    confirmation: "none",
  },
  tab_close: {
    risk: "high",
    scope: "tab",
    permission: "tabs",
    confirmation: "none",
  },
  page_snapshot: {
    risk: "low",
    scope: "page",
    permission: "scripting",
    confirmation: "none",
  },
  page_click: {
    risk: "high",
    scope: "page",
    permission: "scripting",
    confirmation: "none",
  },
  page_fill: {
    risk: "high",
    scope: "page",
    permission: "scripting",
    confirmation: "none",
  },
  page_text: {
    risk: "medium",
    scope: "page",
    permission: "scripting",
    confirmation: "none",
  },
  page_links: {
    risk: "medium",
    scope: "page",
    permission: "scripting",
    confirmation: "none",
  },
  page_screenshot: {
    risk: "medium",
    scope: "page",
    permission: "tabs",
    confirmation: "none",
  },
  page_scroll: {
    risk: "low",
    scope: "page",
    permission: "scripting",
    confirmation: "none",
  },
  page_wait_for: {
    risk: "low",
    scope: "page",
    permission: "scripting",
    confirmation: "none",
  },
  page_eval: {
    risk: "critical",
    scope: "page",
    permission: "scripting",
    confirmation: "none",
  },
  page_snapshot_precise: {
    risk: "medium",
    scope: "page",
    permission: "debugger",
    confirmation: "warn",
  },
  cookie_get: {
    risk: "high",
    scope: "tab",
    permission: "cookies",
    confirmation: "none",
  },
  storage_get: {
    risk: "high",
    scope: "page",
    permission: "scripting",
    confirmation: "none",
  },
};

// Per-tool request shapes, derived from each tool's inputSchema. Discriminated
// on `op`, so consumers (background/dispatch.ts) narrow the args to exactly the
// fields that tool accepts. shared/types.ts intersects this with the request
// envelope ({ id, tabId? }) to form BridgeReq. Required schema props map to
// required fields; the rest are optional. JSON-Schema string→string,
// integer/number→number, boolean→boolean.
export type BridgeCommand =
  | { op: "tab_list"; args: Record<string, never> }
  | { op: "tab_focus"; args: { tabId: number } }
  | { op: "tab_open"; args: { url: string } }
  | { op: "tab_close"; args: { tabId: number } }
  | { op: "page_snapshot"; args: { tabId?: number } }
  | { op: "page_click"; args: { ref?: string; selector?: string; tabId?: number } }
  | { op: "page_fill"; args: { ref?: string; selector?: string; value: string; tabId?: number } }
  | { op: "page_text"; args: { mode?: string; tabId?: number } }
  | { op: "page_links"; args: { type?: string; tabId?: number } }
  | { op: "page_screenshot"; args: { tabId?: number } }
  | { op: "page_scroll"; args: { direction?: string; pixels?: number; tabId?: number } }
  | {
      op: "page_wait_for";
      args: {
        nav?: boolean;
        until?: string;
        selector?: string;
        minCount?: number;
        text?: string;
        settled?: boolean;
        timeoutMs?: number;
        tabId?: number;
      };
    }
  | { op: "page_eval"; args: { code: string; tabId?: number } }
  | { op: "page_snapshot_precise"; args: { frameId?: string; tabId?: number } }
  | { op: "cookie_get"; args: { domain?: string; name?: string; url?: string; tabId?: number } }
  | { op: "storage_get"; args: { key?: string; type?: string; tabId?: number } };
