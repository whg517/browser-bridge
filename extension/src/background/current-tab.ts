// The session's "current tab" — a virtual-focus pointer.
//
// Why it exists (ADR-0028 Phase 1a): every page tool used to resolve "the
// active tab", which is a single GLOBAL browser concept — whatever the human
// is looking at right now. An agent's target drifted the moment the user (or
// a second agent) switched tabs. A session-scoped pointer that follows the
// last tab the agent focused, opened, or explicitly targeted makes tool calls
// land where the conversation left off, not where the window's focus happens
// to be. This is the single-agent ("solo") form of the per-clientId pointer
// the broker will key on later.
//
// chrome.storage.session (not local, not memory): it must survive MV3
// service-worker recycles, which wipe in-memory state mid-conversation — but
// it must NOT survive a browser restart, because tab ids die with the browser
// and a persisted id would silently point at some unrelated future tab.

const KEY = "bb_current_tab_id";

/** The tab the session is currently working in, or null when nothing has
 * been targeted yet (callers fall back to the active tab). */
export async function getCurrentTabId(): Promise<number | null> {
  const rec = await chrome.storage.session.get(KEY);
  const id = rec[KEY];
  return typeof id === "number" ? id : null;
}

/** Make `tabId` the session's current tab. */
export async function setCurrentTabId(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [KEY]: tabId });
}

/** Forget the pointer — the tab it named is gone. */
export async function clearCurrentTabId(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
