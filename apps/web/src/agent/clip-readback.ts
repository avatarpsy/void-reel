/**
 * What has been DONE to a clip — the half of the agent contract that was missing.
 *
 * ── THE PROBLEM THIS EXISTS TO FIX ──────────────────────────────────────────
 * Every Inspector surface the agent can drive was write-only. `get-state`
 * returned a clip's id, times, volume, mute, blend and fade, and nothing about
 * the work: no effects, no grade, no retime, no crop, no keyframes. So an agent
 * that had just applied a blur could not answer "what is on scene 3?", could
 * not remove what it had added (removal needs the effect's ID, which only a
 * read produces), could not confirm an apply had landed, and — worst, because
 * it is silent — could not tell that it had already blurred this clip on the
 * previous turn. Stacking the same effect three times looks exactly like
 * applying it once, until the render.
 *
 * ── WHY A SUMMARY AND NOT THE WHOLE OBJECT ──────────────────────────────────
 * This rides on `get-state`, which the agent calls at the start of most turns,
 * on every clip of a timeline that can hold hundreds. Returning full effect
 * params, whole curve arrays and every keyframe would cost more context than
 * the edit it informs. So: identity and intent, at a size that stays free.
 *   • effects        → id + type + enabled. The ID is the point: it is what
 *                      `video-effects` needs for update / remove / toggle.
 *   • grade          → WHICH grading tools are engaged, not their values.
 *   • speed/reversed → the numbers, because they are one number each.
 *   • keyframes      → property + count, so "is this animated, and on what?"
 *   • crop/transform → present only when moved off default.
 * Full params for one surface on one clip are a separate, deliberate call
 * (`read_inspector_tool`); this is the always-on overview that makes the agent
 * ask for that at all.
 *
 * ── EVERY FIELD IS OMITTED WHEN DEFAULT ─────────────────────────────────────
 * An untouched clip adds NOTHING to the payload. That is what makes this safe
 * to ship on a hot path, and it also means presence is information: if `grade`
 * is there, someone graded this shot.
 */

import type { Clip, Project } from "@openreel/core";

/** One clip's applied work. Every field optional; an untouched clip reads `{}`. */
export interface ClipLooks {
  effects?: Array<{ id: string; type: string; enabled: boolean }>;
  grade?: string[];
  speed?: number;
  reversed?: boolean;
  crop?: { x: number; y: number; width: number; height: number };
  transform?: {
    position?: { x: number; y: number };
    scale?: { x: number; y: number };
    rotation?: number;
    opacity?: number;
  };
  keyframes?: Array<{ property: string; count: number }>;
  emphasis?: string;
  /** This clip is an instance of a nested sequence — which one. */
  sequenceId?: string;
}

/**
 * The store/engine reads this needs, injected rather than imported.
 *
 * `get-state` runs inside App.tsx with the live store in hand, and the unit
 * tests run with neither a store nor an initialised EffectsBridge. Taking the
 * three reads as parameters is what lets the same function serve both without
 * a mock of the entire project store.
 */
export interface ReadbackSources {
  getVideoEffects?: (clipId: string) => Array<{ id: string; type: string; enabled: boolean }> | undefined;
  getColorGrading?: (clipId: string) => Record<string, unknown> | undefined;
  getClipSpeed?: (clipId: string) => number | undefined;
  isReversed?: (clipId: string) => boolean | undefined;
}

const EPS = 1e-4;
const near = (a: number, b: number) => Math.abs(a - b) < EPS;

/**
 * Is this crop the whole frame? A crop of (0,0,1,1) is what the UI writes when
 * a user opens the Crop section and changes nothing, so reporting it would
 * claim an edit that did not happen.
 */
function isFullFrameCrop(c: { x: number; y: number; width: number; height: number }): boolean {
  return near(c.x, 0) && near(c.y, 0) && near(c.width, 1) && near(c.height, 1);
}

export function readClipLooks(clip: Clip, src: ReadbackSources = {}): ClipLooks {
  const out: ClipLooks = {};

  // ── Effect chain (incl. chroma key, blur, sharpen, grain, vignette) ──
  try {
    const fx = src.getVideoEffects?.(clip.id) ?? [];
    if (fx.length > 0) {
      out.effects = fx.map((e) => ({
        id: e.id,
        type: e.type,
        // The flag is the effect's own; an effect with it unset is ON.
        enabled: e.enabled !== false,
      }));
    }
  } catch { /* a cold bridge must not break the whole state read */ }

  // ── Colour grading: which tools, not their values ──
  try {
    const g = src.getColorGrading?.(clip.id);
    if (g) {
      const engaged = Object.keys(g).filter((k) => {
        const v = (g as Record<string, unknown>)[k];
        if (v == null) return false;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === "object") return Object.keys(v as object).length > 0;
        return true;
      });
      if (engaged.length > 0) out.grade = engaged.sort();
    }
  } catch { /* as above */ }

  // ── Retiming ──
  try {
    const s = src.getClipSpeed?.(clip.id);
    if (typeof s === "number" && !near(s, 1)) out.speed = Number(s.toFixed(4));
    if (src.isReversed?.(clip.id) === true) out.reversed = true;
  } catch { /* as above */ }

  // ── Geometry, only where it has been moved ──
  const t = clip.transform;
  if (t) {
    if (t.crop && !isFullFrameCrop(t.crop)) {
      out.crop = {
        x: Number(t.crop.x.toFixed(4)), y: Number(t.crop.y.toFixed(4)),
        width: Number(t.crop.width.toFixed(4)), height: Number(t.crop.height.toFixed(4)),
      };
    }
    const moved: ClipLooks["transform"] = {};
    if (t.position && (!near(t.position.x, 0) || !near(t.position.y, 0))) moved.position = t.position;
    if (t.scale && (!near(t.scale.x, 1) || !near(t.scale.y, 1))) moved.scale = t.scale;
    if (typeof t.rotation === "number" && !near(t.rotation, 0)) moved.rotation = t.rotation;
    if (typeof t.opacity === "number" && !near(t.opacity, 1)) moved.opacity = t.opacity;
    if (Object.keys(moved).length > 0) out.transform = moved;
  }

  // ── Animation: what is keyed, and how densely ──
  const kfs = clip.keyframes ?? [];
  if (kfs.length > 0) {
    const byProp = new Map<string, number>();
    for (const k of kfs) byProp.set(k.property, (byProp.get(k.property) ?? 0) + 1);
    out.keyframes = [...byProp.entries()]
      .map(([property, count]) => ({ property, count }))
      .sort((a, b) => a.property.localeCompare(b.property));
  }

  if (clip.emphasisAnimation?.type && clip.emphasisAnimation.type !== "none") {
    out.emphasis = clip.emphasisAnimation.type;
  }

  // ── Nested sequence identity ──
  // Both spellings, because both exist on the wire: see `compoundIdOfClip`.
  const seq = (clip.metadata?.compoundClipId as string | undefined)
    ?? (clip.mediaId?.startsWith("compound:") ? clip.mediaId.slice("compound:".length) : undefined);
  if (seq) out.sequenceId = seq;

  return out;
}

/**
 * Build the sources object from a live project store.
 *
 * Separate from `readClipLooks` so the pure function stays testable, and so
 * App.tsx has one call rather than four optional-chained reads inlined into a
 * message handler that is already long.
 */
export function readbackSourcesFrom(
  store: Record<string, unknown>,
  speedEngine?: { getClipSpeed?: (id: string) => number; isReverse?: (id: string) => boolean },
): ReadbackSources {
  return {
    getVideoEffects: (id) => {
      const fn = store.getVideoEffects as ((c: string) => any[]) | undefined;
      return typeof fn === "function" ? fn.call(store, id) : undefined;
    },
    getColorGrading: (id) => {
      const fn = store.getColorGrading as ((c: string) => Record<string, unknown>) | undefined;
      return typeof fn === "function" ? fn.call(store, id) : undefined;
    },
    getClipSpeed: (id) => speedEngine?.getClipSpeed?.(id),
    isReversed: (id) => speedEngine?.isReverse?.(id),
  };
}

/**
 * Transitions on a track, for the agent's state read.
 *
 * Kept here beside the clip readback because they answer the same question at
 * the next level up — "what has been done to this cut?" — and because a caller
 * that wants one almost always wants the other.
 */
export function readTrackTransitions(
  track: { transitions?: Array<Record<string, unknown>> },
): Array<{ id: string; type: string; duration: number; clipAId: string; clipBId?: string }> | undefined {
  const list = track.transitions ?? [];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.map((t) => ({
    id: String(t.id ?? ""),
    type: String(t.type ?? ""),
    duration: Number(t.duration ?? 0),
    clipAId: String(t.clipAId ?? ""),
    ...(t.clipBId ? { clipBId: String(t.clipBId) } : {}),
  }));
}

/** Every clip id that carries any applied work — for a project-level summary. */
export function summariseProjectLooks(
  project: Project,
  src: ReadbackSources = {},
): Record<string, ClipLooks> {
  const out: Record<string, ClipLooks> = {};
  for (const tr of project.timeline?.tracks ?? []) {
    for (const c of tr.clips ?? []) {
      const looks = readClipLooks(c, src);
      if (Object.keys(looks).length > 0) out[c.id] = looks;
    }
  }
  return out;
}
