// `isDebuggable` answers false for two different situations — "no URL yet" and
// "scheme not allowed" — and the callers used to report the merged answer as a
// scheme rejection. A tab that had simply been opened a moment ago came back as
// "URL scheme not allowed:" with nothing after the colon, under a NON-retryable
// code, telling the agent to give up on something that fixes itself (#136).

import { describe, expect, test } from "bun:test";
import { assertDrivable, isDebuggable } from "./session";

function reasonFor(url: string | undefined) {
  try {
    assertDrivable(url, "page_wait_for cannot run here");
    return null;
  } catch (e) {
    return e as Error & { code?: string };
  }
}

describe("assertDrivable", () => {
  test("a tab that has not navigated is not ready — and that is retryable", () => {
    const err = reasonFor("");
    expect(err?.code).toBe("EXTENSION_NOT_READY");
    expect(err?.message).toContain("has not navigated");
    // The old message ended in a dangling "not allowed:" with no URL after it.
    expect(err?.message).not.toContain("scheme");
  });

  test("undefined is the same state as empty", () => {
    expect(reasonFor(undefined)?.code).toBe("EXTENSION_NOT_READY");
  });

  test("a scheme the debugger cannot attach to is a different, permanent answer", () => {
    // Every entry in NON_DEBUGGABLE, so the split is pinned across all of them.
    for (const url of [
      "chrome://extensions",
      "chrome-extension://mkjjlmjbcljpcfkfadfmhblmmddkdihf/options.html",
      "https://chrome.google.com/webstore/category/extensions",
      "view-source:https://example.com",
      "about:blank",
      "edge://settings",
    ]) {
      const err = reasonFor(url);
      expect(err?.code).toBe("UNSUPPORTED_PAGE");
      expect(err?.message).toContain(url.slice(0, 20));
    }
  });

  test("an ordinary page passes", () => {
    expect(reasonFor("https://example.com/page")).toBeNull();
    expect(reasonFor("http://localhost:18099/page.html")).toBeNull();
  });

  test("the two states stay distinguishable, which is the whole point", () => {
    expect(isDebuggable("")).toBe(false);
    expect(isDebuggable("chrome://extensions")).toBe(false);
    expect(reasonFor("")?.code).not.toBe(reasonFor("chrome://extensions")?.code);
  });
});
