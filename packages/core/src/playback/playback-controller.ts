import type { Project } from "../types/project";
import type { VideoEngine } from "../video/video-engine";
import type { AudioEngine } from "../audio/audio-engine";
import type { RenderedFrame } from "../video/types";
import type {
  PlaybackConfig,
  PlaybackState,
  PlaybackEvent,
  PlaybackEventListener,
  PlaybackStats,
  FrameRenderResult,
} from "./types";
import { DEFAULT_PLAYBACK_CONFIG } from "./types";
import {
  MasterTimelineClock,
  initializeMasterClock,
  type ClockState,
  type ClockSubscriber,
} from "./master-timeline-clock";
import {
  RealtimeAudioGraph,
  initializeRealtimeAudioGraph,
  type AudioClipSchedule,
} from "../audio/realtime-audio-graph";
import { rewriteToProxy } from "../utils/cors-proxy";
import { flattenCompoundAudio } from "../timeline/flatten-compounds";

export class PlaybackController {
  private videoEngine: VideoEngine | null = null;
  private audioEngine: AudioEngine | null = null;
  private project: Project | null = null;
  private config: PlaybackConfig;

  private masterClock: MasterTimelineClock;
  private clockUnsubscribe: (() => void) | null = null;
  private realtimeAudioGraph: RealtimeAudioGraph;

  private state: PlaybackState = "stopped";
  private playbackRate: number = 1.0;
  private useRealtimeAudio: boolean = true;

  private currentFrame: RenderedFrame | null = null;
  private frameRenderTimes: number[] = [];
  private droppedFrames: number = 0;

  private scrubDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isScrubbing: boolean = false;
  private isRenderingFrame: boolean = false;

  private eventListeners: Map<string, Set<PlaybackEventListener>> = new Map();

  private displayCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private displayCtx:
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null = null;

  constructor(config: Partial<PlaybackConfig> = {}) {
    this.config = { ...DEFAULT_PLAYBACK_CONFIG, ...config };
    this.masterClock = initializeMasterClock({
      frameRate: this.config.frameRate,
    });
    this.realtimeAudioGraph = initializeRealtimeAudioGraph(this.masterClock);
  }

  async initialize(
    videoEngine: VideoEngine,
    audioEngine: AudioEngine,
  ): Promise<void> {
    this.videoEngine = videoEngine;
    this.audioEngine = audioEngine;

    this.setupClockSubscription();
  }

  getRealtimeAudioGraph(): RealtimeAudioGraph {
    return this.realtimeAudioGraph;
  }

  private setupClockSubscription(): void {
    if (this.clockUnsubscribe) {
      this.clockUnsubscribe();
    }

    const subscriber: ClockSubscriber = {
      onTimeUpdate: (time: number) => {
        this.handleClockTimeUpdate(time);
      },
      onStateChange: (clockState: ClockState) => {
        this.handleClockStateChange(clockState);
      },
    };

    this.clockUnsubscribe = this.masterClock.subscribe(subscriber);
  }

  private handleClockTimeUpdate(time: number): void {
    if (this.state !== "playing" || this.isRenderingFrame) {
      return;
    }

    if (this.masterClock.shouldSkipFrame()) {
      this.droppedFrames++;
      return;
    }

    if (this.masterClock.shouldRepeatFrame()) {
      this.emitEvent({
        type: "timeupdate",
        time,
        state: this.state,
      });
      return;
    }

    this.renderFrameAtTime(time);

    this.emitEvent({
      type: "timeupdate",
      time,
      state: this.state,
    });
  }

  private handleClockStateChange(clockState: ClockState): void {
    const previousState = this.state;

    if (clockState === "stopped") {
      this.state = "stopped";
      this.stopAudioPlayback();

      if (previousState !== "stopped") {
        this.emitEvent({
          type: "stop",
          time: 0,
          state: this.state,
        });
        this.emitEvent({
          type: "statechange",
          time: 0,
          state: this.state,
        });
      }
    }
  }

  getMasterClock(): MasterTimelineClock {
    return this.masterClock;
  }

  setProject(project: Project): void {
    this.project = project;
    this.state = "stopped";
    this.masterClock.setDuration(project.timeline.duration);
    this.clearAudioBuffer();
  }

  setDisplayCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    this.displayCanvas = canvas;
    this.displayCtx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D;
  }

  getState(): PlaybackState {
    return this.state;
  }

  getCurrentTime(): number {
    return this.masterClock.currentTime;
  }

  getCurrentFrame(): RenderedFrame | null {
    return this.currentFrame;
  }

  isPlaying(): boolean {
    return this.state === "playing";
  }

  getIsScrubbing(): boolean {
    return this.isScrubbing;
  }

  async play(): Promise<void> {
    if (!this.project || !this.videoEngine) {
      throw new Error("PlaybackController not properly initialized");
    }

    if (this.state === "playing") return;

    const duration = this.project.timeline.duration;
    if (this.masterClock.currentTime >= duration) {
      this.masterClock.seek(0);
    }

    this.state = "playing";

    // Hydrate every buffer we'll need before starting the clock. If we
    // start the clock first and the scheduler runs while a fetch is in
    // flight, the clip's startTime slides into the past unscheduled and
    // the user gets partial / silent audio for the first scene — which
    // is the symptom the chat-driven flow has been hitting because
    // every Voidspace narration starts life as a remote URL with no
    // local blob. preloadAudioBuffers awaits all decodes (incl. the
    // network fetch we now do for blob-less items).
    await this.preloadAudioBuffers();

    // After preload, audit the timeline's audio surface. Any clip that
    // failed to decode after the retries has fallen back to an
    // <audio> element under `htmlAudioFallback` — start those before
    // the clock so they're aligned with masterClock from frame 0.
    this.startHtmlAudioFallbacks();

    const audioCtx = this.realtimeAudioGraph.getAudioContext();
    console.log(
      `[playback] play(): audioContext.state=${audioCtx.state}, buffered=${this.audioBufferCache.size}, fallbacks=${this.htmlAudioFallback.size}, failures=${this.audioDecodeFailures.size}`,
    );

    await this.masterClock.play();
    await this.startAudioPlayback();

    const currentTime = this.masterClock.currentTime;

    this.emitEvent({
      type: "play",
      time: currentTime,
      state: this.state,
    });

    this.emitEvent({
      type: "statechange",
      time: currentTime,
      state: this.state,
    });
  }

  pause(): void {
    if (this.state !== "playing") return;

    this.state = "paused";

    this.masterClock.pause();
    this.stopAudioPlayback();
    this.stopHtmlAudioFallbacks();

    const currentTime = this.masterClock.currentTime;

    this.emitEvent({
      type: "pause",
      time: currentTime,
      state: this.state,
    });

    this.emitEvent({
      type: "statechange",
      time: currentTime,
      state: this.state,
    });
  }

  stop(): void {
    const previousState = this.state;
    this.state = "stopped";

    this.masterClock.stop();
    this.stopAudioPlayback();
    this.stopHtmlAudioFallbacks();

    this.emitEvent({
      type: "stop",
      time: 0,
      state: this.state,
    });

    if (previousState !== this.state) {
      this.emitEvent({
        type: "statechange",
        time: 0,
        state: this.state,
      });
    }
  }

  async togglePlayback(): Promise<void> {
    if (this.state === "playing") {
      this.pause();
    } else {
      await this.play();
    }
  }

  async seek(time: number): Promise<void> {
    if (!this.project) return;

    const wasPlaying = this.state === "playing";

    const duration = this.project.timeline.duration;
    const clampedTime = Math.max(0, Math.min(time, duration));

    this.masterClock.seek(clampedTime);
    this.realtimeAudioGraph.seekTo(clampedTime);

    if (wasPlaying) {
      this.stopAudioPlayback();
      this.stopHtmlAudioFallbacks();
      await this.startAudioPlayback();
      this.startHtmlAudioFallbacks();
    } else {
      // Even when paused, snap fallback elements to the new offset so
      // a subsequent play() picks up from the right spot.
      for (const [, entry] of this.htmlAudioFallback) {
        const offset =
          entry.mediaOffset + Math.max(0, clampedTime - entry.clipStart);
        try {
          entry.el.currentTime = offset;
        } catch { /* ignore */ }
      }
    }

    await this.renderFrameAtTime(clampedTime);

    this.emitEvent({
      type: "seek",
      time: clampedTime,
      state: this.state,
    });
  }

  startScrubbing(): void {
    this.isScrubbing = true;

    // Pause playback if playing
    if (this.state === "playing") {
      this.pause();
    }
  }

  async scrubTo(time: number): Promise<FrameRenderResult> {
    if (!this.project || !this.videoEngine) {
      return {
        frame: null,
        renderTime: 0,
        fromCache: false,
        timedOut: false,
      };
    }

    const duration = this.project.timeline.duration;
    const clampedTime = Math.max(0, Math.min(time, duration));

    this.masterClock.seek(clampedTime);
    this.realtimeAudioGraph.seekTo(clampedTime);

    this.emitEvent({
      type: "timeupdate",
      time: clampedTime,
      state: this.state,
    });

    return this.renderFrameWithTimeout(clampedTime);
  }

  endScrubbing(): void {
    this.isScrubbing = false;

    if (this.scrubDebounceTimer) {
      clearTimeout(this.scrubDebounceTimer);
      this.scrubDebounceTimer = null;
    }
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.1, Math.min(4.0, rate));
    this.masterClock.setPlaybackRate(this.playbackRate);
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  getStats(): PlaybackStats {
    const avgRenderTime =
      this.frameRenderTimes.length > 0
        ? this.frameRenderTimes.reduce((a, b) => a + b, 0) /
          this.frameRenderTimes.length
        : 0;

    return {
      currentTime: this.masterClock.currentTime,
      duration: this.project?.timeline.duration ?? 0,
      state: this.state,
      fps: this.calculateFPS(),
      droppedFrames: this.droppedFrames,
      audioBufferHealth: this.calculateAudioBufferHealth(),
      videoBufferHealth: 1.0,
      avgFrameRenderTime: avgRenderTime,
    };
  }

  addEventListener(type: string, listener: PlaybackEventListener): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set());
    }
    this.eventListeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: PlaybackEventListener): void {
    this.eventListeners.get(type)?.delete(listener);
  }

  dispose(): void {
    this.stop();

    if (this.clockUnsubscribe) {
      this.clockUnsubscribe();
      this.clockUnsubscribe = null;
    }

    this.masterClock.dispose();
    this.realtimeAudioGraph.dispose();
    this.clearAudioBuffer();
    this.eventListeners.clear();
    this.currentFrame?.image.close();
    this.currentFrame = null;
    this.displayCanvas = null;
    this.displayCtx = null;
    this.videoEngine = null;
    this.audioEngine = null;
    this.project = null;
  }

  private async renderFrameAtTime(time: number): Promise<void> {
    if (!this.project || !this.videoEngine || this.isRenderingFrame) return;

    this.isRenderingFrame = true;
    const startTime = performance.now();

    try {
      const frame = await this.videoEngine.renderFrame(this.project, time);

      const renderTime = performance.now() - startTime;
      this.trackFrameRenderTime(renderTime);

      this.masterClock.reportVideoTime(time);

      if (this.currentFrame && this.currentFrame !== frame) {
        this.currentFrame.image.close();
      }
      this.currentFrame = frame;

      this.drawFrameToCanvas(frame);

      this.emitEvent({
        type: "framerendered",
        time,
        state: this.state,
        frame,
      });
    } catch (error) {
      console.error("Frame render error:", error);
      this.droppedFrames++;
    } finally {
      this.isRenderingFrame = false;
    }
  }

  private async renderFrameWithTimeout(
    time: number,
  ): Promise<FrameRenderResult> {
    if (!this.project || !this.videoEngine) {
      return {
        frame: null,
        renderTime: 0,
        fromCache: false,
        timedOut: false,
      };
    }

    const startTime = performance.now();

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Frame render timeout"));
        }, this.config.frameRenderTimeout);
      });

      // Race between render and timeout
      const frame = await Promise.race([
        this.videoEngine.renderFrame(this.project, time),
        timeoutPromise,
      ]);

      const renderTime = performance.now() - startTime;
      this.trackFrameRenderTime(renderTime);
      if (this.currentFrame && this.currentFrame !== frame) {
        this.currentFrame.image.close();
      }
      this.currentFrame = frame;

      // Draw to display canvas
      this.drawFrameToCanvas(frame);

      return {
        frame,
        renderTime,
        fromCache: false, // Could check video engine cache stats
        timedOut: false,
      };
    } catch (error) {
      const renderTime = performance.now() - startTime;

      if (error instanceof Error && error.message === "Frame render timeout") {
        return {
          frame: null,
          renderTime,
          fromCache: false,
          timedOut: true,
        };
      }

      console.error("Frame render error:", error);
      return {
        frame: null,
        renderTime,
        fromCache: false,
        timedOut: false,
      };
    }
  }

  private drawFrameToCanvas(frame: RenderedFrame): void {
    if (!this.displayCanvas || !this.displayCtx) return;

    // Resize canvas if needed
    if (
      this.displayCanvas.width !== frame.width ||
      this.displayCanvas.height !== frame.height
    ) {
      this.displayCanvas.width = frame.width;
      this.displayCanvas.height = frame.height;
    }

    // Draw the frame
    this.displayCtx.drawImage(frame.image, 0, 0);
  }

  private async startAudioPlayback(): Promise<void> {
    if (!this.config.enableAudio || !this.project) {
      return;
    }

    if (this.useRealtimeAudio) {
      await this.realtimeAudioGraph.resume();
      this.setupTracksInAudioGraph();
      this.realtimeAudioGraph.startScheduler((time) =>
        this.getAudioClipsAtTime(time),
      );
    }
  }

  private setupTracksInAudioGraph(): void {
    if (!this.project) return;

    const hasSoloTracks = this.project.timeline.tracks.some((t) => t.solo);

    for (const track of this.project.timeline.tracks) {
      if (track.type !== "audio" && track.type !== "video") continue;

      this.realtimeAudioGraph.createTrack({
        trackId: track.id,
        volume: 1.0,
        pan: 0,
        muted: track.muted,
        solo: track.solo,
        effects: [],
      });

      if (hasSoloTracks) {
        this.realtimeAudioGraph.setTrackSolo(track.id, track.solo);
      }
    }
  }

  private getAudioClipsAtTime(time: number): AudioClipSchedule[] {
    if (!this.project || !this.audioEngine) return [];

    const schedules: AudioClipSchedule[] = [];
    const { timeline, mediaLibrary } = this.project;

    for (const track of timeline.tracks) {
      if (track.type !== "audio" && track.type !== "video") continue;

      for (const clip of track.clips) {
        const clipEnd = clip.startTime + clip.duration;
        if (clipEnd <= time || clip.startTime > time + 1) continue;

        const mediaItem = mediaLibrary.items.find((m) => m.id === clip.mediaId);
        // Skip only when there's neither a blob nor an originalUrl to
        // hydrate from. Voidspace remote media (narration, music,
        // Remotion clips) lands here with `blob: null` because the
        // loader either failed CORS, the blob never made it into
        // IndexedDB, or the project was just recovered from autosave
        // (autosave JSON-strips blobs). `getOrDecodeAudioBuffer` will
        // lazily fetch and decode using `originalUrl` so the very next
        // scheduler tick has audio for this clip.
        if (!mediaItem) continue;
        // Image media lands on video tracks too (drag-drop, agent
        // placement) — it has no audio, so keep it out of the decode
        // pipeline entirely (decodeAudioData churn + bogus <audio>
        // fallbacks otherwise).
        if (mediaItem.type === "image") continue;
        if (!mediaItem.blob && !mediaItem.originalUrl) continue;

        const cachedBuffer = this.getOrDecodeAudioBuffer(mediaItem);
        if (!cachedBuffer) continue;

        schedules.push({
          clipId: clip.id,
          trackId: track.id,
          audioBuffer: cachedBuffer,
          startTime: clip.startTime,
          endTime: clipEnd,
          mediaOffset: clip.inPoint,
          volume: clip.volume,
          pan: 0,
          effects: clip.audioEffects || [],
          speed: clip.speed ?? 1,
        });
      }
    }

    return schedules;
  }

  private audioBufferCache: Map<string, AudioBuffer> = new Map();
  private audioDecodePromises: Map<string, Promise<AudioBuffer | null>> =
    new Map();

  private async preloadAudioBuffers(): Promise<void> {
    if (!this.project) return;

    const { mediaLibrary } = this.project;
    const mediaIdsToPreload = new Set<string>();

    /**
     * FLATTENED, so the media INSIDE a nested sequence gets decoded too.
     *
     * A compound instance's `mediaId` names a sequence, not a file, so the
     * lookup below finds nothing and skips it — and the audio actually inside
     * that sequence was never decoded, never cached, and therefore never
     * scheduled. The sequence played silently while its export had sound.
     *
     * Same function the export mixer uses, so both paths agree on what is
     * audible. Returns the timeline by reference when nothing is nested.
     */
    const timeline = flattenCompoundAudio(this.project);

    for (const track of timeline.tracks) {
      if (track.type !== "audio" && track.type !== "video") continue;

      for (const clip of track.clips) {
        const mediaItem = mediaLibrary.items.find((m) => m.id === clip.mediaId);
        if (!mediaItem) continue;
        if (mediaItem.type === "image") continue; // images carry no audio
        // Preload anything we can hydrate — either an in-memory blob
        // OR a remote `originalUrl` (Voidspace narration / music /
        // Remotion-rendered clips, which arrive blob-less after
        // autosave recovery or when the loader couldn't fetch the
        // bytes inline).
        if (
          !this.audioBufferCache.has(mediaItem.id) &&
          (mediaItem.blob || mediaItem.originalUrl)
        ) {
          mediaIdsToPreload.add(mediaItem.id);
        }
      }
    }

    const decodePromises: Promise<AudioBuffer | null>[] = [];

    for (const mediaId of mediaIdsToPreload) {
      const mediaItem = mediaLibrary.items.find((m) => m.id === mediaId);
      if (mediaItem) {
        decodePromises.push(this.decodeAudioBuffer(mediaItem));
      }
    }

    await Promise.all(decodePromises);

    // After the AudioContext decode round, install HTML <audio>
    // fallbacks for anything that ended up in the failure map. This is
    // the safety net for codecs WebAudio's `decodeAudioData` rejects
    // (some CDN-served MP3s, Opus-in-WebM mismatches, mid-renamed
    // .mp3-with-mp4-bytes outputs from the TTS provider, etc.). The
    // <audio> element decoder is independent and survives most of those.
    for (const track of timeline.tracks) {
      if (track.type !== "audio" && track.type !== "video") continue;
      for (const clip of track.clips) {
        const mediaItem = mediaLibrary.items.find((m) => m.id === clip.mediaId);
        if (!mediaItem) continue;
        if (mediaItem.type === "image") continue; // never <audio>-fallback an image
        const failed = (this.audioDecodeFailures.get(mediaItem.id) ?? 0) >= 2;
        const decoded = this.audioBufferCache.has(mediaItem.id);
        if (!decoded && failed) {
          this.installHtmlAudioFallback(mediaItem, clip);
        }
      }
    }
  }

  /**
   * Tracks media ids whose blob was fetched from `originalUrl` but
   * decoded to nothing — almost always because the bytes were a 0-byte
   * Firebase Storage 200, an HTML error page, or an unsupported codec.
   * On the next decode call we discard the cached blob and re-fetch
   * once. After two consecutive failures we mark the id as permanently
   * undecodable so we stop hammering the network.
   */
  private audioDecodeFailures: Map<string, number> = new Map();

  /**
   * Last-resort playback: an HTMLAudioElement keyed by media id. When
   * `decodeAudioData` rejects (CORS-tainted body, codec unsupported by
   * the WebAudio path, etc.), `<audio>` will still play the URL
   * because the media element decoder is a separate path that doesn't
   * require CORS for playback. We drive it directly off `masterClock`
   * with `currentTime` adjustments so it stays in sync with the
   * timeline. Audio quality is identical; we just lose effects /
   * mixing routing for these clips.
   */
  private htmlAudioFallback: Map<
    string,
    { el: HTMLAudioElement; clipStart: number; clipDuration: number; mediaOffset: number }
  > = new Map();

  private async decodeAudioBuffer(mediaItem: {
    id: string;
    blob?: Blob | null;
    originalUrl?: string;
    name?: string;
    type?: string;
  }): Promise<AudioBuffer | null> {
    if (this.audioBufferCache.has(mediaItem.id)) {
      return this.audioBufferCache.get(mediaItem.id) || null;
    }

    if (this.audioDecodePromises.has(mediaItem.id)) {
      return this.audioDecodePromises.get(mediaItem.id) || null;
    }

    const failures = this.audioDecodeFailures.get(mediaItem.id) ?? 0;
    if (failures >= 2) {
      // Stopped trying — see audioDecodeFailures comment above.
      return null;
    }

    if (mediaItem.type === "image") return null; // images carry no audio
    if (!mediaItem.blob && !mediaItem.originalUrl) return null;

    const audioContext = this.masterClock.getAudioContext();
    const url = mediaItem.originalUrl;
    const label = `${mediaItem.name || mediaItem.id}${url ? ` (${url})` : ""}`;

    // Many studio assets sit on hosts that don't return CORS headers
    // (Kie's tempfile.redpandaai.co is the prime offender — every
    // narration MP3 lands there). A direct cross-origin fetch is hard-
    // blocked. Route through our same-origin proxy which adds an
    // `Access-Control-Allow-Origin: *` header so both `decodeAudioData`
    // here and the export engine succeed. Same-origin URLs (already
    // local public/, our own /api routes) and blob:/data: URLs go
    // direct.
    const fetchUrl = url ? rewriteToProxy(url) : undefined;

    // The cached blob can be tainted: an earlier fetch may have
    // returned 0 bytes, a redirected HTML page, or an opaque response.
    // Any of those decode to nothing and the user gets silence with no
    // log line to point at. Treat a failed prior decode as a signal to
    // discard the cached blob and try the network again.
    const previousDecodeFailed = failures > 0;
    const useCachedBlob =
      mediaItem.blob instanceof Blob &&
      mediaItem.blob.size > 0 &&
      !previousDecodeFailed;

    const blobPromise: Promise<Blob | null> = useCachedBlob
      ? Promise.resolve(mediaItem.blob as Blob)
      : (async () => {
          if (!fetchUrl) {
            console.warn(
              `[playback] No originalUrl to hydrate ${label}; cannot play.`,
            );
            return null;
          }
          try {
            // `cache: "no-store"` sidesteps stale 0-byte responses that
            // some CDNs occasionally serve when the asset was uploaded
            // moments ago. The trade-off is one extra round trip the
            // first time; it's cached on the MediaItem after that.
            const resp = await fetch(fetchUrl, {
              mode: "cors",
              cache: "no-store",
              credentials: "omit",
            });
            if (!resp.ok) {
              console.warn(
                `[playback] Audio fetch ${resp.status} for ${label}`,
              );
              return null;
            }
            const fetched = await resp.blob();
            if (!fetched || fetched.size === 0) {
              console.warn(
                `[playback] Audio fetch returned 0 bytes for ${label}`,
              );
              return null;
            }
            (mediaItem as { blob: Blob | null }).blob = fetched;
            return fetched;
          } catch (err) {
            console.warn(
              `[playback] Audio fetch threw for ${label}:`,
              err,
            );
            return null;
          }
        })();

    const decodePromise = blobPromise
      .then(async (blob) => {
        if (!blob) return null;
        try {
          const arrayBuffer = await blob.arrayBuffer();
          // `decodeAudioData` mutates the ArrayBuffer (transfers it),
          // so always pass a fresh copy if you ever want to retry. We
          // don't retry here, but the next call (after a failure
          // counter bump) re-fetches and gets a fresh buffer.
          return await audioContext.decodeAudioData(arrayBuffer);
        } catch (err) {
          console.warn(
            `[playback] decodeAudioData failed for ${label} (size=${blob.size}, type=${blob.type}):`,
            err,
          );
          return null;
        }
      })
      .then((buffer) => {
        this.audioDecodePromises.delete(mediaItem.id);
        if (buffer) {
          this.audioBufferCache.set(mediaItem.id, buffer);
          this.audioDecodeFailures.delete(mediaItem.id);
          return buffer;
        }
        // Bump the failure counter and discard the cached blob so a
        // follow-up call fetches fresh bytes from `originalUrl`.
        this.audioDecodeFailures.set(mediaItem.id, failures + 1);
        if (mediaItem.blob && url) {
          (mediaItem as { blob: Blob | null }).blob = null;
        }
        return null;
      })
      .catch((err) => {
        this.audioDecodePromises.delete(mediaItem.id);
        this.audioDecodeFailures.set(mediaItem.id, failures + 1);
        console.warn(`[playback] Audio decode chain rejected for ${label}:`, err);
        return null;
      });

    this.audioDecodePromises.set(mediaItem.id, decodePromise);
    return decodePromise;
  }

  private getOrDecodeAudioBuffer(mediaItem: {
    id: string;
    blob?: Blob | null;
    originalUrl?: string;
  }): AudioBuffer | null {
    const cached = this.audioBufferCache.get(mediaItem.id);
    if (cached) return cached;

    if (!mediaItem.blob && !mediaItem.originalUrl) return null;

    // Fire-and-forget: kicks off the decode (and a fetch when the
    // blob is missing). The next scheduler tick after the buffer
    // lands in the cache will pick it up and start playback. This is
    // why narration / music start ~1 tick late on the very first
    // play after a Voidspace load — but it DOES start, where the
    // previous code silently dropped the clip forever.
    this.decodeAudioBuffer(mediaItem);

    return null;
  }

  private stopAudioPlayback(): void {
    if (this.useRealtimeAudio) {
      this.realtimeAudioGraph.stopScheduler();
    }
  }

  private clearAudioBuffer(): void {
    this.stopAudioPlayback();
    this.audioBufferCache.clear();
    this.audioDecodePromises.clear();
    this.audioDecodeFailures.clear();
    this.disposeHtmlAudioFallbacks();
  }

  /**
   * Install or refresh an HTMLAudioElement-backed fallback for a clip
   * whose AudioContext decode path failed. Called from
   * `getOrDecodeAudioBuffer` once `audioDecodeFailures` reaches the
   * cap, and from `preloadAudioBuffers` after the await for any media
   * that ended up in the failure map. Idempotent on (mediaId).
   */
  private installHtmlAudioFallback(
    mediaItem: { id: string; originalUrl?: string; name?: string },
    clip: { startTime: number; duration: number; inPoint?: number },
  ): void {
    if (typeof document === "undefined") return;
    if (this.htmlAudioFallback.has(mediaItem.id)) return;
    if (!mediaItem.originalUrl) return;

    const el = new Audio();
    // NB: deliberately NOT setting `crossOrigin` here. Setting it
    // forces the browser to require CORS on the response — which the
    // Kie temp host refuses, so the element fails to play at all.
    // Without `crossOrigin` the browser treats the audio as opaque:
    // playback works, but it can't be routed through Web Audio nor
    // captured to canvas. For preview-only narration that's an
    // acceptable trade — the user hears the audio. For the export
    // path we go through the same-origin /media-proxy which lets the
    // export-engine's WebAudio fetch succeed.
    el.preload = "auto";
    // Route through the proxy when cross-origin so retries / range
    // requests benefit from edge caching and uniform error semantics.
    el.src = rewriteToProxy(mediaItem.originalUrl);
    el.addEventListener("error", () => {
      console.warn(
        `[playback] HTML <audio> fallback errored for ${mediaItem.name || mediaItem.id}: code=${el.error?.code}`,
      );
    });
    this.htmlAudioFallback.set(mediaItem.id, {
      el,
      clipStart: clip.startTime,
      clipDuration: clip.duration,
      mediaOffset: clip.inPoint ?? 0,
    });
    console.log(
      `[playback] Installed HTML <audio> fallback for ${mediaItem.name || mediaItem.id}`,
    );
  }

  /**
   * Start every HTML audio fallback in sync with masterClock. Called
   * from play() after preloadAudioBuffers awaits. Each element seeks
   * to its scene-relative offset and plays only while the clip is
   * active; outside that window it pauses but stays attached so the
   * next play()/seek doesn't have to reload the source.
   */
  private startHtmlAudioFallbacks(): void {
    const t = this.masterClock.currentTime;
    for (const [, entry] of this.htmlAudioFallback) {
      const { el, clipStart, clipDuration, mediaOffset } = entry;
      const clipEnd = clipStart + clipDuration;
      if (t < clipStart || t >= clipEnd) {
        el.pause();
        try {
          el.currentTime = mediaOffset;
        } catch { /* readyState too low; ignore */ }
        continue;
      }
      try {
        el.currentTime = mediaOffset + (t - clipStart);
      } catch { /* ignore */ }
      el.play().catch((err) => {
        console.warn(
          `[playback] HTML <audio> fallback play() rejected:`,
          err,
        );
      });
    }
  }

  private stopHtmlAudioFallbacks(): void {
    for (const [, entry] of this.htmlAudioFallback) {
      entry.el.pause();
    }
  }

  private disposeHtmlAudioFallbacks(): void {
    for (const [, entry] of this.htmlAudioFallback) {
      entry.el.pause();
      entry.el.src = "";
      entry.el.load();
    }
    this.htmlAudioFallback.clear();
  }

  /**
   * Drop cached buffers / decode state for the given media ids so the
   * next play() refetches and re-decodes them. Called from the project
   * store when Voidspace's live subscription replaces a blob-less media
   * item with the freshly hydrated one — the cached null buffer from
   * the previous attempt would otherwise stick around and the user
   * would still hear silence even after the upgrade.
   */
  public invalidateAudioForMedia(mediaIds: Iterable<string>): void {
    let any = false;
    for (const id of mediaIds) {
      this.audioBufferCache.delete(id);
      this.audioDecodePromises.delete(id);
      this.audioDecodeFailures.delete(id);
      any = true;
    }
    if (any && this.state === "playing") {
      // Force a reschedule on the next tick so the freshly decoded
      // buffer gets picked up for the *current* clip rather than
      // sitting idle until the user pauses and plays again.
      this.realtimeAudioGraph.seekTo(this.masterClock.currentTime);
    }
  }

  private trackFrameRenderTime(time: number): void {
    this.frameRenderTimes.push(time);

    // Keep only last 60 samples
    if (this.frameRenderTimes.length > 60) {
      this.frameRenderTimes.shift();
    }
  }

  private calculateFPS(): number {
    if (this.frameRenderTimes.length < 2) return 0;

    const avgRenderTime =
      this.frameRenderTimes.reduce((a, b) => a + b, 0) /
      this.frameRenderTimes.length;

    return avgRenderTime > 0 ? 1000 / avgRenderTime : 0;
  }

  private calculateAudioBufferHealth(): number {
    return 1.0;
  }

  private emitEvent(event: PlaybackEvent): void {
    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("Event listener error:", error);
        }
      }
    }

    // Also emit to 'all' listeners
    const allListeners = this.eventListeners.get("all");
    if (allListeners) {
      for (const listener of allListeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("Event listener error:", error);
        }
      }
    }
  }
}
let playbackControllerInstance: PlaybackController | null = null;

export function getPlaybackController(): PlaybackController {
  if (!playbackControllerInstance) {
    playbackControllerInstance = new PlaybackController();
  }
  return playbackControllerInstance;
}

export async function initializePlaybackController(
  videoEngine: VideoEngine,
  audioEngine: AudioEngine,
): Promise<PlaybackController> {
  const controller = getPlaybackController();
  await controller.initialize(videoEngine, audioEngine);
  return controller;
}
