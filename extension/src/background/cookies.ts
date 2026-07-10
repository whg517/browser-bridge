// cookie_get — read-only cookie access for allowlisted hosts (chrome.cookies
// is SW-only). httpOnly cookies are readable here (that's the point — session
// tokens live there). Values are masked before leaving the extension. No
// set/remove: writing would allow forging httpOnly cookies (session fixation),
// which even page XSS cannot do. See ADR-0010.

import { maskCookieValue } from "../shared/masking";
import { ensureAllowed, ensureDomainAllowed } from "./allowlist-store";
import { resolveTargetTab } from "./tabs";

export async function cookieGet(maybeTabId: number | undefined, args: any) {
  // If the caller didn't pass url/domain, default to the active tab's URL so
  // "cookie_get {}" means "cookies for the page I'm looking at".
  let { url } = args || {};
  const { domain, name } = args || {};
  if (!url && !domain) {
    const tab = await resolveTargetTab(maybeTabId);
    await ensureAllowed(tab.url);
    url = tab.url;
  } else if (url) {
    await ensureAllowed(url);
  }
  if (domain) {
    await ensureDomainAllowed(domain);
  }

  const filter: any = {};
  if (url) filter.url = url;
  if (domain) filter.domain = domain;
  if (name) filter.name = name;

  const cookies = await chrome.cookies.getAll(filter);
  if (!cookies || cookies.length === 0) {
    return {
      cookies: [],
      count: 0,
      hint: "No cookies matched. If you expected some, verify the host is in the allowlist (popup → Allowed sites).",
    };
  }
  // Mask the value only; keep name/domain/httpOnly etc. for diagnostics.
  const out = cookies.map((c) => ({
    name: c.name,
    value: maskCookieValue(c.value),
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    session: c.session,
    expirationDate: c.expirationDate,
  }));
  return { cookies: out, count: out.length };
}
