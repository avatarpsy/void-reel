import type { Effect } from "../types/timeline";

export interface AudioWaveformData {
  readonly peaks: Float32Array;
  readonly rms: Float32Array;
  readonly sampleRate: number;
  readonly samplesPerPixel: number;
  readonly duration: number;
}

export interface LoudnessMetrics {
  readonly integrated: number; // LUFS
  readonly shortTerm: number; // LUFS
  readonly momentary: number; // LUFS
  readonly truePeak: number; // dBTP
  readonly range: number; // LU
}

export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

export interface AudioTrackRenderInfo {
  readonly trackId: string;
  readonly index: number;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly clips: AudioClipRenderInfo[];
}

export interface AudioClipRenderInfo {
  readonly clipId: string;
  readonly mediaId: string;
  readonly sourceTime: number;
  readonly timelineStartTime: number;
  readonly duration: number;
  readonly volume: number;
  readonly pan: number;
  readonly effects: Effect[];
  readonly fadeIn?: number;
  readonly fadeOut?: number;
  readonly speed?: number;
  readonly reversed?: boolean;
  /** Zero-based index of the audio track within the source media file to use. */
  readonly audioTrackIndex?: number;
  /**
   * Volume automation breakpoints (from the clip's native "volume"
   * keyframes; time = CLIP-local seconds from the clip's own start,
   * value = gain). Rendered as linear gain ramps so exports match the
   * preview's volume line.
   */
  readonly automationVolume?: ReadonlyArray<{ time: number; value: number }>;
  /**
   * The clip's AUDIO effect chain — EQ, compressor, reverb, delay, noise
   * reduction — as distinct from `effects`, which is the VISUAL chain (and
   * which this engine reads only to find a `pan`).
   *
   * `Clip.audioEffects` has existed, been written by the Inspector and by the
   * agent's `audio-effects` surface, and been saved in the project for a long
   * time. Nothing ever read it: `applyAudioEnhancements` in the web app's
   * audio bridge is the only code that runs an effect chain, and it had no
   * callers. So adding reverb to a clip changed the project file and never
   * changed a single sample — in the preview or in the export.
   */
  readonly audioEffects?: ReadonlyArray<Effect>;
  /** How far into the clip the render range starts (clip-local seconds). */
  readonly clipTimeOffset?: number;
}

export interface AudioChannelState {
  readonly trackId: string;
  readonly volume: number;
  readonly pan: number;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly peakLevel: number;
  readonly rmsLevel: number;
}

export interface AudioEffectNodeConfig {
  readonly type: string;
  readonly params: Record<string, unknown>;
  readonly enabled: boolean;
}

export interface RenderedAudio {
  readonly buffer: AudioBuffer;
  readonly startTime: number;
  readonly duration: number;
  readonly channels: number;
  readonly sampleRate: number;
}

export interface AudioEngineConfig {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bufferSize: number;
  readonly latencyHint: "interactive" | "balanced" | "playback";
}

export const DEFAULT_AUDIO_CONFIG: AudioEngineConfig = {
  sampleRate: 48000,
  channels: 2,
  bufferSize: 4096,
  latencyHint: "interactive",
};
