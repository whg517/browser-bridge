// Pure allowlist / origin-glob helpers.
//
// Extracted from background.ts so they can be unit-tested without a browser.
// The chrome.storage-backed read/write of the allowlist stays in background.ts;
// only the pure string logic lives here.

// Derive the origin glob ("https://host/*") for a URL, or null if unparseable.
export function originGlobOf(url: string | undefined): string | null {
  try {
    const u = new URL(url!);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

// Map a sub-frame's URL to the origin glob it should be *gated* by, given the
// (already user-approved) top document URL.
//
// Some frames inherit their embedder's origin but carry a URL that doesn't
// encode it, so gating on the raw URL wrongly skips them (they're effectively
// same-origin — e.g. an AI "canvas"/preview rendered into an iframe):
//   • about:srcdoc / about:blank → inherit the embedder origin → gate by top.
//   • blob:<origin>/<uuid>       → the real origin is embedded → gate by it.
// Everything else gates by its own origin (a genuinely cross-origin frame still
// needs its own grant). Returns null if unparseable.
export function effectiveOriginGlob(
  frameUrl: string | undefined,
  topUrl: string | undefined
): string | null {
  if (!frameUrl) return null;
  if (frameUrl === "about:srcdoc" || frameUrl === "about:blank") {
    return originGlobOf(topUrl);
  }
  if (frameUrl.startsWith("blob:")) {
    // Strip the "blob:" prefix to expose the inner origin URL.
    return originGlobOf(frameUrl.slice("blob:".length));
  }
  return originGlobOf(frameUrl);
}

// Extract the lowercase host from an origin glob, or null if unparseable.
export function hostFromOriginGlob(glob: string): string | null {
  try {
    return new URL(glob.replace(/\*$/, "")).host.toLowerCase();
  } catch {
    return null;
  }
}

// Normalize a user-supplied cookie domain to a bare lowercase host, or null if
// it is not a plain domain (contains scheme/path/glob).
export function normalizeCookieDomain(domain: unknown): string | null {
  if (typeof domain !== "string") return null;
  let d = domain.trim().toLowerCase();
  if (!d || d.includes("://") || d.includes("/") || d.includes("*")) return null;
  while (d.startsWith(".")) d = d.slice(1);
  return d || null;
}

// Does `glob` match any pattern in `list`?
export function matchesAny(glob: string, list: string[]): boolean {
  return list.some((pattern) => simpleMatch(pattern, glob));
}

// Minimal glob match: supports a trailing * only. Good enough for "host/*".
export function simpleMatch(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2); // drop "/*"
    return target === base || target.startsWith(base + "/");
  }
  if (pattern.endsWith("*")) {
    return target.startsWith(pattern.slice(0, -1));
  }
  return false;
}

// Convert an origin glob to a chrome.permissions match pattern, or null.
export function globToPermissionPattern(glob: string): string | null {
  if (typeof glob !== "string" || !glob) return null;
  return glob.endsWith("/*") ? glob : glob + "*";
}
