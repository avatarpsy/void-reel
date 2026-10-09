/**
 * TEMPO + BEAT GRID from a full mix — the analyzer the beat-sync tool relies on.
 *
 * The first analyzer looked for jumps in RMS LOUDNESS. A modern master is
 * compressed flat, so a whole song yielded a handful of "onsets", the BPM step
 * gave up and returned an invented 120 BPM grid with confidence 0, and the
 * tool reported it as a result (BETTER ME, 8 Oct 2026: 437 beats at 120 BPM on
 * a ~92 BPM song). Cuts snapped to that grid land off the music.
 *
 * This is the standard approach that works on dense mixes:
 *   1. Spectral flux — how much NEW energy appears in each frequency band per
 *      frame. Drums and chord changes show up here even when loudness is flat.
 *   2. Autocorrelation of that envelope picks the period, weighted towards
 *      ~120 BPM so a half- or double-time reading only wins when it is
 *      clearly stronger (the usual octave ambiguity).
 *   3. Beats are then TRACKED, not laid as a fixed grid: dynamic programming
 *      picks the strongest onsets spaced close to that period, so a song whose
 *      tempo wanders a little (Suno's BETTER ME runs 92.5 → 92.3 BPM; a fixed
 *      grid ends 0.1 s off) stays on the beat to the last bar.
 *
 * Confidence measures how periodic the flux is — one steady pulse against the
 * average: about 0 for noise (pink noise scores 1.5×), 1 for a clear pulse.
 * Callers must not snap to a low-confidence grid.
 */

export interface TempoTrack {
  bpm: number;
  confidence: number;
  /** Seconds. */
  beatTimes: number[];
  /** 0..1 per beat — how strong the onset under it is. */
  strengths: number[];
}

const TARGET_RATE = 11025;
const FFT_SIZE = 512;
const HOP = 128;

function fftMagnitudes(frame: Float64Array, re: Float64Array, im: Float64Array, out: Float64Array): void {
  const n = frame.length;
  for (let i = 0; i < n; i++) {
    re[i] = frame[i];
    im[i] = 0;
  }
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  for (let k = 0; k < out.length; k++) out[k] = Math.hypot(re[k], im[k]);
}

/** Spectral-flux onset envelope, high-passed and half-wave rectified. */
function onsetEnvelope(samples: Float32Array, sampleRate: number): { env: Float64Array; fps: number; centre: number } {
  const step = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const rate = sampleRate / step;
  const n = Math.floor(samples.length / step);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < step; j++) s += samples[i * step + j];
    x[i] = s / step;
  }
  const frames = Math.max(0, Math.floor((n - FFT_SIZE) / HOP));
  const fps = rate / HOP;
  const win = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  const frame = new Float64Array(FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const bins = FFT_SIZE / 2;
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) frame[i] = x[o + i] * win[i];
    fftMagnitudes(frame, re, im, cur);
    let sum = 0;
    for (let k = 1; k < bins; k++) {
      const v = Math.log1p(100 * cur[k]);
      cur[k] = v;
      if (f > 0) {
        const d = v - prev[k];
        if (d > 0) sum += d;
      }
    }
    flux[f] = sum;
    [prev, cur] = [cur, prev];
  }
  // High-pass: subtract a ~0.4 s moving average, keep only the rises.
  const half = Math.max(1, Math.round(fps * 0.2));
  const env = new Float64Array(frames);
  let acc = 0;
  let lo = 0;
  let hi = -1;
  for (let f = 0; f < frames; f++) {
    while (hi < Math.min(frames - 1, f + half)) acc += flux[++hi];
    while (lo < f - half) acc -= flux[lo++];
    const mean = acc / (hi - lo + 1);
    env[f] = Math.max(0, flux[f] - mean);
  }
  // Frame f covers samples [f·HOP, f·HOP + FFT_SIZE); its onset belongs to the
  // window's centre, not its start (otherwise every beat reads ~23 ms early).
  return { env, fps, centre: FFT_SIZE / 2 / rate };
}

/** Mean envelope value on the comb phase + k·period (linear interpolation). */
function combMean(env: Float64Array, period: number, phase: number): number {
  let s = 0;
  let c = 0;
  for (let t = phase; t < env.length - 1; t += period) {
    const i = Math.floor(t);
    const a = t - i;
    s += env[i] * (1 - a) + env[i + 1] * a;
    c++;
  }
  return c ? s / c : 0;
}

export function trackBeats(
  samples: Float32Array,
  sampleRate: number,
  opts: { minBpm?: number; maxBpm?: number } = {},
): TempoTrack {
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 200;
  const { env, fps, centre } = onsetEnvelope(samples, sampleRate);
  const none: TempoTrack = { bpm: 0, confidence: 0, beatTimes: [], strengths: [] };
  if (env.length < fps * 4) return none;

  let envMean = 0;
  for (let i = 0; i < env.length; i++) envMean += env[i];
  envMean /= env.length;
  if (envMean <= 0) return none;

  // 1) Period by prior-weighted autocorrelation.
  const minLag = Math.floor((fps * 60) / maxBpm);
  const maxLag = Math.ceil((fps * 60) / minBpm);
  const ac = new Float64Array(maxLag + 2);
  for (let L = minLag - 1; L <= maxLag + 1; L++) {
    let s = 0;
    for (let t = 0; t + L < env.length; t++) s += env[t] * env[t + L];
    ac[L] = s / (env.length - L);
  }
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let L = minLag; L <= maxLag; L++) {
    const bpm = (60 * fps) / L;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    const score = ac[L] * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = L;
    }
  }
  // Parabolic refinement around the integer peak.
  const y0 = ac[bestLag - 1];
  const y1 = ac[bestLag];
  const y2 = ac[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const coarse = bestLag + (denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0);

  // 2) Refine the period against the whole track (best comb over phases).
  let period = coarse;
  let bestComb = -Infinity;
  for (let p = coarse * 0.985; p <= coarse * 1.015; p += 0.01) {
    for (let ph = 0; ph < p; ph += 0.5) {
      const sc = combMean(env, p, ph);
      if (sc > bestComb) {
        bestComb = sc;
        period = p;
      }
    }
  }

  // 3) Track beats by dynamic programming (Ellis 2007): each frame's score is
  //    its onset strength plus the best predecessor 0.5–2 periods back, with a
  //    penalty for straying from the period. Follows gentle tempo drift.
  const norm = new Float64Array(env.length);
  for (let i = 0; i < env.length; i++) norm[i] = env[i] / envMean;
  const TIGHTNESS = 100;
  const score = new Float64Array(env.length);
  const back = new Int32Array(env.length).fill(-1);
  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.round(period * 2);
  for (let t = 0; t < env.length; t++) {
    let bestPrev = -1;
    let bestVal = 0;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const v = score[t - d] - TIGHTNESS * Math.log(d / period) ** 2;
      if (bestPrev < 0 || v > bestVal) {
        bestVal = v;
        bestPrev = t - d;
      }
    }
    score[t] = norm[t] + (bestPrev >= 0 ? Math.max(0, bestVal) : 0);
    back[t] = bestPrev >= 0 && bestVal > 0 ? bestPrev : -1;
  }
  // Start the backtrace from the best-scoring frame in the last period.
  let end = env.length - 1;
  for (let t = Math.max(0, env.length - Math.round(period)); t < env.length; t++) {
    if (score[t] > score[end]) end = t;
  }
  const frames: number[] = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();
  if (frames.length < 4) return none;

  // 4) Confidence = how PERIODIC the flux is: the best comb (one steady pulse
  //    over the whole track) against the average. Not the tracked beats' own
  //    flux — the tracker picks the strongest peaks, so even noise scores high.
  const ratio = bestComb / envMean;
  const confidence = Math.max(0, Math.min(1, (ratio - 1.5) / 1.5));

  let envMax = 0;
  for (let i = 0; i < env.length; i++) envMax = Math.max(envMax, env[i]);
  const beatTimes = frames.map((f) => f / fps + centre);
  const strengths = frames.map((f) => (envMax > 0 ? env[f] / envMax : 0));
  return { bpm: (60 * fps) / period, confidence, beatTimes, strengths };
}
