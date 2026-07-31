// page_eval (high-risk) — execute arbitrary JS in the page's global scope.
// Result is safely serialized and always masked before returning. Gated by the
// per-tool enable/disable (Tool enablement).

import type { OpArgs } from "../shared/types";
import { maskSensitive } from "../shared/masking";
import { truncate } from "./util";

// A Content-Security-Policy that omits 'unsafe-eval' blocks `new Function`, so
// page_eval cannot run through the content script at all on that page. That is
// an environment problem the model cannot code its way around — unlike a normal
// JS error — so say what to do about it. The CDP backend evaluates through
// chrome.debugger in the main world, which CSP does not gate (ADR-0017).
export const CSP_EVAL_MESSAGE =
  "page_eval is blocked by the page's Content Security Policy " +
  "(script-src without 'unsafe-eval' forbids new Function in the content script). " +
  "Turn on CDP mode in the extension's Options page to evaluate through " +
  "chrome.debugger instead, or use page_click / page_fill / page_snapshot / " +
  "page_text, which do not need eval.";

// Is this failure the CSP block rather than a fault in the caller's code?
// Chrome raises EvalError; other engines only say so in the message.
export function isCspEvalBlock(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "EvalError") return true;
  return /content security policy/i.test(String(err?.message || ""));
}

export async function runEval(args: OpArgs) {
  const code = args.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("page_eval needs non-empty `code`");
  }
  // Execute. Wrap as an async IIFE in the global scope so the code can use
  // await/return and see page globals. `new Function` (not eval) gives us
  // global scope regardless of the strict-mode closure this file runs in.
  let result: any;
  try {
    const fn = new Function('"use strict";\n' + "return (async () => {\n" + code + "\n})();");
    result = await fn();
  } catch (e: any) {
    // A CSP block is a failed call, not a result: throw so it surfaces as a
    // tool error with a remedy instead of a "successful" payload the model
    // has to parse a wall of CSP text out of.
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
  return maskSensitive(serializeResult(result));
}

// Safe serialization: handles cycles, DOM nodes, errors, exotic types, and
// truncates very large payloads. Returns JSON-serializable data.
function serializeResult(value: any, seen = new WeakSet(), depth = 0): any {
  if (depth > 50) return "[depth limit]";
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return truncate(value, 10000);
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return `[BigInt:${value.toString()}]`;
  if (t === "symbol") return `[Symbol:${value.toString()}]`;
  if (t === "function") return `[function:${value.name || "anonymous"}]`;
  if (t === "object") {
    // Error → structured
    if (value instanceof Error) {
      return { __error: true, name: value.name, message: value.message };
    }
    // DOM node → short tag descriptor
    if (value instanceof Element) {
      const id = value.id ? `#${value.id}` : "";
      return `<${value.tagName.toLowerCase()}${id}>`;
    }
    if (value instanceof Node) {
      return `<${value.nodeName}>`;
    }
    // Cycle guard
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 1000) return `[Array length=${value.length}, truncated]`;
        return value.slice(0, 1000).map((v) => serializeResult(v, seen, depth + 1));
      }
      // Plain object: enumerate own keys. Map/Set/Date get special tags.
      if (value instanceof Map) {
        const obj: any = {};
        let i = 0;
        for (const [k, v] of value) {
          obj[String(k)] = serializeResult(v, seen, depth + 1);
          if (++i > 1000) break;
        }
        return { __Map: obj };
      }
      if (value instanceof Set) {
        return {
          __Set: Array.from(value)
            .slice(0, 1000)
            .map((v) => serializeResult(v, seen, depth + 1)),
        };
      }
      if (value instanceof Date) return { __Date: value.toISOString() };
      if (value instanceof RegExp) return { __RegExp: value.toString() };
      const out: any = {};
      let count = 0;
      for (const key of Object.keys(value)) {
        if (count++ > 1000) {
          out.__truncated = true;
          break;
        }
        out[key] = serializeResult(value[key], seen, depth + 1);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}
