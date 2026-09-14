/**
 * A CLIP'S AUDIO EFFECTS HAVE TO REACH THE SOUND.
 *
 * `Clip.audioEffects` has been on the type for a long time. The Inspector wrote
 * it, the agent's `audio-effects` surface wrote it, and the project file saved
 * it. Nothing ever READ it: the only code that runs an effect chain was
 * `applyAudioEnhancements` in the web app's audio bridge, and that function had
 * no callers anywhere in the repo. So adding reverb or EQ to a clip changed the
 * project and never changed a single sample — in the preview or the export.
 *
 * That is the worst shape of bug this codebase keeps rediscovering: the control
 * responds, the state persists, the reply says ok, and the output is unchanged.
 * Same family as the blend mode that reached the preview and not the export
 * (`clip-blend-mode.test.ts`, which this mirrors deliberately).
 *
 * These pin the WIRING by source rather than by pixels: whether an
 * OfflineAudioContext produces the right samples is the Web Audio API's
 * business, but whether we ever hand it the chain is ours.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE = readFileSync(join(__dirname, "audio-engine.ts"), "utf8");
const TYPES = readFileSync(join(__dirname, "types.ts"), "utf8");

describe("the mixer honours a clip's audio effects", () => {
  it("carries audioEffects on the clip render info", () => {
    // Without this the field never leaves the Clip and the engine cannot see it.
    expect(TYPES).toMatch(/audioEffects\?:\s*ReadonlyArray<Effect>/);
    expect(ENGINE).toMatch(/audioEffects:\s*\(clip\.audioEffects\s*\?\?\s*\[\]\)/);
  });

  it("passes only ENABLED effects, so a disabled one costs nothing", () => {
    expect(ENGINE).toMatch(/\.filter\(\(e\) => e\.enabled !== false\)/);
  });

  it("applies the chain to the decoded buffer BEFORE it is played", () => {
    // The ordering is the whole point: processing after `source.buffer = ...`
    // would be processing a buffer nobody listens to.
    const applyIdx = ENGINE.indexOf("await this.withAudioEffects(decoded, clipInfo)");
    const assignIdx = ENGINE.indexOf("source.buffer = audioBuffer");
    expect(applyIdx, "withAudioEffects must be called").toBeGreaterThan(-1);
    expect(assignIdx, "the buffer must still be assigned").toBeGreaterThan(-1);
    expect(applyIdx).toBeLessThan(assignIdx);
  });

  it("actually runs the effect chain rather than merely reading the field", () => {
    expect(ENGINE).toMatch(/applyEffectChain\(/);
  });

  /**
   * The segmented decoder is a fast path for long media that never produces a
   * whole AudioBuffer. If it stayed eligible for a clip with effects, the chain
   * would be honoured on short clips and silently dropped on long ones — the
   * partial-coverage version of the original bug.
   */
  it("sends a clip with effects down the whole-buffer path", () => {
    // Anchor on the DECLARATION — an unanchored match finds the call site
    // first and asserts against the wrong block.
    const fn = /private shouldUseSegmentedAudioDecoding\([\s\S]*?\n  \}/.exec(ENGINE);
    expect(fn, "shouldUseSegmentedAudioDecoding must exist").toBeTruthy();
    expect(fn![0]).toMatch(/audioEffects\?\.length \?\? 0\) === 0/);
  });

  it("falls back to unprocessed audio instead of dropping the clip", () => {
    // A failed reverb should cost the reverb, not the sound.
    const fn = /private async withAudioEffects\([\s\S]*?\n  \}/.exec(ENGINE);
    expect(fn).toBeTruthy();
    expect(fn![0]).toMatch(/catch[\s\S]*return buffer;/);
  });

  it("caches on the chain itself, so a parameter change invalidates it", () => {
    const fn = /private async withAudioEffects\([\s\S]*?\n  \}/.exec(ENGINE);
    expect(fn![0]).toMatch(/JSON\.stringify\([\s\S]*?e\.type, e\.params/);
  });
});
