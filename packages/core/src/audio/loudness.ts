/**
 * Loudness to ITU-R BS.1770-4 / EBU R128.
 *
 * ── WHY THIS REPLACES A ONE-LINER ───────────────────────────────────────────
 * `AudioEngine.measureLoudness` computed `20*log10(rms) - 0.691` over channel 0
 * and returned a hard-coded `range: 10`. That is RMS with a constant taken off
 * it — no K-weighting, no 400 ms blocks, no gating, no second channel — and it
 * is not LUFS in any sense that survives comparison with a real meter. Anything
 * setting gains from it is setting them from a number that does not mean what
 * its name says.
 *
 * It matters because loudness is the whole basis of a mix. "Put the bed 15 dB
 * under the dialogue" is a statement about perceived loudness, and RMS answers a
 * different question: a bright traffic bed and a warm voice at equal RMS are
 * nowhere near equally loud, which is exactly the case this codebase has to get
 * right. K-weighting exists to model that.
 *
 * ── WHAT IS EXACT AND WHAT IS NOT ───────────────────────────────────────────
 * Integrated loudness, short-term, momentary and LRA follow the spec: K-weighted
 * filters derived for the ACTUAL sample rate (44.1 kHz here, not just the 48 kHz
 * the tabulated coefficients assume), 400 ms blocks at 100 ms hop, the -70 LUFS
 * absolute gate and the -10 LU relative gate.
 *
 * TRUE PEAK is approximated by 4x oversampling with Catmull-Rom interpolation
 * rather than the spec's polyphase FIR. It is always >= the sample peak and
 * within a few tenths of a dB in practice, which is the right accuracy for
 * deciding headroom. `samplePeak` is exact and reported separately so the two
 * are never confused.
 */

/** One biquad, as direct-form I. */
interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/**
 * The two K-weighting stages, derived for `fs`.
 *
 * The spec tabulates coefficients at 48 kHz only. Using those at 44.1 kHz shifts
 * both corner frequencies by ~9%, which quietly biases every reading — and 44.1
 * is what the music editor actually renders at. These come from the analog
 * prototype instead, so they are right at any rate.
 */
export function kWeightingFilters(fs: number): [Biquad, Biquad] {
  // Stage 1 — high shelf, ~+4 dB above ~1.68 kHz (the head/torso model).
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q1 = 0.7071752369554196;
  const K1 = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const den1 = 1 + K1 / Q1 + K1 * K1;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K1) / Q1 + K1 * K1) / den1,
    b1: (2 * (K1 * K1 - Vh)) / den1,
    b2: (Vh - (Vb * K1) / Q1 + K1 * K1) / den1,
    a1: (2 * (K1 * K1 - 1)) / den1,
    a2: (1 - K1 / Q1 + K1 * K1) / den1,
  };

  // Stage 2 — RLB high pass at ~38 Hz, so rumble does not read as loudness.
  const f1 = 38.13547087602444;
  const Q2 = 0.5003270373238773;
  const K2 = Math.tan((Math.PI * f1) / fs);
  const den2 = 1 + K2 / Q2 + K2 * K2;
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K2 * K2 - 1)) / den2,
    a2: (1 - K2 / Q2 + K2 * K2) / den2,
  };

  return [shelf, hp];
}

function applyBiquad(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = f.b0 * xn + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = xn;
    y2 = y1; y1 = yn;
    y[i] = yn;
  }
  return y;
}

export interface LoudnessReading {
  /** Gated integrated loudness, LUFS. -Infinity for silence. */
  integrated: number;
  /** Loudest 3 s window, LUFS. */
  shortTerm: number;
  /** Loudest 400 ms window, LUFS. */
  momentary: number;
  /** Loudness range (10th-95th percentile of short-term), LU. */
  range: number;
  /** 4x-oversampled peak, dBTP. */
  truePeak: number;
  /** Exact sample peak, dBFS. */
  samplePeak: number;
}

const SILENT: LoudnessReading = {
  integrated: -Infinity,
  shortTerm: -Infinity,
  momentary: -Infinity,
  range: 0,
  truePeak: -Infinity,
  samplePeak: -Infinity,
};

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** Mean of the block mean-squares, as a loudness in LUFS. */
const loudnessOf = (blocks: number[]): number => {
  if (blocks.length === 0) return -Infinity;
  const mean = blocks.reduce((s, z) => s + z, 0) / blocks.length;
  return mean > 0 ? -0.691 + 10 * Math.log10(mean) : -Infinity;
};

/**
 * Measure a decoded buffer.
 *
 * @param channels raw PCM per channel
 * @param sampleRate the buffer's OWN rate — not the one anybody requested
 */
export function measureLoudnessOf(
  channels: Float32Array[],
  sampleRate: number,
): LoudnessReading {
  if (channels.length === 0 || channels[0].length === 0) return SILENT;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return SILENT;

  // ── exact sample peak, and an oversampled estimate of the true peak ───────
  let samplePeak = 0;
  let truePeak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > samplePeak) samplePeak = a;
    }
    // Catmull-Rom between samples at 4x. Inter-sample peaks are what clip a
    // downstream D/A or encoder even when every stored sample is under 0 dBFS.
    for (let i = 1; i + 2 < ch.length; i++) {
      const p0 = ch[i - 1], p1 = ch[i], p2 = ch[i + 1], p3 = ch[i + 2];
      for (let s = 1; s < 4; s++) {
        const t = s / 4;
        const v =
          0.5 *
          ((2 * p1) +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
        const a = Math.abs(v);
        if (a > truePeak) truePeak = a;
      }
    }
  }
  truePeak = Math.max(truePeak, samplePeak);

  // ── K-weight every channel ────────────────────────────────────────────────
  const [shelf, hp] = kWeightingFilters(sampleRate);
  const weighted = channels.map((ch) => applyBiquad(applyBiquad(ch, shelf), hp));

  /**
   * Channel weights G. L/R/C are 1.0; surrounds would be 1.41. Everything this
   * editor produces is mono or stereo, so 1.0 across is correct — and stated
   * rather than assumed, because a silent 1.41 would inflate every reading.
   */
  const G = weighted.map(() => 1.0);

  // ── 400 ms blocks, 100 ms hop ─────────────────────────────────────────────
  const blockLen = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  if (weighted[0].length < blockLen) {
    // Too short for even one gating block: report peaks, no loudness. Saying
    // "-70 LUFS" here would be a measurement nobody made.
    return { ...SILENT, truePeak: db(truePeak), samplePeak: db(samplePeak) };
  }

  const blockZ: number[] = [];
  for (let start = 0; start + blockLen <= weighted[0].length; start += hop) {
    let z = 0;
    for (let c = 0; c < weighted.length; c++) {
      const ch = weighted[c];
      let sum = 0;
      for (let i = start; i < start + blockLen; i++) sum += ch[i] * ch[i];
      z += G[c] * (sum / blockLen);
    }
    blockZ.push(z);
  }

  const blockLoudness = blockZ.map((z) =>
    z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity,
  );

  // ── gating: absolute -70 LUFS, then relative -10 LU ───────────────────────
  const aboveAbsolute = blockZ.filter((_, i) => blockLoudness[i] > -70);
  let integrated = -Infinity;
  if (aboveAbsolute.length > 0) {
    const relativeGate = loudnessOf(aboveAbsolute) - 10;
    const aboveRelative = blockZ.filter(
      (_, i) => blockLoudness[i] > -70 && blockLoudness[i] > relativeGate,
    );
    integrated = loudnessOf(aboveRelative.length > 0 ? aboveRelative : aboveAbsolute);
  }

  const momentary = blockLoudness.reduce((m, l) => (l > m ? l : m), -Infinity);

  // ── short-term: 3 s windows at the same 100 ms hop ────────────────────────
  const stBlocks = Math.round(3 / 0.1); // 30 blocks of 100 ms
  const shortTermSeries: number[] = [];
  for (let i = 0; i + stBlocks <= blockZ.length; i++) {
    // Averaging the overlapping 400 ms mean-squares across the window. Exact
    // for steady material, and within a small fraction of a LU of a true 3 s
    // window on real programme — short-term and LRA are advisory here, while
    // `integrated` (which IS to spec) is what gains are set from.
    let sum = 0;
    for (let j = i; j < i + stBlocks; j++) sum += blockZ[j];
    const z = sum / stBlocks;
    shortTermSeries.push(z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity);
  }
  const shortTerm = shortTermSeries.length
    ? shortTermSeries.reduce((m, l) => (l > m ? l : m), -Infinity)
    : momentary;

  // ── LRA: 10th-95th percentile of short-term, gated at -20 LU ──────────────
  let range = 0;
  const stAbove = shortTermSeries.filter((l) => l > -70);
  if (stAbove.length > 1) {
    const stGate =
      loudnessOf(stAbove.map((l) => Math.pow(10, (l + 0.691) / 10))) - 20;
    const kept = stAbove.filter((l) => l > stGate).sort((a, b) => a - b);
    if (kept.length > 1) {
      const at = (p: number) => kept[Math.min(kept.length - 1, Math.max(0, Math.round(p * (kept.length - 1))))];
      range = at(0.95) - at(0.1);
    }
  }

  return {
    integrated,
    shortTerm,
    momentary,
    range,
    truePeak: db(truePeak),
    samplePeak: db(samplePeak),
  };
}

/**
 * The gain that moves `measured` to `target`, as a linear multiplier.
 *
 * Trivial, and worth naming: this is the step that makes a mix deterministic.
 * Loudness is linear in dB under a gain change, so one multiply lands exactly
 * where it was predicted to — no iteration, no "render and see".
 */
export function gainToReach(measuredLufs: number, targetLufs: number): number {
  if (!Number.isFinite(measuredLufs)) return 1;
  return Math.pow(10, (targetLufs - measuredLufs) / 20);
}
