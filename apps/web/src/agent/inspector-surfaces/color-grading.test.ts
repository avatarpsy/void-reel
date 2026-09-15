import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { surface } from "./color-grading";
import { SURFACES } from "./index";

/**
 * Colour grading is the single most-used operation in an edit, and for the life
 * of this fork it did nothing at all: the surface pointed at
 * `updateColorGrading`, which reads `colorWheels` / `curves` / `lut` / `hsl` and
 * ignores every flat field the schema advertised. It returned `true`, so the
 * agent was told "color-grading ✓" every time.
 *
 * These are the two things that were never checked and would have caught it:
 *   • the write goes to a chain the RENDERER reads
 *   • the numbers are in the RENDERER'S units
 */

/** A store stub shaped like the real one's video-effect chain. */
function fakeStore() {
  const chain: Array<{ id: string; type: string; params: Record<string, unknown> }> = [];
  let n = 0;
  return {
    chain,
    getVideoEffects: (_id: string) => chain,
    addVideoEffect: (_id: string, type: string, params: Record<string, unknown>) => {
      const e = { id: `e${++n}`, type, params: { ...params } };
      chain.push(e);
      return e;
    },
    updateVideoEffect: (_id: string, effectId: string, params: Record<string, unknown>) => {
      const e = chain.find((x) => x.id === effectId);
      if (e) e.params = { ...params };
      return e ?? null;
    },
    removeVideoEffect: (_id: string, effectId: string) => {
      const i = chain.findIndex((x) => x.id === effectId);
      if (i >= 0) chain.splice(i, 1);
      return i >= 0;
    },
  };
}

const clip = { id: "c1", kind: "video" as const, trackId: "t1", raw: {} as never };
const ctxFor = (store: ReturnType<typeof fakeStore>) =>
  ({ store: store as unknown as Record<string, unknown>, project: {} as never });

describe("color-grading surface", () => {
  it("writes into the effect chain the renderer reads", async () => {
    const store = fakeStore();
    const r = await surface.apply(clip, { exposure: 30, saturation: 1.4 }, ctxFor(store));
    expect(r.ok).toBe(true);
    expect(store.chain.map((e) => e.type).sort()).toEqual(["brightness", "saturation"]);
  });

  it("speaks the ENGINE's units, not a tidier invented scale", async () => {
    // `VideoEffectsEngine.buildCSSFilter` does `brightness(1 + value/100)`, so
    // exposure is a PERCENT. A first draft called it -1..1; `exposure: 0.3` then
    // rendered as brightness(1.003) — invisible, and reported as success.
    const store = fakeStore();
    await surface.apply(clip, { exposure: 30 }, ctxFor(store));
    expect(store.chain[0].params.value).toBe(30);

    const schema = surface.schema as any;
    expect(schema.properties.exposure.minimum).toBe(-100);
    expect(schema.properties.exposure.maximum).toBe(100);
    expect(schema.properties.temperature.minimum).toBe(-100);
    expect(schema.properties.vignette.maximum).toBe(100);
    // contrast/saturation are ratios around 1, NOT percentages.
    expect(schema.properties.saturation.maximum).toBe(2);
  });

  it("replaces a value instead of stacking a second effect", async () => {
    const store = fakeStore();
    await surface.apply(clip, { saturation: 1.4 }, ctxFor(store));
    await surface.apply(clip, { saturation: 0.6 }, ctxFor(store));
    expect(store.chain.filter((e) => e.type === "saturation")).toHaveLength(1);
    expect(store.chain[0].params.value).toBe(0.6);
  });

  it("treats a neutral value as REMOVE, so a reset clip reports no grade", async () => {
    const store = fakeStore();
    await surface.apply(clip, { saturation: 1.4 }, ctxFor(store));
    await surface.apply(clip, { saturation: 1 }, ctxFor(store));
    expect(store.chain).toHaveLength(0);
    expect(await surface.read!(clip, ctxFor(store))).toBeNull();
  });

  it("keeps saturation 0 — black and white is a real request, not 'unset'", async () => {
    const store = fakeStore();
    await surface.apply(clip, { saturation: 0 }, ctxFor(store));
    expect(store.chain[0].params.value).toBe(0);
    expect(await surface.read!(clip, ctxFor(store))).toEqual({ saturation: 0 });
  });

  it("puts highlights/midtones/shadows on ONE tonal effect", async () => {
    const store = fakeStore();
    await surface.apply(clip, { shadows: 0.2, highlights: -0.3 }, ctxFor(store));
    const tonal = store.chain.filter((e) => e.type === "tonal");
    expect(tonal).toHaveLength(1);
    expect(tonal[0].params).toMatchObject({ shadows: 0.2, highlights: -0.3 });
  });

  it("reset clears every grading effect and nothing else", async () => {
    const store = fakeStore();
    await surface.apply(clip, { exposure: 20, saturation: 1.5 }, ctxFor(store));
    store.addVideoEffect("c1", "blur", { radius: 4 }); // not ours
    await surface.apply(clip, { reset: true }, ctxFor(store));
    expect(store.chain.map((e) => e.type)).toEqual(["blur"]);
  });

  it("refuses a call that names no field, instead of answering ok", async () => {
    const store = fakeStore();
    const r = await surface.apply(clip, {}, ctxFor(store));
    expect(r.ok).toBe(false);
  });

  it("is registered once, from its own file, not as a clip-property row", () => {
    expect(SURFACES["color-grading"]).toBeTruthy();
    const rows = readFileSync(join(process.cwd(), "src/agent/inspector-surfaces/clip-properties.ts"), "utf8");
    expect(rows).not.toContain('name: "color-grading"');
    expect(rows).not.toContain('storeMethod: "updateColorGrading"');
  });
});

/**
 * The chain lived only in `EffectsBridge`; `VideoEngine` — preview frame AND
 * every frame of the export — reads `clip.effects`. Nothing wrote it, so every
 * effect was visible while editing and absent from the file.
 */
describe("effect chain reaches the renderer", () => {
  const store = readFileSync(join(process.cwd(), "src/stores/project-store.ts"), "utf8");

  it("mirrors the bridge onto clip.effects after EVERY chain mutation", () => {
    expect(store).toContain("function mirrorClipEffectsToProject");
    // add / update / remove / reorder / toggle, plus the definition.
    const calls = store.split("mirrorClipEffectsToProject").length - 1;
    expect(calls).toBeGreaterThanOrEqual(6);
  });

  it("does not leave a bare modifiedAt bump in place of the mirror", () => {
    const region = store.slice(store.indexOf("addVideoEffect: ("), store.indexOf("getVideoEffects: ("));
    expect(region).not.toContain("set({ project: { ...get().project, modifiedAt: Date.now() } });");
  });
});
