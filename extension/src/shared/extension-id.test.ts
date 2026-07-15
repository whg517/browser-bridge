import { describe, expect, test } from "bun:test";
import { PINNED_EXTENSION_ID, diagnoseExtensionId } from "./extension-id";

describe("diagnoseExtensionId", () => {
  test("matching id → ok, no error", () => {
    const d = diagnoseExtensionId(PINNED_EXTENSION_ID);
    expect(d.ok).toBe(true);
    expect(d.level).toBe("ok");
    expect(d.message).toContain(PINNED_EXTENSION_ID);
  });

  test("mismatched id → error naming both ids and the rejection", () => {
    const running = "ojpaiphnpfpcomfnilhmbbdecmgkakbo";
    const d = diagnoseExtensionId(running);
    expect(d.ok).toBe(false);
    expect(d.level).toBe("error");
    expect(d.message).toContain(running); // running id
    expect(d.message).toContain(PINNED_EXTENSION_ID); // expected id
    expect(d.message).toContain("REJECTED");
  });

  test("respects an explicit expected id", () => {
    expect(diagnoseExtensionId("abc", "abc").ok).toBe(true);
    expect(diagnoseExtensionId("abc", "def").ok).toBe(false);
  });

  test("pinned id is the canonical 32-char a-p form", () => {
    expect(PINNED_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });
});
