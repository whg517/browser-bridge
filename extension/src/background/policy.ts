// Policy layer (foundation, additive only).
//
// A PURE decision function that, given an op name and the current settings
// context, says whether the op is allowed and how it should be confirmed. It is
// derived entirely from TOOL_META (generated from contracts/tools.json) plus the
// user's disabledTools list — no chrome.* calls, no I/O, no import-time side
// effects — so it is trivially unit-testable and can be reused from anywhere.
//
// Live enforcement point: background/dispatch.ts routes the per-tool
// enable/disable gate through `decide` (assertNotDisabled) before any op runs.

import { TOOL_META, type Confirmation, type Risk } from "../shared/ops";

export type ConfirmationChannel = "extension-ui" | "none";

export interface PolicyDecision {
  allowed: boolean;
  risk: Risk;
  requiresConfirmation: boolean;
  confirmationChannel: ConfirmationChannel;
  reason: string;
}

export interface PolicyContext {
  /** Op names the user has disabled in settings. */
  disabledTools: string[];
}

// Risk assigned to an op we have no metadata for. Treated as the most dangerous
// bucket so unknown ops fail closed.
const UNKNOWN_RISK: Risk = "critical";

/**
 * Map a tool's `confirmation` field to whether a call must be confirmed and via
 * which channel. The only non-"none" value in the contract is "warn"
 * (page_snapshot_precise's on-page notice).
 *
 * - "none" → no confirmation
 * - anything else (e.g. "warn", or a future contract value) → confirm via the
 *   extension UI channel (fail-safe)
 */
function confirmationFor(confirmation: Confirmation): {
  requiresConfirmation: boolean;
  confirmationChannel: ConfirmationChannel;
} {
  switch (confirmation) {
    case "none":
      return { requiresConfirmation: false, confirmationChannel: "none" };
    default:
      // "warn" and any value added to the contract later: require confirmation
      // via the extension UI.
      return { requiresConfirmation: true, confirmationChannel: "extension-ui" };
  }
}

/**
 * Decide whether `op` may run given the current settings context.
 *
 * Pure: depends only on its arguments and the static TOOL_META table.
 */
export function decide(op: string, ctx: PolicyContext): PolicyDecision {
  const meta = TOOL_META[op];

  // Unknown op: fail closed.
  if (!meta) {
    return {
      allowed: false,
      risk: UNKNOWN_RISK,
      requiresConfirmation: true,
      confirmationChannel: "extension-ui",
      reason: "unknown tool",
    };
  }

  const { requiresConfirmation, confirmationChannel } = confirmationFor(meta.confirmation);

  // Disabled by the user in settings: not allowed, but still report the tool's
  // real risk/confirmation shape for UI purposes.
  if (ctx.disabledTools.includes(op)) {
    return {
      allowed: false,
      risk: meta.risk,
      requiresConfirmation,
      confirmationChannel,
      reason: "tool disabled in settings",
    };
  }

  return {
    allowed: true,
    risk: meta.risk,
    requiresConfirmation,
    confirmationChannel,
    reason: requiresConfirmation ? "allowed; requires confirmation" : "allowed",
  };
}
