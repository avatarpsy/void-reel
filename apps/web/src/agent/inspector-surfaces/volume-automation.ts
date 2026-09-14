/**
 * Volume automation surface — fades + volume keyframes for audio (and
 * video-with-embedded-audio) clips. This is what lets chat do "fade the
 * music out over the last 3 seconds" or "duck the music to 30% under the
 * voiceover".
 *
 * ┌─ SINGLE SOURCE OF TRUTH ───────────────────────────────────────────┐
 * │ `automationPoints` writes NATIVE openreel volume keyframes —         │
 * │ `clip.keyframes` rows with `property === "volume"` (value = gain,    │
 * │ 1 = unity, range 0–2) — via the SAME `KeyframeEngine` +             │
 * │ `updateClipKeyframes` path used by the Inspector's Keyframes panel   │
 * │ and the timeline VOL overlay. There is NO parallel automation store. │
 * │ This is why a fade/duck the agent applies shows up in the Inspector  │
 * │ and on the timeline, and survives save/load.                        │
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
    // Mirror the Inspector/timeline exactly: build rows with the shared
    // KeyframeEngine, preserve every non-volume keyframe, and commit via
    // updateClipKeyframes. NOT the legacy audio/addAutomation action (that
    // wrote a parallel clip.automation.volume the playback no longer reads).
    if (Array.isArray(config.automationPoints)) {
      const { KeyframeEngine } = await import("@openreel/core");
      const engine = new KeyframeEngine();
      const existing: Keyframe[] =
        (clip.raw as { keyframes?: Keyframe[] })?.keyframes ?? [];
      const others = existing.filter((k) => k.property !== "volume");
      const fresh = config.automationPoints
        .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
        .map((p) =>
          engine.addKeyframe(
            clip.id,
            "volume",
            Math.max(0, p.time),
            Math.max(0, Math.min(2, p.value)),
            "linear",
          ),
        );
      const merged = [...others, ...fresh].sort((a, b) => a.time - b.time);
      const projectStoreModule = await import("../../stores/project-store");
      projectStoreModule.useProjectStore.getState().updateClipKeyframes(clip.id, merged);
      didAny = true;
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
  read: (clip) => {
    const pts = (clip.raw as any).automation?.volume ?? [];
    return Array.isArray(pts) && pts.length > 0 ? { points: pts } : null;
  },
};
