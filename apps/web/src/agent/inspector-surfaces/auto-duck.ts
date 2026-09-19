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
 * From the WAVEFORM by default, and from the timeline when it cannot.
 *
 * This used to read the timeline only, on the reasoning that every speech clip
 * already declares when it plays, so analysing audio would be a slower way to
 * learn a known thing. That holds only while there is roughly one clip per line.
 * A generated audio episode is the opposite: four characters, seventy seconds,
 * ONE clip. "Duck under the voice" then means duck from the first word to the
 * last — a flat gain reduction that never dips, so the score sits at a constant
 * level over every line. It reported success every time, and the music never
 * moved once.
 *
 * So the default is now to run `AudioEngine.detectSilence` over the voice clip
 * (the same analysis behind "cut the dead air") and invert it to get the real
 * lines. When the media is not decodable here — bytes still only in the browser,
 * a codec the AudioContext refuses — it falls back to clip extents and SAYS so
 * in its note, so a downgrade is never silent. `analyze: false` asks for the old
 * behaviour explicitly.
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
  /** Read the voice track's WAVEFORM to find the real lines instead of using
   *  the clip's start/end. Default true. Set false for the old behaviour. */
  analyze?: boolean;
  /** Anything under this is a pause, not a line. Default -45 dBFS. */
  silenceThresholdDb?: number;
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
  return mergeRanges(
    voiceClipsFrom(project, opts).map((c) => ({
      start: c.startTime,
      end: c.startTime + c.duration,
    })),
    opts.mergeGapSec,
  );
}

/** One voice clip, with what is needed to go and read its audio. */
export interface VoiceClip {
  clipId: string;
  mediaId: string;
  startTime: number;
  duration: number;
  inPoint: number;
  outPoint: number;
}

/**
 * The voice CLIPS themselves, before they are flattened to ranges.
 *
 * Same track selection as `speechRangesFrom` — which is now written in terms of
 * this — because the waveform path needs the clip's `mediaId` and `inPoint` to
 * map analysis time back onto the timeline, and a second copy of the role/name
 * rules would drift from this one the first time either changed.
 */
export function voiceClipsFrom(
  project: { timeline?: { tracks?: Array<Record<string, unknown>> } },
  opts: { excludeTrackId?: string; onlyTrackId?: string },
): VoiceClip[] {
  const out: VoiceClip[] = [];
  for (const tr of project.timeline?.tracks ?? []) {
    const t = tr as any;
    if (opts.excludeTrackId && t.id === opts.excludeTrackId) continue;
    if (t.muted === true) continue;
    // An explicitly chosen track is taken at its word — it does not have to be
    // NAMED like a voice track to be the one the user means.
    if (opts.onlyTrackId) {
      if (t.id !== opts.onlyTrackId) continue;
    } else {
      /**
       * ROLE FIRST, NAME ONLY AS A FALLBACK.
       *
       * Matching on text was how a voice sitting on "Audio 1" became invisible
       * to this — no error, just music that never ducked. `Track.role` says
       * what a track IS, so a dialogue track is found whatever it is called and
       * a music track called "Dialogue stem" is not mistaken for one.
       *
       * The name test stays for every project written before roles existed,
       * which is all of them. Same shape upstream uses for captions:
       * `track.role === "captions" || track.name === "Captions"`.
       */
      const role = String(t.role ?? "");
      if (role) {
        if (role !== "dialogue") continue;
      } else {
        const hay = `${String(t.id ?? "")} ${String(t.name ?? "")}`;
        if (!VOICE_HINT.test(hay)) continue;
      }
    }
    for (const c of t.clips ?? []) {
      if (c?.muted === true) continue;
      const start = Number(c?.startTime);
      const dur = Number(c?.duration);
      if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
      const inPoint = Number(c?.inPoint);
      const outPoint = Number(c?.outPoint);
      out.push({
        clipId: String(c?.id ?? ""),
        mediaId: String(c?.mediaId ?? ""),
        startTime: start,
        duration: dur,
        inPoint: Number.isFinite(inPoint) ? inPoint : 0,
        outPoint: Number.isFinite(outPoint)
          ? outPoint
          : (Number.isFinite(inPoint) ? inPoint : 0) + dur,
      });
    }
  }
  return out;
}

/** Sort, then fold together anything closer than `mergeGapSec`. */
export function mergeRanges(raw: Range[], mergeGapSec: number): Range[] {
  if (raw.length === 0) return [];
  raw = raw.map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const merged: Range[] = [raw[0]];
  for (const r of raw.slice(1)) {
    const last = merged[merged.length - 1];
    // A gap shorter than mergeGapSec is a breath between sentences, not a
    // place to bring the music back up and drop it again.
    if (r.start - last.end <= mergeGapSec) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * WHERE THE VOICE ACTUALLY IS, from the waveform rather than the clip edges.
 *
 * ── WHY THE CLIP RECTANGLE IS NOT ENOUGH ────────────────────────────────────
 * `speechRangesFrom` treats a voice clip as speech from its first frame to its
 * last, which is right when a project has one clip per line and hopeless when it
 * has one clip for the whole episode. An audio drama generated in a single pass
 * is exactly that: 72 seconds of four characters with pauses between every line,
 * arriving as ONE clip. Ducking "under the voice" then means ducking for the
 * entire episode — a flat gain reduction, never a dip, so the score sits at a
 * constant level over every word and the dialogue fights it the whole way.
 * Measured: the music never moved once, and lines were genuinely hard to hear.
 *
 * `AudioEngine.detectSilence` already finds the quiet stretches inside a buffer
 * — it is what "cut the dead air" runs on. Inverting its answer gives the real
 * speech intervals, and those go into the SAME `duckEnvelope` below, so attack,
 * release, lead, tail and merge behave exactly as they always have and the 18
 * tests that pin that geometry still describe it.
 *
 * Pure, and takes the silence list as an argument, so the mapping can be checked
 * without decoding anything.
 *
 * @param silent   quiet ranges in MEDIA time, as detectSilence returns them
 * @param clip     the voice clip those ranges came from
 * @returns        speech ranges in ABSOLUTE timeline seconds
 */
export function speechFromSilence(
  silent: Range[],
  clip: { startTime: number; duration: number; inPoint: number },
  opts: { minSpeechSec?: number } = {},
): Range[] {
  const minSpeech = opts.minSpeechSec ?? 0.12;
  const inPoint = clip.inPoint;
  const outPoint = inPoint + clip.duration;

  // Only the silence that falls inside the part of the media this clip plays.
  const inside = silent
    .map((s) => ({
      start: Math.max(s.start, inPoint),
      end: Math.min(s.end, outPoint),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  // Speech is the complement of silence across [inPoint, outPoint].
  const speechMedia: Range[] = [];
  let cursor = inPoint;
  for (const s of inside) {
    if (s.start > cursor) speechMedia.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < outPoint) speechMedia.push({ start: cursor, end: outPoint });

  return speechMedia
    // A blip shorter than a syllable is a click or a breath, not a line; ducking
    // for it is the pumping this is supposed to avoid.
    .filter((r) => r.end - r.start >= minSpeech)
    // Media time → timeline time. The clip plays `inPoint` at `startTime`.
    .map((r) => ({
      start: clip.startTime + (r.start - inPoint),
      end: clip.startTime + (r.end - inPoint),
    }));
}

/**
 * Turn speech ranges into a volume envelope in CLIP-LOCAL seconds.
 *
 * Pure, and separated from the store on purpose — the geometry is the part
 * that has to be right, and it can be checked without a project.
 */
/**
 * What the envelope geometry needs — and nothing about HOW the speech ranges
 * were found. Keeping analysis options out of here is what lets the waveform
 * path reuse this function untouched.
 */
export type DuckGeometry = Pick<
  Required<AutoDuckConfig>,
  "duckTo" | "attackSec" | "releaseSec" | "leadSec" | "tailSec" | "mergeGapSec"
>;

export function duckEnvelope(
  speech: Range[],
  music: { startTime: number; duration: number },
  cfg: DuckGeometry,
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
  /**
   * 0.45s, not the 1.2s a clip-per-line project wants.
   *
   * With waveform analysis the gaps are REAL pauses between spoken lines, and
   * those run 0.4-0.9s in ordinary delivery. Folding them away at 1.2s would
   * hand back the same flat duck the analysis exists to avoid; 0.45s lets the
   * score lift between lines and still refuses to pump between words.
   */
  mergeGapSec: 0.45,
  analyze: true,
  silenceThresholdDb: -45,
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
      analyze: { type: "boolean", description: "Find the real lines by reading the voice track's waveform rather than using the clip's start/end. Default true — required when the whole episode is ONE voice clip, which would otherwise duck flat from first word to last." },
      silenceThresholdDb: { type: "number", minimum: -90, maximum: 0, description: "Below this is a pause, not a line. Default -45." },
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
      analyze: config.analyze !== false,
      silenceThresholdDb:
        typeof config.silenceThresholdDb === "number" ? config.silenceThresholdDb : DEFAULTS.silenceThresholdDb,
    };

    /**
     * LISTEN TO THE VOICE TRACK IF WE CAN, AND FALL BACK TO ITS EDGES IF NOT.
     *
     * Analysis is the default because the case it fixes — one long voice clip —
     * is the normal shape for a generated episode, and the failure it produces
     * (a flat gain that never dips) looks like working ducking right up until
     * someone cannot hear a line. `analyze: false` keeps the old rectangle
     * behaviour for anyone who wants it.
     *
     * Every failure path here falls back rather than throwing: media kept only
     * in the browser, a codec the AudioContext will not decode, an OfflineAudio
     * context that will not start. A duck from clip edges is worse than one from
     * the waveform and far better than no duck at all — and the note says which
     * one you got, so it is never a silent downgrade.
     */
    const analyse = config.analyze !== false;
    let speech: Range[] = [];
    let speechSource = "clip extents";

    if (analyse) {
      try {
        const voices = voiceClipsFrom(ctx.project as never, {
          excludeTrackId: clip.trackId,
          onlyTrackId: config.againstTrackId,
        });
        const store = useProjectStore.getState() as any;
        const engine = (await import("@openreel/core")).getAudioEngine();
        const ac: AudioContext = new AudioContext();
        try {
          const { rewriteToProxy } = await import("@openreel/core");
          const found: Range[] = [];
          for (const v of voices) {
            const media = store.getMediaItem?.(v.mediaId);
            /**
             * GENERATED NARRATION HAS NO BLOB.
             *
             * Voidspace TTS, music and Kie renders arrive as a remote
             * `originalUrl` with `blob: null` — the bytes were never in
             * IndexedDB, or autosave stripped them (autosave is JSON). Reading
             * only `blob` would therefore find nothing for precisely the clip
             * this analysis exists to inspect, and fall back to the flat duck
             * without a word. Playback and export both hydrate from
             * `originalUrl` through the CORS proxy; so does this, for the same
             * reason — most of those hosts serve no CORS headers and a direct
             * cross-origin fetch is hard-blocked.
             */
            let bytes: ArrayBuffer | null = null;
            if (media?.blob instanceof Blob && media.blob.size > 0) {
              bytes = await media.blob.arrayBuffer();
            } else if (media?.originalUrl) {
              const resp = await fetch(rewriteToProxy(media.originalUrl), { mode: "cors" });
              if (resp.ok) bytes = await resp.arrayBuffer();
            }
            if (!bytes || bytes.byteLength === 0) continue;
            const buf = await ac.decodeAudioData(bytes);
            const silent = engine.detectSilence(buf, cfg.silenceThresholdDb);
            found.push(...speechFromSilence(silent, v));
          }
          if (found.length > 0) {
            speech = mergeRanges(found, cfg.mergeGapSec);
            speechSource = "waveform";
          }
        } finally {
          try { await ac.close(); } catch { /* already closed */ }
        }
      } catch {
        // fall through to clip extents
      }
    }

    if (speech.length === 0) {
      speech = speechRangesFrom(ctx.project as never, {
        mergeGapSec: cfg.mergeGapSec,
        excludeTrackId: clip.trackId,
        onlyTrackId: config.againstTrackId,
      });
    }
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

    /**
     * DUCK RELATIVE TO THE CLIP'S OWN LEVEL, NOT TO UNITY.
     *
     * `duckEnvelope` is normalised: 1 where the music plays out, `duckTo` where
     * the voice is. That is the right shape to test and the wrong thing to write
     * directly, because a volume KEYFRAME overrides `clip.volume` rather than
     * scaling it. So ducking a score already mixed to 0.2 wrote 1.0 between the
     * lines — the music jumping to full level in every gap, 14 dB above where
     * the mix had it, and only in the gaps, which reads as the track surging
     * rather than as a fault.
     *
     * Multiplying by the clip's base gain gives "duck THIS clip to 25% of where
     * it sits", which is what the control says and what a mixer would expect.
     */
    const baseGain = Number.isFinite(Number(raw?.volume)) ? Number(raw.volume) : 1;
    const engine = new KeyframeEngine();
    const fresh = points.map((p) =>
      engine.addKeyframe(
        clip.id,
        "volume",
        p.time,
        Number((p.value * baseGain).toFixed(4)),
        "linear",
      ),
    );
    const merged = [...others, ...fresh].sort((a, b) => a.time - b.time);
    useProjectStore.getState().updateClipKeyframes(clip.id, merged);

    return {
      ok: true,
      note: `ducked to ${Math.round(cfg.duckTo * 100)}% of ${baseGain} under ${speech.length} voice passage(s) found from ${speechSource}, ${points.length} keyframes`,
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
