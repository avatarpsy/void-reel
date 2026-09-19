/**
 * Volume automation surface — fades + volume keyframes for audio (and
 * video-with-embedded-audio) clips. This is what lets chat do "fade the
 * music out over the last 3 seconds" or "duck the music to 30% under the
 * voiceover".
 *
 * ┌─ SINGLE SOURCE OF TRUTH ───────────────────────────────────────────┐
 * │ `automationPoints` writes NATIVE openreel volume keyframes —         │
 * │ `clip.keyframes` rows with `property === "volume"` (value = gain,    │
 * │ 1 = unity, range 0–2) — the same rows the Inspector's Keyframes      │
 * │ panel and the timeline VOL overlay read. There is NO parallel        │
 * │ automation store. This is why a fade/duck the agent applies shows up │
 * │ in the Inspector and on the timeline, and survives save/load.        │
 * │                                                                     │
 * │ Written through the ACTION EXECUTOR (`keyframe/remove` + `keyframe/  │
 * │ add`), not `updateClipKeyframes`. That method is a bare `set()` with │
 * │ no history entry, so the curve could not be undone while the fade    │
 * │ beside it could — one Ctrl+Z took back half a change and left a mix  │
 * │ in a state nobody had chosen.                                       │
 * │                                                                     │
 * │ For animating non-audio properties (opacity, scale, …) use the      │
 * │ `clip-properties` keyframe path; both converge on clip.keyframes.   │
 * │                                                                     │
 * │ `fadeIn` / `fadeOut` are a DISTINCT native concept (`clip.fade`,     │
 * │ an extra gain ramp the audio engine applies) set via the undoable    │
 * │ `audio/setFade` action — not keyframes.                             │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Auto-discovered by inspector-surfaces/index.ts — no registration needed.
 *
 * Point semantics: time = seconds from the clip's start; value = absolute
 * gain (1 = unity, 0 = silent, up to 2). The agent should read current
 * fade/keyframes via read_tracks before adjusting.
 */

import type { InspectorSurface } from "./types";
import type { Keyframe } from "@openreel/core";

export interface VolumeAutomationConfig {
  /** Fade-in length in seconds (from clip start). */
  fadeIn?: number;
  /** Fade-out length in seconds (to clip end). */
  fadeOut?: number;
  /** Replace the clip's VOLUME keyframes with these. An empty array clears
   *  them (revert to the flat clip volume). value = gain (1 = unity). */
  automationPoints?: Array<{ time: number; value: number }>;
}

const aid = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export const surface: InspectorSurface<VolumeAutomationConfig> = {
  name: "volume-automation",
  description:
    "Audio fades + volume keyframes for audio/video clips. fadeIn/fadeOut are seconds; automationPoints=[{time:secondsFromClipStart, value:gain(1=unity,0=silent,max2)}] vary volume over time (e.g. duck music under a voiceover, fade a track out). These are NATIVE volume keyframes (same ones shown in the Inspector Keyframes panel and on the timeline). An empty automationPoints array clears the volume keyframes. Undoable. Read current values via read_tracks first.",
  appliesTo: ["audio", "video"],
  schema: {
    type: "object",
    properties: {
      fadeIn: { type: "number", minimum: 0 },
      fadeOut: { type: "number", minimum: 0 },
      automationPoints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            time: { type: "number", minimum: 0 },
            value: { type: "number", minimum: 0, maximum: 2 },
          },
          required: ["time", "value"],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
    anyOf: [
      { required: ["fadeIn"] },
      { required: ["fadeOut"] },
      { required: ["automationPoints"] },
    ],
  },
  apply: async (clip, config, ctx) => {
    const store = ctx.store as any;
    const exec = store.actionExecutor;
    if (!exec || typeof exec.execute !== "function") {
      return { ok: false, error: "actionExecutor not available on store" };
    }
    const errors: string[] = [];
    let didAny = false;

    // ── Fades: distinct native clip.fade concept (audio/setFade action) ──
    if (typeof config.fadeIn === "number" || typeof config.fadeOut === "number") {
      const cur = (clip.raw as { fade?: { fadeIn?: number; fadeOut?: number } })?.fade ?? {};
      const params = {
        clipId: clip.id,
        fadeIn: typeof config.fadeIn === "number" ? Math.max(0, config.fadeIn) : cur.fadeIn ?? 0,
        fadeOut: typeof config.fadeOut === "number" ? Math.max(0, config.fadeOut) : cur.fadeOut ?? 0,
      };
      const r = await exec.execute(
        { type: "audio/setFade", id: aid("fade"), timestamp: Date.now(), params },
        store.project,
      );
      if (r?.success) didAny = true;
      else errors.push(`setFade: ${r?.error?.message ?? "failed"}`);
    }

    // ── Volume keyframes: NATIVE clip.keyframes (property "volume") ──
    // Every non-volume keyframe on the clip is left alone — the remove pass
    // below is scoped to `property: "volume"`, so an opacity or scale curve on
    // the same clip survives a volume edit. NOT the legacy audio/addAutomation
    // action (that wrote a parallel clip.automation.volume nothing reads).
    if (Array.isArray(config.automationPoints)) {
      /**
       * ── THROUGH THE EXECUTOR, BECAUSE A MIX MUST BE UNDOABLE ──────────────
       *
       * This wrote through `updateClipKeyframes`, which is a bare `set()` on
       * the store with no history entry — so fades (which go through
       * `audio/setFade` above) could be undone and the volume curve beside them
       * could not. One Ctrl+Z took back half a change, and the surface's own
       * description said "Undoable", which made it worse: a person who trusted
       * that and hit undo got a mix in a state nobody had ever chosen.
       *
       * `keyframe/add` and `keyframe/remove` already exist, already have
       * inverse generators, and are what the Inspector's own Keyframes panel
       * goes through. Replacing the volume curve is a remove of what is there
       * followed by an add of what replaces it, so the whole edit lands as one
       * run of undoable actions rather than an invisible mutation.
       */
      const existing: Keyframe[] =
        (clip.raw as { keyframes?: Keyframe[] })?.keyframes ?? [];
      const oldVolume = existing.filter((k) => k.property === "volume");

      for (const kf of oldVolume) {
        const r = await exec.execute(
          {
            type: "keyframe/remove",
            id: aid("kf-rm"),
            timestamp: Date.now(),
            params: { clipId: clip.id, property: "volume", time: kf.time },
          },
          store.project,
        );
        if (!r?.success) errors.push(`keyframe/remove@${kf.time}: ${r?.error?.message ?? "failed"}`);
      }

      const points = config.automationPoints
        .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
        .sort((a, b) => a.time - b.time);
      for (const p of points) {
        const r = await exec.execute(
          {
            type: "keyframe/add",
            id: aid("kf-add"),
            timestamp: Date.now(),
            params: {
              clipId: clip.id,
              property: "volume",
              time: Math.max(0, p.time),
              value: Math.max(0, Math.min(2, p.value)),
            },
          },
          store.project,
        );
        if (r?.success) didAny = true;
        else errors.push(`keyframe/add@${p.time}: ${r?.error?.message ?? "failed"}`);
      }
      // An empty array CLEARS the curve, which is a real edit even though it
      // adds nothing — the removes above are the whole change.
      if (!points.length && oldVolume.length) didAny = true;
    }

    if (didAny) {
      const projectStoreModule = await import("../../stores/project-store");
      projectStoreModule.useProjectStore.setState({
        project: { ...store.project, modifiedAt: Date.now() },
      });
    }
    if (errors.length && !didAny) return { ok: false, error: errors.join("; ") };
    return {
      ok: true,
      note: [
        typeof config.fadeIn === "number" ? `fadeIn=${config.fadeIn}s` : null,
        typeof config.fadeOut === "number" ? `fadeOut=${config.fadeOut}s` : null,
        Array.isArray(config.automationPoints)
          ? `${config.automationPoints.length} volume keyframe(s)`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    };
  },
  /**
   * READ THE TWO PLACES `apply` ACTUALLY WRITES.
   *
   * ── WHY THIS WAS EMPTY FOREVER ──────────────────────────────────────────
   * It used to read `clip.automation.volume` — the LEGACY parallel array that
   * `apply` deliberately stopped writing (see the comment above: playback no
   * longer reads it). So the readback could not return a value no matter what
   * was set: fades landed on `clip.fade`, volume curves landed on
   * `clip.keyframes` with `property: "volume"`, and the reader looked at
   * neither. Measured live: set fadeIn 0.8 / fadeOut 1.2, tool answers
   * `ok: "fadeIn=0.8s fadeOut=1.2s"`, readback `null`.
   *
   * A readback that cannot succeed is worse than no readback: `readable: true`
   * tells the agent this surface can be inspected, so an empty answer reads as
   * "nothing is set" and invites it to apply the same fade again.
   *
   * Neutral values are omitted so an untouched clip reads `null`.
   */
  read: (clip) => {
    const raw = clip.raw as {
      fade?: { fadeIn?: number; fadeOut?: number };
      keyframes?: Keyframe[];
    };
    const out: Record<string, unknown> = {};

    const fadeIn = Number(raw?.fade?.fadeIn);
    const fadeOut = Number(raw?.fade?.fadeOut);
    if (Number.isFinite(fadeIn) && fadeIn > 0) out.fadeIn = fadeIn;
    if (Number.isFinite(fadeOut) && fadeOut > 0) out.fadeOut = fadeOut;

    const points = (raw?.keyframes ?? [])
      .filter((k) => k.property === "volume")
      .map((k) => ({ time: Number(k.time), value: Number(k.value) }))
      .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
      .sort((a, b) => a.time - b.time);
    if (points.length > 0) out.points = points;

    return Object.keys(out).length > 0 ? out : null;
  },
};
