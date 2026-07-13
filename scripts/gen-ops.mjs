// Generate extension/src/shared/ops.ts from contracts/tools.json (the single
// source of truth for the tool catalogue). Run `make gen` after editing the
// contract; CI checks the generated file is up to date.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(readFileSync(join(root, "contracts/tools.json"), "utf8"));

const items = contract.tools
  .map((t) => `  { op: ${JSON.stringify(t.name)}, desc: ${JSON.stringify(t.uiLabel)} },`)
  .join("\n");

const out = `// GENERATED from contracts/tools.json by scripts/gen-ops.mjs — DO NOT EDIT.
// Edit the contract, then run \`make gen\` (or \`node scripts/gen-ops.mjs\`).
//
// The tool catalogue, JS side: op names + Chinese UI labels for the options
// page. tools.rs is verified against the same contract in \`cargo test\`.

export interface ToolInfo {
  op: string;
  desc: string;
}

export const TOOLS: ToolInfo[] = [
${items}
];

// All op names, for enumeration / consistency checks.
export const OP_NAMES: string[] = TOOLS.map((t) => t.op);
`;

writeFileSync(join(root, "extension/src/shared/ops.ts"), out);
console.log("generated extension/src/shared/ops.ts from contracts/tools.json");
