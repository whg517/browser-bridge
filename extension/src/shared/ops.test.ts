import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { OP_NAMES, TOOLS } from "./ops";

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
});
