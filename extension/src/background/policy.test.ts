import { describe, expect, test } from "bun:test";
import { decide } from "./policy";

describe("policy.decide", () => {
  test("a low-risk enabled tool is allowed with no confirmation", () => {
    const d = decide("tab_list", { disabledTools: [] });
    expect(d.allowed).toBe(true);
    expect(d.risk).toBe("low");
    expect(d.requiresConfirmation).toBe(false);
    expect(d.confirmationChannel).toBe("none");
  });

  test("a disabled tool is not allowed", () => {
    const d = decide("tab_list", { disabledTools: ["tab_list"] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("tool disabled in settings");
    // still reports the tool's real risk shape for UI purposes
    expect(d.risk).toBe("low");
  });

  test("page_eval requires no confirmation", () => {
    const d = decide("page_eval", { disabledTools: [] });
    expect(d.allowed).toBe(true);
    expect(d.risk).toBe("critical");
    expect(d.requiresConfirmation).toBe(false);
    expect(d.confirmationChannel).toBe("none");
  });

  test("page_snapshot_precise still notifies via the extension-ui channel (warn)", () => {
    const d = decide("page_snapshot_precise", { disabledTools: [] });
    expect(d.allowed).toBe(true);
    expect(d.requiresConfirmation).toBe(true);
    expect(d.confirmationChannel).toBe("extension-ui");
  });

  test("an unknown op fails closed", () => {
    const d = decide("does_not_exist", { disabledTools: [] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unknown tool");
    expect(d.risk).toBe("critical");
  });

  test("a disabled tool that would otherwise need confirmation still reports it", () => {
    const d = decide("page_snapshot_precise", { disabledTools: ["page_snapshot_precise"] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("tool disabled in settings");
    expect(d.requiresConfirmation).toBe(true);
    expect(d.confirmationChannel).toBe("extension-ui");
  });
});
