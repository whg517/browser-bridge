// A failure the extension can name, rather than describe.
//
// Every extension-side failure used to cross the bridge as a bare string, and
// BridgeResp had nowhere to put anything else — so the Rust side had exactly one
// variant for all of them and every one arrived as EXECUTION_FAILED. That made
// the `retryable` metadata in contracts/errors.json meaningless: a tab that has
// simply not navigated yet was reported as permanently failed, next to a genuine
// page-execution error, under the same non-retryable code (#134, #136).
//
// Throwing a BridgeError attaches a code from the shared taxonomy. Plain Errors
// still work and still land on EXECUTION_FAILED, which is the honest answer for
// "the extension ran the op and it failed" — this exists for the cases where
// something more specific is actually known.

/** Codes the extension can attach. A subset of contracts/errors.json — the rest
 *  are assigned Rust-side (bridge/transport failures) or are reserved. */
export type BridgeErrorCode =
  "TAB_NOT_FOUND" | "UNSUPPORTED_PAGE" | "EXTENSION_NOT_READY" | "TOOL_DISABLED";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BridgeError";
    this.code = code;
  }
}

/** The code to put on the wire for a rejected op, if the thrower named one.
 *
 * Reads the property rather than using `instanceof`: the error may have crossed
 * the service-worker ↔ content-script boundary, where structured cloning strips
 * the prototype and leaves a plain object behind. */
export function codeOf(err: unknown): BridgeErrorCode | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? (code as BridgeErrorCode) : undefined;
}
