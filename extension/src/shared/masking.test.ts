import { describe, expect, test } from "bun:test";
import {
  maskPatterns,
  maskString,
  maskCookieValue,
  maskNamedValue,
  maskNumber,
  maskKeyName,
  maskSensitive,
} from "./masking";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij";
const HEX32 = "deadbeefdeadbeefdeadbeefdeadbeef"; // 32 hex chars

describe("maskPatterns", () => {
  test("redacts JWT / long hex / long digit runs", () => {
    expect(maskPatterns(JWT)).toBe("••••[jwt]");
    expect(maskPatterns(HEX32)).toBe("••••[hex]");
    expect(maskPatterns("123456789012")).toBe("••••[num]");
  });
  test("redacts bearer/token key patterns", () => {
    expect(maskPatterns("token=supersecretvalue")).toBe("••••[redacted]");
  });
  test("leaves ordinary text alone", () => {
    expect(maskPatterns("hello world")).toBe("hello world");
  });
  test("redacts provider API keys, which match no other pattern", () => {
    expect(maskPatterns("sk-proj-QAtestKEY1234567890abcdefGHIJ")).toBe("••••[key]");
    // Deliberately too short to look like a real Stripe key to secret scanners,
    // but still past this rule's 16-char floor.
    expect(maskPatterns("sk_live_QAFAKEKEY01")).toBe("••••[key]");
    expect(maskPatterns("ghp_1234567890abcdefABCDEF1234567890")).toBe("••••[key]");
    expect(maskPatterns("xoxb-123456789012-abcdefGHIJKL")).toBe("••••[key]");
    expect(maskPatterns("AKIAIOSFODNN7EXAMPLE")).toBe("••••[key]");
    expect(maskPatterns("AIza" + "a".repeat(35))).toBe("••••[key]");
  });
  test("ordinary words that merely contain a prefix are untouched", () => {
    expect(maskPatterns("risk-assessment-2026-final")).toBe("risk-assessment-2026-final");
    expect(maskPatterns("task-management-system-v2")).toBe("task-management-system-v2");
  });
  test("a JWT with short payload/signature segments is still masked", () => {
    expect(maskPatterns("eyJhbGciOiJIUzI1NiJ9.sigpart.sigpart2")).toBe("••••[jwt]");
  });
});

describe("maskNamedValue (key name as evidence)", () => {
  test("masks a value whose KEY names a secret, whatever the value looks like", () => {
    // Nothing in the value matches the catalogue — only the key betrays it.
    expect(maskNamedValue("session_apikey", "plainlookingvalue")).toBe("••••[sensitive]");
    expect(maskNamedValue("csrftoken", "f5qxPaVezMMD4gyHBVgpzLP9GfO2saUq")).toBe("••••[sensitive]");
    expect(maskNamedValue("auth", "x")).toBe("••••[sensitive]");
  });
  test("an unremarkable key still gets the value catalogue", () => {
    expect(maskNamedValue("profile", JWT)).toBe("••••[jwt]");
    expect(maskNamedValue("theme", "dark")).toBe("dark");
  });
  test("non-strings and empties pass through", () => {
    expect(maskNamedValue("token", 42)).toBe(42);
    expect(maskNamedValue("token", "")).toBe("");
  });
});

describe("maskString", () => {
  test("passes through short values (<8)", () => {
    expect(maskString("abc")).toBe("abc");
  });
  test("applies the pattern catalogue", () => {
    expect(maskString(JWT)).toBe("••••[jwt]");
    expect(maskString(HEX32)).toBe("••••[hex]");
  });
  test("full-masks a bare credential-like string", () => {
    // Matches SENSITIVE_KEY, length >= 8, no whitespace → fully masked.
    expect(maskString("session_tokenvalue")).toBe("••••[sensitive]");
  });
  test("does NOT full-mask when whitespace is present", () => {
    const out = maskString("please use token=secret12345 now");
    expect(out).toContain("••••[redacted]");
    expect(out).not.toBe("••••[sensitive]");
  });
});

describe("maskCookieValue (pattern-only, no full-mask)", () => {
  test("non-strings pass through", () => {
    expect(maskCookieValue(42)).toBe(42);
    expect(maskCookieValue(null)).toBe(null);
  });
  test("short strings pass through", () => {
    expect(maskCookieValue("abc")).toBe("abc");
  });
  test("applies the catalogue but never full-masks like maskString", () => {
    expect(maskCookieValue(JWT)).toBe("••••[jwt]");
    // Same input that maskString fully masks stays pattern-only here.
    expect(maskCookieValue("session_tokenvalue")).toBe("session_tokenvalue");
    expect(maskString("session_tokenvalue")).toBe("••••[sensitive]");
  });
  test("a secret-named cookie is masked on the strength of its name", () => {
    expect(maskCookieValue("f5qxPaVezMMD4gyHBVgpzLP9GfO2saUq", "csrftoken")).toBe(
      "••••[sensitive]"
    );
    expect(maskCookieValue("abc123", "qa_session")).toBe("••••[sensitive]");
  });
  test("an ordinary cookie name keeps the structured value", () => {
    // The reason cookies aren't full-masked by default: analytics/prefs cookies
    // carry structure worth seeing.
    expect(maskCookieValue("GS2.1.s1758527497$o10$g0", "_ga_YTFTXDTLGX")).toBe(
      "GS2.1.s1758527497$o10$g0"
    );
    expect(maskCookieValue("zh", "i18n_redirected")).toBe("zh");
  });
});

describe("maskNumber", () => {
  test("masks card-like big integers", () => {
    expect(maskNumber(123456789012)).toBe("••••[num]");
  });
  test("leaves small / non-integer numbers alone", () => {
    expect(maskNumber(42)).toBe(42);
    expect(maskNumber(3.14)).toBe(3.14);
  });
});

describe("maskKeyName", () => {
  test("masks sensitive key names, keeps a 2-char tail", () => {
    expect(maskKeyName("password")).toBe("••••rd");
  });
  test("leaves non-sensitive names alone", () => {
    expect(maskKeyName("username")).toBe("username");
  });
});

describe("maskSensitive (recursive)", () => {
  test("masks values and sensitive key names in nested objects", () => {
    const out = maskSensitive({
      user: "alice",
      authToken: JWT,
      nested: { secret: HEX32, count: 3 },
    });
    expect(out.user).toBe("alice");
    expect(out.nested.count).toBe(3);
    // authToken value masked; some keys renamed (contain sensitive words).
    const flat = JSON.stringify(out);
    expect(flat).toContain("••••[jwt]");
    expect(flat).toContain("••••[hex]");
  });
  test("passes through primitives and arrays", () => {
    expect(maskSensitive(true)).toBe(true);
    expect(maskSensitive([1, 2])).toEqual([1, 2]);
  });
});
