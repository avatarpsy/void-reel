import { describe, it, expect } from "vitest";
import { speechRangesFrom, duckEnvelope } from "./auto-duck";

const CFG = {
  duckTo: 0.25, attackSec: 0.3, releaseSec: 0.5,
  leadSec: 0.15, tailSec: 0.25, mergeGapSec: 1.2,
};

function project(tracks: any[]) {
  return { timeline: { tracks } } as never;
}

describe("speechRangesFrom", () => {
  it("finds clips on voice-named tracks and ignores everything else", () => {
    const p = project([
      { id: "track-narration", clips: [{ startTime: 2, duration: 3 }] },
      { id: "track-music", clips: [{ startTime: 0, duration: 30 }] },
      { id: "track-video-1", clips: [{ startTime: 0, duration: 30 }] },
    ]);
    expect(speechRangesFrom(p, { mergeGapSec: 1.2 })).toEqual([{ start: 2, end: 5 }]);
  });

  it("matches on track NAME as well as id, because compiled projects name them", () => {
    const p = project([{ id: "t7", name: "Dialogue", clips: [{ startTime: 1, duration: 2 }] }]);
    expect(speechRangesFrom(p, { mergeGapSec: 1.2 })).toHaveLength(1);
  });

  /**
   * A muted voice track is not being heard, so ducking under it would drop the
   * music for a silence the viewer never hears explained.
   */
  it("skips muted tracks and muted clips", () => {
    const p = project([
      { id: "narration-a", muted: true, clips: [{ startTime: 0, duration: 5 }] },
      { id: "narration-b", clips: [{ startTime: 10, duration: 5, muted: true }] },
    ]);
    expect(speechRangesFrom(p, { mergeGapSec: 1.2 })).toEqual([]);
  });

  it("merges passages separated by less than mergeGapSec", () => {
    const p = project([{
      id: "narration",
      clips: [
        { startTime: 0, duration: 2 },   // 0–2
        { startTime: 2.5, duration: 2 }, // 2.5–4.5, gap 0.5 → merge
        { startTime: 10, duration: 2 },  // gap 5.5 → separate
      ],
    }]);
    expect(speechRangesFrom(p, { mergeGapSec: 1.2 })).toEqual([
      { start: 0, end: 4.5 },
      { start: 10, end: 12 },
    ]);
  });

  it("can exclude the clip's own track, so music never ducks against itself", () => {
    const p = project([{ id: "voice-over", clips: [{ startTime: 0, duration: 5 }] }]);
    expect(speechRangesFrom(p, { mergeGapSec: 1.2, excludeTrackId: "voice-over" })).toEqual([]);
  });
});

describe("duckEnvelope", () => {
  const music = { startTime: 0, duration: 30 };

  it("starts at full level and ramps down before the voice", () => {
    const pts = duckEnvelope([{ start: 10, end: 15 }], music, CFG);
    expect(pts[0]).toEqual({ time: 0, value: 1 });
    // lead 0.15 → down starts at 9.85, reaches the floor after attack 0.3
    expect(pts.find((p) => p.time === 9.85)?.value).toBe(1);
    expect(pts.find((p) => p.time === 10.15)?.value).toBe(0.25);
  });

  it("ramps back up after the voice, release later than attack", () => {
    const pts = duckEnvelope([{ start: 10, end: 15 }], music, CFG);
    // tail 0.25 → hold until 15.25, release 0.5 → back to 1 at 15.75
    expect(pts.find((p) => p.time === 15.25)?.value).toBe(0.25);
    expect(pts.find((p) => p.time === 15.75)?.value).toBe(1);
  });

  it("is sorted, which the keyframe engine relies on", () => {
    const pts = duckEnvelope([{ start: 20, end: 22 }, { start: 5, end: 7 }], music, CFG);
    expect(pts.map((p) => p.time)).toEqual([...pts.map((p) => p.time)].sort((a, b) => a - b));
  });

  it("ignores speech that does not overlap this clip", () => {
    const late = { startTime: 100, duration: 10 };
    expect(duckEnvelope([{ start: 10, end: 15 }], late, CFG)).toEqual([]);
  });

  /**
   * Clip-LOCAL times. A music clip starting at 40s with voice at 45s must duck
   * 5s into itself, not 45s in — which would be past its end and silently do
   * nothing.
   */
  it("converts to clip-local time for a clip that does not start at zero", () => {
    const offset = { startTime: 40, duration: 20 };
    const pts = duckEnvelope([{ start: 45, end: 50 }], offset, CFG);
    expect(pts.find((p) => p.value === 0.25)!.time).toBeCloseTo(5.15, 2);
    expect(pts.every((p) => p.time >= 0 && p.time <= 20)).toBe(true);
  });

  it("opens already ducked when the clip starts inside a passage", () => {
    const pts = duckEnvelope([{ start: -5, end: 10 }], music, CFG);
    expect(pts[0]).toEqual({ time: 0, value: 0.25 });
  });

  it("stays ducked to the last frame when speech outlasts the music", () => {
    const pts = duckEnvelope([{ start: 10, end: 60 }], music, CFG);
    const last = pts[pts.length - 1];
    expect(last.time).toBe(30);
    expect(last.value).toBe(0.25);
  });

  it("does not pump between two passages inside one merged range", () => {
    // Already merged upstream; a single range yields exactly one down and one up.
    const pts = duckEnvelope([{ start: 5, end: 20 }], music, CFG);
    const downs = pts.filter((p) => p.value === 0.25);
    expect(downs).toHaveLength(2); // arrive at floor, leave floor
  });

  it("honours a custom depth", () => {
    const pts = duckEnvelope([{ start: 10, end: 15 }], music, { ...CFG, duckTo: 0.4 });
    expect(pts.some((p) => p.value === 0.4)).toBe(true);
    expect(pts.some((p) => p.value === 0.25)).toBe(false);
  });

  it("never emits a negative time or one past the clip end", () => {
    const pts = duckEnvelope(
      [{ start: -2, end: 1 }, { start: 29, end: 40 }],
      music,
      CFG,
    );
    expect(pts.every((p) => p.time >= 0 && p.time <= 30)).toBe(true);
  });
});

/**
 * ── ROLE BEATS NAME ─────────────────────────────────────────────────────────
 * Matching speech by track NAME is how a voice on "Audio 1" became invisible to
 * the ducker: no error, just music that never ducked. `Track.role` (taken from
 * upstream) says what a track IS. The name test stays for every project written
 * before roles existed.
 */
describe("speechRangesFrom uses the track role", () => {
  it("finds a dialogue track whatever it is called", () => {
    const p = project([
      { id: "t1", name: "Audio 1", role: "dialogue", clips: [{ startTime: 2, duration: 3 }] },
    ]);
    expect(speechRangesFrom(p, { mergeGapSec: 1.2 })).toEqual([{ start: 2, end: 5 }]);
  });

  /** A music track NAMED like speech must not be mistaken for it. */
  it("ignores a non-dialogue track even when its name says otherwise", () => {
    const p = project([
      { id: "t2", name: "Dialogue stem", role: "music", clips: [{ startTime: 0, duration: 9 }] },
    ]);
    expect(speechRangesFrom(p, { mergeGapSec: 1.2 })).toEqual([]);
  });

  /** Roleless projects — all of them, before now — keep working on the name. */
  it("falls back to the name when a track has no role", () => {
    const p = project([
      { id: "t3", name: "Narration", clips: [{ startTime: 1, duration: 2 }] },
      { id: "t4", name: "Audio 1", clips: [{ startTime: 4, duration: 2 }] },
    ]);
    expect(speechRangesFrom(p, { mergeGapSec: 0.1 })).toEqual([{ start: 1, end: 3 }]);
  });
});

/**
 * ── THE ONE-CLIP EPISODE ────────────────────────────────────────────────────
 *
 * A generated audio drama arrives as a single voice clip covering the whole
 * episode. Ducking from clip extents then produces a flat gain — the music
 * never dips for a line — and that is what made dialogue hard to hear. These
 * pin the waveform path that fixes it.
 */
import { speechFromSilence, voiceClipsFrom, mergeRanges } from "./auto-duck";

describe("speechFromSilence", () => {
  const clip = { startTime: 2, duration: 10, inPoint: 0 };

  it("inverts silence into speech, in TIMELINE time", () => {
    // Quiet from 3-4s and 6-7s of the media => speech 0-3, 4-6, 7-10.
    expect(
      speechFromSilence([{ start: 3, end: 4 }, { start: 6, end: 7 }], clip),
    ).toEqual([
      { start: 2, end: 5 },
      { start: 6, end: 8 },
      { start: 9, end: 12 },
    ]);
  });

  it("offsets by inPoint, so a trimmed clip still lines up", () => {
    expect(
      speechFromSilence([{ start: 5, end: 6 }], {
        startTime: 100,
        duration: 4,
        inPoint: 4,
      }),
    ).toEqual([
      { start: 100, end: 101 },
      { start: 102, end: 104 },
    ]);
  });

  it("ignores silence outside the part of the media the clip plays", () => {
    // Silence at 20-30s cannot matter to a clip playing 0-10s.
    expect(speechFromSilence([{ start: 20, end: 30 }], clip)).toEqual([
      { start: 2, end: 12 },
    ]);
  });

  it("drops blips too short to be a line, so the music does not pump", () => {
    // 0-0.05 is a click between two silences; it must not become a passage.
    const r = speechFromSilence(
      [{ start: 0.05, end: 3 }, { start: 3.05, end: 10 }],
      clip,
    );
    expect(r).toEqual([]);
  });

  it("returns the whole clip when nothing is silent", () => {
    expect(speechFromSilence([], clip)).toEqual([{ start: 2, end: 12 }]);
  });

  it("returns nothing when the clip is silent end to end", () => {
    expect(speechFromSilence([{ start: 0, end: 10 }], clip)).toEqual([]);
  });

  it("THE REGRESSION: one long clip yields many passages, not one flat range", () => {
    // Four lines with pauses between them, as a single 20s clip.
    const silences = [
      { start: 4, end: 4.8 },
      { start: 9, end: 9.9 },
      { start: 14, end: 14.7 },
    ];
    const speech = speechFromSilence(silences, {
      startTime: 0,
      duration: 20,
      inPoint: 0,
    });
    expect(speech).toHaveLength(4);

    // And at the analysis default (0.45s) those pauses SURVIVE the merge, so
    // the envelope can lift between lines. At the old 1.2s default they would
    // all fold into one range — which is the flat duck this fixes.
    expect(mergeRanges(speech, 0.45)).toHaveLength(4);
    expect(mergeRanges(speech, 1.2)).toHaveLength(1);
  });
});

describe("voiceClipsFrom", () => {
  const project = {
    timeline: {
      tracks: [
        {
          id: "t-dlg",
          role: "dialogue",
          name: "Dialogue",
          clips: [
            { id: "c1", mediaId: "m1", startTime: 2, duration: 70, inPoint: 0, outPoint: 70 },
          ],
        },
        {
          id: "t-mus",
          role: "music",
          name: "Music",
          clips: [{ id: "c2", mediaId: "m2", startTime: 0, duration: 40, inPoint: 0, outPoint: 40 }],
        },
      ],
    },
  };

  it("returns the voice clip with what the waveform path needs", () => {
    const v = voiceClipsFrom(project, {});
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ clipId: "c1", mediaId: "m1", startTime: 2, inPoint: 0 });
  });

  it("still excludes the clip's own track", () => {
    expect(voiceClipsFrom(project, { excludeTrackId: "t-dlg" })).toEqual([]);
  });
});
