// popup.ts — runs when the user clicks the extension icon. Handles two jobs:
//   1. Show connection status + current allowlist (with revoke).
//   2. If background asked the user to approve a new origin (badge "!" + a
//      `pendingAllow` entry in storage), show the approve/deny UI. Approving
//      ALSO requests the host permission via chrome.permissions.request —
//      this must happen in the popup (a user-gesture context), since service
//      workers cannot request permissions.

import { t, applyI18n, initI18n } from "./shared/i18n";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function refreshStatus() {
  const status = await send({ type: "get_status" });
  const dot = $("dot");
  dot.className = "dot " + (status?.nativeConnected ? "ok" : "bad");
  $("status-text").textContent = status?.nativeConnected
    ? t("status_connected")
    : t("status_disconnected");
}

async function refreshList() {
  const resp = await send({ type: "get_allowlist" });
  const list = (resp?.list as string[]) || [];
  $("empty").style.display = list.length ? "none" : "block";
  $("list").innerHTML = list
    .map(
      (g) =>
        `<div class="item"><code>${escapeHtml(g)}</code>` +
        `<button class="danger" data-glob="${escapeAttr(g)}">${escapeHtml(t("btn_revoke"))}</button></div>`
    )
    .join("");
  // Wire revoke buttons.
  document.querySelectorAll<HTMLButtonElement>(".item button").forEach((b) => {
    b.onclick = async () => {
      const glob = b.getAttribute("data-glob")!;
      await send({ type: "remove_allow", glob });
      refreshList();
    };
  });
}

async function refreshPending() {
  const { pendingAllow } = (await chrome.storage.local.get("pendingAllow")) as {
    pendingAllow?: { id?: string; glob?: string };
  };
  if (pendingAllow && pendingAllow.id && pendingAllow.glob) {
    const { id, glob } = pendingAllow;
    $("pending").style.display = "block";
    $("pending-glob").textContent = glob;
    $("allow").onclick = () => resolvePending(id, glob, true);
    $("deny").onclick = () => resolvePending(id, glob, false);
  } else {
    $("pending").style.display = "none";
  }
}

async function resolvePending(id: string, glob: string, allow: boolean) {
  if (allow) {
    // Request host permission at the same time as recording the allow. The
    // origin glob looks like "https://example.com/*"; convert to a match
    // pattern for permissions.request.
    const pattern = globToPattern(glob);
    try {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) {
        // User declined the OS prompt → treat as deny.
        await send({ type: "resolve_allow", id, allow: false });
        $("pending").style.display = "none";
        return;
      }
    } catch (e) {
      console.warn("[bb] permissions.request failed", e);
    }
  }
  await send({ type: "resolve_allow", id, allow });
  $("pending").style.display = "none";
  refreshList();
}

function globToPattern(glob: string) {
  // "https://example.com/*" is already a valid match pattern; pass through.
  // If it somehow lacks the trailing *, add it.
  return glob.endsWith("/*") ? glob : glob + "*";
}

function send(msg: object): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
function escapeAttr(s: string) {
  return escapeHtml(s);
}

// Open the full settings page (options_ui): tool enablement, the allowlist, and
// execution mode.
$("open-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

(async function init() {
  // Resolve the UI language and fill static [data-i18n] elements first.
  await initI18n();
  applyI18n();
  refreshStatus();
  refreshList();
  refreshPending();
})();

export {};
