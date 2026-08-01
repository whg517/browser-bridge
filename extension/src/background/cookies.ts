// cookie_get — read-only cookie access (chrome.cookies is SW-only). httpOnly
// cookies are readable here (that's the point — session tokens live there).
// Values are masked before leaving the extension. No set/remove: writing would
// allow forging httpOnly cookies (session fixation), which even page XSS cannot
// do. See ADR-0010.

import type { OpArgs } from "../shared/types";
import { maskCookieValue } from "../shared/masking";
import { resolveTargetTab } from "./tabs";

export async function cookieGet(maybeTabId: number | undefined, args: OpArgs) {
  // If the caller didn't pass url/domain, default to the active tab's URL so
  // "cookie_get {}" means "cookies for the page I'm looking at".
  let { url } = args || {};
  const { domain, name } = args || {};
  if (!url && !domain) {
    const tab = await resolveTargetTab(maybeTabId);
    url = tab.url;
  }

  const filter: chrome.cookies.GetAllDetails = {};
  if (url) filter.url = url;
  if (domain) filter.domain = domain;
  if (name) filter.name = name;

  const cookies = await chrome.cookies.getAll(filter);
  if (!cookies || cookies.length === 0) {
    return {
      cookies: [],
      count: 0,
      hint: "No cookies matched the given url/domain/name.",
    };
  }
  // Mask the value only; keep name/domain/httpOnly etc. for diagnostics. The
  // name is passed in as masking evidence: `csrftoken` / `sessionid` values
  // match no pattern in the catalogue but are credentials all the same.
  const out = cookies.map((c) => ({
    name: c.name,
    value: maskCookieValue(c.value, c.name),
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
