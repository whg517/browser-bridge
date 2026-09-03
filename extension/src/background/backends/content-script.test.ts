// Regression guard for frame targeting. Every op the backend sends must name a
// frame: chrome.tabs.sendMessage without a frameId broadcasts to EVERY frame in
// the tab and resolves with whichever answers first. After a read op has run
// injectAllFrames, all frames carry a listener, which broke page_screenshot
// (N captureVisibleTab calls exceed Chrome's 2/sec throttle), made page_scroll
// report a sub-frame's scrollY, and ran page_eval once per frame.

import { afterEach, describe, expect, test } from "bun:test";
import { ContentScriptBackend } from "./content-script";

interface Sent {
  tabId: number;
  msg: { op: string; args?: Record<string, unknown> };
  opts?: { frameId?: number };
}

const realChrome = (globalThis as { chrome?: unknown }).chrome;
afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = realChrome;
});

// Stub Chrome with a tab whose sub-frames are `subFrames`, recording every
// sendMessage so the tests can assert what each op targeted.
function stubChrome(sent: Sent[], subFrames: number[] = []) {
  const frames = [0, ...subFrames];
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      get: async () => ({ id: 1 }),
      // The resolved target IS the visible tab in these tests, so the
      // background-tab screenshot guard (ADR-0028 Phase 1a) lets ops through.
      query: async () => [{ id: 1, windowId: 1, active: true }],
      sendMessage: async (tabId: number, msg: Sent["msg"], opts?: Sent["opts"]) => {
        sent.push({ tabId, msg, opts });
        if (msg.op === "ping") return { pong: true };
        if (msg.op === "page_snapshot") return { nodes: [{ ref: "e1" }] };
        // Echo the bare ref the frame was handed, like the content script does.
        return { clicked: msg.args?.ref, scrollY: 0 };
      },
    },
    scripting: {
      insertCSS: async () => [],
      executeScript: async (opts: { func?: unknown }) =>
        opts.func ? frames.map((frameId) => ({ frameId, result: `http://f/${frameId}` })) : [],
    },
  };
}

const tab = { id: 1 } as chrome.tabs.Tab;

describe("ContentScriptBackend frame targeting", () => {
  test("a non-read op targets the top frame explicitly, never a broadcast", async () => {
    const sent: Sent[] = [];
    stubChrome(sent, [7, 8]); // page has two sub-frames
    await new ContentScriptBackend().run("page_screenshot", {}, tab);

    const op = sent.find((s) => s.msg.op === "page_screenshot");
    expect(op).toBeDefined();
    expect(op!.opts?.frameId).toBe(0);
    // No message at all may go out without a frameId — that is the broadcast.
    expect(sent.every((s) => typeof s.opts?.frameId === "number")).toBe(true);
  });

  test("page_screenshot refuses a background target instead of photographing the wrong tab", async () => {
    const sent: Sent[] = [];
    stubChrome(sent, []);
    // The visible tab is 2, the resolved target is 1: captureVisibleTab would
    // silently return tab 2's pixels for a call aimed at tab 1 (ADR-0028
    // Phase 1a made non-visible targets routine via tabId).
    const stub = (globalThis as { chrome?: { tabs?: { query?: unknown } } }).chrome!;
    stub.tabs!.query = async () => [{ id: 2, windowId: 1, active: true }];
    const backgroundTarget = { id: 1, windowId: 1 } as chrome.tabs.Tab;
    let code = "(did not throw)";
    try {
      await new ContentScriptBackend().run("page_screenshot", {}, backgroundTarget);
    } catch (e) {
      code = (e as { code?: string }).code ?? "(no code)";
    }
    expect(code).toBe("UNSUPPORTED_PAGE");
    // Nothing went out to the page — the refusal happens before any send.
    expect(sent).toEqual([]);
  });

  test("page_scroll and page_eval are top-frame scoped too", async () => {
    for (const op of ["page_scroll", "page_eval"]) {
      const sent: Sent[] = [];
      stubChrome(sent, [7]);
      await new ContentScriptBackend().run(op, {}, tab);
      expect(sent.find((s) => s.msg.op === op)!.opts?.frameId).toBe(0);
    }
  });

  test("a read op still fans out to every frame, top pinned to 0", async () => {
    const sent: Sent[] = [];
    stubChrome(sent, [7, 8]);
    await new ContentScriptBackend().run("page_snapshot", {}, tab);

    const targets = sent.filter((s) => s.msg.op === "page_snapshot").map((s) => s.opts?.frameId);
    expect(targets).toEqual([0, 7, 8]);
  });

  test("a bare-ref click stays on the top frame", async () => {
    const sent: Sent[] = [];
    stubChrome(sent, [7]);
    await new ContentScriptBackend().run("page_click", { ref: "e2" }, tab);
    expect(sent.find((s) => s.msg.op === "page_click")!.opts?.frameId).toBe(0);
  });

  test("a frame-qualified click routes to its frame and echoes the qualified ref", async () => {
    const sent: Sent[] = [];
    stubChrome(sent, [7]);
    const res = await new ContentScriptBackend().run("page_click", { ref: "f7:e2" }, tab);

    const click = sent.find((s) => s.msg.op === "page_click")!;
    expect(click.opts?.frameId).toBe(7);
    expect(click.msg.args?.ref).toBe("e2"); // the frame gets the bare ref
    expect(res).toEqual({ clicked: "f7:e2", scrollY: 0 }); // the caller gets theirs back
  });
});
