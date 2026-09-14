import { describe, it, expect } from "vitest";
import type { TimelineBeatMarker } from "@openreel/core";
import { nearestBeat } from "./beat-sync";

const beat = (time: number, isDownbeat = false): TimelineBeatMarker =>
  ({ time, strength: 1, index: 0, isDownbeat }) as TimelineBeatMarker;

/** A 120 BPM bar: beats every 0.5s, downbeat every 4th. */
const GRID: TimelineBeatMarker[] = Array.from({ length: 17 }, (_, i) =>
  beat(i * 0.5, i % 4 === 0),
);

describe("nearestBeat", () => {
  it("finds the closest beat", () => {
    expect(nearestBeat(GRID, 1.1, { maxShiftSec: 0.25, downbeatsOnly: false })?.time).toBe(1);
    expect(nearestBeat(GRID, 1.4, { maxShiftSec: 0.25, downbeatsOnly: false })?.time).toBe(1.5);
  });

  /**
   * The guard that makes snapping safe. A beat further away than the allowed
   * shift is not "the nearest beat", it is a different part of the song — and
   * dragging a cut there is a re-edit the user did not ask for.
   */
  it("refuses a beat further away than maxShiftSec", () => {
    expect(nearestBeat(GRID, 1.25, { maxShiftSec: 0.1, downbeatsOnly: false })).toBeNull();
    // Same instant, a looser bound: now it is reachable.
    expect(nearestBeat(GRID, 1.25, { maxShiftSec: 0.3, downbeatsOnly: false })).not.toBeNull();
  });

  it("lands on bar starts when downbeatsOnly", () => {
    // 1.4s: nearest beat is 1.5, nearest DOWNBEAT is 2.0.
    expect(nearestBeat(GRID, 1.4, { maxShiftSec: 0.25, downbeatsOnly: false })?.time).toBe(1.5);
    expect(nearestBeat(GRID, 1.4, { maxShiftSec: 0.7, downbeatsOnly: true })?.time).toBe(2);
    // …and with a tight bound there is no downbeat in reach, so nothing moves.
    expect(nearestBeat(GRID, 1.4, { maxShiftSec: 0.25, downbeatsOnly: true })).toBeNull();
  });

  it("returns null on an empty grid rather than guessing", () => {
    expect(nearestBeat([], 1.0, { maxShiftSec: 1, downbeatsOnly: false })).toBeNull();
  });

  it("can snap backwards as well as forwards", () => {
    const b = nearestBeat(GRID, 2.1, { maxShiftSec: 0.25, downbeatsOnly: false });
    expect(b?.time).toBe(2);
  });

  it("is exact when the cut is already on a beat", () => {
    expect(nearestBeat(GRID, 3, { maxShiftSec: 0.25, downbeatsOnly: false })?.time).toBe(3);
  });
});
