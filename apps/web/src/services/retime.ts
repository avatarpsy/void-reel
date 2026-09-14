/**
 * Retiming a clip — the one implementation.
 *
 * ── WHY THIS IS A SERVICE AND NOT TWO COPIES ────────────────────────────────
 * Changing a clip's speed is TWO writes that have to agree:
 *   1. the SpeedEngine's per-clip record, which the renderer consults on every
 *      frame (`video-engine.createClipRenderInfo` → `getSourceTimeAtPlaybackTime`);
 *   2. the clip's own `duration` / `speed` / `reversed`, which the timeline
 *      draws and the project saves.
 * Get them out of step and the clip plays the wrong part of its source — not a
 * cosmetic bug, a frame-accuracy one. That is too sharp an edge to reimplement
 * beside the Inspector when the agent wants the same operation.
 *
 * ── THE `originalDuration` TRAP THIS FIXES ──────────────────────────────────
 * `SpeedEngine.setClipSpeed(clipId, speed, originalDuration)` stores that third
 * argument as the SOURCE span, and `getSourceTimeAtPlaybackTime` clamps its
 * result to it. The Inspector passed `clip.duration` — the ON-TIMELINE length,
 * which is the source span divided by whatever speed is already applied. The
 * two are equal only on a clip that has never been retimed, which is why the
 * bug hid: the value is right the first time and wrong every time after,
 * and `getOrCreateSpeedData` only records it on first touch, so the damage
 * needed a clip that arrived already retimed to show up — exactly what now
 * happens on every reload since retiming became persistent.
 *
 * The source span is `outPoint - inPoint`. Always that, never `duration`.
 */

import { getSpeedEngine, SPEED_MIN, SPEED_MAX } from "@openreel/core";
import type { Clip, Project, Track } from "@openreel/core";
import { useProjectStore } from "../stores/project-store";

export interface RetimeRequest {
  clipId: string;
  /** New playback rate. 2 = twice as fast. Omit to leave unchanged. */
  speed?: number;
  /** Play the source backwards. Omit to leave unchanged. */
  reversed?: boolean;
  /**
   * Also retime an audio clip that shares this clip's media.
   *
   * Default true: a talking-head shot whose audio was split onto its own track
   * is one performance, and speeding the picture without the sound desyncs it
   * for the rest of the timeline.
   */
  affectLinkedAudio?: boolean;
}

export interface RetimeResult {
  ok: boolean;
  error?: string;
  /** New on-timeline length of the primary clip. */
  newDuration?: number;
  /** Ids actually retimed, primary first. */
  clipIds?: string[];
}

/** The SOURCE span a clip covers — what the SpeedEngine means by originalDuration. */
export function sourceSpanOf(clip: Pick<Clip, "inPoint" | "outPoint" | "duration">): number {
  const span = Number(clip.outPoint) - Number(clip.inPoint);
  // Fall back to the on-timeline length for a clip with no meaningful in/out
  // (a generated still, say) rather than returning zero and dividing by it.
  return Number.isFinite(span) && span > 0 ? span : Math.max(0, Number(clip.duration) || 0);
}

export function clampSpeed(speed: number): number {
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
}

function findClip(project: Project, clipId: string): { clip: Clip; track: Track } | null {
  for (const track of project.timeline?.tracks ?? []) {
    const clip = (track.clips ?? []).find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

/**
 * Apply a retime, writing the engine record and the clip fields together.
 *
 * Returns rather than throws: both callers (an Inspector button and an agent
 * tool) need to TELL someone what went wrong, and neither wants an exception
 * escaping into a render loop.
 */
export function retimeClip(req: RetimeRequest): RetimeResult {
  const store = useProjectStore.getState();
  const project = store.project;
  const found = findClip(project, req.clipId);
  if (!found) return { ok: false, error: `clip ${req.clipId} not found` };

  const { clip } = found;
  const speedEngine = getSpeedEngine();
  const currentSpeed = speedEngine.getClipSpeed(clip.id) || Number(clip.speed) || 1;
  const speed = typeof req.speed === "number" ? clampSpeed(req.speed) : currentSpeed;
  const reversed = typeof req.reversed === "boolean"
    ? req.reversed
    : (speedEngine.isReverse(clip.id) || clip.reversed === true);

  if (!Number.isFinite(speed) || speed <= 0) {
    return { ok: false, error: `speed must be a positive number (got ${req.speed})` };
  }

  const affectAudio = req.affectLinkedAudio !== false;
  const touched: string[] = [];

  /** Everything one clip needs, computed from its OWN source span. */
  const applyTo = (c: Clip): Clip => {
    const span = sourceSpanOf(c);
    speedEngine.setClipSpeed(c.id, speed, span);
    speedEngine.setReverse(c.id, reversed, span);
    touched.push(c.id);
    return { ...c, duration: span / speed, speed, reversed } as Clip;
  };

  const tracks = (project.timeline?.tracks ?? []).map((track) => {
    let changed = false;
    const clips = (track.clips ?? []).map((c) => {
      if (c.id === clip.id) { changed = true; return applyTo(c); }
      // The linked-audio case: a different clip on an AUDIO track pointing at
      // the same media file. Matching on mediaId is what the Inspector does,
      // and it is the only link the model has.
      if (affectAudio && track.type === "audio" && c.mediaId === clip.mediaId && c.id !== clip.id) {
        changed = true;
        return applyTo(c);
      }
      return c;
    });
    return changed ? { ...track, clips } : track;
  });

  useProjectStore.setState({
    project: {
      ...project,
      timeline: { ...project.timeline, tracks },
      modifiedAt: Date.now(),
    },
  });

  return {
    ok: true,
    newDuration: sourceSpanOf(clip) / speed,
    clipIds: touched,
  };
}

/** Current retime of a clip, for a readback. */
export function readRetime(clipId: string, clip?: Pick<Clip, "speed" | "reversed">): {
  speed: number;
  reversed: boolean;
} {
  const e = getSpeedEngine();
  return {
    speed: e.getClipSpeed(clipId) || Number(clip?.speed) || 1,
    reversed: e.isReverse(clipId) || clip?.reversed === true,
  };
}
