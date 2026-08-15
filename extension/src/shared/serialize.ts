// Turning a JavaScript value into something the bridge can carry.
//
// The bridge speaks JSON, and JSON cannot express most of what page code
// actually returns. CDP's own `returnByValue` answers that by throwing the
// information away: Date, Map, Set, RegExp, Error, DOM nodes and functions all
// arrive as `{}`, `undefined` disappears, and symbols and cyclic objects are
// refused outright with a raw protocol error. All of it silently — `{}` and
// `null` are plausible answers, so nothing signals that a value was lost.
//
// So serialize before the value ever reaches that boundary, tagging what JSON
// cannot hold. `__`-prefixed markers are the convention already used for errors
// (`__evalError`); this extends the same vocabulary rather than inventing one.
//
// `undefined` is tagged rather than dropped because the language distinguishes
// "no value was produced" from "the value null", and collapsing them is exactly
// what made a missing `return` indistinguishable from a deliberate `return null`.
//
// MUST STAY SELF-CONTAINED. `SERIALIZE_FN_SOURCE` stringifies this function and
// injects it into the page, so it can reference nothing from module scope — no
// imports, no helpers, no constants. Everything it needs is declared inside.

export function serializeForBridge(value: unknown, seen?: unknown, depth?: number): unknown {
  const visited = (seen as Set<unknown>) || new Set<unknown>();
  const level = depth || 0;
  const MAX_DEPTH = 50;
  const MAX_STRING = 10000;
  const MAX_ITEMS = 1000;

  const cut = (s: string) => (s.length > MAX_STRING ? s.slice(0, MAX_STRING) + "…[truncated]" : s);

  if (level > MAX_DEPTH) return "[depth limit]";
  if (value === undefined) return { __undefined: true };
  if (value === null) return null;

  const t = typeof value;
  if (t === "string") return cut(value as string);
  if (t === "boolean") return value;
  if (t === "number") {
    // NaN and ±Infinity are numbers JSON turns into null, losing which one.
    const n = value as number;
    return Number.isFinite(n) ? n : { __number: String(n) };
  }
  if (t === "bigint") return `[BigInt:${(value as bigint).toString()}]`;
  if (t === "symbol") return `[Symbol:${(value as symbol).toString()}]`;
  if (t === "function") return `[function:${(value as { name?: string }).name || "anonymous"}]`;
  if (t !== "object") return String(value);

  if (value instanceof Error) {
    return { __error: true, name: value.name, message: cut(value.message) };
  }
  // Guarded so the function also runs where the DOM does not exist (unit tests).
  if (typeof Element !== "undefined" && value instanceof Element) {
    return `<${value.tagName.toLowerCase()}${value.id ? "#" + value.id : ""}>`;
  }
  if (typeof Node !== "undefined" && value instanceof Node) {
    return `<${(value as Node).nodeName}>`;
  }

  if (visited.has(value)) return "[Circular]";
  visited.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ITEMS) return `[Array length=${value.length}, truncated]`;
      return value.map((v) => serializeForBridge(v, visited, level + 1));
    }
    if (value instanceof Date) return { __Date: value.toISOString() };
    if (value instanceof RegExp) return { __RegExp: value.toString() };
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      let i = 0;
      for (const [k, v] of value) {
        if (i++ >= MAX_ITEMS) break;
        out[String(k)] = serializeForBridge(v, visited, level + 1);
      }
      return { __Map: out };
    }
    if (value instanceof Set) {
      const items: unknown[] = [];
      for (const v of value) {
        if (items.length >= MAX_ITEMS) break;
        items.push(serializeForBridge(v, visited, level + 1));
      }
      return { __Set: items };
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(value as object)) {
      if (count++ >= MAX_ITEMS) {
        out.__truncated = true;
        break;
      }
      out[key] = serializeForBridge((value as Record<string, unknown>)[key], visited, level + 1);
    }
    return out;
  } finally {
    visited.delete(value);
  }
}

/**
 * The function above as source, for injection into the page's MAIN world.
 *
 * `page_eval` runs through CDP, and serializing in the service worker would be
 * too late — `returnByValue` has already flattened everything by then. Wrapping
 * this in parentheses makes it a *named* function expression, so its recursive
 * self-reference resolves to itself.
 *
 * Safe because the bundle is built with `minify: false` (see build.mjs, which
 * says so deliberately: the unpacked extension stays debuggable), so the source
 * survives bundling with its identifiers intact.
 */
export const SERIALIZE_FN_SOURCE = String(serializeForBridge);
