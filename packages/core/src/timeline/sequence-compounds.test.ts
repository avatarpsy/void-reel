/**
 * Screenplay sequences become nested sequences on the timeline.
 *
 * The board has written `board_sequence` on every scene since the structure
 * work and nothing read it, so this whole integration is a read — the wire
 * format does not move and an existing project gains sequences the next time it
 * loads.
 *
 * The rules below were each chosen rather than inherited, and every one of them
 * is a way a film could be quietly rearranged if it were wrong.
 */
import { describe, expect, it } from "vitest";

import { buildSequenceCompounds } from "./sequence-compounds";
import type { Clip, Track } from "../types/timeline";

const transform = () => ({
  position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0,
  anchor: { x: 0.5, y: 0.5 }, opacity: 1,
});

function clip(id: string, startTime: number, duration = 5, trackId = "track-video"): Clip {
  return {
    id, mediaId: `m-${id}`, trackId, startTime, duration,
    inPoint: 0, outPoint: duration, effects: [], audioEffects: [],
    transform: transform(), volume: 1, keyframes: [],
  };
}

function track(id: string, clips: Clip[], type: Track["type"] = "video"): Track {
  return {
    id, type, name: id, clips, transitions: [],
    locked: false, hidden: false, muted: false, solo: false,
  };
}

const ids = (t: Track) => t.clips.map((c) => c.id);

describe("buildSequenceCompounds", () => {
  it("does nothing when the screenplay has no sequences", () => {
    // Every short, every reel, every music video. They must pay nothing.
    const tracks = [track("track-video", [clip("a", 0), clip("b", 5)])];
    const out = buildSequenceCompounds(tracks, []);
    expect(out.compounds).toEqual([]);
    expect(out.tracks[0]!.clips).toHaveLength(2);
  });

  it("wraps a run of shots into one sequence and leaves an instance behind", () => {
    const tracks = [track("track-video", [clip("a", 0), clip("b", 5), clip("c", 10)])];
    const out = buildSequenceCompounds(
      tracks, [{ name: "The chase", startTime: 0, endTime: 10 }],
    );
    expect(out.compounds).toHaveLength(1);
    expect(out.compounds[0]!.name).toBe("The chase");
    // a and b went inside; c stayed, and the instance replaced them.
    expect(ids(out.tracks[0]!)).toEqual(["inst-seq-0-0", "c"]);
  });

  it("normalises the inside to start at zero", () => {
    // A sequence that runs 30s..40s of the film is a TEN second sequence, not
    // ten seconds preceded by half a minute of nothing.
    const tracks = [track("track-video", [clip("a", 30), clip("b", 35)])];
    const out = buildSequenceCompounds(
      tracks, [{ name: "Act two", startTime: 30, endTime: 40 }],
    );
    expect(out.compounds[0]!.content.clips.map((c) => c.startTime)).toEqual([0, 5]);
    expect(out.compounds[0]!.content.duration).toBe(10);
    // …and the instance sits where the sequence was.
    expect(out.tracks[0]!.clips[0]!.startTime).toBe(30);
  });

  it("takes the narration inside with the picture", () => {
    // THE POINT OF A CONTAINER. Move the sequence and its voiceover moves too;
    // leaving narration outside would desync the moment anything is dragged.
    const tracks = [
      track("track-video", [clip("v1", 0), clip("v2", 5)]),
      track("track-narration", [
        clip("n1", 0, 5, "track-narration"), clip("n2", 5, 5, "track-narration"),
      ], "audio"),
    ];
    const out = buildSequenceCompounds(
      tracks, [{ name: "Opening", startTime: 0, endTime: 10 }],
    );
    const inner = out.compounds[0]!.content.tracks.map((t) => t.id);
    expect(inner).toContain("track-video");
    expect(inner).toContain("track-narration");
  });

  it("leaves MUSIC and CAPTIONS outside — they span the whole film", () => {
    // A score cut at a sequence boundary is a score with a hole in it.
    const tracks = [
      track("track-video", [clip("v1", 0), clip("v2", 5)]),
      track("track-music", [clip("m", 0, 60, "track-music")], "audio"),
      track("track-captions", [clip("c", 0, 60, "track-captions")], "text"),
    ];
    const out = buildSequenceCompounds(
      tracks, [{ name: "Opening", startTime: 0, endTime: 10 }],
    );
    const inner = out.compounds[0]!.content.tracks.map((t) => t.id);
    expect(inner).not.toContain("track-music");
    expect(inner).not.toContain("track-captions");
    expect(ids(out.tracks.find((t) => t.id === "track-music")!)).toEqual(["m"]);
  });

  it("leaves a ONE-shot sequence flat", () => {
    // A container with a single clip in it is a layer to open for nothing.
    const tracks = [track("track-video", [clip("only", 0), clip("after", 5)])];
    const out = buildSequenceCompounds(
      tracks, [{ name: "Lonely", startTime: 0, endTime: 5 }],
    );
    expect(out.compounds).toEqual([]);
    expect(ids(out.tracks[0]!)).toEqual(["only", "after"]);
  });

  it("treats two separated runs of one name as two places in the film", () => {
    // Something was put between them — by the writer or by the editor — and
    // merging them into one sequence would move it.
    const tracks = [track("track-video", [
      clip("a", 0), clip("b", 5), clip("mid", 10), clip("c", 15), clip("d", 20),
    ])];
    const out = buildSequenceCompounds(tracks, [
      { name: "Chase", startTime: 0, endTime: 10 },
      { name: "Chase", startTime: 15, endTime: 25 },
    ]);
    expect(out.compounds).toHaveLength(2);
    expect(out.compounds[0]!.id).not.toBe(out.compounds[1]!.id);
    expect(ids(out.tracks[0]!)).toEqual(["inst-seq-0-0", "mid", "inst-seq-1-15"]);
  });

  it("drops a transition whose other end went inside", () => {
    // It has lost an endpoint; keeping it points the renderer at nothing, and
    // the symptom is the whole preview going black.
    const t: Track = {
      ...track("track-video", [clip("a", 0), clip("b", 5), clip("out", 10)]),
      transitions: [
        { id: "x", clipAId: "b", clipBId: "out", type: "fade" as any, duration: 1, params: {} },
      ],
    };
    const out = buildSequenceCompounds(
      [t], [{ name: "S", startTime: 0, endTime: 10 }],
    );
    expect(out.tracks[0]!.transitions).toEqual([]);
  });

  it("keeps ids deterministic, so a rebuild is not a new sequence", () => {
    // The loader rebuilds on every Firestore tick and the editor merges
    // additively BY ID. A fresh id per rebuild would add a second copy of every
    // sequence, forever.
    const tracks = [track("track-video", [clip("a", 0), clip("b", 5)])];
    const spans = [{ name: "S", startTime: 0, endTime: 10 }];
    const first = buildSequenceCompounds(tracks, spans);
    const again = buildSequenceCompounds(tracks, spans);
    expect(again.compounds[0]!.id).toBe(first.compounds[0]!.id);
    expect(again.tracks[0]!.clips[0]!.id).toBe(first.tracks[0]!.clips[0]!.id);
  });

  it("marks the instance BOTH ways, so either reader recognises it", () => {
    const tracks = [track("track-video", [clip("a", 0), clip("b", 5)])];
    const out = buildSequenceCompounds(
      tracks, [{ name: "S", startTime: 0, endTime: 10 }],
    );
    const inst = out.tracks[0]!.clips[0]!;
    expect(inst.metadata?.compoundClipId).toBe(out.compounds[0]!.id);
    expect(inst.mediaId).toBe(`compound:${out.compounds[0]!.id}`);
  });
});
