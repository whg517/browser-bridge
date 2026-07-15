import { describe, expect, test } from "bun:test";
import { REF_ATTR, pageSnapshot, doClick, probeClickTarget } from "./page-fns";
import { REF_ATTR as CONTENT_REF_ATTR } from "../../content/refs";
import { buildEvaluateExpression } from "./session";

describe("REF_ATTR", () => {
  test("matches the content-script ref attribute (refs must interoperate)", () => {
    expect(REF_ATTR).toBe("data-zcb-ref");
    expect(REF_ATTR).toBe(CONTENT_REF_ATTR);
  });
});

describe("page-fn stringification", () => {
  // These functions get stringified and shipped to the page. They must be
  // self-contained: no references to imported/module-scope identifiers.
  test("page functions do not close over module scope", () => {
    for (const fn of [pageSnapshot, doClick, probeClickTarget]) {
      const src = fn.toString();
      // No leftover import/require or reference to the shared truncate/REF_ATTR
      // module bindings (each fn declares its own copies / takes params).
      expect(src).not.toContain("require(");
      expect(src).not.toContain("import(");
    }
  });

  test("buildEvaluateExpression embeds the fn source and the ref attribute arg", () => {
    const expr = buildEvaluateExpression(pageSnapshot as (...a: never[]) => unknown, [REF_ATTR]);
    expect(expr).toContain("createTreeWalker");
    expect(expr).toContain('["data-zcb-ref"]');
  });
});
