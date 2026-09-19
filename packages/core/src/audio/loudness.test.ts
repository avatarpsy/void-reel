/**
 * Calibration against the EBU Tech 3341 test signals.
 *
 * A meter that is not checked against a known signal is a random number
 * generator with units. The one this replaces returned `20*log10(rms) - 0.691`
 * and a hard-coded `range: 10`, and nothing ever compared it to anything.
 */
import { describe, it, expect } from "vitest";

import { measureLoudnessOf, gainToReach, kWeightingFilters } from "./loudness";

/** Stereo 1 kHz sine at `dbfs`, `seconds` long. */
function sine(dbfs: number, seconds = 10, fs = 48000, hz = 1000) {
  const amp = Math.pow(10, dbfs / 20);
  const n = Math.round(seconds * fs);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin((2 * Math.PI * hz * i) / fs);
    l[i] = v;
    r[i] = v;
  }
  return { channels: [l, r], fs };
}

describe("BS.1770 calibration", () => {
  // EBU Tech 3341 case 1: stereo 1 kHz sine at -23 dBFS reads -23.0 LUFS ±0.1.
  it("reads -23 LUFS for the EBU -23 dBFS reference tone", () => {
    const { channels, fs } = sine(-23);
    const r = measureLoudnessOf(channels, fs);
    expect(r.integrated).toBeGreaterThan(-23.2);
    expect(r.integrated).toBeLessThan(-22.8);
  });

  // EBU Tech 3341 case 2: the same tone at -33 dBFS reads -33.0 LUFS ±0.1.
  it("reads -33 LUFS for the -33 dBFS reference tone", () => {
    const { channels, fs } = sine(-33);
    const r = measureLoudnessOf(channels, fs);
    expect(r.integrated).toBeGreaterThan(-33.2);
    expect(r.integrated).toBeLessThan(-32.8);
  });

  it("is calibrated at 44.1 kHz too — the rate this editor actually renders", () => {
    const { channels, fs } = sine(-23, 10, 44100);
    const r = measureLoudnessOf(channels, fs);
    // Would drift if the 48 kHz tabulated coefficients had been hard-coded.
    expect(r.integrated).toBeGreaterThan(-23.3);
    expect(r.integrated).toBeLessThan(-22.7);
  });

  it("moves exactly with gain, which is what makes a mix deterministic", () => {
    const quiet = measureLoudnessOf(sine(-30).channels, 48000).integrated;
    const loud = measureLoudnessOf(sine(-24).channels, 48000).integrated;
    expect(loud - quiet).toBeCloseTo(6, 1);
  });
});

describe("K-weighting", () => {
  it("derives different coefficients per sample rate", () => {
    const [s48] = kWeightingFilters(48000);
    const [s44] = kWeightingFilters(44100);
    expect(s48.b0).not.toBeCloseTo(s44.b0, 6);
  });

  it("matches the published 48 kHz shelf coefficients", () => {
    const [shelf, hp] = kWeightingFilters(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 6);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 6);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 6);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 6);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 6);
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(hp.a2).toBeCloseTo(0.99007225036621, 6);
  });
});

describe("peaks", () => {
  it("reports the exact sample peak", () => {
    const { channels, fs } = sine(-6, 2);
    const r = measureLoudnessOf(channels, fs);
    expect(r.samplePeak).toBeGreaterThan(-6.1);
    expect(r.samplePeak).toBeLessThan(-5.9);
  });

  it("true peak is never below sample peak", () => {
    const { channels, fs } = sine(-3, 2);
    const r = measureLoudnessOf(channels, fs);
    expect(r.truePeak).toBeGreaterThanOrEqual(r.samplePeak - 1e-9);
  });

  it("catches an inter-sample peak a sample-peak reading misses", () => {
    /**
     * A sine at exactly fs/4, offset by a quarter period: successive samples
     * advance by pi/2 and land at +-sin(pi/4) = +-0.707 of the true crest, so
     * EVERY stored sample sits 3 dB below a waveform that actually reaches
     * 0.98. This is the case that clips a converter or an encoder while a
     * sample-peak reading insists there is headroom.
     *
     * (A 1 kHz tone will not show this: at 48 samples per cycle some sample
     * always lands near the crest, which is why the first version of this test
     * measured nothing.)
     */
    const fs = 48000;
    const n = fs * 2;
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ch[i] = 0.98 * Math.sin((2 * Math.PI * (fs / 4) * i) / fs + Math.PI / 4);
    }
    const r = measureLoudnessOf([ch], fs);
    expect(r.samplePeak).toBeLessThan(-2.5); // ~0.707 -> about -3 dBFS
    expect(r.truePeak).toBeGreaterThan(r.samplePeak);
  });
});

describe("degenerate input", () => {
  it("digital silence is -Infinity, not a number that looks like a level", () => {
    const n = 48000;
    const r = measureLoudnessOf([new Float32Array(n), new Float32Array(n)], 48000);
    expect(r.integrated).toBe(-Infinity);
  });

  it("a buffer shorter than one gating block reports peaks and no loudness", () => {
    const { channels } = sine(-10, 0.1); // 100 ms < 400 ms
    const r = measureLoudnessOf(channels, 48000);
    expect(r.integrated).toBe(-Infinity);
    expect(r.samplePeak).toBeGreaterThan(-11);
  });

  it("survives an empty or nonsense buffer", () => {
    expect(measureLoudnessOf([], 48000).integrated).toBe(-Infinity);
    expect(measureLoudnessOf(sine(-20).channels, 0).integrated).toBe(-Infinity);
  });
});

describe("gainToReach", () => {
  it("computes the exact multiplier to hit a target", () => {
    // -30 LUFS to -16 LUFS is +14 dB.
    expect(gainToReach(-30, -16)).toBeCloseTo(Math.pow(10, 14 / 20), 6);
  });

  it("applying it actually lands on the target", () => {
    const { channels, fs } = sine(-30);
    const before = measureLoudnessOf(channels, fs).integrated;
    const g = gainToReach(before, -16);
    const scaled = channels.map((c) => {
      const o = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) o[i] = c[i] * g;
      return o;
    });
    expect(measureLoudnessOf(scaled, fs).integrated).toBeCloseTo(-16, 1);
  });

  it("is a no-op against an unmeasurable source", () => {
    expect(gainToReach(-Infinity, -16)).toBe(1);
  });
});
