import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULTS, getSetting } from "./settings";

describe("DEFAULTS", () => {
  test("has the expected keys and values", () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual(
      [
        "allowAllSites",
        "cdpMode",
        "clickToastTimeoutMs",
        "confirmGraceMs",
        "confirmHighRiskClick",
        "disabledTools",
        "evalMask",
        "evalToastTimeoutMs",
        "pageEvalEnabled",
        "warnPreciseSnapshot",
      ].sort()
    );
    expect(DEFAULTS.pageEvalEnabled).toBe(true);
    expect(DEFAULTS.confirmGraceMs).toBe(60000);
    expect(DEFAULTS.disabledTools).toEqual([]);
    expect(DEFAULTS.allowAllSites).toBe(false);
    expect(DEFAULTS.cdpMode).toBe(false);
  });
});

describe("getSetting", () => {
  const realChrome = (globalThis as any).chrome;
  afterEach(() => {
    (globalThis as any).chrome = realChrome;
  });

  function mockStorage(store: Record<string, unknown>) {
    (globalThis as any).chrome = {
      storage: { local: { get: (key: string, cb: (r: any) => void) => cb({ [key]: store[key] }) } },
    };
  }

  test("returns the stored value when present", async () => {
    mockStorage({ pageEvalEnabled: false });
    expect(await getSetting("pageEvalEnabled")).toBe(false);
  });

  test("falls back to the default when absent", async () => {
    mockStorage({});
    expect(await getSetting("confirmGraceMs")).toBe(60000);
    expect(await getSetting("allowAllSites")).toBe(false);
  });
});
