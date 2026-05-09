/**
 * Audio mix surface — volume + mute on audio (and video-with-audio) clips.
 *
 * Volume and mute aren't direct store methods; openreel routes them
 * through the action-executor (`audio/setVolume`, `audio/setMuted`) so
 * they enter ActionHistory and survive snapshot restore. We dispatch
 * the same actions here.
 *
 * appliesTo includes "video" because narration is often baked into the
 * video clip on Voidspace projects (clip.volume = 1 with embedded
 * audio); muting/volume-shifting that clip is a normal user request.
 */

import type { InspectorSurface } from "./types";

export interface AudioMixConfig {
  /** Linear volume 0..4. Omit to leave unchanged. */
  volume?: number;
  /** Mute toggle. Omit to leave unchanged. */
  muted?: boolean;
}

export const surface: InspectorSurface<AudioMixConfig> = {
  name: "audio-mix",
  description: "Volume (0-4) and mute toggle for audio + video-with-embedded-audio clips. Routes through action history; undoable + snapshot-restorable.",
  appliesTo: ["audio", "video"],
  schema: {
    type: "object",
    properties: {
      volume: { type: "number", minimum: 0, maximum: 4 },
      muted: { type: "boolean" },
    },
    additionalProperties: false,
    // At least one field must be present.
    anyOf: [
      { required: ["volume"] },
      { required: ["muted"] },
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
    if (typeof config.volume === "number") {
      const v = Math.max(0, Math.min(4, config.volume));
      const r = await exec.execute(
        {
          type: "audio/setVolume",
          id: `vol-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
          timestamp: Date.now(),
          params: { clipId: clip.id, volume: v },
        },
        store.project,
      );
      if (r?.success) didAny = true;
      else errors.push(`setVolume: ${r?.error?.message ?? "failed"}`);
    }
    if (typeof config.muted === "boolean") {
      const r = await exec.execute(
        {
          type: "audio/setMuted",
          id: `mute-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
          timestamp: Date.now(),
          params: { clipId: clip.id, muted: config.muted },
        },
        store.project,
      );
      if (r?.success) didAny = true;
      else errors.push(`setMuted: ${r?.error?.message ?? "failed"}`);
    }
    if (didAny) {
      // Force a setState so subscribers (autosave, renderer) react —
      // executor mutated in place; zustand needs a new ref to notify.
      const projectStoreModule = await import("../../stores/project-store");
      projectStoreModule.useProjectStore.setState({
        project: { ...store.project, modifiedAt: Date.now() },
      });
    }
    if (errors.length && !didAny) return { ok: false, error: errors.join("; ") };
    return {
      ok: true,
      note: [
        typeof config.volume === "number" ? `vol=${config.volume.toFixed(2)}` : null,
        typeof config.muted === "boolean" ? `muted=${config.muted}` : null,
      ].filter(Boolean).join(" "),
    };
  },
};
