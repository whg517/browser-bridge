// Per-agent workspace groups (ADR-0028 Phase 1c, generalizing ADR-0018).
//
// Each client gets its own tab group — "Browser Bridge · <name>" — so two
// agents sharing one browser don't collect tabs into one indistinguishable
// pile, and so scoping has something to enforce against: an explicit tabId
// must name a tab in the CALLING agent's group.
//
// Identity: `clientId` ("c1", "c2", …) is broker-GRANTED and stable for the
// connection; the display name arrives later from the client's `initialize`
// and is stored separately so the group can be RETITLED when it lands instead
// of orphaned. The solo path (no broker — one-shot `call`, tests) keeps the
// original single "Browser Bridge" group and is never scope-restricted.
//
// The clientId→groupId mapping lives in chrome.storage.session: tab group ids
// die with the browser (session storage is the right lifetime), and keying by
// id rather than title means the group survives its own retitling.

import { BridgeError } from "../shared/bridge-error";

const SOLO = "solo";
const SOLO_TITLE = "Browser Bridge";
const SOLO_COLOR = "blue";

// chrome.tabGroups.ColorEnum minus grey (too close to the user's own groups).
const COLORS = ["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow"] as const;

/** Deterministic color per client so an agent keeps its color across groups
 * and windows without a shared registry. */
export function colorForClient(client: string): (typeof COLORS)[number] {
  let h = 0;
  for (let i = 0; i < client.length; i++) h = (h * 31 + client.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** The visible group title for a client. */
export function groupTitleFor(client: string, name?: string): string {
  if (client === SOLO) return SOLO_TITLE;
  return name ? `Browser Bridge · ${name}` : `Browser Bridge · ${client}`;
}

/** Remember the display name the broker learned from the client's
 * `initialize` — labels only; scoping keys off the granted id. */
export async function rememberAgentName(client: string, name: string): Promise<void> {
  await chrome.storage.session.set({ [`bb_agent_name:${client}`]: name });
}

async function agentName(client: string): Promise<string | undefined> {
  const key = `bb_agent_name:${client}`;
  const rec = await chrome.storage.session.get(key);
  const v = rec[key];
  return typeof v === "string" ? v : undefined;
}

async function storedGroupId(client: string): Promise<number | undefined> {
  const key = `bb_group:${client}`;
  const rec = await chrome.storage.session.get(key);
  const v = rec[key];
  return typeof v === "number" ? v : undefined;
}

async function storeGroupId(client: string, groupId: number): Promise<void> {
  await chrome.storage.session.set({ [`bb_group:${client}`]: groupId });
}

/** Record which group belongs to `client` — normally done by `tab_open` via
 * addToAgentGroup; exported for tests (and any future flow that learns a
 * group id out of band). */
export async function rememberAgentGroup(client: string, groupId: number): Promise<void> {
  await storeGroupId(client, groupId);
}

/**
 * Put `tabId` into this client's workspace group, creating (and remembering)
 * the group when needed. Best-effort like ADR-0018's grouping: a failure here
 * warns and never fails the tab operation that called it.
 */
export async function addToAgentGroup(
  client: string,
  tabId: number,
  windowId: number | undefined
): Promise<number | undefined> {
  try {
    const title = groupTitleFor(client, await agentName(client));
    // A remembered group id wins — it survives retitling. Fall back to a
    // title lookup (pre-rename groups, other windows), then create fresh.
    const remembered = await storedGroupId(client);
    let existing: number | undefined = remembered;
    if (existing !== undefined) {
      const found = await chrome.tabGroups.get(existing).catch(() => undefined);
      if (found === undefined) existing = undefined;
    }
    if (existing === undefined) {
      const groups = await chrome.tabGroups.query(
        client === SOLO ? (windowId != null ? { windowId } : {}) : { title }
      );
      existing = groups.find(
        (g) => g.title === groupTitleFor(client, undefined) || g.title === title
      )?.id;
    }
    let group: number;
    if (existing !== undefined) {
      group = existing;
      await chrome.tabs.group({ tabIds: [tabId], groupId: group });
    } else {
      group = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(group, {
        title,
        color: client === SOLO ? SOLO_COLOR : colorForClient(client),
      });
    }
    await storeGroupId(client, group);
    // Retitle in the background of a name landing later; never fatal.
    if (client !== SOLO) {
      await chrome.tabGroups.update(group, { title }).catch(() => {});
    }
    return group;
  } catch (e) {
    console.warn("[bb] tab grouping failed:", (e as Error)?.message || e);
    return undefined;
  }
}

/**
 * Scope enforcement (ADR-0028 Phase 1c): an EXPLICITLY targeted tab must be
 * in the calling agent's own workspace. Other agents' tabs and the user's
 * ungrouped tabs are out of reach — that is the isolation this whole phase
 * exists for. The client's own group is remembered from its `tab_open`s, so
 * an agent that has opened nothing yet has nothing to target explicitly (it
 * can still use the unscoped active-tab fallback, the shared visible
 * surface).
 *
 * `solo` (no broker) is never restricted — single-user, unchanged behavior.
 */
export async function assertTabInScope(
  client: string,
  tab: Pick<chrome.tabs.Tab, "id" | "groupId">
): Promise<void> {
  if (client === SOLO) return;
  const mine = await storedGroupId(client);
  const tabGroup = typeof tab.groupId === "number" && tab.groupId >= 0 ? tab.groupId : undefined;
  if (mine !== undefined && tabGroup === mine) return;
  throw new BridgeError(
    "TAB_OUT_OF_SCOPE",
    `tab ${tab.id} is outside your workspace. Target tabs from your own group ` +
      `(open one with tab_open, or see tab_list's owner field), or ask the ` +
      `user to move the tab into it.`
  );
}

/** Which agent (or the user) a tab belongs to, for tab_list's owner field:
 * information is not hidden across agents — operations are. */
export async function ownerOf(
  client: string,
  groupId: number | undefined
): Promise<"you" | "agent" | "user"> {
  if (groupId === undefined) return "user";
  if (client !== SOLO && (await storedGroupId(client)) === groupId) return "you";
  return "agent";
}
