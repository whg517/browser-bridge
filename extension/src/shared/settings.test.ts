import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULTS, getSetting } from "./settings";

describe("DEFAULTS", () => {
  test("has the expected keys and values", () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual(
      ["allowAllSites", "cdpMode", "disabledTools", "language"].sort()
    );
    expect(DEFAULTS.disabledTools).toEqual([]);
    expect(DEFAULTS.allowAllSites).toBe(false);
    expect(DEFAULTS.cdpMode).toBe(false);
    expect(DEFAULTS.language).toBe("auto");
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
    mockStorage({ cdpMode: true });
    expect(await getSetting("cdpMode")).toBe(true);
  });

  test("falls back to the default when absent", async () => {
    mockStorage({});
    expect(await getSetting("cdpMode")).toBe(false);
    expect(await getSetting("allowAllSites")).toBe(false);
  });
});
