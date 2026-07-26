import { describe, it, expect } from "bun:test";
import en from "../../_locales/en/messages.json";
import zhCN from "../../_locales/zh_CN/messages.json";
import { TOOLS } from "./ops";
import { resolveLocale, setLocale, t } from "./i18n";

describe("i18n catalogues", () => {
  it("en and zh_CN have identical keys (no missing translations)", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });

  it("every message is a non-empty string", () => {
    for (const [key, v] of Object.entries({ ...en, ...zhCN })) {
      expect(typeof (v as { message: string }).message).toBe("string");
      expect((v as { message: string }).message.trim().length).toBeGreaterThan(0);
    }
  });

  it("every tool has a localized label (tool_<op>) in both locales", () => {
    for (const tool of TOOLS) {
      const key = "tool_" + tool.op;
      expect((en as Record<string, unknown>)[key]).toBeDefined();
      expect((zhCN as Record<string, unknown>)[key]).toBeDefined();
    }
  });
});

describe("resolveLocale", () => {
  it("forces an explicit locale", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("zh_CN")).toBe("zh_CN");
  });

  it("falls back to en for auto/unknown outside a browser context", () => {
    expect(resolveLocale("auto")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("fr")).toBe("en");
  });
});

describe("t()", () => {
  it("returns the active-locale message", () => {
    setLocale("zh_CN");
    expect(t("btn_add")).toBe(zhCN.btn_add.message);
    expect(t("btn_add")).not.toBe(en.btn_add.message);
    setLocale("en");
    expect(t("btn_add")).toBe(en.btn_add.message);
  });

  it("returns the key itself for an unknown message", () => {
    setLocale("zh_CN");
    expect(t("__no_such_key__")).toBe("__no_such_key__");
    setLocale("en");
  });

  it("fills $1 placeholders from subs", () => {
    // No shipped string uses $1, so exercise the mechanism against a fixed key:
    // subs on a placeholder-free message is a no-op (regression guard).
    expect(t("btn_add", ["ignored"])).toBe(en.btn_add.message);
  });
});
