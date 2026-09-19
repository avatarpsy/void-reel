/**
 * ── THE CHANNEL FADER, END TO END ───────────────────────────────────────────
 *
 * `Track` had no volume or pan, so the AudioMixer's faders wrote to React state
 * and to the live audio graph and nowhere else: audible in the preview, missing
 * from the saved project, missing from the export. Because the preview obeyed
 * them, moving a fader gave every signal that the change had taken.
 *
 * These pin the three things that has to mean now — the action lands, it undoes,
 * and a project that predates the fields still behaves as unity/centre.
 */
import { describe, it, expect } from "vitest";

import { ActionExecutor } from "./action-executor";
import { AudioEngine } from "../audio/audio-engine";
import type { Action } from "../types/actions";

type AnyRec = Record<string, unknown>;

function makeProject(trackExtra: AnyRec = {}) {
  const project: AnyRec = {
    id: "p1",
    name: "t",
    timeline: {
      tracks: [
        {
          id: "track-1",
          type: "audio",
          name: "Music",
          clips: [],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          ...trackExtra,
        },
      ],
      subtitles: [],
      duration: 10,
      markers: [],
    },
    mediaLibrary: { items: [] },
    settings: { sampleRate: 44100, channels: 2 },
  };
  return project;
}

const track = (p: AnyRec) =>
  (((p.timeline as AnyRec).tracks as AnyRec[])[0]) as AnyRec;

const act = (type: string, params: AnyRec): Action =>
  ({ type, id: `a-${type}-${Math.random()}`, timestamp: Date.now(), params }) as unknown as Action;

describe("track/volume", () => {
  it("lands on the track", async () => {
    const p = makeProject();
    const exec = new ActionExecutor();
    const r = await exec.execute(act("track/volume", { trackId: "track-1", volume: 0.4 }), p as never);
    expect(r.success).toBe(true);
    expect(track(p).volume).toBe(0.4);
  });

  it("undoes back to the PREVIOUS value, not to unity", async () => {
    const p = makeProject({ volume: 0.8 });
    const exec = new ActionExecutor();
    await exec.execute(act("track/volume", { trackId: "track-1", volume: 0.2 }), p as never);
    expect(track(p).volume).toBe(0.2);
    await exec.undo(p as never);
    expect(track(p).volume).toBe(0.8);
  });

  it("undoes to UNITY on a project written before faders existed", async () => {
    const p = makeProject(); // no `volume` at all
    const exec = new ActionExecutor();
    await exec.execute(act("track/volume", { trackId: "track-1", volume: 0.3 }), p as never);
    await exec.undo(p as never);
    // Not `undefined` — that would read as 0 gain anywhere it is multiplied.
    expect(track(p).volume).toBe(1);
  });

  it("refuses a gain that would silence the track with no error at playback", async () => {
    const p = makeProject();
    const exec = new ActionExecutor();
    for (const bad of [Number.NaN, Infinity, -0.5, 99]) {
      const r = await exec.execute(act("track/volume", { trackId: "track-1", volume: bad }), p as never);
      expect(r.success).toBe(false);
    }
    expect(track(p).volume).toBeUndefined();
  });

  it("refuses an unknown track", async () => {
    const p = makeProject();
    const exec = new ActionExecutor();
    const r = await exec.execute(act("track/volume", { trackId: "nope", volume: 0.5 }), p as never);
    expect(r.success).toBe(false);
  });
});

describe("track/pan", () => {
  it("lands, and undoes back to centre when there was none", async () => {
    const p = makeProject();
    const exec = new ActionExecutor();
    await exec.execute(act("track/pan", { trackId: "track-1", pan: -0.6 }), p as never);
    expect(track(p).pan).toBe(-0.6);
    await exec.undo(p as never);
    expect(track(p).pan).toBe(0);
  });

  it("refuses a pan outside -1..1", async () => {
    const p = makeProject();
    const exec = new ActionExecutor();
    for (const bad of [-2, 2, Number.NaN]) {
      const r = await exec.execute(act("track/pan", { trackId: "track-1", pan: bad }), p as never);
      expect(r.success).toBe(false);
    }
  });
});

/**
 * ── AND THE EXPORT HAS TO OBEY IT ───────────────────────────────────────────
 *
 * The recurring failure in this codebase is a mix decision that the preview
 * honours and the file ignores. A fader that persisted but never reached the
 * render would be exactly that bug again, so this checks the render info the
 * export mixer actually builds.
 */
describe("the export folds the channel fader into the clip", () => {
  const withClip = (trackFader: Record<string, unknown>, keyframes: unknown[] = []) => ({
    id: "p1",
    name: "t",
    timeline: {
      tracks: [
        {
          id: "track-1",
          type: "audio",
          name: "Music",
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          ...trackFader,
          clips: [
            {
              id: "c1",
              mediaId: "m1",
              trackId: "track-1",
              startTime: 0,
              duration: 10,
              inPoint: 0,
              outPoint: 10,
              effects: [],
              audioEffects: [],
              transform: {},
              volume: 0.5,
              keyframes,
            },
          ],
        },
      ],
      subtitles: [],
      duration: 10,
      markers: [],
    },
    mediaLibrary: { items: [] },
    settings: { sampleRate: 44100, channels: 2 },
  });

  // It takes the TIMELINE (renderAudio hands it the flattened one), not a project.
  const renderInfo = (project: { timeline: unknown }) => {
    const eng = new AudioEngine();
    return (eng as never as {
      getAudioTracksAtTime: (t: unknown, s: number, d: number) => Array<{ clips: Array<Record<string, unknown>> }>;
    }).getAudioTracksAtTime(project.timeline, 0, 10)[0].clips[0];
  };

  it("multiplies the clip gain by the fader", () => {
    expect(renderInfo(withClip({ volume: 0.5 })).volume).toBeCloseTo(0.25, 6);
  });

  it("leaves a pre-fader project exactly as it was", () => {
    expect(renderInfo(withClip({})).volume).toBeCloseTo(0.5, 6);
    expect(renderInfo(withClip({})).pan).toBe(0);
  });

  it("ALSO scales the volume curve — a keyframe replaces clip.volume", () => {
    const kf = [
      { id: "k1", time: 0, property: "volume", value: 0.8, easing: "linear" },
      { id: "k2", time: 5, property: "volume", value: 0.4, easing: "linear" },
    ];
    const info = renderInfo(withClip({ volume: 0.5 }, kf));
    expect(info.automationVolume).toEqual([
      { time: 0, value: 0.4 },
      { time: 5, value: 0.2 },
    ]);
  });

  it("sums pan and clamps it to the stereo field", () => {
    expect(renderInfo(withClip({ pan: 0.5 })).pan).toBeCloseTo(0.5, 6);
    expect(renderInfo(withClip({ pan: -3 })).pan).toBe(-1);
  });
});
