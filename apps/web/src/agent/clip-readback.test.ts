import { describe, it, expect } from "vitest";
import type { Clip } from "@openreel/core";
import {
  readClipLooks,
  readTrackTransitions,
  summariseProjectLooks,
  type ReadbackSources,
} from "./clip-readback";

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: "c1",
    mediaId: "m1",
    trackId: "t1",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
    ...over,
  } as Clip;
}

describe("readClipLooks", () => {
  /**
   * The single most important property. This rides on `get-state`, which runs
   * on every clip of every turn — if an untouched clip costs anything, a
   * hundred-scene timeline pays for it a hundred times for no information.
   */
  it("reports NOTHING for an untouched clip", () => {
    expect(readClipLooks(clip())).toEqual({});
  });

  it("reports effect ids, because removing an effect needs one", () => {
    const src: ReadbackSources = {
      getVideoEffects: () => [
        { id: "fx-1", type: "blur", enabled: true },
        { id: "fx-2", type: "chromaKey", enabled: false },
      ],
    };
    expect(readClipLooks(clip(), src).effects).toEqual([
      { id: "fx-1", type: "blur", enabled: true },
      { id: "fx-2", type: "chromaKey", enabled: false },
    ]);
  });

  it("treats an effect with no enabled flag as on", () => {
    const src: ReadbackSources = {
      getVideoEffects: () => [{ id: "fx-1", type: "blur" } as never],
    };
    expect(readClipLooks(clip(), src).effects?.[0].enabled).toBe(true);
  });

  it("names which grading tools are engaged, not their values", () => {
    const src: ReadbackSources = {
      getColorGrading: () => ({
        colorWheels: { lift: [0.1, 0, 0] },
        curves: {},
        lut: null,
        hsl: { hue: 3 },
      }),
    };
    // curves is an empty object and lut is null — neither is engaged.
    expect(readClipLooks(clip(), src).grade).toEqual(["colorWheels", "hsl"]);
  });

  it("omits grade entirely when nothing is engaged", () => {
    const src: ReadbackSources = { getColorGrading: () => ({ curves: {}, lut: null }) };
    expect(readClipLooks(clip(), src).grade).toBeUndefined();
  });

  it("reports retiming and skips 1x", () => {
    expect(readClipLooks(clip(), { getClipSpeed: () => 2 }).speed).toBe(2);
    expect(readClipLooks(clip(), { getClipSpeed: () => 1 }).speed).toBeUndefined();
    expect(readClipLooks(clip(), { isReversed: () => true }).reversed).toBe(true);
    expect(readClipLooks(clip(), { isReversed: () => false }).reversed).toBeUndefined();
  });

  /**
   * The Crop section writes a full-frame crop the moment it is opened. Calling
   * that an edit would tell the agent a shot was cropped when it was only
   * looked at.
   */
  it("ignores a full-frame crop and reports a real one", () => {
    const full = clip({
      transform: { ...clip().transform, crop: { x: 0, y: 0, width: 1, height: 1 } } as never,
    });
    expect(readClipLooks(full).crop).toBeUndefined();

    const cropped = clip({
      transform: { ...clip().transform, crop: { x: 0.1, y: 0, width: 0.8, height: 1 } } as never,
    });
    expect(readClipLooks(cropped).crop).toEqual({ x: 0.1, y: 0, width: 0.8, height: 1 });
  });

  it("reports transform only where it has moved off default", () => {
    const moved = clip({
      transform: {
        position: { x: 40, y: 0 }, scale: { x: 1, y: 1 },
        rotation: 0, anchor: { x: 0.5, y: 0.5 }, opacity: 0.5,
      } as never,
    });
    const looks = readClipLooks(moved);
    expect(looks.transform).toEqual({ position: { x: 40, y: 0 }, opacity: 0.5 });
    expect(looks.transform).not.toHaveProperty("scale");
    expect(looks.transform).not.toHaveProperty("rotation");
  });

  it("groups keyframes by property with counts", () => {
    const animated = clip({
      keyframes: [
        { id: "k1", time: 0, property: "opacity", value: 0, easing: "linear" },
        { id: "k2", time: 1, property: "opacity", value: 1, easing: "linear" },
        { id: "k3", time: 0, property: "scale", value: 1, easing: "linear" },
      ] as never,
    });
    expect(readClipLooks(animated).keyframes).toEqual([
      { property: "opacity", count: 2 },
      { property: "scale", count: 1 },
    ]);
  });

  it("reads a nested-sequence id from either spelling", () => {
    expect(readClipLooks(clip({ metadata: { compoundClipId: "seq-a" } } as never)).sequenceId)
      .toBe("seq-a");
    expect(readClipLooks(clip({ mediaId: "compound:seq-b" })).sequenceId).toBe("seq-b");
    expect(readClipLooks(clip()).sequenceId).toBeUndefined();
  });

  it("survives a source that throws — a cold bridge must not break the state read", () => {
    const hostile: ReadbackSources = {
      getVideoEffects: () => { throw new Error("bridge not initialized"); },
      getColorGrading: () => { throw new Error("nope"); },
      getClipSpeed: () => { throw new Error("nope"); },
    };
    const animated = clip({
      keyframes: [{ id: "k", time: 0, property: "opacity", value: 1, easing: "linear" }] as never,
    });
    const looks = readClipLooks(animated, hostile);
    expect(looks.effects).toBeUndefined();
    // Everything that did NOT throw still comes back.
    expect(looks.keyframes).toEqual([{ property: "opacity", count: 1 }]);
  });
});

describe("readTrackTransitions", () => {
  it("is undefined for a track with no transitions, so it costs nothing", () => {
    expect(readTrackTransitions({})).toBeUndefined();
    expect(readTrackTransitions({ transitions: [] })).toBeUndefined();
  });

  it("reports the fields needed to change or remove one", () => {
    expect(readTrackTransitions({
      transitions: [{ id: "tr1", type: "crossfade", duration: 0.5, clipAId: "a", clipBId: "b" }],
    })).toEqual([{ id: "tr1", type: "crossfade", duration: 0.5, clipAId: "a", clipBId: "b" }]);
  });

  it("omits clipBId for an edge transition rather than emitting an empty string", () => {
    const [t] = readTrackTransitions({
      transitions: [{ id: "tr1", type: "dipToBlack", duration: 0.4, clipAId: "a" }],
    })!;
    expect(t).not.toHaveProperty("clipBId");
  });
});

describe("summariseProjectLooks", () => {
  it("returns only the clips that carry work", () => {
    const project = {
      timeline: {
        tracks: [{ id: "t1", clips: [clip({ id: "plain" }), clip({ id: "fast" })] }],
      },
    } as never;
    const src: ReadbackSources = {
      getClipSpeed: (id) => (id === "fast" ? 2 : 1),
    };
    expect(Object.keys(summariseProjectLooks(project, src))).toEqual(["fast"]);
  });
});
