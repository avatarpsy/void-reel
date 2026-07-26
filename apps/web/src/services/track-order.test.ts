import { describe, it, expect } from "vitest";
import { freshTrackInsertIndex } from "./track-order";

/**
 * Track order is z-order: the compositor paints pixel tracks by DESCENDING
 * index, so a lower index sits on top.
 *
 * The bug this guards: the additive merge used to append every newly-derived
 * track to the end of the timeline. An overlay track therefore landed at the
 * BOTTOM of the stack on any project that already had a saved timeline — it
 * composited behind the footage and was never visible. Only a brand-new project
 * looked right, which is the worst possible failure shape: it works when you
 * build it and breaks the next time you open it.
 */
describe("freshTrackInsertIndex", () => {
  const FRESH = ["track-overlay", "track-video", "track-image", "track-music"];

  it("puts an overlay ABOVE the video it must composite over", () => {
    const merged = ["track-video", "track-music"];

    const at = freshTrackInsertIndex(merged, FRESH, "track-overlay");

    expect(at).toBe(0);
    merged.splice(at, 0, "track-overlay");
    expect(merged.indexOf("track-overlay")).toBeLessThan(
      merged.indexOf("track-video"),
    );
  });

  it("puts an image track BELOW the video so a still never covers a clip", () => {
    const merged = ["track-overlay", "track-video", "track-music"];

    const at = freshTrackInsertIndex(merged, FRESH, "track-image");

    merged.splice(at, 0, "track-image");
    expect(merged.indexOf("track-image")).toBeGreaterThan(
      merged.indexOf("track-video"),
    );
    expect(merged.indexOf("track-image")).toBeLessThan(
      merged.indexOf("track-music"),
    );
  });

  it("appends when nothing that follows it exists yet", () => {
    const merged = ["track-overlay"];

    expect(freshTrackInsertIndex(merged, FRESH, "track-music")).toBe(1);
  });

  it("appends a track the fresh order does not know about", () => {
    const merged = ["track-video", "track-music"];

    expect(freshTrackInsertIndex(merged, FRESH, "track-mystery")).toBe(2);
  });

  it("handles an empty timeline", () => {
    expect(freshTrackInsertIndex([], FRESH, "track-overlay")).toBe(0);
  });

  it("positions only against tracks BOTH sides agree on, leaving the user's own arrangement alone", () => {
    // The user reordered their timeline and added a track of their own. The
    // incoming overlay must still land above the video without shuffling
    // anything else around.
    const merged = ["track-my-broll", "track-video", "track-image"];

    const at = freshTrackInsertIndex(merged, FRESH, "track-overlay");

    merged.splice(at, 0, "track-overlay");
    expect(merged).toEqual([
      "track-my-broll",
      "track-overlay",
      "track-video",
      "track-image",
    ]);
  });

  it("keeps relative order when several new tracks arrive at once", () => {
    const merged: string[] = ["track-video"];

    for (const id of ["track-overlay", "track-image", "track-music"]) {
      merged.splice(freshTrackInsertIndex(merged, FRESH, id), 0, id);
    }

    expect(merged).toEqual(FRESH);
  });
});
