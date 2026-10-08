/**
 * `caption-style` — the agent's handle on the Inspector's CaptionStylePanel.
 *
 * One call can set everything that panel sets: a named preset, the kinetic
 * word highlight (on/off, colour, animation), the text style (font, size,
 * colours, outline, shadow, box) and where the caption sits. It writes through
 * the same three store methods the panel uses — `updateTextStyle`,
 * `updateTextTransform`, `updateCaptionFields` — so the preview, the export and
 * autosave all see it exactly as if the user had clicked.
 *
 * Order inside one call: preset first, then every explicit field on top of it,
 * so `{ preset: "kinetic", captionHighlightColor: "#7FD4FF" }` means "Kinetic,
 * but light blue".
 *
 * Undo, rollback on failure and the autosave commit are the dispatcher's job
 * (App.tsx `voidspace:apply-inspector-tool`), as for every surface.
 */

import type { CaptionAnimationStyle, TextClip, TextStyle } from "@openreel/core";
import type { InspectorSurface, InspectorSurfaceClip, ApplyContext } from "./types";
import { CAPTION_PRESETS } from "../../components/editor/inspector/caption-presets";
import { ensureFontReady } from "../../components/editor/inspector/font-catalog";

const ANIMATIONS: readonly CaptionAnimationStyle[] = [
  "none", "word-highlight", "word-by-word", "karaoke", "bounce", "typewriter",
];

/** Normalised y (0 = top edge, 1 = bottom edge) for each placement word. */
const PLACEMENTS: Record<string, number> = {
  top: 0.14,          // CaptionStylePanel "Top"
  center: 0.5,        // CaptionStylePanel "Middle"
  "lower-third": 0.75,
  bottom: 0.85,       // CaptionStylePanel "Bottom"
};

/** TextStyle fields passed straight through to `updateTextStyle`. */
const STYLE_KEYS = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "color",
  "strokeColor", "strokeWidth", "shadowColor", "shadowBlur",
  "shadowOffsetX", "shadowOffsetY", "backgroundColor", "textAlign",
  "letterSpacing", "lineHeight",
] as const;

const colour = (description: string) => ({ type: "string", description });

const schema = {
  type: "object",
  description:
    "Every key is optional; pass only what should change. Applied in order: preset → style/size → placement → highlight fields.",
  properties: {
    preset: {
      enum: CAPTION_PRESETS.map((p) => p.id),
      description:
        "One of the Inspector's caption looks, applied first so other keys override it. " +
        CAPTION_PRESETS.map(
          (p) => `${p.id}: ${p.style.fontFamily}, ${(p.heightRatio * 100).toFixed(1)}% of height, y=${p.positionY}` +
            (p.strokeRatio > 0 ? ", outlined" : "") +
            (p.style.backgroundColor && p.style.backgroundColor !== "transparent" ? ", dark box" : ""),
        ).join("; ") + ".",
    },
    captionHighlight: {
      type: "boolean",
      description:
        "Kinetic word highlight on/off (default on). Only captions WITH word timing animate; read `info.hasWordTiming` first. Off = plain static caption text.",
    },
    captionHighlightColor: colour('Active (spoken) word colour, any CSS colour. Default "#FFE600" (yellow). Light blue: "#7FD4FF".'),
    captionAnimation: {
      enum: [...ANIMATIONS],
      description:
        'Kinetic style, default "word-highlight" (active word recoloured + scaled). word-by-word: words appear as spoken. karaoke: fill sweeps across. bounce: active word hops. typewriter: letters type on. none: phrase shown whole, no per-word motion.',
    },
    fontFamily: { type: "string", description: 'Font family, e.g. "Inter", "Poppins", "Montserrat", "Anton", "Bebas Neue", "Archivo Black", "Oswald".' },
    fontSizePct: {
      type: "number", minimum: 2, maximum: 14,
      description:
        "Font size as a PERCENT OF CANVAS HEIGHT (what the Inspector's Size slider uses). 4 = small, 5–6 = standard, 7–8 = bold viral. Preferred over fontSize: it stays right if the aspect changes. An existing outline is rescaled with it unless strokeWidth is also given.",
    },
    fontSize: { type: "number", minimum: 1, description: "Font size in canvas PIXELS. Use fontSizePct instead unless an exact px size was asked for." },
    fontWeight: {
      anyOf: [{ enum: ["normal", "bold"] }, { enum: [100, 200, 300, 400, 500, 600, 700, 800, 900] }],
      description: '"normal" | "bold" | 100–900.',
    },
    fontStyle: { enum: ["normal", "italic"] },
    color: colour('Text colour (non-active words), e.g. "#FFFFFF".'),
    strokeColor: colour('Outline colour, e.g. "#000000".'),
    strokeWidth: { type: "number", minimum: 0, description: "Outline width in px; 0 = no outline. ~9% of the font size reads as a bold viral outline." },
    shadowColor: colour('Drop-shadow colour, e.g. "rgba(0,0,0,0.85)"; "transparent" for none.'),
    shadowBlur: { type: "number", minimum: 0, description: "Shadow blur in px." },
    shadowOffsetX: { type: "number", description: "Shadow x offset in px." },
    shadowOffsetY: { type: "number", description: "Shadow y offset in px." },
    backgroundColor: colour('Box behind the text, e.g. "rgba(0,0,0,0.8)"; "transparent" for none.'),
    textAlign: { enum: ["left", "center", "right"] },
    letterSpacing: { type: "number", description: "Extra px between letters (default 0)." },
    lineHeight: { type: "number", minimum: 0.5, maximum: 3, description: "Line height multiple (default 1.2)." },
    placement: {
      enum: Object.keys(PLACEMENTS),
      description:
        "Vertical spot shorthand: top (y 0.14), center (0.5), lower-third (0.75), bottom (0.85). Keeps the current x. Overridden by position.y if both are given.",
    },
    position: {
      type: "object",
      description: "Exact caption centre, NORMALISED to the canvas: x 0 = left edge, 1 = right; y 0 = top, 1 = bottom. Either key may be omitted.",
      properties: {
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
    captionsOnly: {
      type: "boolean",
      description:
        "Default true: text clips that are NOT captions (titles, lower-third graphics) are skipped, so applyAll restyles every caption and nothing else. Set false to style any targeted text clip.",
    },
    info: {
      type: "object",
      description: "READ-ONLY block returned by read_inspector_tool (isCaption, hasWordTiming, wordCount, canvas). Ignored by apply.",
    },
  },
  additionalProperties: false,
} as const;

type Config = Partial<Record<(typeof STYLE_KEYS)[number], unknown>> & {
  preset?: string;
  captionHighlight?: boolean;
  captionHighlightColor?: string;
  captionAnimation?: CaptionAnimationStyle;
  fontSizePct?: number;
  placement?: string;
  position?: { x?: number; y?: number };
  captionsOnly?: boolean;
};

type Store = {
  getTextClip: (id: string) => TextClip | undefined;
  updateTextStyle: (id: string, style: Partial<TextStyle>) => TextClip | null;
  updateTextTransform: (id: string, t: Record<string, unknown>) => TextClip | null;
  updateCaptionFields: (id: string, f: Record<string, unknown>) => TextClip | null;
};

/** Same rule as InspectorPanel's `isCaptionClipId`. */
function isCaption(tc: TextClip, ctx: ApplyContext): boolean {
  if (tc.trackId === "track-captions" || tc.id.startsWith("caption-")) return true;
  return (ctx.project.timeline?.tracks ?? []).some(
    (t) => t.id === tc.trackId && t.type === "text" && t.name === "Captions",
  );
}

const canvasHeight = (ctx: ApplyContext) => ctx.project.settings?.height || 1080;

const isColour = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** Returns an error string for the first bad value, else null. */
function validate(cfg: Config): string | null {
  if (cfg.preset !== undefined && !CAPTION_PRESETS.some((p) => p.id === cfg.preset)) {
    return `unknown preset "${cfg.preset}" (expected ${CAPTION_PRESETS.map((p) => p.id).join(", ")})`;
  }
  if (cfg.captionAnimation !== undefined && !ANIMATIONS.includes(cfg.captionAnimation)) {
    return `unknown captionAnimation "${cfg.captionAnimation}" (expected ${ANIMATIONS.join(", ")})`;
  }
  if (cfg.placement !== undefined && !(cfg.placement in PLACEMENTS)) {
    return `unknown placement "${cfg.placement}" (expected ${Object.keys(PLACEMENTS).join(", ")})`;
  }
  if (cfg.captionHighlight !== undefined && typeof cfg.captionHighlight !== "boolean") {
    return "captionHighlight must be a boolean";
  }
  for (const k of ["captionHighlightColor", "color", "strokeColor", "shadowColor", "backgroundColor"] as const) {
    if (cfg[k] !== undefined && !isColour(cfg[k])) return `${k} must be a CSS colour string`;
  }
  for (const k of ["fontSize", "strokeWidth", "shadowBlur", "shadowOffsetX", "shadowOffsetY", "letterSpacing", "lineHeight", "fontSizePct"] as const) {
    if (cfg[k] !== undefined && !isNum(cfg[k])) return `${k} must be a number`;
  }
  if (cfg.fontSizePct !== undefined && (cfg.fontSizePct < 2 || cfg.fontSizePct > 14)) {
    return "fontSizePct must be between 2 and 14 (percent of canvas height)";
  }
  for (const axis of ["x", "y"] as const) {
    const v = cfg.position?.[axis];
    if (v !== undefined && (!isNum(v) || v < 0 || v > 1)) {
      return `position.${axis} must be a number from 0 to 1 (normalised to the canvas)`;
    }
  }
  return null;
}

export const surface: InspectorSurface<Config> = {
  name: "caption-style",
  description:
    "Full caption look in one call: preset, kinetic word highlight (on/off, colour, animation style), font/size (as % of canvas height)/colours/outline/shadow/box, and placement (top/center/lower-third/bottom or exact x/y). Use applyAll to restyle every caption at once.",
  appliesTo: ["text"],
  schema: schema as unknown as Record<string, unknown>,

  apply: async (clip, cfg, ctx) => {
    const bad = validate(cfg ?? {});
    if (bad) return { ok: false, error: bad };
    const store = ctx.store as unknown as Store;
    const tc = store.getTextClip(clip.id);
    if (!tc) return { ok: false, error: `text clip ${clip.id} not found in the title engine` };
    if (cfg.captionsOnly !== false && !isCaption(tc, ctx)) {
      return { ok: true, note: "skipped: not a caption (pass captionsOnly:false to style it)" };
    }

    const h = canvasHeight(ctx);
    const preset = CAPTION_PRESETS.find((p) => p.id === cfg.preset);

    // ── Style: preset, then explicit fields on top ──
    const style: Record<string, unknown> = {};
    let y: number | undefined;
    let highlightColor: string | undefined;
    if (preset) {
      const fontSize = Math.round(h * preset.heightRatio);
      Object.assign(style, preset.style, {
        fontSize,
        strokeWidth: Math.round(fontSize * preset.strokeRatio),
      });
      y = preset.positionY;
      highlightColor = preset.highlightColor;
    }
    for (const k of STYLE_KEYS) {
      if (cfg[k] !== undefined) style[k] = cfg[k];
    }
    if (cfg.fontSizePct !== undefined) style.fontSize = Math.round((h * cfg.fontSizePct) / 100);
    // Keep an existing outline proportional when only the size changed — the
    // Inspector's Size slider does the same.
    if (cfg.fontSize !== undefined || cfg.fontSizePct !== undefined) {
      if (cfg.strokeWidth === undefined && !preset) {
        const oldSize = tc.style?.fontSize || 0;
        const oldStroke = tc.style?.strokeWidth || 0;
        if (oldSize > 0 && oldStroke > 0) {
          style.strokeWidth = Math.round((oldStroke * (style.fontSize as number)) / oldSize);
        }
      }
    }

    // ── Placement ──
    if (cfg.placement) y = PLACEMENTS[cfg.placement];
    if (cfg.position?.y !== undefined) y = cfg.position.y;
    const x = cfg.position?.x;

    // ── Kinetic fields ──
    const fields: Record<string, unknown> = {};
    if (highlightColor) fields.captionHighlightColor = highlightColor;
    if (cfg.captionHighlightColor !== undefined) fields.captionHighlightColor = cfg.captionHighlightColor;
    if (cfg.captionHighlight !== undefined) fields.captionHighlight = cfg.captionHighlight;
    if (cfg.captionAnimation !== undefined) fields.captionAnimation = cfg.captionAnimation;

    if (!Object.keys(style).length && y === undefined && x === undefined && !Object.keys(fields).length) {
      return { ok: false, error: "config changes nothing (only read-only `info`?)" };
    }

    if (typeof style.fontFamily === "string") {
      await ensureFontReady(style.fontFamily, (style.fontSize as number) || tc.style?.fontSize || 48);
    }
    if (Object.keys(style).length && !store.updateTextStyle(clip.id, style as Partial<TextStyle>)) {
      return { ok: false, error: "updateTextStyle failed" };
    }
    if (x !== undefined || y !== undefined) {
      const cur = store.getTextClip(clip.id)?.transform?.position ?? { x: 0.5, y: 0.85 };
      if (!store.updateTextTransform(clip.id, { position: { x: x ?? cur.x, y: y ?? cur.y } })) {
        return { ok: false, error: "updateTextTransform failed" };
      }
    }
    if (Object.keys(fields).length && !store.updateCaptionFields(clip.id, fields)) {
      return { ok: false, error: "updateCaptionFields failed" };
    }

    const animates = (tc.captionWords?.length ?? 0) > 0;
    const touchedKinetic = cfg.captionAnimation !== undefined || cfg.captionHighlight !== undefined || cfg.captionHighlightColor !== undefined;
    return {
      ok: true,
      note: touchedKinetic && !animates
        ? "caption-style ✓ (this caption has no word timing, so highlight/animation are stored but not drawn)"
        : "caption-style ✓",
    };
  },

  /**
   * Current look in the shape `apply` takes, plus a read-only `info` block.
   * Reads the TITLE ENGINE (the live copy every edit writes to), not the
   * project snapshot — see the `blend-opacity` note in clip-properties.ts.
   */
  read: (clip: InspectorSurfaceClip, ctx: ApplyContext) => {
    const store = ctx.store as unknown as Store;
    const tc = store.getTextClip?.(clip.id) ?? (clip.raw as unknown as TextClip);
    if (!tc) return null;
    const s = (tc.style ?? {}) as Partial<TextStyle>;
    const h = canvasHeight(ctx);
    const out: Record<string, unknown> = {
      captionHighlight: tc.captionHighlight !== false,
      captionHighlightColor: tc.captionHighlightColor || "#FFE600",
      captionAnimation: tc.captionAnimation || "word-highlight",
    };
    for (const k of STYLE_KEYS) {
      if (s[k] !== undefined) out[k] = s[k];
    }
    if (isNum(s.fontSize)) out.fontSizePct = Math.round(((s.fontSize as number) / h) * 1000) / 10;
    const pos = tc.transform?.position;
    if (pos) out.position = { x: pos.x, y: pos.y };
    out.info = {
      isCaption: isCaption(tc, ctx),
      hasWordTiming: (tc.captionWords?.length ?? 0) > 0,
      wordCount: tc.captionWords?.length ?? 0,
      text: tc.text,
      canvas: { width: ctx.project.settings?.width, height: h },
    };
    return out;
  },
};
