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

const TRANSFORM_STYLES = ["preserve-3d", "flat"] as const;

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
  },
  {
    name: "blend-opacity",
    description: "Per-clip blend opacity 0–1 applied on top of blendMode.",
    appliesTo: VISUAL_KINDS,
    storeMethod: "updateClipBlendOpacity",
    schema: {
      type: "object",
      required: ["opacity"],
      properties: { opacity: { type: "number", minimum: 0, maximum: 1 } },
      additionalProperties: false,
    },
    toStoreArgs: (cfg) => [Math.max(0, Math.min(1, Number(cfg.opacity)))],
  },

  // ── 3D Transforms ──
  {
    name: "perspective",
    description: "CSS-style 3D perspective in px (higher = flatter).",
    appliesTo: VISUAL_KINDS,
    storeMethod: "updateClipPerspective",
    schema: {
      type: "object",
      required: ["perspective"],
      properties: { perspective: { type: "number", minimum: 0 } },
      additionalProperties: false,
    },
    toStoreArgs: (cfg) => [Number(cfg.perspective)],
  },
  {
    name: "transform-style",
    description: "Stacking context for nested 3D transforms.",
    appliesTo: VISUAL_KINDS,
    storeMethod: "updateClipTransformStyle",
    schema: {
      type: "object",
      required: ["transformStyle"],
      properties: { transformStyle: { enum: [...TRANSFORM_STYLES] } },
      additionalProperties: false,
    },
    toStoreArgs: (cfg) => [cfg.transformStyle],
  },

  // ── Transform (position/scale/rotation/opacity) ──
  // Single surface accepting a partial Transform; the store's
  // `updateClipTransform` is itself partial-friendly.
  {
    name: "transform",
    description:
      "Position (x/y in 0..1 normalized canvas), scale, rotation (degrees), opacity (0..1), anchor, crop. Pass only the fields to change.",
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
        borderRadius: { type: "number", minimum: 0 },
        rotate3d: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    toStoreArgs: (cfg) => [cfg],
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
  },

  // ── Subtitle (caption) update ──
  {
    name: "subtitle",
    description: "Update one subtitle/caption (text, timing, style). Targets project.subtitles[].",
    appliesTo: ["text"],
    storeMethod: "updateSubtitle",
    schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        startTime: { type: "number" },
        endTime: { type: "number" },
        style: { type: "object", additionalProperties: true },
      },
      additionalProperties: true,
    },
    toStoreArgs: (cfg) => [cfg],
  },

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
  },
];

export const surfaces = ENTRIES.map(makeClipPropertySurface);
