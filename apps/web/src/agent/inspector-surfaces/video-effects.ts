/**
 * Video effects surface — add/update/remove/toggle/reorder visual effects
 * (brightness, contrast, saturation, blur, sharpen, etc.) on visual clips.
 *
 * Wraps the project-store's video-effect methods. One operation per call.
 */

import type { InspectorSurface } from "./types";

export interface VideoEffectsConfig {
  op: "add" | "update" | "remove" | "toggle" | "reorder";
  effectType?: string;
  params?: Record<string, unknown>;
  effectId?: string;
  enabled?: boolean;
  effectIds?: string[];
}

export const surface: InspectorSurface<VideoEffectsConfig> = {
  name: "video-effects",
  description: "Visual effect chain on a clip (brightness, contrast, saturation, blur, sharpen, color-grade, etc.). One operation per call.",
  appliesTo: ["video", "image"],
  schema: {
    type: "object",
    required: ["op"],
    properties: {
      op: { enum: ["add", "update", "remove", "toggle", "reorder"] },
      effectType: { type: "string", description: "Effect type for op=add (e.g. brightness, contrast, blur)." },
      params: { type: "object", description: "Param overrides for op=add or op=update." },
      effectId: { type: "string", description: "Effect id for op=update/remove/toggle." },
      enabled: { type: "boolean", description: "Enabled flag for op=toggle." },
      effectIds: { type: "array", items: { type: "string" }, description: "New ordering for op=reorder." },
    },
    additionalProperties: false,
  },
  apply: (clip, config, ctx) => {
    const store = ctx.store as any;
    try {
      switch (config.op) {
        case "add": {
          if (!config.effectType) return { ok: false, error: "op=add requires effectType" };
          const r = store.addVideoEffect?.(clip.id, config.effectType, config.params);
          return r ? { ok: true, note: `add ${config.effectType}` } : { ok: false, error: "addVideoEffect returned null" };
        }
        case "update": {
          if (!config.effectId) return { ok: false, error: "op=update requires effectId" };
          const r = store.updateVideoEffect?.(clip.id, config.effectId, config.params ?? {});
          return r ? { ok: true, note: `update ${config.effectId}` } : { ok: false, error: "updateVideoEffect returned null" };
        }
        case "remove": {
          if (!config.effectId) return { ok: false, error: "op=remove requires effectId" };
          const ok = !!store.removeVideoEffect?.(clip.id, config.effectId);
          return ok ? { ok: true, note: `remove ${config.effectId}` } : { ok: false, error: "removeVideoEffect failed" };
        }
        case "toggle": {
          if (!config.effectId || typeof config.enabled !== "boolean")
            return { ok: false, error: "op=toggle requires effectId + enabled" };
          const r = store.toggleVideoEffect?.(clip.id, config.effectId, config.enabled);
          return r ? { ok: true, note: `toggle ${config.effectId}=${config.enabled}` } : { ok: false, error: "toggleVideoEffect failed" };
        }
        case "reorder": {
          if (!Array.isArray(config.effectIds)) return { ok: false, error: "op=reorder requires effectIds" };
          const ok = !!store.reorderVideoEffects?.(clip.id, config.effectIds);
          return ok ? { ok: true, note: "reordered" } : { ok: false, error: "reorderVideoEffects failed" };
        }
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
    return { ok: false, error: "unhandled op" };
  },
};
