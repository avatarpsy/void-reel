import { describe, it, expect } from "vitest";
import { sourceSpanOf, clampSpeed } from "./retime";

/**
 * The bug these pin down: `SpeedEngine.setClipSpeed`'s third argument is the
 * SOURCE span and the renderer clamps playback to it, but the Inspector passed
 * `clip.duration` — the on-timeline length, which is the source span divided by
 * whatever speed is already applied. Equal on a fresh clip, wrong on every
 * retimed one, and invisible until retiming started surviving reloads.
 */
describe("sourceSpanOf", () => {
  it("is outPoint - inPoint, NOT the on-timeline duration", () => {
    // A 10s source, trimmed to 2s–8s, already played at 2x so it occupies 3s.
    expect(sourceSpanOf({ inPoint: 2, outPoint: 8, duration: 3 })).toBe(6);
  });

  it("agrees with duration on an untouched clip — which is why the bug hid", () => {
    expect(sourceSpanOf({ inPoint: 0, outPoint: 10, duration: 10 })).toBe(10);
  });

  it("falls back to duration when there is no meaningful in/out", () => {
    // A generated still has no source span; returning 0 would make the
    // renderer clamp every frame to time zero.
    expect(sourceSpanOf({ inPoint: 0, outPoint: 0, duration: 5 })).toBe(5);
    expect(sourceSpanOf({ inPoint: 4, outPoint: 4, duration: 5 })).toBe(5);
  });

  it("never returns a negative span from a malformed clip", () => {
    expect(sourceSpanOf({ inPoint: 8, outPoint: 2, duration: 3 })).toBe(3);
    expect(sourceSpanOf({ inPoint: NaN, outPoint: 5, duration: 2 })).toBe(2);
  });
});

describe("clampSpeed", () => {
  it("holds the engine's own bounds", () => {
    expect(clampSpeed(0.01)).toBe(0.1);
    expect(clampSpeed(1000)).toBe(20);
    expect(clampSpeed(2)).toBe(2);
  });
});
