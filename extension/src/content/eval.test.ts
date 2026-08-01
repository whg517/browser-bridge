// runEval's error policy. Only the isolated-world CSP block is thrown (so the
// SW can escalate it to the debugger — ADR-0025); a fault in the caller's own
// code stays a structured result the model can read and react to.
//
// Note bun has no CSP, so `new Function` works here — the block itself is
// classified by shared/csp-eval.ts (unit-tested there) and exercised live.

import { describe, expect, test } from "bun:test";
import { runEval } from "./eval";

describe("runEval", () => {
  test("rejects a missing or blank `code`", async () => {
    await expect(runEval({})).rejects.toThrow("non-empty `code`");
    await expect(runEval({ code: "   " })).rejects.toThrow("non-empty `code`");
  });

  test("returns the value, masked", async () => {
    expect(await runEval({ code: "return 6*7" })).toBe(42);
    expect(await runEval({ code: "return 'hello world'" })).toBe("hello world");
    // Masking applies to eval results like everywhere else.
    expect(
      await runEval({
        code: "return 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'",
      })
    ).toBe("••••[jwt]");
  });

  test("awaits an async result", async () => {
    expect(await runEval({ code: "return await Promise.resolve(7)" })).toBe(7);
  });

  test("a fault in the caller's code comes back as data, not a throw", async () => {
    const out = (await runEval({ code: "return notDefinedAnywhere" })) as {
      __evalError: boolean;
      name: string;
      message: string;
    };
    expect(out.__evalError).toBe(true);
    expect(out.name).toBe("ReferenceError");
    expect(out.message).toContain("notDefinedAnywhere");
  });
});
