import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clip, Track } from "@openreel/core";
import { neighbourOf, maxTransitionDuration } from "./clip-transitions";

function clip(id: string, startTime: number, duration: number): Clip {
  return { id, startTime, duration } as Clip;
}
function track(clips: Clip[]): Track {
  return { id: "t1", clips } as Track;
}

describe("neighbourOf", () => {
  /**
   * The clips array is in insertion order, not play order. Addressing "the
   * next clip" by array position would put a dissolve between two shots that
   * are nowhere near each other on the timeline.
   */
  it("uses PLAY order, not array order", () => {
    const t = track([clip("c", 20, 5), clip("a", 0, 5), clip("b", 10, 5)]);
    expect(neighbourOf(t, "a", "end")).toMatchObject({ a: { id: "a" }, b: { id: "b" } });
    expect(neighbourOf(t, "b", "end")).toMatchObject({ a: { id: "b" }, b: { id: "c" } });
  });

  it("start means the pair ENDING at this clip", () => {
    const t = track([clip("a", 0, 5), clip("b", 5, 5)]);
    expect(neighbourOf(t, "b", "start")).toMatchObject({ a: { id: "a" }, b: { id: "b" } });
  });

  /**
   * "Crossfade everything" reaches the last clip, which has no successor. That
   * has to be a skip, not a failure — the inspector batch is all-or-nothing,
   * so a thrown error there would roll back every dissolve that did work.
   */
  it("returns null at the ends rather than throwing", () => {
    const t = track([clip("a", 0, 5), clip("b", 5, 5)]);
    expect(neighbourOf(t, "b", "end")).toBeNull();
    expect(neighbourOf(t, "a", "start")).toBeNull();
  });

  it("returns null for a clip that is not on the track", () => {
    expect(neighbourOf(track([clip("a", 0, 5)]), "ghost", "end")).toBeNull();
  });

  it("pairs across a small gap, because real timelines have them", () => {
    const t = track([clip("a", 0, 5), clip("b", 5.2, 5)]);
    expect(neighbourOf(t, "a", "end")).toMatchObject({ b: { id: "b" } });
  });
});

describe("maxTransitionDuration", () => {
  /**
   * A transition eats the tail of one shot and the head of the next. Longer
   * than half the shorter clip and the "transition" has consumed the shot.
   */
  it("is half the SHORTER clip", () => {
    expect(maxTransitionDuration(clip("a", 0, 10), clip("b", 10, 4))).toBe(2);
    expect(maxTransitionDuration(clip("a", 0, 3), clip("b", 3, 30))).toBe(1.5);
  });

  it("never returns zero, even for a one-frame clip", () => {
    expect(maxTransitionDuration(clip("a", 0, 0.02), clip("b", 0, 10))).toBe(0.1);
  });
});

/**
 * THE EDIT HAS TO BE COMMITTED, NOT JUST MADE.
 *
 * `ActionExecutor.applyAction` mutates the project IN PLACE. So a successful
 * `transition/add` really does put the transition on the live project — and
 * nothing else in the system finds out:
 *
 *  • the autosave is hash-gated on {id, modifiedAt, trackCount, clipCount,
 *    mediaCount}. A transition changes none of them, so the project is never
 *    written and the transition lives only in memory;
 *  • zustand never notifies, because no reference changed, so the timeline UI
 *    never draws it either.
 *
 * Measured consequence on a real agent run: the tool returned
 * `ok: "crossfade 0.8s between …"`, the agent reported success, and the
 * exported MP4 had a HARD CUT — luminance 33.89 → 19.43 in a single frame
 * where a 0.8s dissolve should ramp over ~24 frames. The loader's live rebuild
 * between the edit and the render dropped the unpersisted transition.
 *
 * Pinned by source because the write needs a live zustand store and an
 * ActionExecutor; what must not regress is that BOTH halves of the commit are
 * there and that both the add and the remove path call it.
 */
describe("clip-transitions commits its write", () => {
  const SRC = readFileSync(join(__dirname, "clip-transitions.ts"), "utf8");

  it("bumps modifiedAt, or the autosave never notices", () => {
    expect(SRC).toMatch(/modifiedAt: Date\.now\(\)/);
  });

  it("re-references tracks AND each transitions array, or React never redraws", () => {
    const commit = /const commit = async \(\) => \{[\s\S]*?\n    \};/.exec(SRC);
    expect(commit, "a commit helper must exist").toBeTruthy();
    expect(commit![0]).toMatch(/tracks:.*map/s);
    expect(commit![0]).toMatch(/transitions: \[\.\.\.\(t\.transitions \?\? \[\]\)\]/);
  });

  it("commits after ADD and after REMOVE — a removal that is not saved comes back", () => {
    const applies = SRC.split("await commit();").length - 1;
    expect(applies, "both the add and the remove path must commit").toBeGreaterThanOrEqual(2);
  });

  it("does not commit when the executor refused", () => {
    // Marking the project dirty for an edit that failed would save nothing and
    // claim something happened.
    expect(SRC).toMatch(/if \(!r\?\.success\) return \{ ok: false[\s\S]{0,120}?\n    await commit\(\);/);
  });
});
