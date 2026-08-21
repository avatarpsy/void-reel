/**
 * A CLIP'S BLEND MODE HAS TO REACH THE EXPORT, NOT JUST THE PREVIEW.
 *
 * `Clip.blendMode` has been on the type for a long time and the preview has
 * always honoured it (`drawFrameWithTransform` in the editor's canvas-renderers
 * passes `clip.blendMode` straight through to `globalCompositeOperation`). The
 * path that writes the actual MP4 — `VideoEngine.renderFrame` — never read it.
 *
 * That gap is invisible until it is expensive. A graphic overlay is rendered
 * with a transparent background, and every transparent pixel arrives at this
 * compositor as BLACK; `screen` is what makes the black disappear. Honoured in
 * preview and ignored in export means the overlay looks correct for the whole
 * edit and covers the picture in the file the user ships — the exact class of
 * bug `compositeTracksToCtx` was written to end.
 *
 * These tests drive the mapping and the wiring rather than pixels: the drawing
 * itself is canvas behaviour, but WHICH composite operation gets set is ours.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE = readFileSync(join(__dirname, "video-engine.ts"), "utf8");

describe("export honours a clip's blend mode", () => {
  it("reads clip.blendMode when drawing a clip", () => {
    // The wiring, pinned by source: the call site must PASS the clip's mode.
    // Without this argument the parameter exists, defaults to normal, and the
    // whole feature is silently inert.
    const callSite = /this\.drawFrameToContext\(([\s\S]{0,400}?)\);/.exec(ENGINE);
    expect(callSite, "renderFrame no longer calls drawFrameToContext").toBeTruthy();
    expect(callSite![1]).toContain("clip.blendMode");
  });

  it("sets globalCompositeOperation from it, through the shared mapper", () => {
    // `getCanvasBlendMode` already maps the whole BlendMode vocabulary and
    // already falls back to source-over. A second mapping here would be a
    // second thing to keep in step with the preview.
    const helper = /private drawFrameToContext\([\s\S]*?\n  \}/.exec(ENGINE);
    expect(helper).toBeTruthy();
    expect(helper![0]).toContain("globalCompositeOperation");
    expect(helper![0]).toContain("getCanvasBlendMode");
  });

  it("defaults to normal, so every existing clip draws exactly as before", () => {
    const helper = /private drawFrameToContext\([\s\S]*?\n  \}/.exec(ENGINE);
    expect(helper![0]).toMatch(/blendMode \?\? "normal"/);
  });

  it("restores the context, so one blended clip cannot infect the next", () => {
    // `globalCompositeOperation` is context state. Set without a save/restore
    // pair it would leak onto every clip drawn afterwards in the same frame —
    // one screen-blended overlay would turn the rest of the composite additive.
    const helper = /private drawFrameToContext\([\s\S]*?\n  \}/.exec(ENGINE);
    const body = helper![0];
    expect(body).toContain("ctx.save()");
    expect(body).toContain("ctx.restore()");
    // The composite op must be set AFTER the save, or the save captures it.
    expect(body.indexOf("ctx.save()")).toBeLessThan(
      body.indexOf("globalCompositeOperation"),
    );
  });

  it("maps screen — the mode a transparent overlay depends on", () => {
    const mapper = /private getCanvasBlendMode\([\s\S]*?\n  \}/.exec(ENGINE);
    expect(mapper).toBeTruthy();
    expect(mapper![0]).toContain("screen");
    // And an unknown mode must not throw or blank the frame.
    expect(mapper![0]).toContain("source-over");
  });
});
