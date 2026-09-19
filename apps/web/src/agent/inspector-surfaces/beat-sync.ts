/**
 * Cut to the music — beat detection, and snapping the cuts to it.
 *
 * ── WHY THIS WAS UNREACHABLE ────────────────────────────────────────────────
 * All the machinery existed and nothing drove it. `BeatDetectionEngine` finds
 * beats and downbeats, `BeatSyncBridge` wraps it, `BeatMarkerOverlay` draws the
 * grid on the ruler — and `BeatSyncSection` was never mounted in the Inspector,
 * so no human could reach it either. A working feature with no front door.
 *
 * It also had the persistence trap this codebase keeps hitting:
 * `Timeline.beatMarkers` and `beatAnalysis` have been on the type since the
 * engine was written and NOTHING wrote them. The grid lived in the bridge's own
 * state, so analysing a track drew beats that vanished on reload. Cutting to a
 * grid that disappears is worse than having no grid: the cuts stay and the
 * reason for them is gone. `store.setBeatGrid` now writes the project, and
 * `loadProject` refills the bridge from it.
 *
 * ── WHAT IT ACTUALLY DOES, AND WHAT IT REFUSES TO PRETEND ───────────────────
 * Two honest operations:
 *   analyze — find the beats in THIS audio clip and put the grid on the
 *             timeline. Visible on the ruler, saved with the project.
 *   snap    — move the START of every video/image clip to the nearest beat, so
 *             the cuts land with the music.
 *
 * It does NOT invent cuts. "Auto-edit this to the beat" on a single long clip
 * would mean splitting footage at musical intervals, and choosing WHICH three
 * seconds of a shot to keep is an editorial decision — the agent has
 * `cut_by_transcript` and `auto-cut-silence` for content-driven cutting, and a
 * person has the blade. Snapping existing cuts is the part that is arithmetic,
 * and arithmetic is what should be automated.
 */

import type { InspectorSurface, InspectorSurfaceClip, ApplyContext } from "./types";
import type { Clip, Track, TimelineBeatMarker } from "@openreel/core";

export interface BeatSyncConfig {
  op?: "analyze" | "snap" | "clear";
  /** snap only: ignore a cut already within this many seconds of a beat. */
  toleranceSec?: number;
  /** snap only: only move a cut by at most this much, so nothing lurches. */
  maxShiftSec?: number;
  /** snap only: land on downbeats (bar starts) rather than every beat. */
  downbeatsOnly?: boolean;
}

/**
 * Nearest beat to `t`, or null when none is close enough to be meant.
 *
 * Pure and exported: this is the whole of the snapping decision, and it is the
 * part that must not move a cut somewhere the user did not intend.
 */
export function nearestBeat(
  beats: ReadonlyArray<TimelineBeatMarker>,
  t: number,
  opts: { maxShiftSec: number; downbeatsOnly: boolean },
): TimelineBeatMarker | null {
  let best: TimelineBeatMarker | null = null;
  let bestDist = Infinity;
  for (const b of beats) {
    if (opts.downbeatsOnly && !b.isDownbeat) continue;
    const d = Math.abs(b.time - t);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  // A beat further away than the allowed shift is not "the nearest beat", it is
  // a different part of the song.
  if (!best || bestDist > opts.maxShiftSec) return null;
  return best;
}

export const surface: InspectorSurface<BeatSyncConfig> = {
  name: "beat-sync",
  description:
    "Cut to the music. op:\"analyze\" on a MUSIC clip finds its beats and BPM and puts the grid on the timeline ruler (saved with the project). op:\"snap\" then moves each video/image clip's start onto the nearest beat so the cuts land with the track. op:\"clear\" removes the grid.",
  appliesTo: ["audio", "video", "image"],
  schema: {
    type: "object",
    properties: {
      op: {
        enum: ["analyze", "snap", "clear"],
        description: "\"analyze\" (run this FIRST, on the music clip), then \"snap\" (on any clip — it moves the whole timeline's cuts). Default analyze.",
      },
      toleranceSec: {
        type: "number", minimum: 0, maximum: 1,
        description: "snap: leave a cut alone if it is already this close to a beat. Default 0.03.",
      },
      maxShiftSec: {
        type: "number", minimum: 0.01, maximum: 2,
        description: "snap: never move a cut further than this. Default 0.25 — a bigger shift is a re-edit, not a sync.",
      },
      downbeatsOnly: {
        type: "boolean",
        description: "snap: land on bar starts only. Default false (every beat). Use true for slower, more deliberate cutting.",
      },
    },
    additionalProperties: false,
  },

  apply: async (clip: InspectorSurfaceClip, config: BeatSyncConfig, ctx: ApplyContext) => {
    const op = config.op ?? "analyze";
    const { getBeatSyncBridge } = await import("../../bridges/beat-sync-bridge");
    const bridge = getBeatSyncBridge();
    // The live store the caller already resolved targets against — same object
    // every other surface writes through.
    const store = ctx.store as any;

    if (op === "clear") {
      bridge.clearBeatMarkers();
      (store as any).setBeatGrid([], null);
      return { ok: true, note: "beat grid cleared" };
    }

    if (op === "analyze") {
      // The URL is the media item's, not the clip's — the clip is a window onto it.
      const media: any = (store as any).getMediaItem?.((clip.raw as any).mediaId);
      const url = media?.originalUrl || media?.url;
      if (!url) {
        return { ok: false, error: "that clip's media has no reachable URL to analyse — try the music clip itself" };
      }
      try {
        const result = await bridge.analyzeAudioFromUrl(String(url), clip.id);
        const state = bridge.getState();
        (store as any).setBeatGrid(state.beatMarkers, state.beatAnalysis);
        /**
         * ── RETURN THE GRID, NOT JUST ITS SIZE ───────────────────────────────
         *
         * This used to answer "128 beats at 92 BPM" and keep the times to
         * itself, which is everything a caller needs except the part it needs.
         * `snap` moves PICTURE onto the grid and deliberately never touches
         * audio — correct, since sliding narration would desync it from the
         * shot — so an agent placing a stab or a cue entry had no way to land
         * it on a downbeat and had to guess a second. A hit that misses by a
         * beat is the single most audible amateur tell there is.
         *
         * Downbeats are sent separately because they are what a musical change
         * belongs on: a cue entering on a bar line reads as intentional, and the
         * same cue three sixteenths early reads as a mistake. Capped so a long
         * track does not return thousands of numbers nobody reads.
         */
        // `TimelineBeatMarker` — `isDownbeat`, not a `type` string. (The
        // sound-library `BeatMarker` is the one with `type`; these are not the
        // same shape and the compiler is the only thing that says so.)
        const markers = state.beatMarkers ?? [];
        const at = (t: number) => Number(t.toFixed(3));
        const downbeats = markers.filter((m) => m.isDownbeat).map((m) => at(m.time));
        return {
          ok: true,
          note: `${markers.length} beats at ${Math.round(result.bpm)} BPM (confidence ${result.confidence.toFixed(2)})`,
          bpm: Math.round(result.bpm * 10) / 10,
          confidence: Number(result.confidence.toFixed(2)),
          /** Bar lines — put a cue change or a sting here. */
          downbeats: downbeats.slice(0, 256),
          /** Every beat, for finer placement. */
          beats: markers.map((m) => at(m.time)).slice(0, 512),
          ...(downbeats.length > 256 || markers.length > 512
            ? { truncated: true, totalBeats: markers.length, totalDownbeats: downbeats.length }
            : {}),
        };
      } catch (e: any) {
        return { ok: false, error: `beat analysis failed: ${e?.message ?? String(e)}` };
      }
    }

    // ── snap ──────────────────────────────────────────────────────────────
    const beats = bridge.getState().beatMarkers;
    if (!beats || beats.length === 0) {
      return { ok: false, error: "no beat grid yet — run op:\"analyze\" on the music clip first" };
    }
    const tolerance = typeof config.toleranceSec === "number" ? config.toleranceSec : 0.03;
    const maxShift = typeof config.maxShiftSec === "number" ? config.maxShiftSec : 0.25;
    const downbeatsOnly = config.downbeatsOnly === true;

    const project = store.project ?? ctx.project;
    const moves: Array<{ clipId: string; from: number; to: number }> = [];
    for (const tr of (project.timeline?.tracks ?? []) as Track[]) {
      // Only picture cuts are snapped. Moving the music onto its own beat grid
      // is circular, and shifting narration would desync it from the shot.
      if (tr.type !== "video" && tr.type !== "image") continue;
      for (const c of (tr.clips ?? []) as Clip[]) {
        // The first clip defines the start of the film; sliding it leaves a gap
        // at zero that nobody asked for.
        if (c.startTime <= 0.001) continue;
        const target = nearestBeat(beats, c.startTime, { maxShiftSec: maxShift, downbeatsOnly });
        if (!target) continue;
        const delta = target.time - c.startTime;
        if (Math.abs(delta) <= tolerance) continue;
        moves.push({ clipId: c.id, from: c.startTime, to: target.time });
      }
    }

    if (moves.length === 0) {
      return { ok: true, note: "every cut is already on a beat" };
    }
    for (const m of moves) {
      await (store as any).moveClip(m.clipId, m.to);
    }
    const biggest = moves.reduce((a, b) => (Math.abs(b.to - b.from) > Math.abs(a.to - a.from) ? b : a));
    return {
      ok: true,
      note: `snapped ${moves.length} cut(s) to the beat (largest move ${Math.abs(biggest.to - biggest.from).toFixed(3)}s)`,
    };
  },

  // The grid is a TIMELINE property, not a clip one — the same answer comes
  // back whichever clip is asked, which is correct: there is one song.
  read: async (_clip: InspectorSurfaceClip, ctx: ApplyContext) => {
    const tl = (ctx.project as any)?.timeline;
    const markers = tl?.beatMarkers ?? [];
    if (!Array.isArray(markers) || markers.length === 0) return null;
    return {
      beats: markers.length,
      downbeats: markers.filter((b: TimelineBeatMarker) => b.isDownbeat).length,
      bpm: tl?.beatAnalysis?.bpm ?? null,
      confidence: tl?.beatAnalysis?.confidence ?? null,
    };
  },
};
