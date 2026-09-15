/**
 * Colour grading for an agent — in the terms an agent actually asks in, and
 * through the one path that reaches the exported file.
 *
 * ── WHAT WAS HERE BEFORE, AND WHY IT WAS A NO-OP ────────────────────────────
 * `color-grading` used to be a row in `clip-properties.ts` pointing at the
 * store's `updateColorGrading`. Its schema advertised ten flat fields —
 * exposure, contrast, saturation, temperature, tint, highlights, shadows,
 * whites, blacks, vibrance. `updateColorGrading` reads exactly four keys:
 * `colorWheels`, `curves`, `lut`, `hsl`. None of the ten ever matched a branch.
 * The function bumped `modifiedAt` and returned `true`, the surface wrapper
 * read `true` as success, and the agent was told `color-grading ✓`.
 *
 * So the single most common operation in video editing — "warm this up",
 * "give it more contrast" — was a documented, confident, total no-op. Measured
 * against a live editor: apply exposure/contrast/saturation, then
 * `read_inspector_tool` → null, `get-state` looks → null, rendered frame →
 * unchanged.
 *
 * ── WHY THE EFFECT CHAIN AND NOT THE GRADING MAP ────────────────────────────
 * `colorWheels` / `curves` / `hsl` / `lut` are real and they render — but they
 * are UI instruments. An agent cannot operate a colour wheel; it can say
 * "warmer by a third". The effect chain speaks exactly that language, and it is
 * already proven end to end: it renders in the preview AND in the export
 * (`video-engine` → `VideoEffectsEngine`, which implements all eight types used
 * here), persists via `project.effectsState`, and shows up in `get-state`
 * `looks` so the agent can see its own work.
 *
 * Every field below maps to an effect type the renderer implements. Nothing is
 * offered that the export would drop — that rule is the whole point of this
 * file. `highlights`/`shadows`/`midtones` ride the one `tonal` effect;
 * `whites`, `blacks` and `vibrance` are NOT offered because no renderer here
 * implements them, and a gap is better than a lie.
 *
 * This surface and `video-effects` are deliberately not rivals: this one is the
 * grade in human terms (one value per look, idempotent — grading twice does not
 * stack two effects), `video-effects` is the raw chain with ids for blur,
 * sharpen, glow, chroma key and reordering.
 */

import type { InspectorSurface, InspectorSurfaceClip, ApplyContext } from "./types";

export interface ColorGradingConfig {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  midtones?: number;
  shadows?: number;
  vignette?: number;
  grain?: number;
  reset?: boolean;
}

/**
 * field → the effect that renders it, in the RENDERER'S OWN UNITS.
 *
 * ── THE UNITS ARE NOT A DETAIL, THEY ARE THE WHOLE BUG SURFACE ──────────────
 * `VideoEffectsEngine` is internally consistent with the Inspector's sliders
 * and nothing reconciles anyone else to it: brightness and temperature/tint are
 * PERCENT (-100..100, the engine divides by 100), vignette and grain are 0..100,
 * while contrast and saturation are RATIOS with 1.0 neutral. A first draft of
 * this file documented exposure as -1..1; `exposure: 0.3` then rendered as
 * `brightness(1.003)` — a 0.3% lift, invisible, and the surface reported
 * success. That is precisely the `blend-opacity` 0–1-vs-0–100 bug again, and
 * only a test that measured the PICTURE caught it.
 *
 * So: these numbers are the engine's, the schema below states them in the same
 * units, and `verify-every-surface.mjs` renders a frame before and after to
 * prove the pixels actually move.
 */
const SCALAR: Record<string, { type: string; param: string; neutral: number }> = {
  exposure: { type: "brightness", param: "value", neutral: 0 },      // -100..100 (%)
  contrast: { type: "contrast", param: "value", neutral: 1 },        // ratio, 1 = neutral
  saturation: { type: "saturation", param: "value", neutral: 1 },    // ratio, 1 = neutral
  temperature: { type: "temperature", param: "value", neutral: 0 },  // -100..100
  tint: { type: "tint", param: "value", neutral: 0 },                // -100..100
  vignette: { type: "vignette", param: "amount", neutral: 0 },       // 0..100
  grain: { type: "grain", param: "amount", neutral: 0 },             // 0..100
};

/** The three that share ONE `tonal` effect. */
const TONAL_FIELDS = ["highlights", "midtones", "shadows"] as const;

/** Every effect type this surface owns, for `reset`. */
const OWNED = new Set([...Object.values(SCALAR).map((s) => s.type), "tonal"]);

export const surface: InspectorSurface<ColorGradingConfig> = {
  name: "color-grading",
  description:
    "Grade a shot: exposure, contrast, saturation, temperature (warm/cool), tint (green/magenta), highlights/midtones/shadows, vignette and grain. READ THE RANGES — exposure, temperature and tint are -100..100, contrast and saturation are ratios around 1, vignette and grain are 0..100. Pass only the fields you want to change; grading the same clip twice REPLACES the value, it does not stack. `reset: true` removes the whole grade. Renders in the preview and in the exported file.",
  appliesTo: ["video", "image"],
  schema: {
    type: "object",
    properties: {
      exposure: { type: "number", minimum: -100, maximum: 100, description: "Brightness as a PERCENT. 0 = untouched, +15 is a gentle lift, -15 a gentle pull down. Not a 0-1 fraction." },
      contrast: { type: "number", minimum: 0, maximum: 2, description: "A RATIO, not a percent. 1 = untouched, 1.2 is punchy, 0.85 is flat/filmic, 0 is dead grey." },
      saturation: { type: "number", minimum: 0, maximum: 2, description: "A RATIO, not a percent. 1 = untouched, 0 = black and white, 1.3 = rich, 1.8 = stylised." },
      temperature: { type: "number", minimum: -100, maximum: 100, description: "Warm/cool, -100..100. 0 = untouched, positive = warmer (golden), negative = cooler (blue). 20 is a noticeable warm-up." },
      tint: { type: "number", minimum: -100, maximum: 100, description: "Green/magenta, -100..100. 0 = untouched. Use sparingly — this is a correction, not a look." },
      highlights: { type: "number", minimum: -1, maximum: 1, description: "Lift or recover the brightest part of the image, -1..1. 0 = untouched." },
      midtones: { type: "number", minimum: -1, maximum: 1, description: "Lift or pull the middle of the image, where faces live, -1..1. 0 = untouched." },
      shadows: { type: "number", minimum: -1, maximum: 1, description: "Lift (milky, filmic) or crush (contrasty) the darkest part, -1..1. 0 = untouched." },
      vignette: { type: "number", minimum: 0, maximum: 100, description: "Darken the corners to pull the eye to the centre, 0..100. 0 = off, 30 is subtle." },
      grain: { type: "number", minimum: 0, maximum: 100, description: "Film grain, 0..100. 0 = off, 15 reads as texture rather than noise." },
      reset: { type: "boolean", description: "Remove every grading effect from the clip. Ignores all other fields." },
    },
    additionalProperties: false,
  },

  apply: (clip: InspectorSurfaceClip, config: ColorGradingConfig, ctx: ApplyContext) => {
    const store = ctx.store as any;
    const list = (): Array<{ id: string; type: string; params: Record<string, unknown> }> =>
      (typeof store.getVideoEffects === "function" ? store.getVideoEffects(clip.id) : []) ?? [];

    if (typeof store.addVideoEffect !== "function" || typeof store.updateVideoEffect !== "function") {
      return { ok: false, error: "video effect chain not available on the store" };
    }

    if (config.reset === true) {
      const mine = list().filter((e) => OWNED.has(e.type));
      for (const e of mine) store.removeVideoEffect?.(clip.id, e.id);
      return { ok: true, note: mine.length ? `cleared ${mine.length} grading effect(s)` : "nothing to clear" };
    }

    /**
     * ONE EFFECT PER LOOK, UPDATED IN PLACE.
     *
     * Adding a second `saturation` entry every time the agent nudges saturation
     * would multiply the chain — visibly wrong after three calls, and the agent
     * has no reason to expect it. So: find mine, update it; otherwise add it.
     */
    const upsert = (type: string, params: Record<string, unknown>) => {
      const existing = list().find((e) => e.type === type);
      if (existing) store.updateVideoEffect(clip.id, existing.id, { ...existing.params, ...params });
      else store.addVideoEffect(clip.id, type, params);
    };

    const applied: string[] = [];
    for (const [field, spec] of Object.entries(SCALAR)) {
      const v = (config as any)[field];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v === spec.neutral) {
        // Setting a field back to neutral means REMOVE it, not "keep a
        // do-nothing effect in the chain" — otherwise a clip the agent reset
        // field-by-field still reports a grade.
        const existing = list().find((e) => e.type === spec.type);
        if (existing) store.removeVideoEffect?.(clip.id, existing.id);
        applied.push(`${field}=neutral`);
        continue;
      }
      upsert(spec.type, { [spec.param]: v });
      applied.push(`${field}=${v}`);
    }

    const tonal: Record<string, number> = {};
    for (const f of TONAL_FIELDS) {
      const v = (config as any)[f];
      if (typeof v === "number" && Number.isFinite(v)) tonal[f] = v;
    }
    if (Object.keys(tonal).length > 0) {
      const all = { ...tonal };
      if (Object.values(all).every((v) => v === 0)) {
        const existing = list().find((e) => e.type === "tonal");
        if (existing) store.removeVideoEffect?.(clip.id, existing.id);
        applied.push("tonal=neutral");
      } else {
        upsert("tonal", all);
        applied.push(...Object.entries(all).map(([k, v]) => `${k}=${v}`));
      }
    }

    if (applied.length === 0) {
      return { ok: false, error: "no grading fields given — pass at least one of " + [...Object.keys(SCALAR), ...TONAL_FIELDS].join(", ") };
    }
    return { ok: true, note: applied.join(" ") };
  },

  /**
   * The grade in the SAME words it was set in, read back off the chain the
   * renderer uses. Neutral fields are omitted, so an ungraded clip reads null
   * and a `looks` summary of a plain timeline stays empty.
   */
  read: (clip: InspectorSurfaceClip, ctx: ApplyContext) => {
    const store = ctx.store as any;
    const fx: Array<{ type: string; params: Record<string, unknown>; enabled?: boolean }> =
      (typeof store.getVideoEffects === "function" ? store.getVideoEffects(clip.id) : []) ?? [];
    if (fx.length === 0) return null;

    const out: Record<string, number> = {};
    for (const [field, spec] of Object.entries(SCALAR)) {
      const e = fx.find((x) => x.type === spec.type && x.enabled !== false);
      if (!e) continue;
      const v = Number(e.params?.[spec.param]);
      if (Number.isFinite(v) && v !== spec.neutral) out[field] = v;
    }
    const tonal = fx.find((x) => x.type === "tonal" && x.enabled !== false);
    if (tonal) {
      for (const f of TONAL_FIELDS) {
        const v = Number(tonal.params?.[f]);
        if (Number.isFinite(v) && v !== 0) out[f] = v;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  },
};
