/**
 * Entry/Exit Transitions surface — wraps the Inspector's
 * ClipTransitionSection.tsx. Same generateClipTransitionKeyframes export
 * the section uses, same updateClipKeyframes store method the section's
 * "Apply Transitions" button calls.
 */

import type { InspectorSurface } from "./types";
import { generateClipTransitionKeyframes } from "../../components/editor/inspector/ClipTransitionSection";

export interface TransitionsConfig {
  entry?: {
    preset?:
      | "none" | "fade"
      | "slide-left" | "slide-right" | "slide-up" | "slide-down"
      | "zoom-in" | "zoom-out" | "rotate" | "blur"
      | "iris-circle" | "iris-rectangle" | "iris-diamond" | "iris-star";
    durationSec?: number;
    easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out";
  };
  exit?: {
    preset?:
      | "none" | "fade"
      | "slide-left" | "slide-right" | "slide-up" | "slide-down"
      | "zoom-in" | "zoom-out" | "rotate" | "blur"
      | "iris-circle" | "iris-rectangle" | "iris-diamond" | "iris-star";
    durationSec?: number;
    easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out";
  };
}

const PRESET_ENUM = [
  "none", "fade",
  "slide-left", "slide-right", "slide-up", "slide-down",
  "zoom-in", "zoom-out", "rotate", "blur",
  "iris-circle", "iris-rectangle", "iris-diamond", "iris-star",
] as const;

const EASING_ENUM = ["linear", "ease-in", "ease-out", "ease-in-out"] as const;

export const surface: InspectorSurface<TransitionsConfig> = {
  name: "entry-exit-transitions",
  description:
    "Per-clip entry and exit animations (fade, slide, zoom, blur, iris, rotate). Each clip animates independently; no inter-clip overlap or bridge state.",
  appliesTo: ["video", "image", "text", "graphics", "shape", "sticker", "svg"],
  schema: {
    type: "object",
    properties: {
      entry: {
        type: "object",
        properties: {
          preset: { enum: [...PRESET_ENUM] },
          durationSec: { type: "number", minimum: 0.05, maximum: 5 },
          easing: { enum: [...EASING_ENUM] },
        },
        additionalProperties: false,
      },
      exit: {
        type: "object",
        properties: {
          preset: { enum: [...PRESET_ENUM] },
          durationSec: { type: "number", minimum: 0.05, maximum: 5 },
          easing: { enum: [...EASING_ENUM] },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  apply: (clip, config, ctx) => {
    const raw = clip.raw as Record<string, unknown>;
    const dur = Number((raw as any).duration) || 0;
    if (dur <= 0) return { ok: false, error: "clip has no duration" };

    const entryCfg = {
      preset: (config?.entry?.preset ?? "none") as any,
      duration: Math.min(
        Math.max(0.05, config?.entry?.durationSec ?? 0.5),
        dur / 2,
      ),
      easing: (config?.entry?.easing ?? "ease-out") as any,
    };
    const exitCfg = {
      preset: (config?.exit?.preset ?? "none") as any,
      duration: Math.min(
        Math.max(0.05, config?.exit?.durationSec ?? 0.5),
        dur / 2,
      ),
      easing: (config?.exit?.easing ?? "ease-in") as any,
    };
    const settings = (ctx.project.settings ?? {}) as any;
    const canvas = {
      width: typeof settings.width === "number" ? settings.width : 1920,
      height: typeof settings.height === "number" ? settings.height : 1080,
    };

    // Strip prior entry/exit keyframes — same as the Inspector's
    // applyTransitions: re-applying replaces, never stacks.
    const existingKfs = Array.isArray((raw as any).keyframes)
      ? ((raw as any).keyframes as any[])
      : [];
    const preserved = existingKfs.filter(
      (kf) =>
        !(
          typeof kf?.id === "string" &&
          (kf.id.startsWith("kf-entry-") || kf.id.startsWith("kf-exit-"))
        ),
    );

    const fresh = generateClipTransitionKeyframes(
      {
        id: clip.id,
        duration: dur,
        transform: (raw as any).transform,
        keyframes: existingKfs,
      },
      entryCfg,
      exitCfg,
      clip.kind === "text" ? "text" : "regular",
      canvas,
    );

    const store = ctx.store as any;
    let ok = false;
    if (clip.kind === "text") {
      ok = !!store.updateTextClipKeyframes?.(clip.id, [...preserved, ...fresh]);
    } else {
      ok = !!store.updateClipKeyframes?.(clip.id, [...preserved, ...fresh]);
    }
    if (!ok) return { ok: false, error: "store update failed" };

    const parts: string[] = [];
    if (entryCfg.preset !== "none")
      parts.push(`entry ${entryCfg.preset} ${entryCfg.duration.toFixed(2)}s`);
    if (exitCfg.preset !== "none")
      parts.push(`exit ${exitCfg.preset} ${exitCfg.duration.toFixed(2)}s`);
    return { ok: true, note: parts.length ? parts.join(", ") : "cleared" };
  },
};
