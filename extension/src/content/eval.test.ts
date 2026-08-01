// A CSP without 'unsafe-eval' forbids `new Function`, so page_eval cannot run
// through the content script at all on that page. That used to come back as a
// successful call carrying a soft error object full of CSP text, which reads
// like a result. It is a failed call with a specific remedy, so classify it.

import { describe, expect, test } from "bun:test";
import { CSP_EVAL_MESSAGE, isCspEvalBlock } from "./eval";

describe("isCspEvalBlock", () => {
  test("recognises Chrome's EvalError", () => {
    const e = new Error("Evaluating a string as JavaScript violates …");
    e.name = "EvalError";
    expect(isCspEvalBlock(e)).toBe(true);
  });

  test("recognises the block by message when the name is generic", () => {
    expect(
      isCspEvalBlock(
        new Error(
          "call to Function() blocked by Content Security Policy directive: \"script-src 'self'\""
        )
      )
    ).toBe(true);
  });

  test("ordinary JS errors are NOT the CSP block — they stay structured data", () => {
    expect(isCspEvalBlock(new TypeError("x is not a function"))).toBe(false);
    expect(isCspEvalBlock(new SyntaxError("Unexpected token"))).toBe(false);
    expect(isCspEvalBlock(new ReferenceError("foo is not defined"))).toBe(false);
    expect(isCspEvalBlock(null)).toBe(false);
    expect(isCspEvalBlock(undefined)).toBe(false);
  });
});

describe("CSP_EVAL_MESSAGE", () => {
  test("names the cause and the way out", () => {
    expect(CSP_EVAL_MESSAGE).toContain("Content Security Policy");
    // The remedy is what makes this actionable rather than just a diagnosis.
    expect(CSP_EVAL_MESSAGE).toContain("CDP mode");
  });
});
