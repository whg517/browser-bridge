#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, "extension/manifest.json"), "utf8"));
if (typeof manifest.key !== "string" || manifest.key.length === 0) {
  throw new Error("extension/manifest.json has no public key");
}

const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
const derivedId = [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");

const sources = [
  ["install/install.sh", /PINNED_EXTENSION_ID="([a-p]{32})"/],
  ["install/install.ps1", /\$ExtensionId\s*=\s*'([a-p]{32})'/],
  ["extension/src/shared/extension-id.ts", /PINNED_EXTENSION_ID\s*=\s*"([a-p]{32})"/],
];

let failed = false;
for (const [relativePath, pattern] of sources) {
  const source = readFileSync(resolve(root, relativePath), "utf8");
  const configuredId = source.match(pattern)?.[1];
  if (configuredId !== derivedId) {
    console.error(`${relativePath}: configured=${configuredId || "missing"} derived=${derivedId}`);
    failed = true;
  }
}

// The Chrome Web Store-assigned id is NOT derived from the manifest key (the
// store assigns it), so it has no derivable source of truth. Instead just keep
// the three hard-coded copies in lockstep with each other.
const storeSources = [
  ["install/install.sh", /STORE_EXTENSION_ID="([a-p]{32})"/],
  ["install/install.ps1", /\$StoreExtensionId\s*=\s*'([a-p]{32})'/],
  ["extension/src/shared/extension-id.ts", /STORE_EXTENSION_ID\s*=\s*"([a-p]{32})"/],
];
const storeIds = storeSources.map(([relativePath, pattern]) => {
  const source = readFileSync(resolve(root, relativePath), "utf8");
  return [relativePath, source.match(pattern)?.[1]];
});
const storeId = storeIds[0][1];
for (const [relativePath, configuredId] of storeIds) {
  if (!configuredId || configuredId !== storeId) {
    console.error(`${relativePath}: store id=${configuredId || "missing"} expected=${storeId || "?"}`);
    failed = true;
  }
}
if (storeId && storeId === derivedId) {
  console.error(`store id ${storeId} must differ from the pinned unpacked id ${derivedId}`);
  failed = true;
}

if (failed) process.exit(1);
console.log(
  `extension ids: pinned=${derivedId} store=${storeId} ` +
    `(manifest key + installers + store id consistent)`
);
