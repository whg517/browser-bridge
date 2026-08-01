// Shared sensitive-data masking.
//
// The JWT/hex/number/bearer pattern catalogue was previously duplicated
// verbatim between background.ts (maskCookieValue) and content.ts
// (maskString). It is unified here. NOTE the two entry points are deliberately
// NOT identical: `maskString` additionally full-masks a value that *looks* like
// a bare credential, while `maskCookieValue` applies only the pattern catalogue
// (cookies are structured; a full-mask would hide too much). Preserve that.

// Keys/values whose name hints at a secret.
export const SENSITIVE_KEY = /(token|cookie|password|passwd|secret|api[_-]?key|auth|cred|session)/i;

// Apply the credential-pattern catalogue to a string (no length guard). Shared
// core of both maskString and maskCookieValue.
export function maskPatterns(s: string): string {
  let out = s;
  // Provider API keys. These carry no hex/digit run and no `key=` prefix, so
  // nothing below catches them: an `sk-…` sitting in localStorage came back in
  // full. Match the issuer prefixes first so they claim the whole token.
  out = out.replace(/\bsk[-_][A-Za-z0-9_-]{16,}/g, "••••[key]"); // OpenAI / Anthropic / Stripe
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "••••[key]"); // GitHub
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "••••[key]"); // Slack
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "••••[key]"); // AWS access key id
  out = out.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "••••[key]"); // Google API key
  // JWT (eyJ... . ... . ...). The payload/signature segments are only required
  // to be 4+ chars: real tokens are far longer, but a short-signature JWT is
  // still a credential and used to slip through a {8,} floor.
  out = out.replace(/ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "••••[jwt]");
  // Long hex (>=32): secrets, hashes, API keys
  out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, "••••[hex]");
  // Long digit runs (>=12): card numbers, account ids
  out = out.replace(/\b\d{12,}\b/g, "••••[num]");
  // Bearer / key-like patterns
  out = out.replace(
    /(?:bearer|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
    "••••[redacted]"
  );
  return out;
}

// Content-script string masking: short values pass through; otherwise apply the
// catalogue, then full-mask if the whole string reads like a bare credential.
export function maskString(s: string): string {
  if (s.length < 8) return s;
  const out = maskPatterns(s);
  if (SENSITIVE_KEY.test(s) && s.length >= 8 && !/\s/.test(s)) {
    return "••••[sensitive]";
  }
  return out;
}

// Cookie value masking: non-strings and short values pass through unchanged;
// otherwise apply only the pattern catalogue (no full-mask — see note above).
// Pass the cookie's NAME to also honour the key-name signal: a cookie called
// `csrftoken` or `sessionid` is a credential whatever its value looks like.
export function maskCookieValue(v: unknown, name?: string): unknown {
  if (typeof v !== "string") return v;
  if (name && SENSITIVE_KEY.test(name)) return "••••[sensitive]";
  if (v.length < 8) return v;
  return maskPatterns(v);
}

// Mask a value using its KEY as evidence. The name is the strongest signal
// available — an `sk-…` or a 32-char CSRF token under `apiKey` / `csrftoken`
// matches no value pattern, but the key says exactly what it is — so a
// secret-named entry is masked outright. Otherwise fall back to the value-only
// catalogue. Used by the two silent credential readers (storage_get,
// cookie_get); note maskString tests the VALUE for those same words, which
// only helps when the secret happens to describe itself.
export function maskNamedValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "") return value;
  if (SENSITIVE_KEY.test(key)) return "••••[sensitive]";
  return maskString(value);
}

// Mask a long integer that looks card-like / id-like.
export function maskNumber(n: number): number | string {
  if (Number.isInteger(n) && Math.abs(n) >= 1e11) return "••••[num]";
  return n;
}

// Mask a key NAME (not value) when it hints at a secret.
export function maskKeyName(key: string): string {
  return SENSITIVE_KEY.test(key) ? "••••" + key.slice(-2) : key;
}

// Recursively mask an arbitrary JSON-ish value (strings, numbers, arrays,
// objects). Used for eval results and storage dumps.
export function maskSensitive(value: any): any {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return maskString(value);
  if (t === "number") return maskNumber(value);
  if (t === "boolean") return value;
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (t === "object") {
    const out: any = {};
    for (const k of Object.keys(value)) {
      out[maskKeyName(k)] = maskSensitive(value[k]);
    }
    return out;
  }
  return value;
}
