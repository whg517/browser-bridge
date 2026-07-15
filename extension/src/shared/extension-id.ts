// The pinned extension ID — the ID Chrome derives from the manifest `key`.
//
// This is the extension-side copy of the single source of truth. It is kept in
// lockstep with `extension/manifest.json`'s `key`, `install/install.sh`, and
// `install/install.ps1` by `scripts/check-extension-id.mjs` (a CI gate). If you
// rotate the key (e.g. to adopt a Chrome Web Store-assigned id), update all of
// them together — the gate fails otherwise.
export const PINNED_EXTENSION_ID = "mkjjlmjbcljpcfkfadfmhblmmddkdihf";

export interface IdDiagnosis {
  ok: boolean;
  level: "ok" | "error";
  message: string;
}

/**
 * Pure diagnosis: does the running extension id match the pinned one?
 *
 * The native-messaging host's manifest pins the expected id in
 * `allowed_origins`, so if the loaded extension has a different id, Chrome
 * rejects the native connection and browser-bridge cannot work. This surfaces
 * that failure loudly at startup instead of leaving the user to guess.
 *
 * We compare ids only — `chrome.runtime.getManifest()` strips the `key` field
 * at runtime, so we cannot reliably tell "no key" from "different key" here;
 * the message lists the likely causes instead of asserting one.
 */
export function diagnoseExtensionId(
  runtimeId: string,
  expected: string = PINNED_EXTENSION_ID
): IdDiagnosis {
  if (runtimeId === expected) {
    return {
      ok: true,
      level: "ok",
      message: `extension id ${runtimeId} matches the pinned id — native messaging will be accepted`,
    };
  }
  return {
    ok: false,
    level: "error",
    message:
      `extension id mismatch: running=${runtimeId} expected=${expected}. ` +
      `The native-messaging host pins the expected id in allowed_origins, so this ` +
      `extension will be REJECTED and browser-bridge cannot connect. Likely cause: ` +
      `you loaded a build whose manifest lacks the pinned \`key\` (Chrome then derives ` +
      `a path-based id), or a Chrome Web Store build with a store-assigned id. Fix: load ` +
      `the built extension/dist that contains the pinned key, or update the pinned id ` +
      `(manifest key + installers) to match your build.`,
  };
}
