/**
 * ── THE ENVELOPE MUST BE WRITTEN RELATIVE TO THE CLIP'S OWN LEVEL ───────────
 *
 * `duckEnvelope` is normalised — 1 where the music plays out, `duckTo` under the
 * voice — which is the right shape to reason about and the wrong thing to write
 * verbatim, because a volume KEYFRAME overrides `clip.volume` instead of scaling
 * it. Writing the normalised curve onto a score already mixed to 0.2 puts 1.0 in
 * every gap between lines: the music surging to full level whenever nobody is
 * speaking, 14 dB above where the mix had it.
 *
 * The pure-function tests cannot see this — they check the shape, and the shape
 * was always right. It only goes wrong where the curve meets the clip, so that
 * is what this tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateClipKeyframes = vi.fn();

vi.mock("../../stores/project-store", () => ({
  useProjectStore: {
    getState: () => ({
      updateClipKeyframes,
      getMediaItem: () => undefined,
    }),
  },
}));

vi.mock("@openreel/core", () => ({
  KeyframeEngine: class {
    addKeyframe(
      _clipId: string,
      property: string,
      time: number,
      value: number,
      easing: string,
    ) {
      return { id: `k-${property}-${time}`, time, property, value, easing };
    }
  },
  getAudioEngine: () => ({ detectSilence: () => [] }),
  rewriteToProxy: (u: string) => u,
}));

import { surface } from "./auto-duck";

/** One dialogue clip from 10s to 20s; the music clip runs 0-30s. */
const project = {
  timeline: {
    tracks: [
      {
        id: "t-dlg",
        role: "dialogue",
        name: "Dialogue",
        clips: [
          { id: "d1", mediaId: "m-d", startTime: 10, duration: 10, inPoint: 0, outPoint: 10 },
        ],
      },
      { id: "t-mus", role: "music", name: "Music", clips: [] },
    ],
  },
};

const applyTo = (volume: number, config: Record<string, unknown> = {}) =>
  (surface.apply as never as (
    c: unknown,
    cfg: unknown,
    ctx: unknown,
  ) => Promise<{ ok: boolean; note?: string; error?: string }>)(
    {
      id: "music-1",
      trackId: "t-mus",
      raw: { id: "music-1", startTime: 0, duration: 30, volume, keyframes: [] },
    },
    // analyze:false keeps this on the clip-extent path, so the test is about the
    // gain scaling and nothing else.
    { duckTo: 0.25, analyze: false, ...config },
    { project, store: { project } },
  );

const writtenValues = () =>
  (updateClipKeyframes.mock.calls.at(-1)?.[1] as Array<{ value: number }>).map(
    (k) => k.value,
  );

describe("auto-duck writes gains relative to the clip", () => {
  beforeEach(() => updateClipKeyframes.mockClear());

  it("REGRESSION: a score at 0.2 never jumps to 1.0 between lines", async () => {
    const r = await applyTo(0.2);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);

    const values = writtenValues();
    // Out of the duck it sits at the clip's own level, not unity.
    expect(Math.max(...values)).toBeCloseTo(0.2, 4);
    // Under the voice it is duckTo OF that level.
    expect(Math.min(...values)).toBeCloseTo(0.05, 4);
  });

  it("a clip already at unity is unaffected by the scaling", async () => {
    await applyTo(1);
    const values = writtenValues();
    expect(Math.max(...values)).toBeCloseTo(1, 4);
    expect(Math.min(...values)).toBeCloseTo(0.25, 4);
  });

  it("honours the depth against the clip's level", async () => {
    await applyTo(0.5, { duckTo: 0.4 });
    const values = writtenValues();
    expect(Math.max(...values)).toBeCloseTo(0.5, 4);
    expect(Math.min(...values)).toBeCloseTo(0.2, 4);
  });

  it("says in the note which level it ducked against, and how it found the voice", async () => {
    const r = await applyTo(0.2);
    expect(r.note).toContain("0.2");
    expect(r.note).toContain("clip extents");
  });

  it("still refuses when there is no voice to duck against", async () => {
    const r = await (surface.apply as never as (
      c: unknown,
      cfg: unknown,
      ctx: unknown,
    ) => Promise<{ ok: boolean; error?: string }>)(
      { id: "music-1", trackId: "t-mus", raw: { startTime: 0, duration: 30, volume: 0.2, keyframes: [] } },
      { duckTo: 0.25, analyze: false },
      { project: { timeline: { tracks: [] } }, store: { project: { timeline: { tracks: [] } } } },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no narration\/dialogue/i);
  });
});
