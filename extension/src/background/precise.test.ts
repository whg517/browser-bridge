// The descriptor function page_snapshot_precise injects into the page. It used
// to return `this.value` raw, so a password field came back in cleartext while
// the other two snapshot paths masked it (content/snapshot.ts, cdp/page-fns.ts).

import { describe, expect, test } from "bun:test";
import { NODE_DESCRIPTOR_FN } from "./precise";

// Evaluate the injected source the way Runtime.callFunctionOn does, then apply
// it to a stand-in element.
const descriptorFn = new Function("return (" + NODE_DESCRIPTOR_FN + ")")() as (
  this: unknown,
  ref: string
) => { tag: string; id: string; name: string; value?: string; checked?: boolean };

function el(props: Record<string, unknown>) {
  return {
    tagName: "INPUT",
    id: "",
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    getAttribute() {
      return null;
    },
    ...props,
  };
}

const describeFor = (props: Record<string, unknown>) => descriptorFn.call(el(props), "p1");

describe("NODE_DESCRIPTOR_FN", () => {
  test("masks a password value instead of returning it", () => {
    expect(describeFor({ type: "password", value: "supersecret" }).value).toBe("••••••");
    expect(describeFor({ type: "PASSWORD", value: "supersecret" }).value).toBe("••••••");
  });

  test("an empty password reads as empty, not as bullets", () => {
    expect(describeFor({ type: "password", value: "" }).value).toBe("");
  });

  test('reports checkbox/radio state as `checked`, never the bogus value "on"', () => {
    const unchecked = describeFor({ type: "checkbox", value: "on", checked: false });
    expect(unchecked.checked).toBe(false);
    expect(unchecked.value).toBeUndefined();

    const checked = describeFor({ type: "radio", value: "on", checked: true });
    expect(checked.checked).toBe(true);
    expect(checked.value).toBeUndefined();
  });

  test("ordinary fields keep their value, truncated to 60 chars", () => {
    expect(describeFor({ type: "text", value: "hello" }).value).toBe("hello");
    expect(describeFor({ type: "text", value: "x".repeat(80) }).value).toHaveLength(60);
    expect(describeFor({ type: "text", value: "hello" }).checked).toBeUndefined();
  });

  test("tags the element with its ref and reports tag/id", () => {
    const target = el({ tagName: "BUTTON", id: "go" });
    const d = descriptorFn.call(target, "p7");
    expect(target.attrs["data-zcb-ref"]).toBe("p7");
    expect(d.tag).toBe("button");
    expect(d.id).toBe("#go");
  });

  test("a valueless element reports no value", () => {
    expect(describeFor({ tagName: "DIV", value: undefined }).value).toBeUndefined();
  });
});
