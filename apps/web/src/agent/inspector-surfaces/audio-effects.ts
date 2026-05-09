/**
 * Audio effects surface — add/update/remove/toggle effects (EQ, reverb,
 * compression, etc.) on audio + video-with-audio clips.
 *
 * Direct wraps the project-store's audio-effects methods. Each call is
 * one of: { op: "add", effect } | { op: "update", effectId, params } |
 * { op: "remove", effectId } | { op: "toggle", effectId, enabled }.
 */

import type { InspectorSurface } from "./types";

export interface AudioEffectsConfig {
  op: "add" | "update" | "remove" | "toggle";
  effect?: Record<string, unknown>;
  effectId?: string;
  params?: Record<string, unknown>;
  enabled?: boolean;
}

export const surface: InspectorSurface<AudioEffectsConfig> = {
  name: "audio-effects",
  description: "Add/update/remove/toggle audio effects (EQ, reverb, compression, etc.) on a clip. One operation per call.",
  appliesTo: ["audio", "video"],
  schema: {
    type: "object",
    required: ["op"],
    properties: {
      op: { enum: ["add", "update", "remove", "toggle"] },
      effect: { type: "object", description: "Effect object for op=add (shape per Effect type)." },
      effectId: { type: "string", description: "Effect id for op=update/remove/toggle." },
      params: { type: "object", description: "Param overrides for op=update." },
      enabled: { type: "boolean", description: "Enabled flag for op=toggle." },
    },
    additionalProperties: false,
  },
  apply: (clip, config, ctx) => {
    const store = ctx.store as any;
    let ok: boolean | undefined;
    try {
      switch (config.op) {
        case "add":
          if (!config.effect) return { ok: false, error: "op=add requires effect" };
          ok = !!store.addAudioEffect?.(clip.id, config.effect);
          break;
        case "update":
          if (!config.effectId) return { ok: false, error: "op=update requires effectId" };
          ok = !!store.updateAudioEffect?.(clip.id, config.effectId, config.params ?? {});
          break;
        case "remove":
          if (!config.effectId) return { ok: false, error: "op=remove requires effectId" };
          ok = !!store.removeAudioEffect?.(clip.id, config.effectId);
          break;
        case "toggle":
          if (!config.effectId || typeof config.enabled !== "boolean")
            return { ok: false, error: "op=toggle requires effectId + enabled" };
          ok = !!store.toggleAudioEffect?.(clip.id, config.effectId, config.enabled);
          break;
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
    if (!ok) return { ok: false, error: `${config.op} failed` };
    return { ok: true, note: `audio-effect ${config.op}` };
  },
};
