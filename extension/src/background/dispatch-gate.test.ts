import { describe, expect, test } from "bun:test";
import { assertNotDisabled } from "./dispatch";

describe("dispatch disable-gate (assertNotDisabled)", () => {
  test("a known disabled tool throws the exact legacy message", () => {
    expect(() => assertNotDisabled("tab_list", ["tab_list"])).toThrow(
      "tool disabled in settings: tab_list"
    );
  });

  test("an enabled known tool is not blocked", () => {
    expect(() => assertNotDisabled("tab_list", [])).not.toThrow();
    // other tools being disabled must not block this one
    expect(() => assertNotDisabled("tab_list", ["page_eval"])).not.toThrow();
  });

  test("an unknown op is not blocked by the gate (passthrough)", () => {
    // Even if the unknown name appears in disabledTools, the gate must not
    // fail-close it — Rust validates tool names upstream and the switch handles
    // routing. This preserves the original inline behavior.
    expect(() => assertNotDisabled("does_not_exist", ["does_not_exist"])).not.toThrow();
    expect(() => assertNotDisabled(undefined, ["tab_list"])).not.toThrow();
    expect(() => assertNotDisabled("", [])).not.toThrow();
  });
});
