// The code only helps if it survives the trip. `codeOf` is what port.ts puts on
// the wire, and the error it inspects may have crossed the service-worker ↔
// content-script boundary, where structured cloning strips the prototype — so it
// must read the property rather than trust `instanceof`.

import { describe, expect, test } from "bun:test";
import { BridgeError, codeOf } from "./bridge-error";

describe("codeOf", () => {
  test("reads the code off a BridgeError", () => {
    expect(codeOf(new BridgeError("TAB_NOT_FOUND", "tab 7 not found"))).toBe("TAB_NOT_FOUND");
  });

  test("reads it off a structurally-cloned copy, which has lost the prototype", () => {
    const original = new BridgeError("TOOL_DISABLED", "tool disabled in settings: page_eval");
    // What survives a message hop: plain data, no class identity.
    const cloned = { name: original.name, message: original.message, code: original.code };
    expect(cloned instanceof BridgeError).toBe(false);
    expect(codeOf(cloned)).toBe("TOOL_DISABLED");
  });

  test("an ordinary Error is unclassified — the server reports EXECUTION_FAILED", () => {
    expect(codeOf(new Error("selector matched nothing"))).toBeUndefined();
  });

  test("survives the shapes a rejected promise can carry", () => {
    expect(codeOf(undefined)).toBeUndefined();
    expect(codeOf(null)).toBeUndefined();
    expect(codeOf("a bare string rejection")).toBeUndefined();
    // A non-string `code` is not a taxonomy code (DOMException carries a number).
    expect(codeOf({ code: 42 })).toBeUndefined();
  });

  test("keeps the message intact, since that is what the model reads", () => {
    const err = new BridgeError("UNSUPPORTED_PAGE", "cannot be driven by the debugger");
    expect(err.message).toBe("cannot be driven by the debugger");
    expect(err).toBeInstanceOf(Error);
  });
});
