/**
 * Emphasis Animation surface — wraps the Inspector's emphasis picker
 * (pulse, shake, bounce, float, spin, flash, etc.). Maps to
 * clip.emphasisAnimation via updateClipEmphasisAnimation, which
 * dispatches to the right engine (regular, text, graphics).
 *
 * Animation list mirrors the cases supported by `applyEmphasisAnimation`
 * in canvas-renderers.ts — the renderer is the source of truth.
 */

import type { InspectorSurface } from "./types";

const EMPHASIS_TYPES = [
  "none",
  "pulse",
  "shake",
  "bounce",
  "float",
  "spin",
  "flash",
  "heartbeat",
  "swing",
  "wobble",
  "jello",
  "rubber-band",
  "tada",
  "vibrate",
  "flicker",
  "glow",
  "breathe",
  "wave",
  "tilt",
  "zoom-pulse",
  "focus-zoom",
  "pan-left",
  "pan-right",
  "pan-up",
  "pan-down",
  "ken-burns",
] as const;

export interface EmphasisAnimationConfig {
  type: (typeof EMPHASIS_TYPES)[number];
  /** Animation playback speed (cycles per second). Default 1. */
  speed?: number;
  /** Strength multiplier (0-2). Default 1. */
  intensity?: number;
  /** Whether to loop continuously. Default true. */
  loop?: boolean;
  /** Optional clip-local start time in seconds. Default 0. */
  startTime?: number;
  /** Optional clip-local duration in seconds. Omit = entire clip. */
  animationDuration?: number;
}

export const surface: InspectorSurface<EmphasisAnimationConfig> = {
  name: "emphasis-animation",
  description:
    "Continuous looping emphasis animation on a clip (pulse, shake, ken-burns, etc.). type='none' clears it.",
  appliesTo: ["video", "image", "text", "graphics", "shape", "sticker", "svg"],
  schema: {
    type: "object",
    required: ["type"],
    properties: {
      type: { enum: [...EMPHASIS_TYPES] },
      speed: { type: "number", minimum: 0, maximum: 10 },
      intensity: { type: "number", minimum: 0, maximum: 2 },
      loop: { type: "boolean" },
      startTime: { type: "number", minimum: 0 },
      animationDuration: { type: "number", minimum: 0 },
    },
    additionalProperties: false,
  },
  apply: (clip, config, ctx) => {
    const store = ctx.store as any;
    const value =
      config.type === "none"
        ? null
        : {
            type: config.type,
            speed: typeof config.speed === "number" ? config.speed : 1,
            intensity: typeof config.intensity === "number" ? config.intensity : 1,
            loop: config.loop !== false,
            startTime: config.startTime,
            animationDuration: config.animationDuration,
          };
    const ok = !!store.updateClipEmphasisAnimation?.(clip.id, value);
    if (!ok) return { ok: false, error: "updateClipEmphasisAnimation failed" };
    return { ok: true, note: `emphasis=${config.type}` };
  },
};
