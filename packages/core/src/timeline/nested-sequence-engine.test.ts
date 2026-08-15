/**
 * Nested sequences — the container, and what it must not do.
 *
 * A compound clip is a timeline in its own right, stored ONCE on the project.
 * The timeline holds INSTANCES of it — ordinary clips carrying
 * `metadata.compoundClipId` — which is the decision the whole feature rests on:
 * an instance moves, trims, splits and selects with every tool the timeline
 * already has, and nesting is the same thing one level down.
 *
 * Because the content lives in one place, editing inside a sequence changes
 * every instance of it. That is the behaviour people expect from Premiere and
 * the reason to build it this way rather than copying content per instance.
 */
import { describe, expect, it, beforeEach } from "vitest";

import { NestedSequenceEngine } from "./nested-sequence-engine";
import type { Clip, Track } from "../types/timeline";

const transform = () => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
});

function clip(id: string, startTime: number, duration = 5, trackId = "t1"): Clip {
  return {
    id, mediaId: `m-${id}`, trackId, startTime, duration,
    inPoint: 0, outPoint: duration,
    effects: [], audioEffects: [], transform: transform(),
    volume: 1, keyframes: [],
  };
}

function track(id: string, clips: Clip[]): Track {
  return {
    id, type: "video", name: id, clips, transitions: [],
    locked: false, hidden: false, muted: false, solo: false,
  };
}

describe("NestedSequenceEngine", () => {
  let e: NestedSequenceEngine;
  beforeEach(() => { e = new NestedSequenceEngine(); });

  it("normalises the selection to start at zero", () => {
    // A sequence made from clips at 10s and 15s is a five-second sequence that
    // starts at 0 — not one with ten seconds of nothing at the front. Its
    // position on the parent timeline is the INSTANCE's business.
    const a = clip("a", 10), b = clip("b", 15);
    const c = e.createCompoundClip([a, b], [track("t1", [a, b])]);
    expect(c.content.clips.map((x) => x.startTime)).toEqual([0, 5]);
    expect(c.content.duration).toBe(10);
  });

  it("takes ONLY the selected clips, not everything on their track", () => {
    // The bug upstream fixed and this fork had: `relevantTracks` kept whole
    // tracks, so making a sequence from two clips on a ten-clip track swallowed
    // all ten — and the user's timeline lost eight clips into a container they
    // never asked to include.
    const a = clip("a", 0), b = clip("b", 5), other = clip("other", 10);
    const c = e.createCompoundClip([a, b], [track("t1", [a, b, other])]);
    const ids = c.content.tracks.flatMap((t) => t.clips.map((x) => x.id));
    expect(ids).toEqual(["a", "b"]);
    expect(ids).not.toContain("other");
  });

  it("drops a transition whose other end was left behind", () => {
    // A transition needs both clips. Carrying one whose partner stayed outside
    // the sequence poisons the renderer's transition map — the symptom is the
    // whole preview going black, far from the cause.
    const a = clip("a", 0), b = clip("b", 5), outside = clip("outside", 10);
    const t: Track = {
      ...track("t1", [a, b, outside]),
      transitions: [
        { id: "keep", clipAId: "a", clipBId: "b", type: "fade" as any, duration: 1, params: {} },
        { id: "drop", clipAId: "b", clipBId: "outside", type: "fade" as any, duration: 1, params: {} },
      ],
    };
    const c = e.createCompoundClip([a, b], [t]);
    const kept = c.content.tracks.flatMap((x) => x.transitions.map((tr) => tr.id));
    expect(kept).toEqual(["keep"]);
  });

  it("refuses to build one from nothing", () => {
    expect(() => e.createCompoundClip([], [])).toThrow();
  });

  it("shares content between instances — this is why an edit propagates", () => {
    // THE POINT OF THE FEATURE. Two instances are two references to one
    // sequence, so changing the sequence changes both. Copying content per
    // instance would make "edit the sequence" mean "edit this one copy".
    const a = clip("a", 0);
    const c = e.createCompoundClip([a], [track("t1", [a])]);
    const i1 = e.createInstance(c.id, "video", 0)!;
    const i2 = e.createInstance(c.id, "video", 30)!;

    e.updateCompoundClip(c.id, {
      clips: [clip("a", 0, 9)],
      tracks: [track("t1", [clip("a", 0, 9)])],
      duration: 9,
    });

    for (const inst of [i1, i2]) {
      expect(e.getCompoundClipForInstance(inst.id)!.content.duration).toBe(9);
    }
  });

  it("counts instances, and refuses to delete a sequence still in use", () => {
    // Deleting content that is on the timeline would leave instances pointing
    // at nothing — clips that render as holes with no way to find out why.
    const a = clip("a", 0);
    const c = e.createCompoundClip([a], [track("t1", [a])]);
    const inst = e.createInstance(c.id, "video", 0)!;

    expect(e.getInstanceCount(c.id)).toBe(1);
    expect(e.deleteCompoundClip(c.id)).toBe(false);

    e.deleteInstance(inst.id);
    expect(e.getInstanceCount(c.id)).toBe(0);
    expect(e.deleteCompoundClip(c.id)).toBe(true);
  });

  it("restores from saved state, so a sequence survives a reload", () => {
    // Without `loadState` the engine is in-memory only: every compound and
    // every instance vanishes when the tab closes, and the timeline reopens
    // full of clips referencing sequences that no longer exist.
    const a = clip("a", 0);
    const c = e.createCompoundClip([a], [track("t1", [a])]);
    const inst = e.createInstance(c.id, "video", 4)!;

    const fresh = new NestedSequenceEngine();
    fresh.loadState([c], [inst]);

    expect(fresh.getCompoundClip(c.id)!.name).toBe(c.name);
    expect(fresh.getInstancesForCompound(c.id).map((i) => i.id)).toEqual([inst.id]);
    expect(fresh.getInstanceCount(c.id)).toBe(1);
  });

  it("flattens an instance back to real clips at the right place", () => {
    // The way out. A sequence dropped at 20s flattens to its clips at 20s and
    // onward — offsets preserved, so the cut sounds and looks identical.
    const a = clip("a", 0), b = clip("b", 5);
    const c = e.createCompoundClip([a, b], [track("t1", [a, b])]);
    const inst = e.createInstance(c.id, "video", 20)!;

    const flat = e.flattenInstance(inst.id)!;
    expect(flat.startTime).toBe(20);
    expect(flat.clips.map((x) => x.startTime)).toEqual([20, 25]);
    // The instance is gone — it has become its contents.
    expect(e.getInstance(inst.id)).toBeUndefined();
  });

  it("duplicates a sequence as an independent one", () => {
    // A copy you can diverge. Sharing content here would make "duplicate"
    // indistinguishable from "use twice", which is what an instance already is.
    const a = clip("a", 0);
    const c = e.createCompoundClip([a], [track("t1", [a])]);
    const copy = e.duplicateCompoundClip(c.id)!;

    expect(copy.id).not.toBe(c.id);
    expect(e.getInstanceCount(copy.id)).toBe(0);
    e.updateCompoundClip(copy.id, { clips: [], tracks: [], duration: 99 });
    expect(e.getCompoundClip(c.id)!.content.duration).toBe(5);
  });
});

/**
 * A SEQUENCE IS A TIMELINE IN A BOX — it must hold what a timeline holds.
 *
 * Video, audio and image clips ride on `tracks` and always did. Text, shapes,
 * SVG and stickers DO NOT: in this codebase a text track's `clips` array is
 * empty and the content lives on `Project.textClips`, keyed by track. So a
 * compound had nowhere to put them and the renderer had to blank them — a
 * sequence containing a title card rendered without the title.
 *
 * `CompoundClipContent` now mirrors `Project`'s overlay fields one for one,
 * which is the point: the inside of a sequence and the top-level timeline are
 * the same kind of object.
 */
describe("NestedSequenceEngine · a sequence holds a whole timeline", () => {
  const overlay = (id: string, trackId: string, startTime: number) =>
    ({ id, trackId, startTime, duration: 3, text: id }) as any;

  it("carries text, shapes, SVG and stickers into the sequence", () => {
    const e = new NestedSequenceEngine();
    const a = clip("a", 0), b = clip("b", 5);
    const c = e.createCompoundClip(
      [a, b],
      [track("t1", [a, b])],
      {},
      {
        textClips: [overlay("title", "t1", 0)],
        shapeClips: [overlay("box", "t1", 1)],
        svgClips: [overlay("logo", "t1", 2)],
        stickerClips: [overlay("star", "t1", 3)],
      },
    );
    expect(c.content.textClips?.map((t: any) => t.id)).toEqual(["title"]);
    expect(c.content.shapeClips?.map((t: any) => t.id)).toEqual(["box"]);
    expect(c.content.svgClips?.map((t: any) => t.id)).toEqual(["logo"]);
    expect(c.content.stickerClips?.map((t: any) => t.id)).toEqual(["star"]);
  });

  it("puts overlays on the sequence's OWN clock", () => {
    // A title two seconds into the selection is two seconds into the sequence,
    // not wherever it sat on the parent timeline. Otherwise opening a sequence
    // shows its titles somewhere else entirely.
    const e = new NestedSequenceEngine();
    const a = clip("a", 30), b = clip("b", 35);
    const c = e.createCompoundClip(
      [a, b], [track("t1", [a, b])], {},
      { textClips: [overlay("title", "t1", 32)] },
    );
    expect(c.content.textClips![0]!.startTime).toBe(2);
  });

  it("leaves an overlay on a track that stayed outside", () => {
    // Track membership is the only thing that says in or out, because an
    // overlay is timed like a clip but stored on the project.
    const e = new NestedSequenceEngine();
    const a = clip("a", 0), b = clip("b", 5);
    const c = e.createCompoundClip(
      [a, b], [track("t1", [a, b])], {},
      { textClips: [overlay("caption", "track-captions", 0)] },
    );
    expect(c.content.textClips).toBeUndefined();
  });

  it("omits the overlay fields entirely when there are none", () => {
    // Upstream's `{clips, tracks, duration}` stays a valid value of this type,
    // so a compound built before these fields existed behaves identically and
    // the eventual merge does not conflict.
    const e = new NestedSequenceEngine();
    const a = clip("a", 0), b = clip("b", 5);
    const c = e.createCompoundClip([a, b], [track("t1", [a, b])]);
    expect(c.content.textClips).toBeUndefined();
    expect(c.content.shapeClips).toBeUndefined();
  });

  it("keeps audio and image tracks, not just video", () => {
    // "Anything inside" means anything: a sequence is not a video-only bundle.
    const e = new NestedSequenceEngine();
    const v = clip("v", 0), n = { ...clip("n", 0), trackId: "audio1" };
    const c = e.createCompoundClip(
      [v, n],
      [track("t1", [v]), { ...track("audio1", [n]), type: "audio" as const }],
    );
    const types = c.content.tracks.map((t) => t.type).sort();
    expect(types).toEqual(["audio", "video"]);
  });
});
