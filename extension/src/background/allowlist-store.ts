// Storage-backed domain allowlist + the new-origin approval flow.
//
// The allowlist lives in chrome.storage.local (survives SW restarts). A new
// origin surfaces a badge + pending request that the popup resolves.

import { getSetting } from "../shared/settings";
import {
  originGlobOf,
  hostFromOriginGlob,
  normalizeCookieDomain,
  matchesAny,
  globToPermissionPattern,
} from "../shared/allowlist";

const STORAGE_KEY = "allowlist";

export async function getAllowlist(): Promise<string[]> {
  const { [STORAGE_KEY]: list } = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(list) ? list : [];
}

export async function setAllowlist(list: string[]) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

export async function ensureDomainAllowed(domain: string) {
  const host = normalizeCookieDomain(domain);
  if (!host) throw new Error(`invalid cookie domain: ${domain}`);
  // Global bypass: if the user opted into "allow all sites", skip the
  // per-site check entirely.
  if ((await getSetting("allowAllSites")) === true) return;
  const list = await getAllowlist();
  const allowed = list.some((glob) => hostFromOriginGlob(glob) === host);
  if (!allowed) {
    throw new Error(
      `cookie domain not allowed by user: ${domain}. Use a URL for the active allowlisted origin, or approve that exact host first.`
    );
  }
}

export async function ensureAllowed(url: string | undefined) {
  const glob = originGlobOf(url);
  if (!glob) throw new Error(`cannot parse url: ${url}`);
  // Global bypass: if the user opted into "allow all sites", skip the
  // per-site prompt entirely. The <all_urls> host permission must have been
  // granted when they enabled the toggle (see options.ts), so content-script
  // injection works on any origin.
  if ((await getSetting("allowAllSites")) === true) return;
  const list = await getAllowlist();
  if (matchesAny(glob, list)) return;
  // Not allowlisted → ask the user. We raise a "!" toolbar badge + a pending
  // record the popup reads; the popup grants/denies. Give the agent a distinct,
  // actionable message per outcome (#79) — a bare "not allowed" reads as a
  // permanent failure and doesn't tell the user what to click.
  const reason = await promptUserForAllow(glob);
  if (reason === "denied") {
    throw new Error(`The user denied browser-bridge access to ${glob}.`);
  }
  if (reason === "timeout") {
    // On timeout the badge + pending record are already cleared, so there's
    // nothing left to click — the fix is to RETRY, which re-opens the prompt.
    throw new Error(
      `Approval for ${glob} timed out (no response in 60s). Retry this tool call, ` +
        `then click the Browser Bridge toolbar icon (it shows a red "!" badge) and ` +
        `choose Allow within 60s. Or pre-approve the origin in the extension's ` +
        `Settings → Allowed sites.`
    );
  }
  // reason === "granted" → allowed; fall through.
}

type AllowReason = "granted" | "denied" | "timeout";

// Ask the user to approve a new origin. Surfaces a "!" toolbar badge + a pending
// record the popup reads, and resolves how it ended so the caller can tell the
// agent exactly what happened. Fails closed: no response in 60s → "timeout".
function promptUserForAllow(glob: string): Promise<AllowReason> {
  return new Promise((resolve) => {
    const reqId = `allow_${Date.now()}`;
    pendingAllowRequests.set(reqId, { glob, resolve });
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#d9534f" });
    chrome.storage.local.set({ pendingAllow: { id: reqId, glob } });
    // Auto-reject after 60s.
    setTimeout(() => {
      if (pendingAllowRequests.has(reqId)) {
        pendingAllowRequests.delete(reqId);
        chrome.storage.local.remove("pendingAllow");
        maybeClearBadge();
        resolve("timeout");
      }
    }, 60000);
  });
}

const pendingAllowRequests = new Map<string, { glob: string; resolve: (v: AllowReason) => void }>();

function maybeClearBadge() {
  if (pendingAllowRequests.size === 0) {
    chrome.action.setBadgeText({ text: "" });
  }
}

// Resolve a pending approval (called by the popup via the message router).
export async function resolvePendingAllow(
  id: string,
  allow: boolean
): Promise<{ ok: boolean; error?: string }> {
  const pending = pendingAllowRequests.get(id);
  if (!pending) return { ok: false, error: "no such pending request" };
  pendingAllowRequests.delete(id);
  chrome.storage.local.remove("pendingAllow");
  maybeClearBadge();
  if (allow) {
    const list = await getAllowlist();
    if (!list.includes(pending.glob)) list.push(pending.glob);
    await setAllowlist(list);
    pending.resolve("granted");
  } else {
    pending.resolve("denied");
  }
  return { ok: true };
}

// Manual add from the options page. We only persist the glob — MV3 forbids
// chrome.permissions.request outside a user-gesture context, so the actual
// host permission is requested on first visit via ensureAllowed().
export async function addAllow(glob: string): Promise<string[]> {
  const list = await getAllowlist();
  if (!list.includes(glob)) list.push(glob);
  await setAllowlist(list);
  return list;
}

// Remove a glob and best-effort release its host permission.
export async function removeAllow(glob: string): Promise<{
  list: string[];
  permissionRemoved: boolean;
  permissionError?: string;
}> {
  const list = await getAllowlist();
  const next = list.filter((g) => g !== glob);
  await setAllowlist(next);
  const pattern = globToPermissionPattern(glob);
  if (!pattern) return { list: next, permissionRemoved: false };
  return new Promise((resolve) => {
    chrome.permissions.remove({ origins: [pattern] }, (removed) => {
      resolve({
        list: next,
        permissionRemoved: Boolean(removed),
        permissionError: chrome.runtime.lastError?.message,
      });
    });
  });
}
