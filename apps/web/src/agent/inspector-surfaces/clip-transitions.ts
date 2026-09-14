/**
 * Real transitions BETWEEN two shots — the thing we did not have.
 *
 * ── WHY THIS IS NOT `entry-exit-transitions` ────────────────────────────────
 * That surface animates ONE clip: it compiles a preset into opacity/transform
 * keyframes at the head and tail of a single shot. Ask it for a cross-dissolve
 * and you get shot A fading to the background and shot B fading up from it —
 * a dip through black. Everyone recognises that as "not a dissolve"; it is the
 * single most visible way an edit reads as amateur.
 *
 * A real transition needs BOTH shots on screen at once, blended by one
 * function of progress. That is `track.transitions[]`, and until now nothing
 * in this fork rendered it: `TransitionEngine` existed and had no callers, so
 * the type was there, the engine was there, and the picture never changed.
 * The engine is now wired into `video-engine.renderFrame`, which both the
 * preview and the export go through — so a transition placed here is in the
 * MP4.
 *
 * ── WHY THE SURFACE IS CLIP-ADDRESSED WHEN THE OBJECT IS TRACK-LEVEL ────────
 * A transition belongs to a track and names two clips. But the agent thinks in
 * shots — "crossfade between scene 2 and scene 3", "dissolve everything" — and
 * it already holds clip ids from `read_timeline`. So the address is a clip and
 * an edge: `at: "end"` means "between this clip and the one after it". With
 * `applyAll`, that single rule becomes "put a dissolve on every cut", which is
 * the request people actually make.
 *
 * The write goes through the ActionExecutor's existing `transition/add` and
 * `transition/remove`, so it is undoable and snapshot-restorable like any
 * other edit. No parallel store.
 */

import type { InspectorSurface, InspectorSurfaceClip, ApplyContext } from "./types";
import { TRANSITION_TYPES } from "@openreel/core";
import type { Clip, Track, Transition } from "@openreel/core";

export interface ClipTransitionConfig {
  type?: string;
  durationSec?: number;
  at?: "end" | "start";
  params?: Record<string, unknown>;
  remove?: boolean;
}

const DEFAULT_DURATION = 0.5;

/** Clips on this track in play order. */
function ordered(track: Track): Clip[] {
  return [...(track.clips ?? [])].sort((a, b) => a.startTime - b.startTime);
}

/**
 * The clip on the other side of this edge.
 *
 * "Adjacent" is deliberately generous — a frame or two of gap between two
 * shots is a normal timeline, and refusing to dissolve across it would make
 * the tool useless on real projects. The engine clamps the transition to what
 * actually overlaps.
 */
export function neighbourOf(
  track: Track,
  clipId: string,
  at: "end" | "start",
): { a: Clip; b: Clip } | null {
  const clips = ordered(track);
  const i = clips.findIndex((c) => c.id === clipId);
  if (i < 0) return null;
  if (at === "end") {
    const b = clips[i + 1];
    return b ? { a: clips[i], b } : null;
  }
  const a = clips[i - 1];
  return a ? { a, b: clips[i] } : null;
}

/**
 * How long a transition between these two can be.
 *
 * It consumes the tail of A and the head of B, so it cannot exceed either —
 * and it must leave something of each, or the "transition" is the whole shot.
 * Half of the shorter clip is the ceiling everyone converges on.
 */
export function maxTransitionDuration(a: Clip, b: Clip): number {
  return Math.max(0.1, Math.min(a.duration, b.duration) / 2);
}

export const surface: InspectorSurface<ClipTransitionConfig> = {
  name: "clip-transitions",
  description:
    "A real transition BETWEEN this clip and its neighbour — crossfade, wipe, whip-pan, circle reveal and 20 more. Both shots are on screen at once, so a crossfade is a true dissolve and not a dip through black. Use `at` to pick the edge (\"end\" = with the NEXT clip, the usual case), `applyAll` to put one on every cut, and remove:true to take them off.",
  appliesTo: ["video", "image"],
  schema: {
    type: "object",
    properties: {
      type: {
        enum: [...TRANSITION_TYPES],
        description: "Which transition. crossfade is the safe default for narrative cuts; dipToBlack for a scene break; whipPan/glitch for energy; circleReveal/diamondReveal/splitReveal for graphic moments.",
      },
      durationSec: {
        type: "number", minimum: 0.1, maximum: 5,
        description: "Length of the blend. Default 0.5. Clamped to half the shorter clip — a transition cannot eat a whole shot.",
      },
      at: {
        enum: ["end", "start"],
        description: "\"end\" (default) = between this clip and the NEXT one. \"start\" = between the PREVIOUS clip and this one.",
      },
      params: { type: "object", additionalProperties: true, description: "Type-specific options, e.g. { direction: \"left\" } for wipe/slide/push/whipPan." },
      remove: { type: "boolean", description: "Remove the transition at this edge instead of adding one." },
    },
    additionalProperties: false,
  },

  apply: async (clip: InspectorSurfaceClip, config: ClipTransitionConfig, ctx: ApplyContext) => {
    const store = ctx.store as any;
    const exec = store.actionExecutor;
    if (!exec || typeof exec.execute !== "function") {
      return { ok: false, error: "actionExecutor not available on store" };
    }

    /**
     * COMMIT THE EXECUTOR'S IN-PLACE MUTATION.
     *
     * ── WHY THIS IS REQUIRED AND WHAT IT COST TO LEARN ─────────────────────
     * `ActionExecutor.applyAction` mutates the project OBJECT IN PLACE (the
     * clone it takes is only for generating the inverse). So after a successful
     * `transition/add` the transition really is on the live project — and
     * nothing else in the system knows:
     *
     *  • the AUTOSAVE is hash-gated on `{id, modifiedAt, trackCount, clipCount,
     *    mediaCount}`. Adding a transition changes none of them, so the project
     *    was never written. The transition existed only in memory.
     *  • ZUSTAND never notified, because no reference changed — so the timeline
     *    UI never drew the transition either.
     *
     * The visible symptom was the worst kind: the tool returned
     * `ok: "crossfade 0.8s between …"`, the agent reported success, and the
     * EXPORTED MP4 contained a hard cut. Measured on a real render — luminance
     * went 33.89 → 19.43 in a single frame where a 0.8s dissolve should have
     * ramped over ~24. The loader's live rebuild between the edit and the
     * render dropped the unpersisted transition.
     *
     * New references on `tracks` and each `transitions` array are what make
     * React re-render; `modifiedAt` is what makes it save. Both, or the edit is
     * a rumour.
     */
    const commit = async () => {
      const { useProjectStore } = await import("../../stores/project-store");
      useProjectStore.setState((s: any) => ({
        project: {
          ...s.project,
          timeline: {
            ...s.project.timeline,
            tracks: (s.project.timeline?.tracks ?? []).map((t: any) => ({
              ...t,
              transitions: [...(t.transitions ?? [])],
            })),
          },
          modifiedAt: Date.now(),
        },
      }));
    };

    const project = store.project ?? ctx.project;
    const track: Track | undefined = (project.timeline?.tracks ?? [])
      .find((t: Track) => t.id === clip.trackId);
    if (!track) return { ok: false, error: `track ${clip.trackId} not found` };

    const at = config.at === "start" ? "start" : "end";
    const pair = neighbourOf(track, clip.id, at);
    if (!pair) {
      // Not an error worth failing a batch over: "crossfade everything" hits
      // the last clip, which has nothing after it. Say so and move on.
      return { ok: true, note: at === "end" ? "no clip after this one — skipped" : "no clip before this one — skipped" };
    }

    const existing: Transition | undefined = (track.transitions ?? [])
      .find((t: Transition) => t.clipAId === pair.a.id && t.clipBId === pair.b.id);

    if (config.remove === true) {
      if (!existing) return { ok: true, note: "no transition at this edge" };
      const r = await exec.execute(
        { type: "transition/remove", id: `tr-rm-${Date.now().toString(36)}`, timestamp: Date.now(), params: { transitionId: existing.id } },
        project,
      );
      if (!r?.success) return { ok: false, error: r?.error?.message ?? "remove failed" };
      await commit();
      return { ok: true, note: `removed ${existing.type}` };
    }

    const type = String(config.type ?? "crossfade");
    if (!(TRANSITION_TYPES as readonly string[]).includes(type)) {
      return { ok: false, error: `unknown transition type "${type}" — see the schema enum` };
    }

    const ceiling = maxTransitionDuration(pair.a, pair.b);
    const wanted = typeof config.durationSec === "number" ? config.durationSec : DEFAULT_DURATION;
    const duration = Math.max(0.1, Math.min(wanted, ceiling));

    // Replace rather than stack: two transitions on one cut would both claim
    // the same frames, and the first match wins at render time — so the second
    // would silently do nothing.
    if (existing) {
      await exec.execute(
        { type: "transition/remove", id: `tr-rp-${Date.now().toString(36)}`, timestamp: Date.now(), params: { transitionId: existing.id } },
        project,
      );
    }

    const r = await exec.execute(
      {
        type: "transition/add",
        id: `tr-add-${Date.now().toString(36)}`,
        timestamp: Date.now(),
        params: {
          clipAId: pair.a.id,
          clipBId: pair.b.id,
          transitionType: type,
          duration,
          ...(config.params ? { params: config.params } : {}),
        },
      },
      project,
    );
    if (!r?.success) return { ok: false, error: r?.error?.message ?? "transition/add failed" };
    await commit();

    const clamped = duration < wanted ? ` (clamped from ${wanted}s)` : "";
    return { ok: true, note: `${type} ${duration}s between ${pair.a.id} → ${pair.b.id}${clamped}` };
  },

  read: (clip, ctx) => {
    const project = (ctx.store as any)?.project ?? ctx.project;
    const track: Track | undefined = (project.timeline?.tracks ?? [])
      .find((t: Track) => t.id === clip.trackId);
    if (!track) return null;
    const mine = (track.transitions ?? []).filter(
      (t: Transition) => t.clipAId === clip.id || t.clipBId === clip.id,
    );
    if (mine.length === 0) return null;
    return mine.map((t: Transition) => ({
      id: t.id,
      type: t.type,
      duration: t.duration,
      // Which edge of THIS clip it sits on, which is how the agent addressed it.
      at: t.clipAId === clip.id ? "end" : "start",
      otherClipId: t.clipAId === clip.id ? t.clipBId : t.clipAId,
    }));
  },
};
