// popup.ts — runs when the user clicks the extension icon. Shows the native-host
// connection status and a link to the full settings page. (There is no per-site
// approval flow: the extension holds the <all_urls> host permission outright.)

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

function send(msg: object): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

// Open the full settings page (options_ui): tool enablement, execution mode.
$("open-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

(async function init() {
  await initI18n();
  applyI18n();
  refreshStatus();
})();

export {};
