// Pure helpers for allFrames page reading — no chrome APIs, so they're
// unit-testable. The orchestration (enumerate / inject / dispatch) lives in
// ContentScriptBackend; this module only parses frame-qualified refs and merges
// per-frame results.
//
// Ref namespacing: the content script stays frame-agnostic (each frame mints
// bare `eN` refs in its own document). The SW prefixes a sub-frame's refs with
// `f<frameId>:` when merging a snapshot, and strips it again to route a
// click/fill back to that frame — so bare `eN` never collides across frames.

export type FrameResult = { frameId: number; url: string; data: SnapshotLike };

// Loose shapes for the three read ops' payloads (only the fields we merge).
interface SnapshotLike {
  nodes?: Array<Record<string, unknown> & { ref?: string }>;
  text?: string;
  mode?: string;
  links?: Array<Record<string, unknown>>;
  url?: string;
  title?: string;
}

// The tab's top document. Every page op must name a frame explicitly —
// chrome.tabs.sendMessage without a frameId broadcasts to all frames.
export const TOP_FRAME = 0;

// Parse a frame-qualified ref like "f2:e3" → { frameId: 2, bareRef: "e3" }.
// Returns null for a bare ref (e3), a precise ref (p3), or undefined.
export function parseFrameRef(
  ref: string | undefined
): { frameId: number; bareRef: string } | null {
  if (!ref) return null;
  const m = /^f(\d+):(.+)$/.exec(ref);
  return m ? { frameId: Number(m[1]), bareRef: m[2] } : null;
}

// Restore the frame prefix on a sub-frame click/fill echo. The content script
// is frame-agnostic and reports the bare ref it was given, so `{clicked:"e2"}`
// coming out of frame 7 would otherwise name the *top* frame's e2.
export function qualifyRefEcho(resp: unknown, frameId: number, bareRef: string): unknown {
  if (!resp || typeof resp !== "object") return resp;
  const out = { ...(resp as Record<string, unknown>) };
  for (const k of ["clicked", "filled"]) {
    if (out[k] === bareRef) out[k] = `f${frameId}:${bareRef}`;
  }
  return out;
}

// Merge a page_snapshot across frames: keep the top frame's refs bare (back-
// compat) and prefix each sub-frame node's ref with `f<frameId>:`, tagging it
// with the source frame url.
export function mergeSnapshot(top: SnapshotLike, subs: FrameResult[]): SnapshotLike {
  const nodes = [...(top.nodes || [])];
  for (const s of subs) {
    for (const n of s.data.nodes || []) {
      nodes.push({ ...n, ref: `f${s.frameId}:${n.ref}`, frame: s.url });
    }
  }
  return { refCount: nodes.length, nodes, url: top.url, title: top.title } as SnapshotLike & {
    refCount: number;
  };
}

// Merge page_text: top frame first, each sub-frame appended under a marker.
export function mergeText(top: SnapshotLike, subs: FrameResult[]): SnapshotLike {
  let text = top.text || "";
  for (const s of subs) {
    const t = (s.data.text || "").trim();
    if (t) text += `\n\n--- frame f${s.frameId} (${s.url}) ---\n${t}`;
  }
  return { text, url: top.url, mode: top.mode };
}

// Merge page_links: concatenate, tag sub-frame links with their frame url, cap
// at 500 total (matches the per-frame cap).
export function mergeLinks(top: SnapshotLike, subs: FrameResult[]): SnapshotLike {
  const links = [...(top.links || [])];
  for (const s of subs) {
    for (const l of s.data.links || []) links.push({ ...l, frame: s.url });
  }
  const capped = links.slice(0, 500);
  return { links: capped, count: capped.length, url: top.url } as SnapshotLike & { count: number };
}
