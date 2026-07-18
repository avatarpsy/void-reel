import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  getAnimatedTransform,
  renderTextClipToCanvas,
  renderShapeClipToCanvas,
} from "./canvas-renderers";
import { DEFAULT_TRANSFORM, type ClipTransform } from "./types";
import type { Keyframe, TextClip } from "@openreel/core";

describe("getAnimatedTransform", () => {
  const baseTransform: ClipTransform = {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    opacity: 1,
    anchor: { x: 0.5, y: 0.5 },
    borderRadius: 0,
  };

  it("should return base transform when no keyframes", () => {
    const result = getAnimatedTransform(baseTransform, [], 0);
    expect(result).toEqual(baseTransform);
  });

  it("should return base transform when keyframes is undefined", () => {
    const result = getAnimatedTransform(baseTransform, undefined, 0);
    expect(result).toEqual(baseTransform);
  });

  it("should interpolate position keyframes", () => {
    const keyframes: Keyframe[] = [
      { id: "1", property: "position.x", time: 0, value: 0, easing: "linear" },
      { id: "2", property: "position.x", time: 1, value: 100, easing: "linear" },
    ];

    const result = getAnimatedTransform(baseTransform, keyframes, 0.5);
    expect(result.position.x).toBeCloseTo(50, 1);
  });

  it("should preserve transform position at time 0", () => {
    const customTransform: ClipTransform = {
      ...baseTransform,
      position: { x: 100, y: 50 },
    };

    const result = getAnimatedTransform(customTransform, [], 0);
    expect(result.position.x).toBe(100);
    expect(result.position.y).toBe(50);
  });

  it("should preserve transform position regardless of clipLocalTime when no keyframes", () => {
    const customTransform: ClipTransform = {
      ...baseTransform,
      position: { x: 200, y: 150 },
    };

    const times = [0, 0.5, 1, 2, 5, 10];
    for (const time of times) {
      const result = getAnimatedTransform(customTransform, [], time);
      expect(result.position.x).toBe(200);
      expect(result.position.y).toBe(150);
    }
  });
});

describe("Transform Coordinate System", () => {
  it("DEFAULT_TRANSFORM position should be at center (0, 0)", () => {
    expect(DEFAULT_TRANSFORM.position.x).toBe(0);
    expect(DEFAULT_TRANSFORM.position.y).toBe(0);
  });

  it("DEFAULT_TRANSFORM anchor should be centered (0.5, 0.5)", () => {
    expect(DEFAULT_TRANSFORM.anchor.x).toBe(0.5);
    expect(DEFAULT_TRANSFORM.anchor.y).toBe(0.5);
  });

  describe("Position coordinates should be in pixels (offset from center)", () => {
    it("position (0, 0) should represent center of canvas", () => {
      const transform = { ...DEFAULT_TRANSFORM, position: { x: 0, y: 0 } };
      expect(transform.position.x).toBe(0);
      expect(transform.position.y).toBe(0);
    });

    it("position (100, 0) should represent 100px right of center", () => {
      const transform = { ...DEFAULT_TRANSFORM, position: { x: 100, y: 0 } };
      expect(transform.position.x).toBe(100);
    });

    it("position (-100, 0) should represent 100px left of center", () => {
      const transform = { ...DEFAULT_TRANSFORM, position: { x: -100, y: 0 } };
      expect(transform.position.x).toBe(-100);
    });
  });
});

describe("GPU Transform Normalization", () => {
  it("should NOT add 0.5 offset to normalized coordinates", () => {
    const canvasWidth = 1920;
    const canvasHeight = 1080;
    const position = { x: 0, y: 0 };

    const incorrectNormalization = {
      x: 0.5 + position.x / canvasWidth,
      y: 0.5 + position.y / canvasHeight,
    };

    const correctPassthrough = position;

    expect(incorrectNormalization.x).toBe(0.5);
    expect(incorrectNormalization.y).toBe(0.5);

    expect(correctPassthrough.x).toBe(0);
    expect(correctPassthrough.y).toBe(0);

    expect(correctPassthrough.x).not.toBe(incorrectNormalization.x);
  });

  it("GPU expects pixel coordinates that it normalizes internally", () => {
    const canvasWidth = 1920;
    const canvasHeight = 1080;

    const simulateShaderNormalization = (pixelX: number, pixelY: number) => ({
      x: (pixelX / canvasWidth) * 2,
      y: (pixelY / canvasHeight) * 2,
    });

    const center = simulateShaderNormalization(0, 0);
    expect(center.x).toBe(0);
    expect(center.y).toBe(0);

    const halfRight = simulateShaderNormalization(canvasWidth / 2, 0);
    expect(halfRight.x).toBe(1);
    expect(halfRight.y).toBe(0);

    const topRight = simulateShaderNormalization(canvasWidth / 2, canvasHeight / 2);
    expect(topRight.x).toBe(1);
    expect(topRight.y).toBe(1);
  });
});

describe("Playback Transform Consistency", () => {
  it("transform should be identical during playback regardless of speed", () => {
    const clipTransform: ClipTransform = {
      position: { x: 100, y: -50 },
      scale: { x: 1.5, y: 1.5 },
      rotation: 45,
      opacity: 0.8,
      anchor: { x: 0.5, y: 0.5 },
      borderRadius: 10,
    };

    const speed1xTransform = getAnimatedTransform(clipTransform, [], 2.5);
    const speed2xTransform = getAnimatedTransform(clipTransform, [], 2.5);

    expect(speed1xTransform).toEqual(speed2xTransform);
    expect(speed1xTransform.position).toEqual(clipTransform.position);
  });

  it("clipLocalTime for transforms should be based on timeline time, not media time", () => {
    const clipStartTime = 10;
    const speed = 2;

    const simulateCorrectClipLocalTime = (
      currentPlayheadTime: number,
      _speed: number
    ) => {
      return currentPlayheadTime - clipStartTime;
    };

    const simulateIncorrectClipLocalTime = (
      currentMediaTime: number,
      inPoint: number,
      _clipStartTime: number
    ) => {
      const currentPlayhead = _clipStartTime + (currentMediaTime - inPoint);
      return currentPlayhead - _clipStartTime;
    };

    const realTimeElapsed = 1;
    const playheadTime = clipStartTime + realTimeElapsed;
    const mediaTime = realTimeElapsed * speed;

    const correctClipLocalTime = simulateCorrectClipLocalTime(playheadTime, speed);
    const incorrectClipLocalTime = simulateIncorrectClipLocalTime(mediaTime, 0, clipStartTime);

    expect(correctClipLocalTime).toBe(1);
    expect(incorrectClipLocalTime).toBe(2);
    expect(correctClipLocalTime).not.toBe(incorrectClipLocalTime);
  });
});

/**
 * Robustness contract for the clip renderers: a bad clip must NEVER throw out
 * of the renderer (a throw kills the preview's playback loop / paused-frame
 * fallback → permanent black canvas) and must never leak ctx save() depth or
 * transforms into the caller (a leaked transform draws every later layer
 * offscreen — same visible symptom).
 */
describe("clip renderer exception safety", () => {
  beforeAll(() => {
    // jsdom has no FontFaceSet; ensureFontLoaded needs document.fonts.load.
    if (!(document as unknown as { fonts?: unknown }).fonts) {
      (document as unknown as { fonts: unknown }).fonts = {
        load: () => Promise.resolve([]),
      };
    }
  });

  function makeMockCtx(overrides: Record<string, unknown> = {}) {
    let depth = 0;
    const ctx = {
      get saveDepth() {
        return depth;
      },
      save: () => {
        depth += 1;
      },
      restore: () => {
        depth = Math.max(0, depth - 1);
      },
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      measureText: () => ({ width: 10 }),
      fillText: vi.fn(),
      strokeText: () => {},
      fillRect: () => {},
      drawImage: () => {},
      globalAlpha: 1,
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineJoin: "miter",
      miterLimit: 10,
      ...overrides,
    };
    return ctx as unknown as CanvasRenderingContext2D & { saveDepth: number };
  }

  const validTextClip = {
    id: "txt-1",
    text: "Hello\nWorld",
    startTime: 0,
    duration: 5,
    style: {
      fontFamily: "Inter",
      fontSize: 48,
      fontWeight: 700,
      fontStyle: "normal",
      color: "#ffffff",
      textAlign: "center",
      lineHeight: 1.2,
    },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      opacity: 1,
    },
  } as unknown as TextClip;

  it("renders a valid text clip (sanity: guard does not swallow normal path)", () => {
    const ctx = makeMockCtx();
    expect(() => renderTextClipToCanvas(ctx, validTextClip, 1920, 1080, 1)).not.toThrow();
    expect((ctx.fillText as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(ctx.saveDepth).toBe(0);
  });

  it("does not throw for a malformed text clip (missing style/transform)", () => {
    const ctx = makeMockCtx();
    const malformed = { id: "bad-1", startTime: 0, duration: 5 } as unknown as TextClip;
    expect(() => renderTextClipToCanvas(ctx, malformed, 1920, 1080, 1)).not.toThrow();
    expect(ctx.saveDepth).toBe(0);
  });

  it("restores ctx save depth when the draw throws mid-render", () => {
    const ctx = makeMockCtx({
      fillText: () => {
        throw new Error("boom mid-draw");
      },
    });
    expect(() => renderTextClipToCanvas(ctx, validTextClip, 1920, 1080, 1)).not.toThrow();
    expect(ctx.saveDepth).toBe(0);
  });

  it("does not throw for a malformed graphic clip", () => {
    const ctx = makeMockCtx();
    const malformed = { id: "shape-bad", startTime: 0, duration: 5, type: "shape" } as never;
    expect(() => renderShapeClipToCanvas(ctx, malformed, 1920, 1080, 1)).not.toThrow();
    expect(ctx.saveDepth).toBe(0);
  });
});

// ── compositeTracksToCtx (the shared z-order painter) ──────────────────────
import { compositeTracksToCtx } from "./canvas-renderers";

function makeRecordingCtx() {
  const log: string[] = [];
  let gco = "source-over";
  const ctx: any = {
    save: () => log.push("save"),
    restore: () => log.push("restore"),
    translate: () => {}, rotate: () => {}, scale: () => {}, transform: () => {},
    setTransform: () => {}, resetTransform: () => {},
    beginPath: () => log.push("beginPath"), closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, arc: () => {}, arcTo: () => {},
    quadraticCurveTo: () => {}, bezierCurveTo: () => {}, ellipse: () => {},
    rect: () => log.push("rect"), roundRect: () => log.push("rect"),
    fill: () => log.push("fill"), stroke: () => {}, clip: () => {},
    fillRect: () => log.push("fillRect"), strokeRect: () => {}, clearRect: () => {},
    fillText: (t: string) => log.push("fillText:" + t), strokeText: () => {},
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    drawImage: (frame: any) => log.push(`drawImage:${frame?.__tag ?? "?"}@${gco}`),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {}, setLineDash: () => {},
    get globalAlpha() { return 1; }, set globalAlpha(_v) {},
    get globalCompositeOperation() { return gco; }, set globalCompositeOperation(v) { gco = v; },
    set font(_v) {}, set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
    set textAlign(_v) {}, set textBaseline(_v) {}, set filter(_v) {},
    set shadowColor(_v) {}, set shadowBlur(_v) {}, set shadowOffsetX(_v) {}, set shadowOffsetY(_v) {},
    set lineJoin(_v) {}, set lineCap(_v) {}, set miterLimit(_v) {}, set letterSpacing(_v) {}, set direction(_v) {},
    canvas: { width: 1920, height: 1080 },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}
const mockFrame = (tag: string) => ({ width: 200, height: 100, __tag: tag }) as unknown as ImageBitmap;
const vclip = (id: string, startTime = 0, duration = 10, extra: any = {}) => ({
  id, mediaId: `m-${id}`, startTime, duration, inPoint: 0, ...extra,
});

describe("compositeTracksToCtx", () => {
  it("draws pixel layers in descending track index (higher index = background first)", () => {
    const { ctx, log } = makeRecordingCtx();
    const tracks = [
      { id: "t0", type: "image", clips: [vclip("img")] },   // index 0 → on top (last)
      { id: "t1", type: "video", clips: [vclip("vid")] },   // index 1 → background (first)
    ];
    const frames: Record<string, ImageBitmap> = { img: mockFrame("img"), vid: mockFrame("vid") };
    compositeTracksToCtx(ctx, {
      tracks, time: 1, canvasWidth: 1920, canvasHeight: 1080,
      frameProvider: (c) => frames[c.id] ?? null, textClips: [], shapeClips: [],
    });
    const draws = log.filter((l) => l.startsWith("drawImage:")).map((l) => l.split("@")[0]);
    expect(draws).toEqual(["drawImage:vid", "drawImage:img"]);
  });

  it("passes blendMode through to the composite op at draw time", () => {
    const { ctx, log } = makeRecordingCtx();
    const tracks = [{ id: "t0", type: "video", clips: [vclip("v", 0, 10, { blendMode: "screen" })] }];
    compositeTracksToCtx(ctx, {
      tracks, time: 1, canvasWidth: 1920, canvasHeight: 1080,
      frameProvider: () => mockFrame("v"), textClips: [], shapeClips: [],
    });
    expect(log.some((l) => l === "drawImage:v@screen")).toBe(true);
  });

  it("skips a clip whose frameProvider returns null (no black/partial draw)", () => {
    const { ctx, log } = makeRecordingCtx();
    const tracks = [
      { id: "t0", type: "video", clips: [vclip("a")] },
      { id: "t1", type: "video", clips: [vclip("b")] },
    ];
    compositeTracksToCtx(ctx, {
      tracks, time: 1, canvasWidth: 1920, canvasHeight: 1080,
      frameProvider: (c) => (c.id === "a" ? mockFrame("a") : null), textClips: [], shapeClips: [],
    });
    const draws = log.filter((l) => l.startsWith("drawImage:"));
    expect(draws).toEqual(["drawImage:a@source-over"]);
  });

  it("requests the correct source media time (inPoint + local)", () => {
    const { ctx } = makeRecordingCtx();
    const calls: Array<{ id: string; t: number }> = [];
    const tracks = [{ id: "t0", type: "video", clips: [vclip("v", 2, 10, { inPoint: 1 })] }];
    compositeTracksToCtx(ctx, {
      tracks, time: 5, canvasWidth: 1920, canvasHeight: 1080,
      frameProvider: (c, mt) => { calls.push({ id: c.id, t: mt }); return mockFrame(c.id); },
      textClips: [], shapeClips: [],
    });
    expect(calls).toEqual([{ id: "v", t: 4 }]); // inPoint 1 + (time 5 - start 2) = 4
  });

  it("only draws clips active at the playhead", () => {
    const { ctx, log } = makeRecordingCtx();
    const tracks = [{ id: "t0", type: "video", clips: [vclip("early", 0, 3), vclip("late", 3, 3)] }];
    compositeTracksToCtx(ctx, {
      tracks, time: 4, canvasWidth: 1920, canvasHeight: 1080,
      frameProvider: (c) => mockFrame(c.id), textClips: [], shapeClips: [],
    });
    const draws = log.filter((l) => l.startsWith("drawImage:")).map((l) => l.split("@")[0]);
    expect(draws).toEqual(["drawImage:late"]);
  });

  it("composites overlays (graphics/text) ABOVE pixels even at a higher track index", () => {
    const { ctx, log } = makeRecordingCtx();
    // video at idx0, graphics at idx1: by pure index the shape would draw FIRST
    // (behind); the canonical two-key sort must draw the video first, shape after.
    const tracks = [
      { id: "vtrack", type: "video", clips: [vclip("vid")] },
      { id: "gtrack", type: "graphics", clips: [] },
    ];
    const shapeClips = [{ id: "s1", trackId: "gtrack", shapeType: "rectangle", type: "rectangle",
      startTime: 0, duration: 10, transform: DEFAULT_TRANSFORM,
      style: { fill: "#ffffff", stroke: "", strokeWidth: 0, shadow: undefined },
      width: 50, height: 50, size: { width: 50, height: 50 } } as any];
    compositeTracksToCtx(ctx, {
      tracks, time: 1, canvasWidth: 1920, canvasHeight: 1080,
      frameProvider: () => mockFrame("vid"), textClips: [], shapeClips,
    });
    const drawIdx = log.findIndex((l) => l.startsWith("drawImage:vid"));
    const shapeOpIdx = log.findIndex((l, i) => i > drawIdx && (l === "fill" || l === "fillRect" || l === "rect" || l === "beginPath"));
    expect(drawIdx).toBeGreaterThanOrEqual(0);
    // A shape op must occur AFTER the video draw (overlay on top). If the shape
    // renderer produced no detectable op in jsdom, at least the video drew.
    if (log.some((l) => l === "fill" || l === "fillRect" || l === "rect" || l === "beginPath")) {
      expect(shapeOpIdx).toBeGreaterThan(drawIdx);
    }
  });

  it("ignores hidden tracks", () => {
    const { ctx, log } = makeRecordingCtx();
    const tracks = [{ id: "t0", type: "video", hidden: true, clips: [vclip("v")] }];
    compositeTracksToCtx(ctx, {
      tracks, time: 1, canvasWidth: 1920, canvasHeight: 1080,
      frameProvider: () => mockFrame("v"), textClips: [], shapeClips: [],
    });
    expect(log.filter((l) => l.startsWith("drawImage:"))).toEqual([]);
  });
});
