/**
 * Retiming — speed and reverse — for the agent.
 *
 * ── WHY IT WAS NOT HERE BEFORE, AND WHAT CHANGED ────────────────────────────
 * Retiming lived only in the SpeedEngine's in-memory map. Nothing serialised
 * it, so a clip retimed in one session came back at 1x in the next — inside
 * the SHORTENED window the Inspector had already written to `clip.duration`.
 * Exposing that to an agent would have been exposing a control that quietly
 * truncates the back half of a shot on the next reload.
 *
 * `SpeedEngine.serializeAll()` / `restoreAll()` and `project.speedState` fixed
 * that, so retiming is now durable and this surface is safe to offer.
 *
 * ── ONE IMPLEMENTATION ──────────────────────────────────────────────────────
 * The actual work is `services/retime.ts`, which the Inspector's Speed section
 * uses too. Retiming is two writes that must agree (the engine record the
 * renderer reads, and the clip fields the timeline draws); a second copy here
 * is how they would drift.
 */

import type { InspectorSurface } from "./types";

export interface SpeedConfig {
  speed?: number;
  reversed?: boolean;
  affectLinkedAudio?: boolean;
}

export const surface: InspectorSurface<SpeedConfig> = {
  name: "speed",
  description:
    "Retime a clip: playback speed (0.1–20, where 2 = twice as fast and 0.5 = half speed) and reverse. The clip's length on the timeline changes to match. Audio split onto its own track from the same media is retimed with it by default, so a talking head stays in sync.",
  appliesTo: ["video", "audio", "image"],
  schema: {
    type: "object",
    properties: {
      speed: {
        type: "number", minimum: 0.1, maximum: 20,
        description: "Playback rate. 2 = twice as fast (half the length), 0.5 = slow motion (twice the length). 1 restores normal speed.",
      },
      reversed: { type: "boolean", description: "Play the source backwards." },
      affectLinkedAudio: {
        type: "boolean",
        description: "Also retime an audio clip that shares this clip's media. Default true — turn it off only when the sound should keep its original timing.",
      },
    },
    anyOf: [{ required: ["speed"] }, { required: ["reversed"] }],
    additionalProperties: false,
  },

  apply: async (clip, config) => {
    const { retimeClip } = await import("../../services/retime");
    const r = retimeClip({
      clipId: clip.id,
      speed: config.speed,
      reversed: config.reversed,
      affectLinkedAudio: config.affectLinkedAudio,
    });
    if (!r.ok) return { ok: false, error: r.error ?? "retime failed" };
    const bits = [
      typeof config.speed === "number" ? `${config.speed}x` : null,
      config.reversed === true ? "reversed" : config.reversed === false ? "forward" : null,
      typeof r.newDuration === "number" ? `→ ${r.newDuration.toFixed(2)}s` : null,
      (r.clipIds?.length ?? 0) > 1 ? `(+${(r.clipIds!.length - 1)} linked audio)` : null,
    ].filter(Boolean);
    return { ok: true, note: bits.join(" ") };
  },

  read: async (clip) => {
    const { readRetime } = await import("../../services/retime");
    const r = readRetime(clip.id, clip.raw as never);
    // Normal speed, playing forwards, is not a retime — say nothing rather
    // than reporting a setting the user never made.
    if (r.speed === 1 && !r.reversed) return null;
    return r;
  },
};
