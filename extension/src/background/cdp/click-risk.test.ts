import { describe, expect, test } from "bun:test";
import { isHighRiskClick, describeAction, describeForToast, type ClickTarget } from "./click-risk";

function target(over: Partial<ClickTarget>): ClickTarget {
  return { tagName: "DIV", role: "", type: "", hasHref: false, name: "", ...over };
}

describe("isHighRiskClick", () => {
  test("submit buttons are high-risk", () => {
    expect(isHighRiskClick(target({ tagName: "BUTTON", role: "button", type: "submit" }))).toBe(
      true
    );
  });

  test("non-submit buttons are not high-risk", () => {
    expect(isHighRiskClick(target({ tagName: "BUTTON", role: "button", type: "button" }))).toBe(
      false
    );
    expect(isHighRiskClick(target({ tagName: "BUTTON", role: "button", type: "" }))).toBe(false);
  });

  test("anchors with href are high-risk", () => {
    expect(isHighRiskClick(target({ tagName: "A", hasHref: true }))).toBe(true);
  });

  test("anchors without href are not high-risk", () => {
    expect(isHighRiskClick(target({ tagName: "A", hasHref: false }))).toBe(false);
  });

  test("role=link is high-risk regardless of tag", () => {
    expect(isHighRiskClick(target({ tagName: "SPAN", role: "link" }))).toBe(true);
  });

  test("plain elements are not high-risk", () => {
    expect(isHighRiskClick(target({ tagName: "DIV", role: "button", type: "" }))).toBe(false);
    expect(isHighRiskClick(target({ tagName: "INPUT", role: "textbox" }))).toBe(false);
  });
});

describe("describeAction", () => {
  test("navigating targets read as 'navigate'", () => {
    expect(describeAction(target({ role: "link" }), "click")).toBe("navigate");
    expect(describeAction(target({ tagName: "A", hasHref: true }), "click")).toBe("navigate");
  });

  test("buttons read as 'submit'", () => {
    expect(describeAction(target({ role: "button" }), "click")).toBe("submit");
  });

  test("everything else reads as the kind", () => {
    expect(describeAction(target({ role: "textbox" }), "click")).toBe("click");
    expect(describeAction(target({ role: "button" }), "fill")).toBe("fill");
  });
});

describe("describeForToast", () => {
  test("prefers the name, then role, then lowercased tag", () => {
    expect(describeForToast(target({ name: "Sign in", role: "button", tagName: "BUTTON" }))).toBe(
      "Sign in"
    );
    expect(describeForToast(target({ name: "", role: "button", tagName: "BUTTON" }))).toBe(
      "button"
    );
    expect(describeForToast(target({ name: "", role: "", tagName: "BUTTON" }))).toBe("button");
  });

  test("truncates to 40 chars", () => {
    const long = "x".repeat(60);
    const out = describeForToast(target({ name: long }));
    expect(out.length).toBe(41); // 40 chars + the ellipsis
    expect(out.endsWith("…")).toBe(true);
  });
});
