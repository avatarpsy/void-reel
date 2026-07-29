export type VideoResolution = "720p" | "1080p" | "1440p" | "4k";
export type FrameRate = 30 | 60;
export type WebcamResolution = "480p" | "720p" | "1080p";
export type RecordingStatus =
  | "idle"
  | "requesting"
  | "countdown"
  | "recording"
  | "paused"
  | "processing"
  | "error";

/**
 * What to capture:
 *   • 'screen' — screen only (+ optional system audio / mic).
 *   • 'camera' — webcam only (talking head); mic is the audio source. No screen prompt.
 *   • 'both'   — screen as the primary recording + webcam as a SEPARATE file (PIP).
 *   • 'audio'  — microphone only (voiceover); no video, no screen prompt.
 */
export type RecordingMode = "screen" | "camera" | "both" | "audio";

/**
 * Shapes a webcam take can be recorded in. "project" follows the project's own
 * aspect ratio (the default); the rest are the ratios people actually shoot
 * for — widescreen, vertical, square, classic, and the 4:5 portrait that reads
 * well in feeds.
 */
export type WebcamAspect = "project" | "16:9" | "9:16" | "1:1" | "4:3" | "4:5";

export const WEBCAM_ASPECTS: { value: WebcamAspect; label: string; ratio: number | null }[] = [
  { value: "project", label: "Match project", ratio: null },
  { value: "16:9", label: "16:9 — Widescreen", ratio: 16 / 9 },
  { value: "9:16", label: "9:16 — Vertical", ratio: 9 / 16 },
  { value: "1:1", label: "1:1 — Square", ratio: 1 },
  { value: "4:5", label: "4:5 — Portrait", ratio: 4 / 5 },
  { value: "4:3", label: "4:3 — Classic", ratio: 4 / 3 },
];

/**
 * The aspect ratio a recording should actually target: the user's explicit
 * choice, or the project's ratio when they've left it on "Match project".
 */
export function resolveTargetAspect(options: RecordingOptions): number | undefined {
  const choice = options.webcam.aspect ?? "project";
  if (choice === "project") return options.targetAspect;
  return WEBCAM_ASPECTS.find((a) => a.value === choice)?.ratio ?? options.targetAspect;
}

export interface RecordingOptions {
  /** Capture mode. Defaults to 'both' when webcam.enabled, else 'screen'. */
  mode?: RecordingMode;
  video: {
    resolution: VideoResolution;
    frameRate: FrameRate;
    displaySurface?: "monitor" | "window" | "browser";
  };
  audio: {
    systemAudio: boolean;
    microphone: boolean;
  };
  webcam: {
    enabled: boolean;
    resolution: WebcamResolution;
    /**
     * Shape of the take. "project" (the default) follows the project's own
     * aspect ratio; the rest let the user override it for this recording.
     * Whatever is chosen is still validated against what the camera can
     * actually sustain — see acquireHealthyWebcam.
     */
    aspect?: WebcamAspect;
  };
  /** Selected input device ids (empty/undefined = system default). */
  audioDeviceId?: string;
  videoDeviceId?: string;
  /**
   * The PROJECT's aspect ratio (width / height). When set, webcam capture is
   * constrained to match it (e.g. a 9:16 project records portrait, 1:1 records
   * square) so the recorded clip fills the project frame instead of being
   * letterboxed/cropped. Undefined → capture at the resolution's native 16:9.
   * NEVER used to mutate the project's own settings — capture only.
   */
  targetAspect?: number;
}

/**
 * Resolve a webcam capture size from a quality tier + target aspect. The tier's
 * pixel count anchors the SHORT side (480/720/1080) so quality is consistent
 * across orientations; the long side follows the aspect ratio.
 */
export function webcamDimsForAspect(
  res: WebcamResolution,
  aspect?: number,
): { width: number; height: number; aspect: number } {
  const base = RESOLUTION_MAP[res];
  const ar = aspect && aspect > 0 ? aspect : base.width / base.height;
  const shortSide = base.height; // 480 / 720 / 1080
  if (ar >= 1) {
    const height = shortSide;
    return { width: Math.round((height * ar) / 2) * 2, height, aspect: ar };
  }
  const width = shortSide;
  return { width, height: Math.round((width / ar) / 2) * 2, aspect: ar };
}

/** Below this, a take is a slideshow — treat the capture as failed. */
export const MIN_USABLE_FPS = 10;

/**
 * Measure the frame rate a live video track ACTUALLY delivers.
 *
 * There is no way to predict this. A camera reports `frameRate: 30` in
 * getSettings() while delivering 0.7, and which geometries collapse is
 * per-device and not guessable from the numbers. Measured on a Dell WB7022:
 *
 *     1280x720  landscape → 30.0 fps
 *     1920x1080 landscape → 30.0 fps
 *     1080x1920 PORTRAIT  → 29.7 fps
 *     720x1280  PORTRAIT  →  0.7 fps   ← same aspect, same camera
 *
 * So we stop guessing and count frames. `requestVideoFrameCallback` fires once
 * per presented frame; a detached <video> is enough to drive it.
 */
export async function measureTrackFps(stream: MediaStream, sampleMs = 600): Promise<number> {
  if (typeof document === "undefined") return Number.POSITIVE_INFINITY;
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  try {
    await v.play().catch(() => {
      /* autoplay is fine for a muted, detached element */
    });
    const rvfc = (v as any).requestVideoFrameCallback;
    if (typeof rvfc !== "function") return Number.POSITIVE_INFINITY; // can't measure — don't block
    let frames = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      frames++;
      (v as any).requestVideoFrameCallback(tick);
    };
    (v as any).requestVideoFrameCallback(tick);
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, sampleMs));
    stopped = true;
    const elapsed = (performance.now() - t0) / 1000;
    return elapsed > 0 ? frames / elapsed : 0;
  } finally {
    // Detach fully — a still-playing element keeps decoding the track.
    try {
      v.pause();
      v.srcObject = null;
      v.removeAttribute("src");
      v.load();
    } catch {
      /* noop */
    }
  }
}

/**
 * Build the ordered list of capture constraints to try for a webcam.
 *
 * POLICY: match the PROJECT's aspect ratio — portrait project, portrait take;
 * landscape project, landscape take — using whichever mode the webcam can
 * actually sustain. Only if the camera can't deliver ANY mode at that aspect do
 * we fall back to its own default.
 *
 * So the list is in two stages:
 *   1. Every quality tier at the project's aspect, the user's chosen tier
 *      first, then the others (a camera that stalls at 720x1280 may be perfect
 *      at 1080x1920 — that is real, measured behaviour, not a guess).
 *   2. The camera's default: its preferred mode at the chosen tier's pixel
 *      budget, then bare native. Aspect is no longer honoured here, so the
 *      compositor frames the clip instead and the user is told.
 */
interface WebcamCandidate {
  label: string;
  video: MediaTrackConstraints;
  /** Does this mode give the project's aspect ratio? */
  matchesAspect: boolean;
}

function webcamCandidates(options: RecordingOptions): WebcamCandidate[] {
  const device: MediaTrackConstraints = options.videoDeviceId
    ? { deviceId: { exact: options.videoDeviceId } }
    : { facingMode: "user" };
  const fps = { ideal: options.video.frameRate };
  const sized = (w: number, h: number): MediaTrackConstraints => ({
    ...device,
    frameRate: fps,
    width: { ideal: w },
    height: { ideal: h },
  });

  const out: WebcamCandidate[] = [];
  const seen = new Set<string>();
  const add = (w: number, h: number, label: string, matchesAspect: boolean) => {
    const key = `${w}x${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: `${key} ${label}`, video: sized(w, h), matchesAspect });
  };

  // ── Stage 1: the wanted aspect, across every quality tier ──
  const wanted = resolveTargetAspect(options);
  const chosen = options.webcam.resolution;
  const tiers: WebcamResolution[] = [chosen, "1080p", "720p", "480p"];
  for (const tier of tiers) {
    const d = webcamDimsForAspect(tier, wanted);
    add(d.width, d.height, tier === chosen ? "(project aspect)" : `(project aspect, ${tier})`, true);
  }

  // ── Stage 2: the camera's own default ──
  const land = RESOLUTION_MAP[chosen];
  add(land.width, land.height, "(camera default)", !wanted || wanted >= 1);
  out.push({ label: "camera native", video: { ...device, frameRate: fps }, matchesAspect: false });
  return out;
}

/**
 * Acquire a webcam stream that is actually DELIVERING FRAMES.
 *
 * Walks the candidate constraints, measuring each briefly, and keeps the first
 * that clears MIN_USABLE_FPS. If none do, it returns the fastest one seen so
 * the caller can still proceed (and warn) rather than failing outright.
 */
export interface AcquiredWebcam {
  stream: MediaStream;
  /** Frames per second actually measured, not the camera's claim. */
  fps: number;
  label: string;
  /** True when the take will come out at the PROJECT's aspect ratio. */
  matchedAspect: boolean;
  width: number;
  height: number;
}

/**
 * Remembers the mode that won, per camera + aspect + tier.
 *
 * Probing the ladder means opening and measuring several camera modes, which
 * takes a second or two and makes the device renegotiate each time. The dialog
 * re-previews on open, on mode change, and on every device-picker change, so
 * without this the camera is thrashed constantly — which reads as lag long
 * after the right mode has been found. The answer doesn't change for a given
 * camera, so learn it once per session.
 */
const _modeCache = new Map<string, { width: number; height: number; matchedAspect: boolean; label: string }>();

/**
 * Forget the learned capture modes. Call when the set of cameras changes (a
 * device plugged in or removed can renumber things), and in tests so one case
 * can't inherit another's answer.
 */
export function clearWebcamModeCache(): void {
  _modeCache.clear();
}

function cacheKey(options: RecordingOptions): string {
  return [
    options.videoDeviceId || "default",
    options.webcam.resolution,
    resolveTargetAspect(options)?.toFixed(4) ?? "none",
    options.video.frameRate,
  ].join("|");
}

export async function acquireHealthyWebcam(options: RecordingOptions): Promise<AcquiredWebcam | null> {
  const key = cacheKey(options);
  const device: MediaTrackConstraints = options.videoDeviceId
    ? { deviceId: { exact: options.videoDeviceId } }
    : { facingMode: "user" };

  // Known-good mode for this camera? Open it directly — no ladder, no probing.
  const known = _modeCache.get(key);
  if (known) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...device,
          frameRate: { ideal: options.video.frameRate },
          ...(known.width ? { width: { ideal: known.width }, height: { ideal: known.height } } : {}),
        },
        audio: false,
      });
      return {
        stream,
        fps: MIN_USABLE_FPS,
        width: known.width,
        height: known.height,
        matchedAspect: known.matchedAspect,
        label: `${known.label} (cached)`,
      };
    } catch {
      _modeCache.delete(key); // camera changed under us — re-probe below
    }
  }

  let best: AcquiredWebcam | null = null;
  /** Never leave a probe stream open: a dead mode still held by the camera
   *  forces it to serve two configurations and stutters everything. */
  const release = (a: AcquiredWebcam | null) => a?.stream.getTracks().forEach((t) => t.stop());

  for (const cand of webcamCandidates(options)) {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: cand.video, audio: false });
    } catch (e) {
      console.warn(`[recorder] camera rejected ${cand.label}:`, (e as any)?.message ?? e);
      continue;
    }
    const fps = await measureTrackFps(stream);
    const s = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    const width = Number(s.width) || 0;
    const height = Number(s.height) || 0;
    // Trust what we GOT, not what we asked for: a camera can quietly hand back
    // a different geometry, and then "matched the project aspect" would be a
    // claim we never verified.
    const matchedAspect =
      cand.matchesAspect && !!width && !!height && aspectMatches(width / height, resolveTargetAspect(options));
    console.info(
      `[recorder] tried ${cand.label} → ${width}x${height} @ ${fps.toFixed(1)} fps measured` +
        (matchedAspect ? " · project aspect" : ""),
    );
    const picked: AcquiredWebcam = { stream, fps, label: cand.label, matchedAspect, width, height };
    if (fps >= MIN_USABLE_FPS) {
      release(best); // ← the loser is still holding the camera; let it go
      _modeCache.set(key, { width, height, matchedAspect, label: cand.label });
      return picked;
    }
    if (!best || fps > best.fps) {
      release(best);
      best = picked;
    } else {
      release(picked);
    }
  }
  if (best) {
    console.warn(
      `[recorder] no capture mode reached ${MIN_USABLE_FPS} fps; using ${best.label} at ${best.fps.toFixed(1)} fps`,
    );
  }
  return best;
}

/** Aspect comparison with enough slack for rounding to even dimensions. */
function aspectMatches(got: number, want?: number): boolean {
  if (!want || !Number.isFinite(want)) return true; // no project aspect → nothing to match
  return Math.abs(got - want) <= 0.02 * want;
}

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

export interface RecordingState {
  status: RecordingStatus;
  duration: number;
  error?: string;
  screenStream?: MediaStream;
  webcamStream?: MediaStream;
}

export interface RecordingResult {
  /** The PRIMARY recording: screen (screen/both), webcam (camera), or audio (audio). */
  screenBlob: Blob;
  /** The secondary webcam file — only in 'both' mode. */
  webcamBlob?: Blob;
  /** Which mode produced this result, so consumers import it correctly. */
  mode?: RecordingMode;
  /**
   * What the capture ACTUALLY produced, snapshotted before teardown. A starved
   * camera is otherwise undetectable until the user plays the take back and
   * finds a static image, so importers check this and refuse a dead take.
   */
  capture?: {
    frames: number | null;
    width: number;
    height: number;
    fps: number | null;
    durationSec: number;
    /** False when the camera couldn't deliver the project's aspect ratio. */
    matchedAspect: boolean;
  };
}

const RESOLUTION_MAP: Record<
  VideoResolution | WebcamResolution,
  { width: number; height: number }
> = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "4k": { width: 3840, height: 2160 },
};

const BITRATE_MAP: Record<VideoResolution | WebcamResolution, number> = {
  "480p": 2_500_000,
  "720p": 5_000_000,
  "1080p": 12_000_000,
  "1440p": 20_000_000,
  "4k": 40_000_000,
};

type RecordingEventType =
  | "start"
  | "stop"
  | "pause"
  | "resume"
  | "error"
  | "duration";
type RecordingEventHandler = (data?: unknown) => void;

export class ScreenRecorderService {
  private screenRecorder: MediaRecorder | null = null;
  private webcamRecorder: MediaRecorder | null = null;
  private screenChunks: Blob[] = [];
  private webcamChunks: Blob[] = [];
  private screenStream: MediaStream | null = null;
  private webcamStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private startTime: number = 0;
  private pausedDuration: number = 0;
  private pauseStartTime: number = 0;
  private durationInterval: number | null = null;
  private eventHandlers: Map<RecordingEventType, Set<RecordingEventHandler>> =
    new Map();
  private isStopping: boolean = false;
  private lastResult: RecordingResult | null = null;
  private mode: RecordingMode = "screen";
  /** Negotiated webcam geometry — surfaced so the UI can warn on a bad take. */
  private webcamSettings: MediaTrackSettings | null = null;
  /** Frame rate actually measured at acquisition (not the camera's claim). */
  private webcamMeasuredFps: number | null = null;
  /** Whether the chosen capture mode matches the project's aspect ratio. */
  private webcamMatchedAspect = true;

  on(event: RecordingEventType, handler: RecordingEventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return () => this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: RecordingEventType, data?: unknown): void {
    this.eventHandlers.get(event)?.forEach((handler) => handler(data));
  }

  async requestPermissions(
    options: RecordingOptions,
  ): Promise<{ screenStream: MediaStream; webcamStream?: MediaStream }> {
    const mode: RecordingMode = options.mode ?? (options.webcam.enabled ? "both" : "screen");
    this.mode = mode;

    const wantsScreen = mode === "screen" || mode === "both";
    const wantsWebcam = mode === "camera" || mode === "both";
    // In camera/audio modes the mic IS the audio source; in screen/both it's optional.
    const wantsMic = options.audio.microphone || mode === "camera" || mode === "audio";

    const resolution = RESOLUTION_MAP[options.video.resolution];

    let screenStream: MediaStream | undefined;
    if (wantsScreen) {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: resolution.width },
          height: { ideal: resolution.height },
          frameRate: { ideal: options.video.frameRate },
        },
        audio: options.audio.systemAudio,
      });
    }

    let micStream: MediaStream | undefined;
    if (wantsMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(options.audioDeviceId ? { deviceId: { exact: options.audioDeviceId } } : {}),
          },
        });
      } catch {
        console.warn("Microphone access denied, continuing without microphone");
      }
    }

    let webcamStream: MediaStream | undefined;
    if (wantsWebcam) {
      // Capture at the PROJECT's aspect ratio so the clip fills the frame
      // (a 9:16 project records portrait, 1:1 square).
      //
      // ── Why there is NO `aspectRatio` constraint here ────────────────────
      // There used to be one, and it produced unplayable takes. Given
      // aspectRatio:{ideal:0.5625}, Chrome may satisfy it by CROPPING the
      // sensor's native mode rather than scaling to the size we asked for: a
      // 2560x1440 camera yields 810x1440. `getSettings()` cheerfully reports
      // 810x1440 and the track looks healthy — but that crop path delivers
      // roughly ONE FRAME PER SECOND, so a 26-second take encodes a handful of
      // frames and plays back as a static image.
      //
      // Measured (record → play back → count presented frames):
      //     1280x720  → 41-99 frames   OK
      //     1080x1920 → 98-100 frames  OK
      //     810x1440  →   4-5 frames   BROKEN
      //     812x1440  →   2-4 frames   BROKEN   (so not macroblock alignment)
      //
      // Asking for explicit width/height with a `max` keeps the browser on a
      // real capture mode and scaling to it, which is the path that works.
      // Pick a capture mode by MEASURING what the camera delivers, not by
      // trusting the geometry we asked for (see acquireHealthyWebcam).
      try {
        const picked = await acquireHealthyWebcam(options);
        if (picked) {
          webcamStream = picked.stream;
          this.webcamSettings = webcamStream.getVideoTracks()[0]?.getSettings?.() ?? null;
          this.webcamMeasuredFps = picked.fps;
          this.webcamMatchedAspect = picked.matchedAspect;
          console.info(
            "[recorder] webcam capture:",
            `${picked.width}x${picked.height}`,
            `@ ${picked.fps.toFixed(1)} fps measured (${picked.label})`,
            picked.matchedAspect ? "· matches project aspect" : "· PROJECT ASPECT NOT MATCHED",
          );
        } else {
          console.warn("Webcam unavailable, continuing without webcam");
        }
      } catch {
        console.warn("Webcam access denied, continuing without webcam");
      }
    }

    // Assign the PRIMARY stream (recorded into screenChunks) + optional
    // secondary (webcam PIP, 'both' only) based on mode. The mic is folded
    // into the primary's audio in startRecording().
    if (mode === "screen" || mode === "both") {
      this.screenStream = screenStream!;
      this.webcamStream = mode === "both" ? webcamStream ?? null : null;
      this.micStream = micStream ?? null;
    } else if (mode === "camera") {
      if (!webcamStream) throw new Error("Webcam access denied");
      this.screenStream = webcamStream; // primary = webcam video
      this.webcamStream = null;
      this.micStream = micStream ?? null; // mic = audio
    } else {
      // audio-only: the mic IS the primary recording.
      if (!micStream) throw new Error("Microphone access denied");
      this.screenStream = micStream;
      this.webcamStream = null;
      this.micStream = null; // already the primary; don't double-add
    }

    return {
      screenStream: this.screenStream,
      webcamStream: this.webcamStream || undefined,
    };
  }

  async startRecording(options: RecordingOptions): Promise<void> {
    if (!this.screenStream) {
      throw new Error(
        "Screen stream not initialized. Call requestPermissions first.",
      );
    }

    this.screenChunks = [];
    this.webcamChunks = [];
    this.isStopping = false;
    this.lastResult = null;

    const combinedStream = new MediaStream();
    this.screenStream
      .getVideoTracks()
      .forEach((track) => combinedStream.addTrack(track));

    if (this.screenStream.getAudioTracks().length > 0) {
      this.screenStream
        .getAudioTracks()
        .forEach((track) => combinedStream.addTrack(track));
    }

    if (this.micStream) {
      this.micStream
        .getAudioTracks()
        .forEach((track) => combinedStream.addTrack(track));
    }

    const isAudio = this.mode === "audio";
    const screenMimeType = this.getBestMimeType(isAudio);
    // Camera mode's PRIMARY recording is the webcam, so bitrate-budget it to the
    // webcam resolution (e.g. 720p → 5 Mbps), not the screen-capture resolution
    // (1080p → 12 Mbps). Over-budgeting a small webcam stream wastes real-time
    // encoder headroom and contributes to dropped frames / jitter.
    const screenBitrate =
      this.mode === "camera"
        ? BITRATE_MAP[options.webcam.resolution]
        : BITRATE_MAP[options.video.resolution];

    this.screenRecorder = new MediaRecorder(
      combinedStream,
      isAudio
        ? { mimeType: screenMimeType, audioBitsPerSecond: 128000 }
        : { mimeType: screenMimeType, videoBitsPerSecond: screenBitrate },
    );

    this.screenRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.screenChunks.push(e.data);
      }
    };

    this.screenRecorder.onerror = (e) => {
      this.emit("error", e);
    };

    // When the user ends screen-share from the browser chrome, stop. Audio-only
    // and camera-only have no screen-share track to listen on.
    const primaryVideoTrack = this.screenStream.getVideoTracks()[0];
    if (primaryVideoTrack) {
      primaryVideoTrack.onended = () => {
        this.stopRecording();
      };
    }

    // Secondary webcam recorder — only set in 'both' mode (camera mode puts the
    // webcam in the primary stream). Gate on the stream itself, not on the
    // legacy webcam.enabled flag, since `mode` now drives capture.
    if (this.webcamStream) {
      const webcamMimeType = this.getBestMimeType();
      const webcamBitrate = BITRATE_MAP[options.webcam.resolution];

      this.webcamRecorder = new MediaRecorder(this.webcamStream, {
        mimeType: webcamMimeType,
        videoBitsPerSecond: webcamBitrate,
      });

      this.webcamRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.webcamChunks.push(e.data);
        }
      };

      this.webcamRecorder.start(1000);
    }

    this.screenRecorder.start(1000);
    this.startTime = Date.now();
    this.pausedDuration = 0;

    this.durationInterval = window.setInterval(() => {
      const elapsed = Date.now() - this.startTime - this.pausedDuration;
      this.emit("duration", elapsed);
    }, 100);

    this.emit("start");
  }

  pauseRecording(): void {
    if (this.screenRecorder?.state === "recording") {
      this.screenRecorder.pause();
      this.pauseStartTime = Date.now();
    }
    if (this.webcamRecorder?.state === "recording") {
      this.webcamRecorder.pause();
    }
    this.emit("pause");
  }

  resumeRecording(): void {
    if (this.screenRecorder?.state === "paused") {
      this.screenRecorder.resume();
      this.pausedDuration += Date.now() - this.pauseStartTime;
    }
    if (this.webcamRecorder?.state === "paused") {
      this.webcamRecorder.resume();
    }
    this.emit("resume");
  }

  async stopRecording(): Promise<RecordingResult> {
    if (this.lastResult) {
      return this.lastResult;
    }

    if (this.isStopping) {
      await new Promise<void>((resolve) => {
        const checkResult = setInterval(() => {
          if (this.lastResult) {
            clearInterval(checkResult);
            resolve();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(checkResult);
          resolve();
        }, 5000);
      });
      return this.lastResult || { screenBlob: new Blob() };
    }

    this.isStopping = true;

    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }

    const results: RecordingResult = {
      screenBlob: new Blob(),
      mode: this.mode,
    };

    const stopPromises: Promise<void>[] = [];

    if (this.screenRecorder && this.screenRecorder.state !== "inactive") {
      stopPromises.push(
        this.stopRecorder(this.screenRecorder, this.screenChunks).then(
          (blob) => {
            results.screenBlob = blob;
          },
        ),
      );
    } else if (this.screenChunks.length > 0) {
      results.screenBlob = new Blob(this.screenChunks, {
        type: this.mode === "audio" ? "audio/webm" : "video/webm",
      });
    }

    if (this.webcamRecorder && this.webcamRecorder.state !== "inactive") {
      stopPromises.push(
        this.stopRecorder(this.webcamRecorder, this.webcamChunks).then(
          (blob) => {
            results.webcamBlob = blob;
          },
        ),
      );
    } else if (this.webcamChunks.length > 0) {
      results.webcamBlob = new Blob(this.webcamChunks, { type: "video/webm" });
    }

    await Promise.all(stopPromises);
    // Snapshot capture health BEFORE cleanup() drops the tracks.
    if (this.mode !== "audio") {
      const h = this.getCaptureHealth();
      results.capture = {
        ...h,
        durationSec: Math.max(0, (Date.now() - this.startTime - this.pausedDuration) / 1000),
        matchedAspect: this.webcamMatchedAspect,
      };
    }
    this.lastResult = results;
    this.cleanup();
    this.emit("stop", results);
    return results;
  }

  cancelRecording(): void {
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }

    if (this.screenRecorder && this.screenRecorder.state !== "inactive") {
      this.screenRecorder.stop();
    }
    if (this.webcamRecorder && this.webcamRecorder.state !== "inactive") {
      this.webcamRecorder.stop();
    }

    this.cleanup();
  }

  /**
   * How many video frames the primary capture has actually produced, and the
   * geometry it settled on. `frames` comes from the track's own stats, so it
   * reflects what the CAMERA delivered, not what we asked for.
   *
   * This exists because a starved capture is invisible until playback: the
   * preview looks alive (it shows the few frames there are), the file has a
   * plausible size (audio + keyframes), and only when the user opens the take
   * do they find a static image. Callers use this to refuse to import a take
   * that never really recorded.
   */
  getCaptureHealth(): { frames: number | null; width: number; height: number; fps: number | null } {
    const track = this.screenStream?.getVideoTracks?.()[0];
    const s = track?.getSettings?.() ?? this.webcamSettings ?? {};
    // `frames` is a non-standard but widely available stat on Chromium.
    const frames = (track as any)?.stats?.totalFrames ?? null;
    return {
      frames: typeof frames === "number" ? frames : null,
      width: Number(s.width) || 0,
      height: Number(s.height) || 0,
      // The MEASURED rate, not the camera's self-report — getSettings() happily
      // claims 30 on a track delivering 0.7.
      fps: this.webcamMeasuredFps ?? (typeof s.frameRate === "number" ? s.frameRate : null),
    };
  }

  getRecordingState(): "inactive" | "recording" | "paused" {
    return this.screenRecorder?.state || "inactive";
  }

  isRecording(): boolean {
    return this.screenRecorder?.state === "recording";
  }

  isPaused(): boolean {
    return this.screenRecorder?.state === "paused";
  }

  /**
   * The live microphone stream, for on-device speech-to-text (the teleprompter's
   * Whisper auto-scroll). The mic is captured separately as `this.micStream` for
   * screen / camera / both, and IS the primary stream for audio-only mode. A
   * second AudioContext consumer can safely tap the same track while the recorder
   * records it. Returns null when no mic was captured (e.g. screen-only, mic off).
   */
  getMicStream(): MediaStream | null {
    if (this.micStream && this.micStream.getAudioTracks().length > 0) {
      return this.micStream;
    }
    if (this.screenStream && this.screenStream.getAudioTracks().length > 0) {
      return this.screenStream;
    }
    return null;
  }

  private stopRecorder(recorder: MediaRecorder, chunks: Blob[]): Promise<Blob> {
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "video/webm";
        resolve(new Blob(chunks, { type: mimeType }));
      };
      recorder.stop();
    });
  }

  private getBestMimeType(audioOnly = false): string {
    // For real-time capture, codec ENCODE SPEED matters far more than
    // compression ratio. VP9 software-encodes slowly and drops frames under
    // load → the jittery, laggy recordings users hit. Prefer hardware-friendly
    // H.264, then the light VP8 encoder, and only fall back to VP9 last. The
    // editor decodes all of these fine; this is purely about smooth capture.
    const types = audioOnly
      ? ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      : [
          "video/webm;codecs=h264,opus", // hardware-accelerated where available
          "video/webm;codecs=vp8,opus",  // light, fast software encode — smooth
          "video/mp4;codecs=h264,aac",   // hardware h264 (newer Chrome)
          "video/webm;codecs=vp9,opus",  // heavy encode — last resort
          "video/webm",
          "video/mp4",
        ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }

    return audioOnly ? "audio/webm" : "video/webm";
  }

  private cleanup(): void {
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.webcamStream?.getTracks().forEach((track) => track.stop());
    this.micStream?.getTracks().forEach((track) => track.stop());

    this.screenStream = null;
    this.webcamStream = null;
    this.micStream = null;
    this.webcamSettings = null;
    this.webcamMeasuredFps = null;
    this.webcamMatchedAspect = true;
    this.screenRecorder = null;
    this.webcamRecorder = null;
    this.screenChunks = [];
    this.webcamChunks = [];
  }

  /**
   * List available microphones + cameras. Labels are only populated once the
   * user has granted media permission at least once (browser privacy rule),
   * so callers that need names should acquire a stream first (e.g. the dialog
   * preview).
   */
  static async listMediaDevices(): Promise<{
    mics: MediaDeviceOption[];
    cameras: MediaDeviceOption[];
  }> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const pick = (kind: MediaDeviceKind) =>
        devices
          .filter((d) => d.kind === kind && d.deviceId)
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `${kind === "audioinput" ? "Microphone" : "Camera"} ${i + 1}`,
          }));
      return { mics: pick("audioinput"), cameras: pick("videoinput") };
    } catch {
      return { mics: [], cameras: [] };
    }
  }

  static isSupported(): boolean {
    const hasDisplayMedia =
      typeof navigator.mediaDevices?.getDisplayMedia === "function";
    const hasMediaRecorder = typeof MediaRecorder !== "undefined";
    const supportsWebm =
      hasMediaRecorder && MediaRecorder.isTypeSupported("video/webm");
    return hasDisplayMedia && supportsWebm;
  }

  static getSupportedFeatures(): {
    screenCapture: boolean;
    systemAudio: boolean;
    webcam: boolean;
    vp9: boolean;
    h264: boolean;
  } {
    const isChromium = /Chrome|Chromium|Edge/.test(navigator.userAgent);
    const isSafari =
      /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

    return {
      screenCapture: !!navigator.mediaDevices?.getDisplayMedia,
      systemAudio: isChromium,
      webcam: !!navigator.mediaDevices?.getUserMedia,
      vp9: MediaRecorder.isTypeSupported("video/webm;codecs=vp9"),
      h264: MediaRecorder.isTypeSupported("video/webm;codecs=h264") || isSafari,
    };
  }
}

export const screenRecorderService = new ScreenRecorderService();

export function getFileExtension(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("webm")) return "webm";
  return "webm";
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export const DEFAULT_RECORDING_OPTIONS: RecordingOptions = {
  mode: "screen",
  video: {
    resolution: "1080p",
    frameRate: 30,
  },
  audio: {
    systemAudio: true,
    microphone: false,
  },
  webcam: {
    enabled: false,
    resolution: "720p",
    aspect: "project",
  },
};
