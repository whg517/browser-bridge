// popup.js — runs when the user clicks the extension icon. Handles two jobs:
//   1. Show connection status + current allowlist (with revoke).
//   2. If background asked the user to approve a new origin (badge "!" + a
//      `pendingAllow` entry in storage), show the approve/deny UI. Approving
//      ALSO requests the host permission via chrome.permissions.request —
//      this must happen in the popup (a user-gesture context), since service
//      workers cannot request permissions.

function $(id) {
  return document.getElementById(id);
}

async function refreshStatus() {
  const status = await send({ type: "get_status" });
  const dot = $("dot");
  dot.className = "dot " + (status?.nativeConnected ? "ok" : "bad");
  $("status-text").textContent = status?.nativeConnected
    ? "Connected to bridge"
    : "Not connected (is ZCode running?)";
}

async function refreshList() {
  const resp = await send({ type: "get_allowlist" });
  const list = resp?.list || [];
  $("empty").style.display = list.length ? "none" : "block";
  $("list").innerHTML = list
    .map(
      (g) =>
        `<div class="item"><code>${escapeHtml(g)}</code>` +
        `<button class="danger" data-glob="${escapeAttr(g)}">Revoke</button></div>`
    )
    .join("");
  // Wire revoke buttons.
  document.querySelectorAll(".item button").forEach((b) => {
    b.onclick = async () => {
      const glob = b.getAttribute("data-glob");
      await send({ type: "remove_allow", glob });
      refreshList();
    };
  });
}

async function refreshPending() {
  const { pendingAllow } = await chrome.storage.local.get("pendingAllow");
  if (pendingAllow && pendingAllow.id && pendingAllow.glob) {
    $("pending").style.display = "block";
    $("pending-glob").textContent = pendingAllow.glob;
    $("allow").onclick = () => resolvePending(pendingAllow.id, pendingAllow.glob, true);
    $("deny").onclick = () => resolvePending(pendingAllow.id, pendingAllow.glob, false);
  } else {
    $("pending").style.display = "none";
  }
}

async function resolvePending(id, glob, allow) {
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

function globToPattern(glob) {
  // "https://example.com/*" is already a valid match pattern; pass through.
  // If it somehow lacks the trailing *, add it.
  return glob.endsWith("/*") ? glob : glob + "*";
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// Open the full settings page (options_ui). The evalMask toggle and all other
// security/tool/timeout settings now live there.
$("open-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refreshStatus();
refreshList();
refreshPending();
