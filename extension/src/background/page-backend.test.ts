import { describe, expect, test } from "bun:test";
import { selectBackend } from "./page-backend";

describe("selectBackend", () => {
  test("returns the CDP backend when cdpMode is on", () => {
    expect(selectBackend(true).constructor.name).toBe("CdpBackend");
  });

  test("returns the content-script backend when cdpMode is off", () => {
    expect(selectBackend(false).constructor.name).toBe("ContentScriptBackend");
  });

  test("the two backends are distinct, and each is a stable singleton", () => {
    expect(selectBackend(true)).not.toBe(selectBackend(false));
    // Same instance returned across calls (module-level singletons).
    expect(selectBackend(true)).toBe(selectBackend(true));
    expect(selectBackend(false)).toBe(selectBackend(false));
  });
});
