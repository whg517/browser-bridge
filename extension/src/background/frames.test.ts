import { describe, it, expect } from "bun:test";
import {
  TOP_FRAME,
  parseFrameRef,
  qualifyRefEcho,
  mergeSnapshot,
  mergeText,
  mergeLinks,
  type FrameResult,
  isPreciseRef,
  mergeNotes,
} from "./frames";

describe("TOP_FRAME", () => {
  it("is frame 0 — page ops must name it rather than broadcasting", () => {
    expect(TOP_FRAME).toBe(0);
  });
});

describe("qualifyRefEcho", () => {
  it("re-prefixes the bare ref a sub-frame echoed back", () => {
    expect(qualifyRefEcho({ clicked: "e2", role: "button" }, 7, "e2")).toEqual({
      clicked: "f7:e2",
      role: "button",
    });
    expect(qualifyRefEcho({ filled: "e3" }, 12, "e3")).toEqual({ filled: "f12:e3" });
  });
  it("leaves other payloads untouched", () => {
    // A selector-driven reply names the selector, not the ref — don't rewrite it.
    expect(qualifyRefEcho({ clicked: "#go" }, 7, "e2")).toEqual({ clicked: "#go" });
    expect(qualifyRefEcho(null, 7, "e2")).toBeNull();
    expect(qualifyRefEcho("done", 7, "e2")).toBe("done");
  });
});

describe("parseFrameRef", () => {
  it("parses a frame-qualified ref", () => {
    expect(parseFrameRef("f2:e3")).toEqual({ frameId: 2, bareRef: "e3" });
    expect(parseFrameRef("f0:e1")).toEqual({ frameId: 0, bareRef: "e1" });
  });
  it("returns null for a bare ref, precise ref, selector, or undefined", () => {
    expect(parseFrameRef("e3")).toBeNull();
    expect(parseFrameRef("p3")).toBeNull();
    expect(parseFrameRef("#login")).toBeNull();
    expect(parseFrameRef(undefined)).toBeNull();
  });
});

const sub = (frameId: number, url: string, data: unknown): FrameResult =>
  ({ frameId, url, data }) as FrameResult;

describe("mergeSnapshot", () => {
  it("keeps top refs bare and prefixes sub-frame refs with f<N>:", () => {
    const top = { nodes: [{ ref: "e1", role: "button" }], url: "https://a.com/", title: "A" };
    const subs = [sub(2, "https://a.com/child", { nodes: [{ ref: "e1" }, { ref: "e2" }] })];
    const m = mergeSnapshot(top, subs) as {
      refCount: number;
      nodes: Array<Record<string, unknown>>;
    };
    expect(m.refCount).toBe(3);
    expect(m.nodes[0].ref).toBe("e1"); // top unchanged
    expect(m.nodes[1].ref).toBe("f2:e1"); // sub prefixed
    expect(m.nodes[2].ref).toBe("f2:e2");
    expect(m.nodes[1].frame).toBe("https://a.com/child"); // tagged with source
  });
});

describe("mergeText", () => {
  it("appends each sub-frame under a marker; skips empty", () => {
    const top = { text: "top text", url: "https://a.com/", mode: "visible" };
    const subs = [
      sub(2, "https://a.com/c", { text: "child text" }),
      sub(3, "https://a.com/e", { text: "   " }), // empty → skipped
    ];
    const m = mergeText(top, subs) as { text: string; mode: string };
    expect(m.text).toContain("top text");
    expect(m.text).toContain("--- frame f2 (https://a.com/c) ---");
    expect(m.text).toContain("child text");
    expect(m.text).not.toContain("frame f3");
    expect(m.mode).toBe("visible");
  });
});

describe("mergeLinks", () => {
  it("concatenates, tags sub-frame links, and caps at 500", () => {
    const top = { links: [{ href: "https://a.com/x", type: "internal" }], url: "https://a.com/" };
    const many = Array.from({ length: 600 }, (_, i) => ({
      href: "https://a.com/" + i,
      type: "internal",
    }));
    const subs = [sub(2, "https://a.com/c", { links: many })];
    const m = mergeLinks(top, subs) as { links: Array<Record<string, unknown>>; count: number };
    expect(m.count).toBe(500);
    expect(m.links.length).toBe(500);
    expect(m.links[0].href).toBe("https://a.com/x"); // top first
    expect(m.links[1].frame).toBe("https://a.com/c"); // sub tagged
  });
});

describe("isPreciseRef", () => {
  it("matches precise refs only", () => {
    expect(isPreciseRef("p1")).toBe(true);
    expect(isPreciseRef("p42")).toBe(true);
    // content-script refs, frame-qualified refs and junk must NOT be treated as
    // precise — they have their own routing.
    expect(isPreciseRef("e1")).toBe(false);
    expect(isPreciseRef("f7:p1")).toBe(false);
    expect(isPreciseRef("p")).toBe(false);
    expect(isPreciseRef("pa1")).toBe(false);
    expect(isPreciseRef(undefined)).toBe(false);
  });
});

describe("note propagation across frames", () => {
  const sub = (frameId, data) => ({ frameId, url: `https://a.com/f${frameId}`, data });

  // The regression this exists for: a canvas-rendered résumé lived in an iframe,
  // so the frame contributed NO text and was dropped from the merge entirely,
  // taking its note with it. Same canvas at top level produced the note fine.
  it("keeps a sub-frame's note even when that frame has no text", () => {
    const m = mergeText({ text: "top" }, [sub(7, { text: "", note: "drawn into a <canvas>" })]);
    expect(m.text).toBe("top"); // empty frame still contributes no text
    expect(m.note).toContain("drawn into a <canvas>");
    expect(m.note).toContain("f7"); // and says which frame it came from
  });

  it("keeps the top frame's note once any sub-frame exists", () => {
    // Before, ANY sub-frame meant the merged result was rebuilt without `note`,
    // so even a top-frame canvas advisory was lost.
    const m = mergeText({ text: "top", note: "top note" }, [sub(2, { text: "sub" })]);
    expect(m.note).toBe("top note");
  });

  it("emits an identical note once, and distinct ones separately", () => {
    const m = mergeText({ text: "" }, [
      sub(1, { text: "", note: "same" }),
      sub(2, { text: "", note: "same" }),
      sub(3, { text: "", note: "different" }),
    ]);
    expect(m.note.match(/same/g).length).toBe(1);
    expect(m.note).toContain("different");
  });

  it("omits the field entirely when nothing had a note", () => {
    expect(mergeText({ text: "top" }, [sub(1, { text: "sub" })]).note).toBeUndefined();
    expect(mergeSnapshot({ nodes: [] }, [sub(1, { nodes: [] })]).note).toBeUndefined();
    expect(mergeLinks({ links: [] }, [sub(1, { links: [] })]).note).toBeUndefined();
  });

  // page_snapshot and page_links rebuild their result the same way, so they had
  // the same hole.
  it("propagates through mergeSnapshot and mergeLinks too", () => {
    expect(mergeSnapshot({ nodes: [], note: "n" }, [sub(1, { nodes: [] })]).note).toBe("n");
    expect(mergeLinks({ links: [], note: "n" }, [sub(1, { links: [] })]).note).toBe("n");
  });

  it("mergeNotes returns undefined when there is nothing to say", () => {
    expect(mergeNotes({}, [])).toBeUndefined();
    expect(mergeNotes({ note: "   " }, [])).toBeUndefined();
  });
});
