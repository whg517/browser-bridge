// Canvas-rendered text is unreadable by every text-based tool, correctly — there
// are no text nodes. The hint exists so an agent stops rather than following the
// usual "wait and re-snapshot, then try precise" advice, which cannot help and
// costs two more calls before it concludes the page is empty.
//
// The size floor is the part worth pinning: an icon or a sparkline must never
// trigger it, or the hint appears on ordinary pages and gets ignored.

import { beforeEach, describe, expect, test } from "bun:test";
import { canvasContentNote } from "./util";

type FakeCanvas = { width: number; height: number };

function withCanvases(sizes: FakeCanvas[]) {
  (globalThis as Record<string, unknown>).document = {
    querySelectorAll: (sel: string) => (sel === "canvas" ? sizes : []),
  };
}

describe("canvasContentNote", () => {
  beforeEach(() => withCanvases([]));

  test("silent when the page has no canvas", () => {
    expect(canvasContentNote()).toBeNull();
  });

  test("silent for decoration — icons, sparklines, small charts", () => {
    withCanvases([
      { width: 16, height: 16 },
      { width: 300, height: 150 }, // the default <canvas> size
      { width: 640, height: 300 }, // a chart widget
    ]);
    expect(canvasContentNote()).toBeNull();
  });

  test("fires for a canvas large enough to BE the content", () => {
    // The size that prompted this: an online résumé rendered as one image.
    withCanvases([{ width: 1460, height: 2112 }]);
    const note = canvasContentNote();
    expect(note).toContain("1460x2112");
    // It must name the one tool that works; the whole failure was agents
    // following advice that could not.
    expect(note).toContain("page_screenshot");
  });

  test("finds a large canvas among decorative ones", () => {
    withCanvases([
      { width: 16, height: 16 },
      { width: 1460, height: 2112 },
    ]);
    expect(canvasContentNote()).toContain("1460x2112");
  });

  test("the floor sits between a chart and a full page", () => {
    expect(canvasContentNote()).toBeNull();
    withCanvases([{ width: 500, height: 499 }]); // 249_500 — just under
    expect(canvasContentNote()).toBeNull();
    withCanvases([{ width: 500, height: 500 }]); // 250_000 — at the floor
    expect(canvasContentNote()).not.toBeNull();
  });
});
