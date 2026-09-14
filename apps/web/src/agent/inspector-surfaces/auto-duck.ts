/**
 * Duck the music under the voice — as an actual edit, not a panel that lies.
 *
 * ── WHY THIS SURFACE EXISTS ─────────────────────────────────────────────────
 * Two separate reasons, and both are worth stating because either alone would
 * have justified it.
 *
 * 1. THE INSPECTOR'S DUCKING SECTION DID NOTHING. `AudioDuckingSection`'s
 *    "Apply" handler sets a local React flag and bumps `project.modifiedAt`.
 *    It writes no automation, changes no gain, and touches no clip. A user who
 *    set a threshold, chose a preset and pressed Apply got a green tick and an
 *    unchanged mix.
 *
 * 2. THE AGENT WAS TOLD TO DO IT WITH NO WAY TO. The `episode-from-storyboard`
 *    playbook says music should be "ducked under narration". The primitive for
 *    that — `volume-automation`, which writes native volume keyframes the
 *    preview AND the export both read — has always existed, but using it for
 *    ducking means the model must gather every narration clip, convert their
 *    absolute times into music-clip-local times, and emit a correctly ordered
 *    envelope with attack and release ramps. That is precisely the class of
 *    arithmetic this codebase has already learned the LLM gets wrong: it is
 *    why `trim_silence` exists as a macro instead of leaving the agent to
 *    compute out-points. The same answer applies here.
 *
 * So: the agent picks the music clip and the depth; this computes the envelope.
 *
 * ── HOW IT DECIDES WHERE THE VOICE IS ───────────────────────────────────────
 * From the TIMELINE, not from the audio signal. Every speech clip on the
 * timeline already declares exactly when it plays, so a waveform analysis
 * would be a slower, less reliable way to learn something already known. It
 * also means ducking works before any audio has been decoded — which matters,
 * because a delegated production ducks immediately after placing narration.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 * Native `clip.keyframes` rows with `property === "volume"`, through the very
 * same `KeyframeEngine` + `updateClipKeyframes` path as `volume-automation`.
 * No parallel store, so the result is visible in the Inspector's Keyframes
 * panel, drawn on the timeline's volume overlay, undoable, saved in the
 * project blob, and present in the rendered MP4.
 */

import type { InspectorSurface, InspectorSurfaceClip, ApplyContext } from "./types";
import type { Keyframe } from "@openreel/core";

export interface AutoDuckConfig {
  /** Gain to duck DOWN to, as a fraction of the clip's normal level. Default 0.25. */
  duckTo?: number;
  /** Ramp down, seconds. Default 0.3. */
  attackSec?: number;
  /** Ramp back up, seconds. Default 0.5. */
  releaseSec?: number;
  /** Start ducking this long BEFORE the voice. Default 0.15 — a duck that
   *  begins exactly on the first syllable is heard as a stumble. */
  leadSec?: number;
  /** Hold the duck this long after the voice stops. Default 0.25. */
  tailSec?: number;
  /** Merge two speech ranges closer together than this, so the music does not
   *  pump up and down between sentences. Default 1.2. */
  mergeGapSec?: number;
  /** Duck against ONE specific track instead of every voice-named track.
   *  The Inspector's "source track" picker passes this. */
  againstTrackId?: string;
  /** Clear ducking instead of applying it. */
  clear?: boolean;
}

/** Tracks whose clips count as "voice" for the purpose of ducking. */
const VOICE_HINT = /narration|voice|vo\b|dialogue|speech|vocal/i;

interface Range { start: number; end: number }

/**
 * Speech ranges in ABSOLUTE timeline seconds.
 *
 * Exported for tests: the merge/clamp behaviour here is the part worth pinning
 * down, and it is pure.
 */
export function speechRangesFrom(
  project: { timeline?: { tracks?: Array<Record<string, unknown>> } },
  opts: { mergeGapSec: number; excludeTrackId?: string; onlyTrackId?: string },
): Range[] {
  const raw: Range[] = [];
  for (const tr of project.timeline?.tracks ?? []) {
    const t = tr as any;
    if (opts.excludeTrackId && t.id === opts.excludeTrackId) continue;
    if (t.muted === true) continue;
    // An explicitly chosen track is taken at its word — it does not have to be
    // NAMED like a voice track to be the one the user means.
    if (opts.onlyTrackId) {
      if (t.id !== opts.onlyTrackId) continue;
    } else {
      const hay = `${String(t.id ?? "")} ${String(t.name ?? "")}`;
      if (!VOICE_HINT.test(hay)) continue;
    }
    for (const c of t.clips ?? []) {
      if (c?.muted === true) continue;
      const start = Number(c?.startTime);
      const dur = Number(c?.duration);
      if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
      raw.push({ start, end: start + dur });
    }
  }
  if (raw.length === 0) return [];

  raw.sort((a, b) => a.start - b.start);
  const merged: Range[] = [raw[0]];
  for (const r of raw.slice(1)) {
    const last = merged[merged.length - 1];
    // A gap shorter than mergeGapSec is a breath between sentences, not a
    // place to bring the music back up and drop it again.
    if (r.start - last.end <= opts.mergeGapSec) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Turn speech ranges into a volume envelope in CLIP-LOCAL seconds.
 *
 * Pure, and separated from the store on purpose — the geometry is the part
 * that has to be right, and it can be checked without a project.
 */
export function duckEnvelope(
  speech: Range[],
  music: { startTime: number; duration: number },
  cfg: Required<Omit<AutoDuckConfig, "clear" | "againstTrackId">>,
): Array<{ time: number; value: number }> {
  const clipStart = music.startTime;
  const clipEnd = music.startTime + music.duration;
  const points: Array<{ time: number; value: number }> = [];

  const local = (abs: number) => Math.max(0, Math.min(music.duration, abs - clipStart));

  // Only the speech that actually overlaps this clip matters; a narration clip
  // an hour later must not put a keyframe on this one.
  const overlapping = speech
    .filter((s) => s.end > clipStart && s.start < clipEnd)
    .map((s) => ({
      start: s.start - cfg.leadSec,
      end: s.end + cfg.tailSec,
    }));
  if (overlapping.length === 0) return [];

  // Re-merge: lead/tail padding can make neighbours overlap.
  const padded: Range[] = [overlapping[0]];
  for (const r of overlapping.slice(1)) {
    const last = padded[padded.length - 1];
    if (r.start <= last.end) last.end = Math.max(last.end, r.end);
    else padded.push({ ...r });
  }

  const push = (time: number, value: number) => {
    const t = Number(time.toFixed(3));
    // Two keyframes at the same instant make the ramp ambiguous; the later
    // write wins, which is what a ramp arriving at a held value should do.
    const existing = points.find((p) => Math.abs(p.time - t) < 1e-3);
    if (existing) existing.value = value;
    else points.push({ time: t, value: Number(value.toFixed(4)) });
  };

  // Start at full level unless the clip opens already inside speech.
  const opensDucked = padded[0].start <= clipStart;
  push(0, opensDucked ? cfg.duckTo : 1);

  for (const r of padded) {
    const downStart = local(r.start);
    const downEnd = local(r.start + cfg.attackSec);
    const upStart = local(r.end);
    const upEnd = local(r.end + cfg.releaseSec);

    if (r.start > clipStart) {
      push(downStart, 1);
      push(downEnd, cfg.duckTo);
    }
    if (r.end < clipEnd) {
      push(upStart, cfg.duckTo);
      push(upEnd, 1);
    } else {
      // Speech runs past the end of the music: stay ducked to the last frame
      // rather than ramping up over silence that is not there.
      push(music.duration, cfg.duckTo);
    }
  }

  return points.sort((a, b) => a.time - b.time);
}

const DEFAULTS: Required<Omit<AutoDuckConfig, "clear" | "againstTrackId">> = {
  duckTo: 0.25,
  attackSec: 0.3,
  releaseSec: 0.5,
  leadSec: 0.15,
  tailSec: 0.25,
  mergeGapSec: 1.2,
};

export const surface: InspectorSurface<AutoDuckConfig> = {
  name: "auto-duck",
  description:
    "Duck this music/ambience clip under the voice automatically. Finds every narration/dialogue clip on the timeline, and writes a real volume envelope (native volume keyframes — visible in the Inspector, on the timeline, and in the export) with attack/release ramps. Use this for \"put the music under the voiceover\" instead of computing keyframes by hand. clear:true removes it.",
  appliesTo: ["audio"],
  schema: {
    type: "object",
    properties: {
      duckTo: {
        type: "number", minimum: 0, maximum: 1,
        description: "Level under the voice, as a fraction of normal. Default 0.25. Use 0.15 for a dense voiceover, 0.4 when the music should stay present.",
      },
      attackSec: { type: "number", minimum: 0, maximum: 3, description: "Ramp down. Default 0.3." },
      releaseSec: { type: "number", minimum: 0, maximum: 5, description: "Ramp back up. Default 0.5 — longer than the attack, which is what sounds natural." },
      leadSec: { type: "number", minimum: 0, maximum: 2, description: "Begin ducking this long before the voice. Default 0.15." },
      tailSec: { type: "number", minimum: 0, maximum: 3, description: "Hold the duck this long after the voice. Default 0.25." },
      mergeGapSec: { type: "number", minimum: 0, maximum: 10, description: "Treat voice clips closer than this as one passage, so the music does not pump between sentences. Default 1.2." },
      againstTrackId: { type: "string", description: "Duck against ONE track id instead of auto-detecting every narration/dialogue track. Rarely needed." },
      clear: { type: "boolean", description: "Remove volume automation from this clip instead of ducking." },
    },
    additionalProperties: false,
  },

  apply: async (clip: InspectorSurfaceClip, config: AutoDuckConfig, ctx: ApplyContext) => {
    const raw = clip.raw as any;
    const duration = Number(raw?.duration);
    const startTime = Number(raw?.startTime);
    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, error: "clip has no duration" };
    }

    const { KeyframeEngine } = await import("@openreel/core");
    const { useProjectStore } = await import("../../stores/project-store");
    const existing: Keyframe[] = raw?.keyframes ?? [];
    const others = existing.filter((k) => k.property !== "volume");

    if (config.clear === true) {
      useProjectStore.getState().updateClipKeyframes(clip.id, others);
      return { ok: true, note: "ducking cleared" };
    }

    const cfg: Required<Omit<AutoDuckConfig, "clear" | "againstTrackId">> = {
      duckTo: typeof config.duckTo === "number" ? Math.max(0, Math.min(1, config.duckTo)) : DEFAULTS.duckTo,
      attackSec: typeof config.attackSec === "number" ? Math.max(0, config.attackSec) : DEFAULTS.attackSec,
      releaseSec: typeof config.releaseSec === "number" ? Math.max(0, config.releaseSec) : DEFAULTS.releaseSec,
      leadSec: typeof config.leadSec === "number" ? Math.max(0, config.leadSec) : DEFAULTS.leadSec,
      tailSec: typeof config.tailSec === "number" ? Math.max(0, config.tailSec) : DEFAULTS.tailSec,
      mergeGapSec: typeof config.mergeGapSec === "number" ? Math.max(0, config.mergeGapSec) : DEFAULTS.mergeGapSec,
    };

    const speech = speechRangesFrom(ctx.project as never, {
      mergeGapSec: cfg.mergeGapSec,
      excludeTrackId: clip.trackId,
      onlyTrackId: config.againstTrackId,
    });
    if (speech.length === 0) {
      // Say so rather than writing a flat envelope that looks like success.
      return {
        ok: false,
        error: "no narration/dialogue clips found to duck against — name the voice track \"narration\" or place the voiceover first",
      };
    }

    const points = duckEnvelope(speech, { startTime, duration }, cfg);
    if (points.length === 0) {
      return { ok: false, error: "no voice overlaps this clip — nothing to duck against here" };
    }

    const engine = new KeyframeEngine();
    const fresh = points.map((p) =>
      engine.addKeyframe(clip.id, "volume", p.time, p.value, "linear"),
    );
    const merged = [...others, ...fresh].sort((a, b) => a.time - b.time);
    useProjectStore.getState().updateClipKeyframes(clip.id, merged);

    return {
      ok: true,
      note: `ducked to ${Math.round(cfg.duckTo * 100)}% under ${speech.length} voice passage(s), ${points.length} keyframes`,
    };
  },

  read: (clip) => {
    const kfs: Keyframe[] = (clip.raw as any)?.keyframes ?? [];
    const vol = kfs.filter((k) => k.property === "volume");
    if (vol.length === 0) return null;
    const values = vol.map((k) => Number(k.value)).filter((v) => Number.isFinite(v));
    return {
      volumeKeyframes: vol.length,
      // The floor is what "how far is it ducked" means to a person.
      duckedTo: values.length ? Number(Math.min(...values).toFixed(3)) : null,
      peak: values.length ? Number(Math.max(...values).toFixed(3)) : null,
    };
  },
};
