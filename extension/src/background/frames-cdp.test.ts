import { describe, it, expect } from "bun:test";

import { flattenFrameTree, type CdpFrameTree } from "./frames";

describe("flattenFrameTree", () => {
  it("returns the top frame first, then descendants depth-first", () => {
    // Shape of Page.getFrameTree: nested {frame, childFrames}. Order matters —
    // the caller omits `frameId` for the first entry (the top document), which
    // is the long-standing call shape for a single-frame page.
    const tree: CdpFrameTree = {
      frame: { id: "TOP", url: "https://site/" },
      childFrames: [
        {
          frame: { id: "A", url: "https://site/a" },
          childFrames: [{ frame: { id: "A1", url: "https://site/a1" } }],
        },
        { frame: { id: "B", url: "https://site/b" } },
      ],
    };
    expect(flattenFrameTree(tree).map((f) => f.id)).toEqual(["TOP", "A", "A1", "B"]);
  });

  it("handles a single-frame page", () => {
    expect(flattenFrameTree({ frame: { id: "TOP", url: "https://site/" } })).toEqual([
      { id: "TOP", url: "https://site/" },
    ]);
  });

  // Page.getFrameTree can be unavailable (older targets, restricted pages); the
  // caller falls back to a top-frame-only read, so an empty walk must not throw.
  it("returns nothing for a missing tree", () => {
    expect(flattenFrameTree(undefined)).toEqual([]);
    expect(flattenFrameTree({} as CdpFrameTree)).toEqual([]);
  });
});
