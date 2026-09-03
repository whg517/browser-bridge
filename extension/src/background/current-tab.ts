// Each agent's "current tab" — a per-client virtual-focus pointer.
//
// Why it exists (ADR-0028 Phase 1a/1c): every page tool used to resolve "the
// active tab", which is a single GLOBAL browser concept — whatever the human
// is looking at right now. An agent's target drifted the moment the user (or
// a second agent) switched tabs. A session-scoped pointer that follows the
// last tab the agent focused, opened, or explicitly targeted makes tool calls
// land where the conversation left off.
//
// The pointer is keyed by CLIENT (the broker-granted `clientId`, "solo" on
// the single-process path): two agents sharing one browser each keep their
// own focus, which is the whole point of Phase 1c.
//
// chrome.storage.session (not local, not memory): it must survive MV3
// service-worker recycles, which wipe in-memory state mid-conversation — but
// it must NOT survive a browser restart, because tab ids die with the browser
// and a persisted id would silently point at some unrelated future tab.

const keyFor = (client: string) => `bb_current_tab:${client}`;

/** The tab `client` is currently working in, or null when it has not targeted
 * anything yet (callers fall back to the active tab). */
export async function getCurrentTabId(client: string): Promise<number | null> {
  const rec = await chrome.storage.session.get(keyFor(client));
  const id = rec[keyFor(client)];
  return typeof id === "number" ? id : null;
}

/** Make `tabId` the client's current tab. */
export async function setCurrentTabId(client: string, tabId: number): Promise<void> {
  await chrome.storage.session.set({ [keyFor(client)]: tabId });
}

/** Forget the pointer — the tab it named is gone. */
export async function clearCurrentTabId(client: string): Promise<void> {
  await chrome.storage.session.remove(keyFor(client));
}
