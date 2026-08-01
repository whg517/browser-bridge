// MV3 governs the content script's isolated world with the EXTENSION's CSP,
// which has no 'unsafe-eval' — so `new Function` is blocked there on every page.
// The extension does not escalate on its own (ADR-0025); it fails with a message
// the agent is meant to relay, so that message has to carry the remedy.

import { describe, expect, test } from "bun:test";
import { CSP_EVAL_MESSAGE, isCspEvalBlock } from "./csp-eval";

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
  test("instructs the agent to tell the user, and names the switch to flip", () => {
    expect(CSP_EVAL_MESSAGE).toContain("TELL THE USER");
    expect(CSP_EVAL_MESSAGE).toContain("CDP mode");
    expect(CSP_EVAL_MESSAGE).toContain("Options");
  });

  test("says the block is not page-specific, so the agent doesn't just try elsewhere", () => {
    expect(CSP_EVAL_MESSAGE).toContain("every site");
  });

  test("points at the tools that still work, so the agent has a way forward", () => {
    expect(CSP_EVAL_MESSAGE).toContain("page_snapshot");
    expect(CSP_EVAL_MESSAGE).toContain("page_click");
  });
});
