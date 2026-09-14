/**
 * Declarative manifest of direct-property Inspector surfaces.
 *
 * Each entry maps one agent-callable surface to one project-store
 * `update*` method. Adding a new Inspector section that just sets one
 * or two clip fields = one entry here. No new file, no App.tsx change.
 *
 * Use the `clip-properties.ts` file ONLY for surfaces whose apply logic
 * is "call a store method." For surfaces with non-trivial logic
 * (transitions generate keyframes, motion presets generate keyframes
 * from a curve, AI captions kick off a pipeline), create a dedicated
 * file in this directory exporting `surface = ...`.
 */

import type { ClipKind } from "./types";
import {
  type ClipPropertyDescriptor,
  makeClipPropertySurface,
} from "./clip-property-surface";

const VISUAL_KINDS: readonly ClipKind[] = [
  "video", "image", "text", "graphics", "shape", "sticker", "svg",
];

const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
] as const;

const ENTRIES: ClipPropertyDescriptor[] = [
  // ── Blending ──
  {
    name: "blending",
    description: "Compositing blend mode (multiply, screen, overlay, etc.).",
    appliesTo: VISUAL_KINDS,
    storeMethod: "updateClipBlendMode",
    schema: {
      type: "object",
      required: ["blendMode"],
      properties: { blendMode: { enum: [...BLEND_MODES] } },
      additionalProperties: false,
    },
    toStoreArgs: (cfg) => [cfg.blendMode],
    fromClip: (clip) => ({ blendMode: (clip.raw as any).blendMode ?? "normal" }),
  },
  /**
   * ── THIS WAS BROKEN IN BOTH DIRECTIONS ──────────────────────────────────────
   * `blendOpacity` is stored as a PERCENTAGE (0–100): the store rejects
   * anything outside that range, the Inspector's slider is 0–100 with a "%"
   * unit, and the renderer divides by 100. This surface declared 0–1 and
   * clamped to it, so:
   *   • `opacity: 0.5` (obeying the schema) became 0.5% — invisible;
   *   • `opacity: 50` (the real unit) was clamped to 1, i.e. 1% — invisible.
   * There was no value an agent could send that produced a usable result, and
   * every call reported success.
   *
   * ── AND IT CLAIMED CLIP KINDS THAT IGNORE IT ────────────────────────────────
   * Only `threejs-layer-renderer` reads `blendOpacity`, and only for text,
   * shape, svg and sticker clips. `canvas-renderers` does not, and
   * `video-engine` — which writes the MP4 — does not. On a video or image clip
   * it did nothing at all, in preview or in export.
   *
   * For video and image clips the working control is `transform` → `opacity`
   * (0–1), which `video-engine` applies as `globalAlpha` in both paths.
   */
  {
    name: "blend-opacity",
    description:
      "Overlay opacity as a PERCENTAGE (0–100) for text/shape/SVG/sticker clips, applied on top of blendMode. For video or image clips use the `transform` surface's `opacity` (0–1) instead — that is the one the export honours.",
    appliesTo: ["text", "shape", "svg", "sticker"],
    storeMethod: "updateClipBlendOpacity",
    schema: {
      type: "object",
      required: ["opacity"],
      properties: {
        opacity: {
          type: "number", minimum: 0, maximum: 100,
          description: "Percent. 100 = fully opaque, 0 = invisible. NOT a 0–1 fraction.",
        },
      },
      additionalProperties: false,
    },
    toStoreArgs: (cfg) => [Math.max(0, Math.min(100, Number(cfg.opacity)))],
    fromClip: (clip) => ({ opacity: (clip.raw as any).blendOpacity ?? 100 }),
  },

  // ── 3D transforms: DELIBERATELY NOT EXPOSED ────────────────────────────────
  // `perspective`, `transform-style` and `rotate3d` are honoured by the PREVIEW
  // (canvas-renderers / threejs-layer-renderer) and dropped by the export:
  // `video-engine.getAnimatedTransform` does not even carry them, and
  // `drawFrameToContext` applies only position, rotation, scale, anchor, crop,
  // opacity and blendMode.
  //
  // An agent tool whose effect is visible while editing and absent from the
  // delivered file is worse than a missing one — the user approves what they
  // saw and ships something else. If the export ever learns 3D, add them back
  // here in the same commit.

  // ── Transform (position/scale/rotation/opacity) ──
  // Single surface accepting a partial Transform; the store's
  // `updateClipTransform` is itself partial-friendly.
  {
    name: "transform",
    description:
      "Position (pixels from centre), scale, rotation (degrees, 2D), opacity (0..1), anchor and crop. This is the surface the EXPORT honours, so it is the right one for reframing a shot or fading a clip. Pass only the fields to change.",
    appliesTo: VISUAL_KINDS,
    storeMethod: "updateClipTransform",
    schema: {
      type: "object",
      properties: {
        position: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          additionalProperties: false,
        },
        scale: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          additionalProperties: false,
        },
        rotation: { type: "number" },
        opacity: { type: "number", minimum: 0, maximum: 1 },
        anchor: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          additionalProperties: false,
        },
        crop: {
          type: "object",
          properties: {
            x: { type: "number" }, y: { type: "number" },
            width: { type: "number" }, height: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    toStoreArgs: (cfg) => [cfg],
    // The whole Transform as stored, which is exactly the shape `apply`
    // takes — so a read can be edited and handed straight back.
    fromClip: (clip) => (clip.raw as any).transform ?? null,
  },

  // ── Color grading (single store method, partial) ──
  {
    name: "color-grading",
    description: "Color grading settings (exposure, contrast, saturation, temperature, tint, highlights, shadows, etc.). Pass only fields to change.",
    appliesTo: ["video", "image"],
    storeMethod: "updateColorGrading",
    schema: {
      type: "object",
      properties: {
        exposure: { type: "number" },
        contrast: { type: "number" },
        saturation: { type: "number" },
        temperature: { type: "number" },
        tint: { type: "number" },
        highlights: { type: "number" },
        shadows: { type: "number" },
        whites: { type: "number" },
        blacks: { type: "number" },
        vibrance: { type: "number" },
      },
      additionalProperties: true,
    },
    toStoreArgs: (cfg) => [cfg],
    // Grading lives in the EffectsBridge, not on the clip: ask the store.
    fromClip: (clip, ctx) => {
      const fn = (ctx.store as any).getColorGrading;
      if (typeof fn !== "function") return null;
      const g = fn.call(ctx.store, clip.id);
      return g && Object.keys(g).length > 0 ? g : null;
    },
  },

  // ── Raw keyframes (advanced; lets agent set arbitrary curves) ──
  {
    name: "keyframes",
    description: "Replace the entire keyframes array on a clip. Advanced — use entry-exit-transitions or motion-presets for common cases.",
    appliesTo: VISUAL_KINDS,
    storeMethod: "updateClipKeyframes",
    schema: {
      type: "object",
      required: ["keyframes"],
      properties: {
        keyframes: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "time", "property", "value"],
            properties: {
              id: { type: "string" },
              time: { type: "number" },
              property: { type: "string" },
              value: {},
              easing: { enum: ["linear", "ease-in", "ease-out", "ease-in-out"] },
            },
          },
        },
      },
      additionalProperties: false,
    },
    toStoreArgs: (cfg) => [cfg.keyframes],
    fromClip: (clip) => ({ keyframes: (clip.raw as any).keyframes ?? [] }),
  },

  // ── Subtitle: DELIBERATELY NOT EXPOSED ─────────────────────────────────────
  // There was a `subtitle` entry here and it could never have worked.
  // `updateSubtitle(subtitleId, …)` matches `project.timeline.subtitles` by id,
  // but `resolveTargetClips` only ever yields timeline clips, TEXT CLIPS (the
  // title engine) and graphics — never a subtitle. So with `appliesTo: ["text"]`
  // it handed a text-clip id to a subtitle lookup, matched nothing, mutated
  // nothing, and returned `undefined` — which the factory reads as success
  // because it only treats an explicit `false` as failure.
  //
  // Voidspace captions ARE text clips, and `text-content` / `text-style` edit
  // them through the title engine, which the export renders. That is the real
  // path; this was a second, broken one pointing at a preview-only array.

  // ── Text ──
  {
    name: "text-content",
    description: "Replace the displayed text of a text clip.",
    appliesTo: ["text"],
    storeMethod: "updateTextContent",
    schema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
      additionalProperties: false,
    },
    toStoreArgs: (cfg) => [String(cfg.text)],
    fromClip: (clip) => ({ text: (clip.raw as any).text ?? "" }),
  },
  {
    name: "text-style",
    description:
      "Text style fields (font family, size, weight, color, stroke, shadow, alignment).",
    appliesTo: ["text"],
    storeMethod: "updateTextStyle",
    schema: {
      type: "object",
      properties: {
        fontFamily: { type: "string" },
        fontSize: { type: "number", minimum: 1 },
        fontWeight: {},
        fontStyle: { enum: ["normal", "italic"] },
        color: { type: "string" },
        strokeColor: { type: "string" },
        strokeWidth: { type: "number", minimum: 0 },
        shadowColor: { type: "string" },
        shadowBlur: { type: "number", minimum: 0 },
        shadowOffsetX: { type: "number" },
        shadowOffsetY: { type: "number" },
        backgroundColor: { type: "string" },
        textAlign: { enum: ["left", "center", "right"] },
        verticalAlign: { enum: ["top", "middle", "bottom"] },
        lineHeight: { type: "number", minimum: 0 },
      },
      additionalProperties: true,
    },
    toStoreArgs: (cfg) => [cfg],
    fromClip: (clip) => (clip.raw as any).style ?? null,
  },
];

export const surfaces = ENTRIES.map(makeClipPropertySurface);
