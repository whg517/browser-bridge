import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { OP_NAMES, TOOL_META, TOOLS } from "./ops";
import type { BridgeCommand } from "./ops";

// The JSON-Schema → TS type mapping the generator uses; mirrored here so the
// test can reconstruct the expected union arms from the contract.
const JSON_TYPE_TO_TS: Record<string, string> = {
  string: "string",
  integer: "number",
  number: "number",
  boolean: "boolean",
};

describe("ops catalogue", () => {
  test("op names are unique", () => {
    expect(new Set(OP_NAMES).size).toBe(OP_NAMES.length);
  });

  test("every tool has an op and a description", () => {
    for (const t of TOOLS) {
      expect(t.op.length).toBeGreaterThan(0);
      expect(t.desc.length).toBeGreaterThan(0);
    }
  });

  // ops.ts is generated from contracts/tools.json (scripts/gen-ops.mjs); assert
  // it's in sync with the contract (the single source). tools.rs is checked
  // against the same contract in `cargo test` — so all three stay aligned.
  test("matches contracts/tools.json (the source)", () => {
    const contract = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../../contracts/tools.json"), "utf8")
    );
    const names = contract.tools.map((t: { name: string }) => t.name);
    const labels = Object.fromEntries(
      contract.tools.map((t: { name: string; uiLabel: string }) => [t.name, t.uiLabel])
    );
    expect(OP_NAMES).toEqual(names);
    for (const t of TOOLS) expect(t.desc).toBe(labels[t.op]);
  });

  // TOOL_META is generated from the same contract; assert the policy metadata
  // (risk / scope / permission / confirmation) matches tool-for-tool.
  test("TOOL_META matches contracts/tools.json (the source)", () => {
    const contract = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../../contracts/tools.json"), "utf8")
    ) as {
      tools: {
        name: string;
        risk: string;
        scope: string;
        permission: string;
        confirmation: string;
      }[];
    };

    // Same set of ops, no extras on either side.
    expect(Object.keys(TOOL_META).sort()).toEqual(contract.tools.map((t) => t.name).sort());

    for (const t of contract.tools) {
      expect(TOOL_META[t.name]).toEqual({
        risk: t.risk,
        scope: t.scope,
        permission: t.permission,
        confirmation: t.confirmation,
      });
    }
  });

  // BridgeCommand is a generated discriminated union (one arm per tool, args
  // derived from inputSchema). It is a compile-time-only type, so we verify the
  // generated source text against the contract: each arm carries exactly the
  // schema's props with the right TS type and optionality (required → no `?`).
  test("BridgeCommand union matches contracts/tools.json (the source)", () => {
    const src = readFileSync(resolve(import.meta.dir, "./ops.ts"), "utf8");
    const contract = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../../contracts/tools.json"), "utf8")
    ) as {
      tools: {
        name: string;
        inputSchema: {
          properties: Record<string, { type: string }>;
          required?: string[];
        };
      }[];
    };

    const unionStart = src.indexOf("export type BridgeCommand =");
    expect(unionStart).toBeGreaterThan(-1);
    // Collapse whitespace so single-line and wrapped arms compare the same way.
    const union = src.slice(unionStart).replace(/\s+/g, " ");

    for (const t of contract.tools) {
      const props = t.inputSchema.properties ?? {};
      const required = new Set(t.inputSchema.required ?? []);
      const keys = Object.keys(props);

      // Every tool appears as its own arm.
      expect(union).toContain(`op: ${JSON.stringify(t.name)};`);

      if (keys.length === 0) {
        // No-arg tools use the strict empty-object type.
        expect(union).toContain(`op: ${JSON.stringify(t.name)}; args: Record<string, never>`);
        continue;
      }

      for (const k of keys) {
        const tsType = JSON_TYPE_TO_TS[props[k].type];
        expect(tsType).toBeDefined();
        const optional = required.has(k) ? "" : "?";
        expect(union).toContain(`${k}${optional}: ${tsType}`);
      }
    }
  });

  // Compile-time coverage: these assignments only type-check if the generated
  // union narrows on `op` and enforces each tool's args (required vs optional,
  // and the right value type). `tsc --noEmit` (npm run typecheck) is the gate;
  // the runtime body below is a trivial smoke assertion.
  test("BridgeCommand narrows args per op (compile-time)", () => {
    const list: BridgeCommand = { op: "tab_list", args: {} };
    const focus: BridgeCommand = { op: "tab_focus", args: { tabId: 3 } };
    const fill: BridgeCommand = { op: "page_fill", args: { value: "hi", ref: "e1" } };
    const evalCmd: BridgeCommand = { op: "page_eval", args: { code: "1+1" } };

    // @ts-expect-error tab_focus requires args.tabId
    const missing: BridgeCommand = { op: "tab_focus", args: {} };
    // @ts-expect-error tab_focus.args has no `code` field
    const wrongField: BridgeCommand = { op: "tab_focus", args: { tabId: 1, code: "x" } };
    // @ts-expect-error tab_focus.args.tabId is a number, not a string
    const wrongType: BridgeCommand = { op: "tab_focus", args: { tabId: "3" } };

    void missing;
    void wrongField;
    void wrongType;
    expect([list.op, focus.op, fill.op, evalCmd.op]).toEqual([
      "tab_list",
      "tab_focus",
      "page_fill",
      "page_eval",
    ]);
  });
});
