/**
 * Volume automation surface — fades + volume rubber-band keyframes for
 * audio (and video-with-embedded-audio) clips. This is what lets chat do
 * "fade the music out over the last 3 seconds" or "duck the music to 30%
 * under the voiceover".
 *
 * Routes through the action-executor (`audio/setFade`, `audio/addAutomation`)
 * exactly like the audio-mix surface, so edits enter ActionHistory, survive
 * snapshot restore, and are honored by the realtime gain envelope + render.
 * Auto-discovered by inspector-surfaces/index.ts — no registration needed.
 *
 * Point semantics: time = seconds from the clip's start; value = absolute
 * gain (1 = unity, 0 = silent, up to 4). The agent should read current
 * fade/automation via read_tracks before adjusting.
 */

import type { InspectorSurface } from "./types";

export interface VolumeAutomationConfig {
  /** Fade-in length in seconds (from clip start). */
  fadeIn?: number;
  /** Fade-out length in seconds (to clip end). */
  fadeOut?: number;
  /** Replace the clip's volume rubber-band with these keyframes. An empty
   *  array clears automation (revert to the flat clip volume). */
  automationPoints?: Array<{ time: number; value: number }>;
}

const aid = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export const surface: InspectorSurface<VolumeAutomationConfig> = {
  name: "volume-automation",
  description:
    "Audio fades + volume automation (rubber-band keyframes) for audio/video clips. fadeIn/fadeOut are seconds; automationPoints=[{time:secondsFromClipStart, value:gain(1=unity,0=silent,max4)}] shape volume over time (e.g. duck music under a voiceover, fade a track out). An empty automationPoints array clears automation. Undoable. Read current values via read_tracks first.",
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
            value: { type: "number", minimum: 0, maximum: 4 },
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

    if (Array.isArray(config.automationPoints)) {
      const points = config.automationPoints
        .map((p) => ({ time: Math.max(0, p.time), value: Math.max(0, Math.min(4, p.value)) }))
        .sort((a, b) => a.time - b.time);
      const r = await exec.execute(
        { type: "audio/addAutomation", id: aid("auto"), timestamp: Date.now(), params: { clipId: clip.id, points } },
        store.project,
      );
      if (r?.success) didAny = true;
      else errors.push(`addAutomation: ${r?.error?.message ?? "failed"}`);
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
          ? `${config.automationPoints.length} automation pts`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    };
  },
};
