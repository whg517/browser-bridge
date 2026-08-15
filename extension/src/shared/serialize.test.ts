// What page_eval used to return for each of these, measured against Chrome 151
// with CDP mode on, is in the right-hand column of #135: `{}` for Date, Set,
// RegExp, Error, DOM nodes and functions; `null` for BigInt and for undefined;
// and a raw protocol error for symbols and cycles. All with isError:false.
//
// These tests pin the replacement — and the SOURCE form too, because the CDP
// path does not call the function, it injects its text into the page. A change
// that broke stringification would leave every test here passing.

import { describe, expect, test } from "bun:test";
import { SERIALIZE_FN_SOURCE, serializeForBridge } from "./serialize";

// The function as the page receives it: parenthesised so its recursive
// self-reference resolves, exactly as backends/cdp.ts embeds it.
const injected = new Function(`return (${SERIALIZE_FN_SOURCE})`)() as typeof serializeForBridge;

// Every case is asserted through both, so the two can never drift.
function both(value: unknown): [unknown, unknown] {
  return [serializeForBridge(value), injected(value)];
}
function expectBoth(value: unknown, expected: unknown) {
  const [direct, viaSource] = both(value);
  expect(direct).toEqual(expected as never);
  expect(viaSource).toEqual(expected as never);
}

describe("serializeForBridge", () => {
  test("plain JSON values pass through untouched", () => {
    expectBoth(1, 1);
    expectBoth("hi", "hi");
    expectBoth(true, true);
    expectBoth(null, null);
    expectBoth({ a: 1, b: [2, "3"] }, { a: 1, b: [2, "3"] });
  });

  test("undefined is a value, not an absence", () => {
    // The distinction that made a missing `return` indistinguishable from a
    // deliberate `return null`.
    expectBoth(undefined, { __undefined: true });
    expectBoth({ a: undefined, b: null }, { a: { __undefined: true }, b: null });
    expectBoth([undefined, null], [{ __undefined: true }, null]);
  });

  test("types JSON cannot hold keep their identity", () => {
    expectBoth(new Date(0), { __Date: "1970-01-01T00:00:00.000Z" });
    expectBoth(/ab+c/gi, { __RegExp: "/ab+c/gi" });
    expectBoth(
      new Map([
        ["k", 1],
        ["j", 2],
      ]),
      { __Map: { k: 1, j: 2 } }
    );
    expectBoth(new Set([1, "two"]), { __Set: [1, "two"] });
    expectBoth(10n, "[BigInt:10]");
    expectBoth(Symbol("s"), "[Symbol:Symbol(s)]");
  });

  test("numbers JSON turns into null keep which one they were", () => {
    expectBoth(NaN, { __number: "NaN" });
    expectBoth(Infinity, { __number: "Infinity" });
    expectBoth(-Infinity, { __number: "-Infinity" });
    expectBoth(0, 0);
    expectBoth(-1.5, -1.5);
  });

  test("functions report their name instead of collapsing to {}", () => {
    const [direct, viaSource] = both(function foo() {});
    expect(direct).toBe("[function:foo]");
    expect(viaSource).toBe("[function:foo]");
    expect(serializeForBridge(() => {})).toBe("[function:anonymous]");
  });

  test("an Error keeps its name and message", () => {
    expectBoth(new TypeError("boom"), { __error: true, name: "TypeError", message: "boom" });
  });

  test("a cycle is reported, not refused", () => {
    // CDP answered this with `{"code":-32000,"message":"Object reference chain
    // is too long"}` — a protocol error surfacing as a tool failure.
    const o: Record<string, unknown> = { name: "root" };
    o.self = o;
    expectBoth(o, { name: "root", self: "[Circular]" });
  });

  test("a repeated sibling is not mistaken for a cycle", () => {
    // The guard has to be scoped to the current path, or a value referenced
    // twice at the same level reads as circular.
    const shared = { v: 1 };
    expectBoth({ a: shared, b: shared }, { a: { v: 1 }, b: { v: 1 } });
  });

  test("oversized payloads are bounded", () => {
    const long = "x".repeat(20000);
    expect(serializeForBridge(long) as string).toHaveLength(10000 + "…[truncated]".length);
    expect(serializeForBridge(new Array(2000).fill(1))).toBe("[Array length=2000, truncated]");
    const wide: Record<string, number> = {};
    for (let i = 0; i < 1500; i++) wide["k" + i] = i;
    expect((serializeForBridge(wide) as Record<string, unknown>).__truncated).toBe(true);
  });

  test("deep nesting stops rather than blowing the stack", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 80; i++) deep = { next: deep };
    expect(JSON.stringify(serializeForBridge(deep))).toContain("[depth limit]");
  });

  test("the injected source is self-contained", () => {
    // It is stringified and evaluated in the page, so any reference to module
    // scope — an import, a helper, a constant — would throw there and nowhere
    // else. Constructing it in an empty scope is the check.
    expect(() => new Function(`return (${SERIALIZE_FN_SOURCE})`)()).not.toThrow();
    expect(SERIALIZE_FN_SOURCE).toContain("function serializeForBridge");
  });
});
