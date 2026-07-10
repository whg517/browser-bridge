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

  // Cross-language guard: the JS op list must match the Rust authority
  // (src/tools.rs). This catches the drift that once left docs claiming 11
  // tools when there were really 15.
  test("matches the Rust tool list in tools.rs", () => {
    const toolsRs = readFileSync(resolve(import.meta.dir, "../../../src/tools.rs"), "utf8");
    const rustNames = [...toolsRs.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(rustNames.length).toBeGreaterThan(0);
    expect([...OP_NAMES].sort()).toEqual([...rustNames].sort());
  });
});
