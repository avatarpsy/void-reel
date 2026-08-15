/**
 * Nested sequences have to make a sound.
 *
 * The picture of a compound is handled by recursion — its tracks go through a
 * whole `renderFrame`. Audio has no equivalent: a compound instance is one clip
 * whose `mediaId` names a sequence rather than a file, so the mixer finds no
 * media and contributes silence. A nested sequence would play with a picture
 * and nothing to hear, which reads as broken export rather than a missing
 * feature. Upstream has this gap too.
 */
import { describe, expect, it } from "vitest";

import { flattenCompoundAudio } from "./flatten-compounds";
import type { Clip, Project, Track } from "../types";

const transform = () => ({
  position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0,
  anchor: { x: 0.5, y: 0.5 }, opacity: 1,
});

function clip(over: Partial<Clip> & { id: string }): Clip {
  return {
    mediaId: `m-${over.id}`, trackId: "t1", startTime: 0, duration: 5,
    inPoint: 0, outPoint: 5, effects: [], audioEffects: [],
    transform: transform(), volume: 1, keyframes: [], ...over,
  } as Clip;
}

function track(id: string, clips: Clip[], type: Track["type"] = "video"): Track {
  return {
    id, type, name: id, clips, transitions: [],
    locked: false, hidden: false, muted: false, solo: false,
  };
}

function project(tracks: Track[], compoundClips: any[] = []): Project {
  return {
    id: "p", name: "p", createdAt: 0, modifiedAt: 0, settings: {} as any,
    mediaLibrary: { items: [] },
    timeline: { tracks, subtitles: [], duration: 0, markers: [] },
    compoundClips,
  } as Project;
}

/** A sequence holding two 5s clips back to back. */
const SEQ = {
  id: "seq1",
  name: "Sequence 1",
  createdAt: 0, modifiedAt: 0, color: "#000",
  content: {
    clips: [clip({ id: "in1" }), clip({ id: "in2", startTime: 5 })],
    tracks: [track("t1", [clip({ id: "in1" }), clip({ id: "in2", startTime: 5 })])],
    duration: 10,
  },
};

const instance = (over: Partial<Clip> = {}) => clip({
  id: "inst", mediaId: "compound:seq1", duration: 10, outPoint: 10, ...over,
});

describe("flattenCompoundAudio", () => {
  it("returns the timeline untouched when nothing is nested", () => {
    // The ordinary project must pay nothing for a feature it is not using.
    const p = project([track("v", [clip({ id: "a" })])]);
    expect(flattenCompoundAudio(p)).toBe(p.timeline);
  });

  it("replaces an instance with the clips inside it", () => {
    const p = project([track("v", [instance()])], [SEQ]);
    const ids = flattenCompoundAudio(p).tracks[0]!.clips.map((c) => c.id);
    expect(ids).toEqual(["inst::in1", "inst::in2"]);
  });

  it("offsets inner audio to where the instance sits", () => {
    // An inner clip at 5s inside a sequence placed at 30s plays at 35s. Get
    // this wrong and the dialogue lands in the wrong scene.
    const p = project([track("v", [instance({ startTime: 30 })])], [SEQ]);
    const starts = flattenCompoundAudio(p).tracks[0]!.clips.map((c) => c.startTime);
    expect(starts).toEqual([30, 35]);
  });

  it("honours a trimmed instance — only the audio inside the window", () => {
    // Trimmed to 6s..10s of a 10s sequence: the first inner clip (0..5) is
    // mostly outside and survives only its last second; the second (5..10)
    // survives whole. Without this, trimming a sequence would shorten the
    // picture and leave the sound running.
    const p = project(
      [track("v", [instance({ inPoint: 6, outPoint: 10, duration: 4 })])],
      [SEQ],
    );
    const clips = flattenCompoundAudio(p).tracks[0]!.clips;
    expect(clips.map((c) => [c.startTime, c.duration])).toEqual([[0, 4]]);
  });

  it("multiplies the instance's volume over its contents, like a group fader", () => {
    const seq = { ...SEQ, content: { ...SEQ.content,
      tracks: [track("t1", [clip({ id: "in1", volume: 0.5 })])] } };
    const p = project([track("v", [instance({ volume: 0.5 })])], [seq]);
    expect(flattenCompoundAudio(p).tracks[0]!.clips[0]!.volume).toBeCloseTo(0.25);
  });

  it("flattens a sequence inside a sequence", () => {
    // Nesting is the point. Depth is unbounded in principle; only cycles are not.
    const inner = { ...SEQ, id: "inner" };
    const outer = {
      ...SEQ, id: "outer",
      content: {
        clips: [], duration: 10,
        tracks: [track("t1", [clip({ id: "nest", mediaId: "compound:inner", duration: 10, outPoint: 10 })])],
      },
    };
    const p = project(
      [track("v", [clip({ id: "inst", mediaId: "compound:outer", duration: 10, outPoint: 10 })])],
      [inner, outer],
    );
    const ids = flattenCompoundAudio(p).tracks[0]!.clips.map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toContain("in1");
  });

  it("does not hang on a sequence that contains itself", () => {
    // Reachable by dragging a sequence into itself. The guard is per-branch, so
    // a legitimate repeat elsewhere is unaffected.
    const selfRef = {
      ...SEQ, id: "loop",
      content: {
        clips: [], duration: 10,
        tracks: [track("t1", [clip({ id: "me", mediaId: "compound:loop", duration: 10, outPoint: 10 })])],
      },
    };
    const p = project(
      [track("v", [clip({ id: "inst", mediaId: "compound:loop", duration: 10, outPoint: 10 })])],
      [selfRef],
    );
    expect(() => flattenCompoundAudio(p)).not.toThrow();
    expect(flattenCompoundAudio(p).tracks[0]!.clips).toEqual([]);
  });

  it("drops an instance whose sequence no longer exists", () => {
    // It renders as nothing; it must sound like nothing too, rather than
    // throwing on a dangling id.
    const p = project([track("v", [instance()])], []);
    expect(flattenCompoundAudio(p)).toBe(p.timeline);
  });

  it("leaves ordinary clips on the same track alone", () => {
    const p = project([track("v", [clip({ id: "plain" }), instance({ startTime: 10 })])], [SEQ]);
    const ids = flattenCompoundAudio(p).tracks[0]!.clips.map((c) => c.id);
    expect(ids[0]).toBe("plain");
    expect(ids).toHaveLength(3);
  });
});
