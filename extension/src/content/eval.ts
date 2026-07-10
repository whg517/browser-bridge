// page_eval (high-risk, ADR-0008) — execute arbitrary JS in the page's global
// scope after an enlarged confirmation toast. Result is safely serialized and
// (by default) masked before returning.

import type { OpArgs } from "../shared/types";
import { getSetting } from "../shared/settings";
import { maskSensitive } from "../shared/masking";
import { truncate } from "./util";
import { confirmWithEvalToast } from "./toast";

export async function runEval(args: OpArgs) {
  const code = args.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("page_eval needs non-empty `code`");
  }
  // Global kill switch: if the user disabled page_eval in settings, refuse
  // before any code runs (and before any confirmation prompt).
  const evalEnabled = await getSetting("pageEvalEnabled");
  if (evalEnabled === false) {
    throw new Error("page_eval disabled in settings");
  }
  // Confirm with the user via an enlarged Toast showing the full code.
  // Reuses lastConfirmed so same-origin eval within 60s of a prior approval
  // does not re-prompt. NOTE: this grace window is riskier for eval than for
  // click (see ADR-0008) — two evals can be totally unrelated code.
  await confirmWithEvalToast(code);
  // Execute. Wrap as an async IIFE in the global scope so the code can use
  // await/return and see page globals. `new Function` (not eval) gives us
  // global scope regardless of the strict-mode closure this file runs in.
  let result: any;
  try {
    const fn = new Function('"use strict";\n' + "return (async () => {\n" + code + "\n})();");
    result = await fn();
  } catch (e: any) {
    // Surface JS errors to the model as structured data, not a throw, so the
    // model can react (e.g. fix the code and retry).
    return {
      __evalError: true,
      name: e?.name || "Error",
      message: String(e?.message || e),
      stack: truncate(String(e?.stack || ""), 2000),
    };
  }
  const serialized = serializeResult(result);
  const mask = await getMaskSetting();
  return mask ? maskSensitive(serialized) : serialized;
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

// Read the eval mask toggle from storage. Default true (mask on). Cached after
// the first read.
let _maskCache = true;
let _maskLoaded = false;
function getMaskSetting() {
  if (_maskLoaded) return Promise.resolve(_maskCache);
  return new Promise((resolve) => {
    chrome.storage.local.get("evalMask", (r) => {
      // undefined → default true (mask on)
      _maskCache = r.evalMask !== false;
      _maskLoaded = true;
      resolve(_maskCache);
    });
  });
}
