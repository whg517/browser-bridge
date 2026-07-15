import { describe, expect, test } from "bun:test";
import {
  isDebuggable,
  NON_DEBUGGABLE,
  buildEvaluateExpression,
  evalExceptionMessage,
} from "./session";

describe("isDebuggable", () => {
  test("ordinary http(s) pages are debuggable", () => {
    expect(isDebuggable("https://www.bing.com/")).toBe(true);
    expect(isDebuggable("http://localhost:3000/app")).toBe(true);
  });

  test("restricted schemes are not debuggable", () => {
    expect(isDebuggable("chrome://settings")).toBe(false);
    expect(isDebuggable("chrome-extension://abc/options.html")).toBe(false);
    expect(isDebuggable("https://chrome.google.com/webstore/detail/x")).toBe(false);
    expect(isDebuggable("view-source:https://example.com")).toBe(false);
    expect(isDebuggable("about:blank")).toBe(false);
    expect(isDebuggable("edge://flags")).toBe(false);
  });

  test("empty / undefined URLs are not debuggable", () => {
    expect(isDebuggable(undefined)).toBe(false);
    expect(isDebuggable("")).toBe(false);
  });

  test("NON_DEBUGGABLE is the source of the deny patterns", () => {
    expect(NON_DEBUGGABLE.some((re) => re.test("chrome://x"))).toBe(true);
    expect(NON_DEBUGGABLE.some((re) => re.test("https://example.com"))).toBe(false);
  });
});

describe("buildEvaluateExpression", () => {
  test("stringifies the function and applies it to JSON args", () => {
    function greet(name: string) {
      return "hi " + name;
    }
    const expr = buildEvaluateExpression(greet as (...a: never[]) => unknown, ["bob"]);
    expect(expr).toContain("greet");
    expect(expr).toContain('.apply(undefined, ["bob"])');
    // The produced expression is itself valid JS that evaluates to the result.
    // eslint-disable-next-line no-eval
    expect(eval(expr)).toBe("hi bob");
  });

  test("defaults to an empty args array", () => {
    const expr = buildEvaluateExpression((() => 42) as (...a: never[]) => unknown);
    expect(expr).toContain(".apply(undefined, [])");
    // eslint-disable-next-line no-eval
    expect(eval(expr)).toBe(42);
  });
});

describe("evalExceptionMessage", () => {
  test("prefers the exception description's first line", () => {
    expect(
      evalExceptionMessage({
        text: "Uncaught",
        exception: { description: "ReferenceError: x is not defined\n    at <anonymous>" },
      })
    ).toBe("ReferenceError: x is not defined");
  });

  test("falls back to text when there is no description", () => {
    expect(evalExceptionMessage({ text: "Uncaught SyntaxError" })).toBe("Uncaught SyntaxError");
  });

  test("has a final generic fallback", () => {
    expect(evalExceptionMessage({})).toBe("evaluation failed");
  });
});
