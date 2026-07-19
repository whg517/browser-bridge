// The pinned extension ID — the ID Chrome derives from the manifest `key` when
// the extension is loaded unpacked (developers, and the prebuilt install path).
//
// This is the extension-side copy of the single source of truth. It is kept in
// lockstep with `extension/manifest.json`'s `key`, `install/install.sh`, and
// `install/install.ps1` by `scripts/check-extension-id.mjs` (a CI gate). If you
// rotate the key, update all of them together — the gate fails otherwise.
export const PINNED_EXTENSION_ID = "mkjjlmjbcljpcfkfadfmhblmmddkdihf";

// The Chrome Web Store-assigned ID. Users who install from the store run the
// published build, whose ID is fixed by the store (which ignores the manifest
// `key`), so it differs from the pinned unpacked ID above. The native-messaging
// host trusts BOTH ids in allowed_origins, and this self-check accepts both.
// This constant is kept in lockstep with the installers by the same CI gate.
export const STORE_EXTENSION_ID = "dgccjfjjilfpkbdllclmkiicajndkfcd";

// Every id a correctly-installed browser-bridge may legitimately run under.
export const TRUSTED_EXTENSION_IDS: readonly string[] = [PINNED_EXTENSION_ID, STORE_EXTENSION_ID];

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
  expected: readonly string[] = TRUSTED_EXTENSION_IDS
): IdDiagnosis {
  if (expected.includes(runtimeId)) {
    return {
      ok: true,
      level: "ok",
      message: `extension id ${runtimeId} is trusted — native messaging will be accepted`,
    };
  }
  return {
    ok: false,
    level: "error",
    message:
      `extension id mismatch: running=${runtimeId} trusted=${expected.join(", ")}. ` +
      `The native-messaging host pins the trusted ids in allowed_origins, so this ` +
      `extension will be REJECTED and browser-bridge cannot connect. Likely cause: ` +
      `you loaded a build whose manifest lacks the pinned \`key\` (Chrome then derives ` +
      `a path-based id), or an install whose host manifest predates this build's id. ` +
      `Fix: load the built extension/dist that contains the pinned key (or install from ` +
      `the Chrome Web Store), and re-run the installer so allowed_origins trusts your id.`,
  };
}
