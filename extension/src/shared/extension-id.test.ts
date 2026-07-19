import { describe, expect, test } from "bun:test";
import {
  PINNED_EXTENSION_ID,
  STORE_EXTENSION_ID,
  TRUSTED_EXTENSION_IDS,
  diagnoseExtensionId,
} from "./extension-id";

describe("diagnoseExtensionId", () => {
  test("pinned (unpacked) id → ok, no error", () => {
    const d = diagnoseExtensionId(PINNED_EXTENSION_ID);
    expect(d.ok).toBe(true);
    expect(d.level).toBe("ok");
    expect(d.message).toContain(PINNED_EXTENSION_ID);
  });

  test("store id → ok (store users are trusted too)", () => {
    const d = diagnoseExtensionId(STORE_EXTENSION_ID);
    expect(d.ok).toBe(true);
    expect(d.level).toBe("ok");
    expect(d.message).toContain(STORE_EXTENSION_ID);
  });

  test("mismatched id → error naming the running + trusted ids and the rejection", () => {
    const running = "ojpaiphnpfpcomfnilhmbbdecmgkakbo";
    const d = diagnoseExtensionId(running);
    expect(d.ok).toBe(false);
    expect(d.level).toBe("error");
    expect(d.message).toContain(running); // running id
    expect(d.message).toContain(PINNED_EXTENSION_ID); // trusted id
    expect(d.message).toContain(STORE_EXTENSION_ID); // trusted id
    expect(d.message).toContain("REJECTED");
  });

  test("respects an explicit trusted-id list", () => {
    expect(diagnoseExtensionId("abc", ["abc"]).ok).toBe(true);
    expect(diagnoseExtensionId("abc", ["def"]).ok).toBe(false);
    expect(diagnoseExtensionId("abc", ["def", "abc"]).ok).toBe(true);
  });

  test("both trusted ids are the canonical 32-char a-p form", () => {
    for (const id of TRUSTED_EXTENSION_IDS) {
      expect(id).toMatch(/^[a-p]{32}$/);
    }
    expect(PINNED_EXTENSION_ID).not.toBe(STORE_EXTENSION_ID);
  });
});
