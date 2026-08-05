import { describe, it, expect } from "vitest";
import { mediaName, mediaId } from "./media-name";

/**
 * These guard the exact expressions that crashed the Assets panel: the search
 * filter and the per-section sort. If either can throw again, the whole asset
 * browser disappears behind "failed to load" on every reload.
 */
describe("media-name", () => {
  const broken = [
    { id: "a", name: "Beach.mp4" },
    { id: "b" },                              // no name at all
    { id: "c", name: null },
    { id: "d", name: "" },
    { name: "no id" },                        // no id either
    {},
  ] as Array<{ id?: unknown; name?: unknown }>;

  it("never returns a non-string name", () => {
    for (const item of broken) expect(typeof mediaName(item)).toBe("string");
    expect(mediaName(null)).toBe("Untitled");
    expect(mediaName(undefined)).toBe("Untitled");
  });

  it("keeps a real name untouched", () => {
    expect(mediaName({ name: "Beach.mp4" })).toBe("Beach.mp4");
    expect(mediaId({ id: "clip-1" })).toBe("clip-1");
  });

  it("survives the search filter that used to throw", () => {
    const matched = broken.filter((i) =>
      mediaName(i).toLowerCase().includes("beach"),
    );
    expect(matched).toHaveLength(1);
  });

  it("survives the section sort that used to throw", () => {
    const sorted = [...broken].sort((a, b) =>
      mediaName(a).localeCompare(mediaName(b)),
    );
    expect(sorted).toHaveLength(broken.length);
    expect(mediaName(sorted[0])).toBe("Beach.mp4");
  });

  it("gives an empty id rather than undefined, so key fallbacks work", () => {
    expect(mediaId({})).toBe("");
    expect(mediaId(null)).toBe("");
  });
});
