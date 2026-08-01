import { describe, expect, it } from "bun:test";

import { ANNOUNCE_ID, announceFrame, buildAnnounce, parseBrowser } from "./announce";
import { PROTOCOL_VERSION } from "./ops";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36";

describe("parseBrowser", () => {
  it("reads Chrome's name and full version", () => {
    expect(parseBrowser(CHROME_UA)).toEqual({ name: "Chrome", version: "141.0.7390.55" });
  });

  // Chromium forks all carry a "Chrome/" token as well, so the fork's own token
  // has to win or every Edge user would be reported as Chrome.
  it("prefers a fork's own token over the Chrome/ one it also carries", () => {
    expect(parseBrowser(`${CHROME_UA} Edg/141.0.3537.57`).name).toBe("Edge");
    expect(parseBrowser(`${CHROME_UA} OPR/120.0.5543.93`).name).toBe("Opera");
  });

  // Diagnostic context must never throw — a weird UA just means "unknown".
  it("falls back to unknown instead of throwing", () => {
    expect(parseBrowser("")).toEqual({ name: "unknown", version: "unknown" });
    expect(parseBrowser("Mozilla/5.0 (X11; Linux x86_64)")).toEqual({
      name: "unknown",
      version: "unknown",
    });
  });
});

describe("buildAnnounce", () => {
  it("carries the manifest version and the contract's protocol version", () => {
    expect(buildAnnounce("0.6.0", CHROME_UA)).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      version: "0.6.0",
      browser: { name: "Chrome", version: "141.0.7390.55" },
    });
  });
});

describe("announceFrame", () => {
  // The envelope is the whole point: an older MCP server parses every inbound
  // line as a BridgeResp, and a frame it cannot deserialize kills its reader
  // loop and drops the connection. id/ok must therefore always be present, and
  // the id must be the reserved 0 (server request ids start at 1).
  it("is a valid BridgeResp on the reserved id", () => {
    const frame = announceFrame(buildAnnounce("0.6.0", CHROME_UA));
    expect(frame.id).toBe(ANNOUNCE_ID);
    expect(ANNOUNCE_ID).toBe(0);
    expect(frame.ok).toBe(true);
    expect(frame.error).toBeUndefined();
    // Nested under `data.announce` so it can never be mistaken for an op result.
    expect((frame.data as { announce: { version: string } }).announce.version).toBe("0.6.0");
  });

  it("survives a JSON round-trip unchanged", () => {
    const frame = announceFrame(buildAnnounce("0.6.0", CHROME_UA));
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });
});
