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
  ["install.sh", /PINNED_EXTENSION_ID="([a-p]{32})"/],
  ["install.ps1", /\$ExtensionId\s*=\s*'([a-p]{32})'/],
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

if (failed) process.exit(1);
console.log(`extension id: ${derivedId} (manifest key + installers consistent)`);
