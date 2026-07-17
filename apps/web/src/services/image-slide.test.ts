import { describe, it, expect } from "vitest";
import { kenBurnsKeyframes, fadeInKeyframes } from "./image-slide";

describe("kenBurnsKeyframes", () => {
  it("zoom in scales up over the clip on both axes", () => {
    const kfs = kenBurnsKeyframes(4, "in");
    expect(kfs).toHaveLength(4);
    const sx = kfs.filter((k) => k.property === "scale.x");
    expect(sx[0].time).toBe(0);
    expect(sx[0].value).toBeCloseTo(1.06);
    expect(sx[1].time).toBe(4);
    expect(sx[1].value).toBeCloseTo(1.18);
  });

  it("zoom out scales down over the clip", () => {
    const sx = kenBurnsKeyframes(4, "out").filter((k) => k.property === "scale.x");
    expect(sx[0].value).toBeCloseTo(1.18);
    expect(sx[1].value).toBeCloseTo(1.06);
  });

  it("zoom none produces no keyframes", () => {
    expect(kenBurnsKeyframes(4, "none")).toHaveLength(0);
  });
});

describe("fadeInKeyframes", () => {
  it("fades opacity 0→1 over the head", () => {
    const kfs = fadeInKeyframes(0.5);
    expect(kfs).toHaveLength(2);
    expect(kfs[0]).toMatchObject({ time: 0, property: "opacity", value: 0 });
    expect(kfs[1]).toMatchObject({ time: 0.5, property: "opacity", value: 1 });
  });

  it("no fade when duration is 0", () => {
    expect(fadeInKeyframes(0)).toHaveLength(0);
  });
});
