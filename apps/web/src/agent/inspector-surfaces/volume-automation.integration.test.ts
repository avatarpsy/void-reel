/**
 * ── THE CURVE MUST BE ON THE CLIP AFTERWARDS ────────────────────────────────
 *
 * The sibling unit test asserts which ACTIONS this surface emits, against a
 * mock executor that returns `{success:true}` and touches nothing. That proves
 * the surface asks for the right thing. It cannot prove the thing happened, and
 * a mix was shipped where every call answered `ok:true, clipsTouched:1` and the
 * clip came back with no keyframes at all.
 *
 * So this test runs the REAL ActionExecutor against a REAL project object and
 * asserts the only thing that matters: what is on the clip when the call
 * returns. A surface that reports success and writes nothing fails here.
 */
import { describe, it, expect } from "vitest";

import { ActionExecutor } from "@openreel/core";
import { surface } from "./volume-automation";

type AnyRec = Record<string, unknown>;

function makeProject() {
  const clip: AnyRec = {
    id: "clip-1",
    mediaId: "m1",
    trackId: "track-1",
    startTime: 0,
    duration: 10,
    inPoint: 0,
    outPoint: 10,
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
    keyframes: [] as AnyRec[],
  };
  const project: AnyRec = {
    id: "p1",
    name: "t",
    timeline: {
      tracks: [
        {
          id: "track-1",
          type: "audio",
          name: "Audio 1",
          clips: [clip],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
      subtitles: [],
      duration: 10,
      markers: [],
    },
    mediaLibrary: { items: [] },
    settings: { sampleRate: 44100, channels: 2 },
    modifiedAt: 0,
  };
  return { project, clip };
}

/** The clip as the project holds it NOW — not the reference we started with. */
const liveKeyframes = (project: AnyRec) => {
  const tl = project.timeline as AnyRec;
  const tracks = tl.tracks as AnyRec[];
  const clips = tracks[0].clips as AnyRec[];
  return (clips[0].keyframes as AnyRec[]) ?? [];
};

const volumePoints = (project: AnyRec) =>
  liveKeyframes(project)
    .filter((k) => k.property === "volume")
    .map((k) => ({ time: k.time, value: k.value }))
    .sort((a, b) => (a.time as number) - (b.time as number));

describe("volume-automation actually lands on the clip", () => {
  it("writes the curve into project.timeline, not just into the action log", async () => {
    const { project, clip } = makeProject();
    const exec = new ActionExecutor();

    const r = await (surface.apply as never as (
      c: unknown,
      cfg: unknown,
      ctx: unknown,
    ) => Promise<{ ok: boolean; error?: string }>)(
      { id: "clip-1", raw: clip },
      {
        automationPoints: [
          { time: 0, value: 0 },
          { time: 1.2, value: 0.142 },
          { time: 9, value: 0.142 },
        ],
      },
      { project, store: { project, actionExecutor: exec } },
    );

    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    // The whole point: ok:true must mean the curve is THERE.
    expect(volumePoints(project)).toEqual([
      { time: 0, value: 0 },
      { time: 1.2, value: 0.142 },
      { time: 9, value: 0.142 },
    ]);
  });

  it("REPLACES an existing curve instead of stacking a second one on top", async () => {
    const { project, clip } = makeProject();
    const exec = new ActionExecutor();
    const apply = surface.apply as never as (
      c: unknown,
      cfg: unknown,
      ctx: unknown,
    ) => Promise<{ ok: boolean }>;

    await apply(
      { id: "clip-1", raw: clip },
      { automationPoints: [{ time: 0, value: 1 }, { time: 5, value: 0.5 }] },
      { project, store: { project, actionExecutor: exec } },
    );

    // Second pass must read the CURRENT clip, so pass what the project holds now.
    const live = ((project.timeline as AnyRec).tracks as AnyRec[])[0];
    const liveClip = (live.clips as AnyRec[])[0];

    await apply(
      { id: "clip-1", raw: liveClip },
      { automationPoints: [{ time: 0, value: 0.2 }, { time: 8, value: 0.2 }] },
      { project, store: { project, actionExecutor: exec } },
    );

    expect(volumePoints(project)).toEqual([
      { time: 0, value: 0.2 },
      { time: 8, value: 0.2 },
    ]);
  });

  it("leaves a non-volume curve on the same clip untouched", async () => {
    const { project, clip } = makeProject();
    (clip.keyframes as AnyRec[]).push({
      id: "k-op",
      time: 3,
      property: "opacity",
      value: 0.5,
      easing: "linear",
    });
    const exec = new ActionExecutor();

    await (surface.apply as never as (
      c: unknown,
      cfg: unknown,
      ctx: unknown,
    ) => Promise<unknown>)(
      { id: "clip-1", raw: clip },
      { automationPoints: [{ time: 0, value: 0.3 }] },
      { project, store: { project, actionExecutor: exec } },
    );

    const opacity = liveKeyframes(project).filter(
      (k) => k.property === "opacity",
    );
    expect(opacity).toHaveLength(1);
    expect(opacity[0].value).toBe(0.5);
  });

  it("an empty array clears the curve on the clip", async () => {
    const { project, clip } = makeProject();
    const exec = new ActionExecutor();
    const apply = surface.apply as never as (
      c: unknown,
      cfg: unknown,
      ctx: unknown,
    ) => Promise<unknown>;

    await apply(
      { id: "clip-1", raw: clip },
      { automationPoints: [{ time: 0, value: 1 }, { time: 4, value: 0 }] },
      { project, store: { project, actionExecutor: exec } },
    );
    const liveClip = (
      ((project.timeline as AnyRec).tracks as AnyRec[])[0].clips as AnyRec[]
    )[0];
    await apply(
      { id: "clip-1", raw: liveClip },
      { automationPoints: [] },
      { project, store: { project, actionExecutor: exec } },
    );

    expect(volumePoints(project)).toEqual([]);
  });
});
