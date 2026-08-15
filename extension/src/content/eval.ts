// page_eval (high-risk) — execute arbitrary JS in the page's global scope.
// Result is safely serialized and always masked before returning. Gated by the
// per-tool enable/disable (Tool enablement).
//
// This backend only runs with CDP mode OFF (the default), where the extension's
// own CSP forbids `new Function` on every site — so in practice its whole job is
// to classify that block and say so. The evaluation path below is kept correct
// and in step with the CDP backend anyway: "always blocked" is an observation
// about current Chrome, not a guarantee across versions, policies and forks.

import type { OpArgs } from "../shared/types";
import { maskSensitive } from "../shared/masking";
import { CSP_EVAL_MESSAGE, isCspEvalBlock } from "../shared/csp-eval";
import { serializeForBridge } from "../shared/serialize";
import { truncate } from "./util";

export async function runEval(args: OpArgs) {
  const code = args.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("page_eval needs non-empty `code`");
  }
  // Execute. Wrap as an async IIFE in the global scope so the code can use
  // await/return and see page globals. `new Function` (not eval) gives us
  // global scope regardless of the strict-mode closure this file runs in.
  let result: unknown;
  try {
    result = await buildEval(code)();
  } catch (e: any) {
    // The isolated-world CSP block is not a fault in the caller's code and the
    // model cannot work around it, so it must not come back as an __evalError
    // payload that reads like a result. Throw the marked message instead: it
    // reaches the agent as a tool error and tells it to stop and ask the
    // operator to enable CDP mode.
    //
    // Nothing escalates on the agent's behalf. Catching this in the service
    // worker and re-running the call through chrome.debugger was built, tested
    // end to end, and REJECTED — attaching the debugger is a strictly larger
    // surface and granting it is the operator's decision, not a model's
    // (ADR-0025).
    if (isCspEvalBlock(e)) throw new Error(CSP_EVAL_MESSAGE, { cause: e });
    // Ordinary JS errors stay structured data, so the model can react
    // (e.g. fix the code and retry).
    return {
      __evalError: true,
      name: e?.name || "Error",
      message: String(e?.message || e),
      stack: truncate(String(e?.stack || ""), 2000),
    };
  }
  // Always mask token-like values before returning (the mask toggle was removed).
  return maskSensitive(serializeForBridge(result));
}

/**
 * Compile the caller's code, preferring an expression BODY.
 *
 * A block body discards an expression statement's value, so `1+1` evaluated to
 * nothing while plainly having run. `new Function` throws at CONSTRUCTION for a
 * parse failure — before any of the caller's code executes — which is what makes
 * falling back to the statement body free of double side effects. Retrying after
 * a *runtime* SyntaxError would not be: `JSON.parse("{")` throws one too, after
 * whatever ran before it.
 */
function buildEval(code: string): () => Promise<unknown> {
  const asExpression = '"use strict";\nreturn (async () => (\n' + code + "\n))();";
  const asStatements = '"use strict";\nreturn (async () => {\n' + code + "\n})();";
  try {
    return new Function(asExpression) as () => Promise<unknown>;
  } catch (e) {
    // A CSP block is not about the shape of the code; re-throw so runEval
    // classifies it. Anything else means "not a single expression".
    if (isCspEvalBlock(e)) throw e;
    return new Function(asStatements) as () => Promise<unknown>;
  }
}
