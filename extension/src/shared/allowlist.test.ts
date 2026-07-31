import { describe, expect, test } from "bun:test";
import {
  originGlobOf,
  effectiveOriginGlob,
  hostFromOriginGlob,
  normalizeCookieDomain,
  matchesAny,
  simpleMatch,
  globToPermissionPattern,
} from "./allowlist";

describe("simpleMatch", () => {
  test("exact match", () => {
    expect(simpleMatch("https://a.com/x", "https://a.com/x")).toBe(true);
  });
  test("trailing /* matches base and sub-paths", () => {
    expect(simpleMatch("https://a.com/*", "https://a.com/")).toBe(true);
    expect(simpleMatch("https://a.com/*", "https://a.com/page")).toBe(true);
  });
  test("does not match a different host", () => {
    expect(simpleMatch("https://a.com/*", "https://b.com/")).toBe(false);
  });
  test("trailing * (no slash) is a prefix match", () => {
    expect(simpleMatch("https://a.com*", "https://a.com/anything")).toBe(true);
  });
});

describe("matchesAny", () => {
  test("true if any pattern matches", () => {
    expect(matchesAny("https://a.com/x", ["https://b.com/*", "https://a.com/*"])).toBe(true);
    expect(matchesAny("https://c.com/x", ["https://a.com/*"])).toBe(false);
  });
});

describe("originGlobOf", () => {
  test("derives host/* from a URL", () => {
    expect(originGlobOf("https://x.com/path?q=1")).toBe("https://x.com/*");
  });
  test("null for unparseable input", () => {
    expect(originGlobOf("not a url")).toBeNull();
    expect(originGlobOf(undefined)).toBeNull();
  });
});

describe("effectiveOriginGlob", () => {
  const top = "http://localhost:8000/index.html";
  test("about:srcdoc / about:blank inherit the top origin", () => {
    expect(effectiveOriginGlob("about:srcdoc", top)).toBe("http://localhost:8000/*");
    expect(effectiveOriginGlob("about:blank", top)).toBe("http://localhost:8000/*");
  });
  test("blob: gates by its inner origin, not the top", () => {
    expect(effectiveOriginGlob("blob:http://localhost:8000/abc-123", "https://other.com/")).toBe(
      "http://localhost:8000/*"
    );
  });
  test("an ordinary frame gates by its own origin", () => {
    expect(effectiveOriginGlob("http://localhost:8001/a.html?x=1", top)).toBe(
      "http://localhost:8001/*"
    );
  });
  test("null for unparseable frame url, or when top is needed but unparseable", () => {
    expect(effectiveOriginGlob(undefined, top)).toBeNull();
    expect(effectiveOriginGlob("about:srcdoc", "not a url")).toBeNull();
  });
});

describe("hostFromOriginGlob", () => {
  test("extracts the lowercase host", () => {
    expect(hostFromOriginGlob("https://X.COM/*")).toBe("x.com");
  });
});

describe("normalizeCookieDomain", () => {
  test("strips leading dots and lowercases", () => {
    expect(normalizeCookieDomain(".Example.com")).toBe("example.com");
  });
  test("rejects scheme/path/glob/non-strings", () => {
    expect(normalizeCookieDomain("http://x.com")).toBeNull();
    expect(normalizeCookieDomain("a/b")).toBeNull();
    expect(normalizeCookieDomain("*.x.com")).toBeNull();
    expect(normalizeCookieDomain(123)).toBeNull();
  });
});

describe("globToPermissionPattern", () => {
  test("keeps /* globs, appends * otherwise, null for empty", () => {
    expect(globToPermissionPattern("https://a.com/*")).toBe("https://a.com/*");
    expect(globToPermissionPattern("https://a.com")).toBe("https://a.com*");
    expect(globToPermissionPattern("")).toBeNull();
  });
});
