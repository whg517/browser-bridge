import { describe, it, expect } from "bun:test";
import { parseFrameRef, mergeSnapshot, mergeText, mergeLinks, type FrameResult } from "./frames";

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
