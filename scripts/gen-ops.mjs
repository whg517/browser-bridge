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

// Collect the distinct values for each metadata field so the generated union
// types stay in sync with the contract (add a new risk level in tools.json and
// it appears here automatically).
const distinct = (key) =>
  [...new Set(contract.tools.map((t) => t[key]))]
    .sort()
    .map((v) => JSON.stringify(v))
    .join(" | ");

const riskUnion = distinct("risk");
const scopeUnion = distinct("scope");
const permissionUnion = distinct("permission");
const confirmationUnion = distinct("confirmation");

// op names are valid JS identifiers, so emit unquoted keys (matches Prettier's
// `quoteProps: "as-needed"` default). Each entry is emitted multiline so the
// generated file stays format-clean regardless of value lengths (Prettier keeps
// an object expanded when there's a newline right after the opening brace).
const meta = contract.tools
  .map(
    (t) =>
      `  ${t.name}: {\n` +
      `    risk: ${JSON.stringify(t.risk)},\n` +
      `    scope: ${JSON.stringify(t.scope)},\n` +
      `    permission: ${JSON.stringify(t.permission)},\n` +
      `    confirmation: ${JSON.stringify(t.confirmation)},\n` +
      `  },`
  )
  .join("\n");

// Discriminated union of every tool's request shape, derived from each tool's
// inputSchema. Required props → required fields; the rest → optional. This is
// the compile-time contract the extension narrows on (see shared/types.ts's
// BridgeReq). Emitted already Prettier-formatted (printWidth 100) so the raw
// generator output stays diff-clean without a post-format step.
const PRINT_WIDTH = 100;

const jsonTypeToTs = (jsonType) => {
  switch (jsonType) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      throw new Error(`gen-ops: unsupported JSON Schema type ${JSON.stringify(jsonType)}`);
  }
};

const commandArm = (t) => {
  const schema = t.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const fields = Object.keys(props).map(
    (k) => `${k}${required.has(k) ? "" : "?"}: ${jsonTypeToTs(props[k].type)}`
  );
  const opLit = JSON.stringify(t.name);
  // A tool with no inputSchema props gets a strict empty-object type. `{}` would
  // trip @typescript-eslint/no-empty-object-type (and it wrongly allows any
  // non-nullish value); Record<string, never> is the precise "no fields" type
  // an empty object literal still satisfies.
  const argsInline = fields.length ? `{ ${fields.join("; ")} }` : "Record<string, never>";

  // Mirror Prettier's line-breaking: keep the arm on one line when it fits;
  // otherwise break the outer object, and break the args object too if its
  // line still overflows.
  const single = `  | { op: ${opLit}; args: ${argsInline} }`;
  if (single.length <= PRINT_WIDTH) return single;

  const argsLine = `      args: ${argsInline};`;
  if (argsLine.length <= PRINT_WIDTH) {
    return `  | {\n      op: ${opLit};\n${argsLine}\n    }`;
  }

  const argsBlock = fields.map((f) => `        ${f};`).join("\n");
  return `  | {\n      op: ${opLit};\n      args: {\n${argsBlock}\n      };\n    }`;
};

const commands = contract.tools.map(commandArm).join("\n");

const out = `// GENERATED from contracts/tools.json by scripts/gen-ops.mjs — DO NOT EDIT.
// Edit the contract, then run \`make gen\` (or \`node scripts/gen-ops.mjs\`).
//
// The tool catalogue, JS side: op names + Chinese UI labels for the options
// page, policy metadata (risk / scope / permission / confirmation), and the
// per-tool request shapes (BridgeCommand, derived from each inputSchema).
// tools.rs is verified against the same contract in \`cargo test\`.

export interface ToolInfo {
  op: string;
  desc: string;
}

export const TOOLS: ToolInfo[] = [
${items}
];

// All op names, for enumeration / consistency checks.
export const OP_NAMES: string[] = TOOLS.map((t) => t.op);

// Policy metadata, mirrored from the contract. Consumed by the policy layer
// (background/policy.ts) — kept as plain data so it stays import-side-effect-free.
export type Risk = ${riskUnion};
export type Scope = ${scopeUnion};
export type Permission = ${permissionUnion};
export type Confirmation = ${confirmationUnion};

export interface ToolMeta {
  risk: Risk;
  scope: Scope;
  permission: Permission;
  confirmation: Confirmation;
}

export const TOOL_META: Record<string, ToolMeta> = {
${meta}
};

// Per-tool request shapes, derived from each tool's inputSchema. Discriminated
// on \`op\`, so consumers (background/dispatch.ts) narrow the args to exactly the
// fields that tool accepts. shared/types.ts intersects this with the request
// envelope ({ id, tabId? }) to form BridgeReq. Required schema props map to
// required fields; the rest are optional. JSON-Schema string→string,
// integer/number→number, boolean→boolean.
export type BridgeCommand =
${commands};
`;

writeFileSync(join(root, "extension/src/shared/ops.ts"), out);
console.log("generated extension/src/shared/ops.ts from contracts/tools.json");
