// CdpSessionRegistry — a module-level singleton mapping tabId → CdpSession.
//
// In CDP mode the debugger stays attached across ops (the "Started debugging
// this browser" banner persists — by design, ADR-0017), so we cache one
// attached session per tab and reuse it. Sessions are torn down when the tab
// closes, when Chrome detaches us, or when the user turns CDP mode off.

import { CdpSession } from "./session";

class CdpSessionRegistry {
  private sessions = new Map<number, CdpSession>();

  // Get (creating + attaching lazily) the session for a tab. attach() is
  // idempotent, so this is cheap on the hot path.
  async get(tabId: number): Promise<CdpSession> {
    let session = this.sessions.get(tabId);
    if (!session) {
      session = new CdpSession(tabId);
      this.sessions.set(tabId, session);
    }
    try {
      await session.attach();
    } catch (e) {
      // Attach failed → don't leave a half-dead session cached. But if a
      // concurrent op already attached this same session, keep it — deleting it
      // would orphan a live debugger attach (stuck banner, teardown misses it).
      if (!session.isAttached) this.sessions.delete(tabId);
      throw e;
    }
    return session;
  }

  // Explicit teardown: detach and forget. Safe to call for an unknown tab.
  async teardown(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.sessions.delete(tabId);
    await session.detach();
  }

  async teardownAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.detach()));
  }

  // Chrome already detached us (onDetach) — drop the session WITHOUT issuing a
  // redundant detach command.
  handleExternalDetach(tabId: number): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.markDetached();
    this.sessions.delete(tabId);
  }

  // Whether a persistent session is currently held for this tab (no attach, no
  // side effect). Used by precise.ts to avoid a second, conflicting attach when
  // CDP mode already holds the tab.
  hasSession(tabId: number): boolean {
    return this.sessions.has(tabId);
  }

  // For diagnostics / tests.
  get size(): number {
    return this.sessions.size;
  }
}

export const cdpRegistry = new CdpSessionRegistry();

// Wire session teardown to the relevant Chrome events. Called once at SW
// startup from background.ts (NOT at module load, so importing the registry
// from unit tests / the backend selector stays free of chrome.* side effects).
let listenersInstalled = false;
export function installCdpLifecycleListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  // Tab closed → detach + forget.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void cdpRegistry.teardown(tabId);
  });

  // Chrome detached us (tab navigated to a non-debuggable page, user hit the
  // banner's "Cancel", DevTools opened, …). Drop the session without re-detach.
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === "number") cdpRegistry.handleExternalDetach(source.tabId);
  });

  // CDP mode turned off → detach everything so the banner goes away.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const change = changes.cdpMode;
    if (change && change.newValue === false) void cdpRegistry.teardownAll();
  });
}
