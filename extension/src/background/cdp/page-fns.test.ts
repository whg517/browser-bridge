import { afterEach, describe, expect, test } from "bun:test";
import { REF_ATTR, pageSnapshot, doClick, pageScroll } from "./page-fns";
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
    for (const fn of [pageSnapshot, doClick]) {
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

// CDP mode runs its own copy of the page ops, so a fix applied only to the
// content script leaves the same bug live for anyone with cdpMode on.
describe("pageScroll (CDP copy) matches the content-script contract", () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = realWindow;
  });

  function stubWindow() {
    const w = {
      scrollX: 0,
      scrollY: 0,
      innerHeight: 1000,
      scrollBy: (_x: number, y: number) => {
        w.scrollY += y;
      },
      scrollTo: (_x: number, y: number) => {
        w.scrollY = y;
      },
    };
    (globalThis as { window?: unknown }).window = w;
    return w;
  }

  test("an unknown direction throws rather than reporting a no-op as success", () => {
    stubWindow();
    expect(() => pageScroll({ direction: "sideways" })).toThrow(/unknown direction "sideways"/);
  });

  test("no direction and no pixels still throws", () => {
    stubWindow();
    expect(() => pageScroll({})).toThrow(/needs `direction` or `pixels`/);
  });

  test("the four real directions and pixels still scroll", () => {
    const w = stubWindow();
    expect(pageScroll({ pixels: 300 }).scrollY).toBe(300);
    expect(pageScroll({ direction: "top" }).scrollY).toBe(0);
    expect(pageScroll({ direction: "down" }).scrollY).toBe(900);
    expect(pageScroll({ direction: "up" }).scrollY).toBe(0);
    w.scrollY = 0;
  });
});
