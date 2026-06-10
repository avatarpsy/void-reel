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
      // (a 9:16 project records portrait, 1:1 square). aspectRatio:{ideal}
      // lets the browser crop the camera's native landscape sensor to match.
      const dims = webcamDimsForAspect(options.webcam.resolution, options.targetAspect);
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: dims.width },
            height: { ideal: dims.height },
            aspectRatio: { ideal: dims.aspect },
            // Request a steady frame rate (best-effort `ideal`, no hard `min` —
            // a hard floor throws OverconstrainedError on cameras that can't
            // sustain it and would break recording entirely). Without any fps
            // hint the camera runs variable-frame-rate and plays back choppy.
            frameRate: { ideal: options.video.frameRate },
            ...(options.videoDeviceId
              ? { deviceId: { exact: options.videoDeviceId } }
              : { facingMode: "user" }),
          },
          audio: false,
        });
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

  getRecordingState(): "inactive" | "recording" | "paused" {
    return this.screenRecorder?.state || "inactive";
  }

  isRecording(): boolean {
    return this.screenRecorder?.state === "recording";
  }

  isPaused(): boolean {
    return this.screenRecorder?.state === "paused";
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
  },
};
