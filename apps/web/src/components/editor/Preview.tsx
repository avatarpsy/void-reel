import React, {
  useRef,
  useEffect,
  useCallback,
  useState,
  useMemo,
} from "react";
import {
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Move,
  Loader2,
  ZoomIn,
  Gauge,
} from "lucide-react";
import { useCenterShift } from "@openreel/ui";
import type { PreviewQuality } from "../../stores/timeline-store";
import { useProjectStore } from "../../stores/project-store";
import { InlineRecordingPreview } from "./InlineRecordingPreview";
import { useTimelineStore } from "../../stores/timeline-store";
import { useUIStore } from "../../stores/ui-store";
import { useThemeStore } from "../../stores/theme-store";
import { getRenderBridge } from "../../bridges/render-bridge";
import { setRamCacheState } from "../../bridges/ram-cache-bridge";
import { getEffectsBridge } from "../../bridges/effects-bridge";
import {
  RendererFactory,
  type Renderer,
  getSpeedEngine,
  getMasterClock,
  getRealtimeAudioGraph,
  getParticleEngine,
  type Effect,
  type AudioClipSchedule,
  type TextClip,
  type ShapeClip,
  type SVGClip,
  type StickerClip,
  type Subtitle,
  type Track,
  rewriteToProxy,
  PreviewFrameCache,
  // Nested sequences: the shared "is this a compound, and which" answer. It
  // must be the same one the export path uses, or the two disagree about what
  // is even a sequence.
  compoundIdOfClip,
  // …and the same flattener the export mixer uses, so preview and export
  // agree about what a nested sequence SOUNDS like, not just what it looks like.
  flattenCompoundAudio,
} from "@openreel/core";
import { useEngineStore } from "../../stores/engine-store";
import { useSettingsStore } from "../../stores/settings-store";
import { Transport } from "./Transport";
import {
  type HandlePosition,
  type InteractionMode,
  type ClipTransform,
  DEFAULT_TRANSFORM,
  formatTime,
  renderTextClipToCanvas,
  getActiveTextClips,
  getActiveShapeClips,
  renderShapeClipToCanvas,
  drawFrameWithTransform,
  compositeTracksToCtx,
  applyEffectsToFrame,
  setImageLoadCallback,
  getAnimatedTransform,
  applyEmphasisAnimation,
  CropModeView,
  MotionPathOverlay,
  ParticleRenderer,
} from "./preview/index";
import { ProcessingOverlay } from "./ProcessingOverlay";
import type { MotionPathConfig, GSAPMotionPathPoint } from "@openreel/core";

const getAdaptivePoolSize = (width: number, height: number): number => {
  const pixels = width * height;
  if (pixels >= 3840 * 2160) return 8;
  if (pixels >= 2560 * 1440) return 7;
  if (pixels >= 1920 * 1080) return 6;
  return 5;
};

/**
 * Decode an image blob to an ImageBitmap sized for the PREVIEW canvas.
 * Imported / user media is often much larger than the comp (2000x2000+
 * stills), and compositing a full-res bitmap every frame is both slow and
 * memory-heavy. We downscale to fit the canvas (never upscale) — the
 * compositor cover-fits anyway, so nothing visible is lost, and this is
 * the same "display a compressed copy" behaviour generated content gets.
 * `createImageBitmap` decodes + resizes in one GPU-friendly step.
 */
const decodeImageFittedToCanvas = async (
  blob: Blob,
  canvasW: number,
  canvasH: number,
): Promise<ImageBitmap> => {
  // Cap at 1.5x the canvas so a slight upscale on export/zoom still looks
  // crisp, while huge originals are brought down.
  const maxW = Math.max(16, Math.round((canvasW || 1920) * 1.5));
  const maxH = Math.max(16, Math.round((canvasH || 1080) * 1.5));
  const full = await createImageBitmap(blob);
  if (full.width <= maxW && full.height <= maxH) return full;
  const scale = Math.min(maxW / full.width, maxH / full.height);
  const w = Math.max(1, Math.round(full.width * scale));
  const h = Math.max(1, Math.round(full.height * scale));
  try {
    const small = await createImageBitmap(full, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: "high",
    });
    full.close();
    return small;
  } catch {
    // Resize unsupported — return the full bitmap rather than nothing.
    return full;
  }
};


interface ClipWithPlaceholder {
  isPlaceholder?: boolean;
}

export const Preview: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  /**
   * The area the stage is centred in, and the offset that keeps the stage still
   * when that area changes width.
   *
   * See the wrapper in the JSX for the why. `useCenterShift` reports how far
   * this area's centre moved on screen — collapsing the Assets column moves it
   * ~138px — and we subtract exactly that, clamped so the stage can never be
   * pushed past the edge of the area it lives in. Clamping matters on a narrow
   * window, where holding position uncompensated would push the picture out of
   * sight; there the offset simply gives back what it cannot afford.
   *
   * HORIZONTAL ONLY, deliberately. The vertical dimension changes for a reason
   * the user is looking at: dragging the timeline up, or minimising the video.
   * Those SHOULD re-centre — pinning the picture while the space under it
   * shrinks would slide it behind the timeline. Width changes are the opposite:
   * they come from chrome the user just put away, and the stage never uses the
   * extra width anyway (it is a fixed 450px tall, capped at 800 wide), so
   * holding position costs nothing at all.
   */
  const stageAreaRef = useRef<HTMLDivElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageOffsetRef = useRef(0);
  const [stageOffset, setStageOffset] = useState(0);
  useCenterShift(stageAreaRef, (dx) => {
    const area = stageAreaRef.current?.clientWidth ?? 0;
    const stage = overlayRef.current?.getBoundingClientRect().width ?? 0;
    const limit = Math.max(0, (area - stage) / 2);
    const next = Math.max(-limit, Math.min(limit, stageOffsetRef.current - dx));
    stageOffsetRef.current = next;
    /**
     * WRITTEN TO THE ELEMENT, NOT JUST TO STATE.
     *
     * A ResizeObserver callback runs after layout and BEFORE the browser
     * paints, so a style written here lands in the same frame as the resize
     * that caused it. Going only through `setState` put the correction one
     * frame late, which is exactly long enough to see: the picture jumped
     * ~140px and snapped back. The state below still holds the value so every
     * later render re-applies it — this line is only about which frame it
     * first appears in.
     */
    if (stageWrapRef.current) {
      stageWrapRef.current.style.transform = `translateX(${next}px)`;
    }
    setStageOffset(next);
  });
  const animationRef = useRef<number | null>(null);
  const renderBridgeInitialized = useRef<boolean>(false);
  const lastGoodFrameRef = useRef<ImageBitmap | null>(null);
  const offscreenCanvasRef = useRef<OffscreenCanvas | null>(null);
  const offscreenCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(
    null,
  );

  // Native video element for hardware-accelerated playback (much faster for 4K)
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const currentVideoMediaIdRef = useRef<string | null>(null);
  const nativePlaybackActiveRef = useRef<boolean>(false);

  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioGraphRef = useRef<ReturnType<typeof getRealtimeAudioGraph> | null>(
    null,
  );
  const audioBufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());

  /** Returns the cache key for an audio buffer, accounting for multi-track audio files. */
  const getAudioBufferCacheKey = (mediaId: string, audioTrackIndex?: number): string =>
    audioTrackIndex !== undefined && audioTrackIndex > 0
      ? `${mediaId}:${audioTrackIndex}`
      : mediaId;

  /**
   * Loads an AudioBuffer for the given media item and audio track index.
   * Uses mediabunny for non-primary tracks; falls back to decodeAudioData for the primary track.
   */
  const loadAudioBuffer = async (
    audioContext: AudioContext | BaseAudioContext,
    blob: Blob,
    audioTrackIndex: number = 0,
  ): Promise<AudioBuffer | null> => {
    if (audioTrackIndex === 0) {
      try {
        const arrayBuffer = await blob.arrayBuffer();
        return await audioContext.decodeAudioData(arrayBuffer);
      } catch {
        // Fall through to mediabunny extraction
      }
    }
    // Use mediabunny to extract the specific audio track
    try {
      const { Input, ALL_FORMATS, BlobSource, AudioBufferSink } =
        await import("mediabunny");
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const audioTracks = await (input as any).getAudioTracks();
      const track =
        audioTracks[audioTrackIndex] ??
        (await (input as any).getPrimaryAudioTrack()) ??
        audioTracks[0] ??
        null;
      if (!track) {
        (input as any)[Symbol.dispose]?.();
        return null;
      }
      const canDecode = await track.canDecode();
      if (!canDecode) {
        (input as any)[Symbol.dispose]?.();
        return null;
      }
      const sink = new AudioBufferSink(track);
      const duration = await track.computeDuration();
      if (!duration || duration <= 0) {
        (input as any)[Symbol.dispose]?.();
        return null;
      }
      // Collect all audio buffers from the sink
      const chunks: { buffer: AudioBuffer; timestamp: number }[] = [];
      for await (const wrapped of sink.buffers(0, duration)) {
        chunks.push({ buffer: wrapped.buffer, timestamp: wrapped.timestamp });
      }
      (input as any)[Symbol.dispose]?.();
      if (chunks.length === 0) return null;
      // Concatenate all chunks into a single AudioBuffer
      const sampleRate = chunks[0].buffer.sampleRate;
      const numChannels = chunks[0].buffer.numberOfChannels;
      const totalFrames = Math.ceil(duration * sampleRate);
      const combined = audioContext.createBuffer(numChannels, totalFrames, sampleRate);
      for (const chunk of chunks) {
        const offsetFrames = Math.round(chunk.timestamp * sampleRate);
        for (let ch = 0; ch < numChannels; ch++) {
          const dest = combined.getChannelData(ch);
          const src = chunk.buffer.getChannelData(ch);
          dest.set(src, offsetFrames);
        }
      }
      return combined;
    } catch {
      return null;
    }
  };

  const rendererRef = useRef<Renderer | null>(null);
  const rendererInitializedRef = useRef<boolean>(false);

  const [isMuted, setIsMuted] = useState(false);
  const [isRenderBridgeReady, setIsRenderBridgeReady] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [rendererType, setRendererType] = useState<string>("none");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showRamMenu, setShowRamMenu] = useState(false);

  const ZOOM_OPTIONS = [
    { label: "100%", value: 1 },
    { label: "125%", value: 1.25 },
    { label: "150%", value: 1.5 },
    { label: "200%", value: 2 },
  ];

  const QUALITY_OPTIONS: { label: string; value: PreviewQuality }[] = [
    { label: "Auto", value: "auto" },
    { label: "Full", value: "full" },
    { label: "1/2", value: "half" },
    { label: "1/3", value: "third" },
    { label: "1/4", value: "quarter" },
    { label: "1/8", value: "eighth" },
    { label: "1/16", value: "sixteenth" },
  ];

  const frameDropCountRef = useRef(0);
  const frameTotalCountRef = useRef(0);

  // ── RAM Preview cache ──────────────────────────────────────────────
  const ramCacheRef = useRef(new PreviewFrameCache());
  const [ramCacheCount, setRamCacheCount] = useState(0);
  const ramMaxGB = useSettingsStore((s) => s.ramPreviewMaxGB);
  useEffect(() => {
    ramCacheRef.current.setMaxMemory(ramMaxGB * 1024 * 1024 * 1024);
  }, [ramMaxGB]);

  const isDark = useThemeStore((state) => state.isDark);

  // Canvas interaction state for resize/move
  const [interactionMode, setInteractionMode] =
    useState<InteractionMode>("none");
  const [activeHandle, setActiveHandle] = useState<HandlePosition | null>(null);
  const [lockAspectRatio, setLockAspectRatio] = useState(true);
  const interactionStartRef = useRef<{
    x: number;
    y: number;
    transform: { x: number; y: number; scaleX: number; scaleY: number };
  } | null>(null);
  const pendingTransformRef = useRef<{
    clipId: string;
    transform: {
      position?: { x: number; y: number };
      scale?: { x: number; y: number };
    };
  } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // ── Prerender progress state ──
  const [prerenderActive, setPrerenderActive] = useState(false);
  const [prerenderProgress, setPrerenderProgress] = useState(0);
  const prerenderCancelRef = useRef(false);

  // RAM-cache a composited frame at FULL resolution. It used to store at 1/2
  // res (4× more frames per byte budget), but cache HITS were then upscaled
  // while MISSES rendered sharp — alternating soft/sharp frames read as a
  // visible shimmer during playback (and paths B/C already cache full-res, so
  // identical frame numbers held different resolutions). Full-res = fewer
  // cached frames, consistent premium quality.
  const downscaleAndCache = useCallback((source: OffscreenCanvas | HTMLCanvasElement, frameNum: number) => {
    try {
      createImageBitmap(source).then((bmp) => {
        ramCacheRef.current.set(frameNum, bmp);
      }).catch(() => {});
    } catch {}
  }, []);

  // Track if we're currently interacting to prevent re-renders during resize/move
  const isInteractingRef = useRef<boolean>(false);
  // Throttle store updates during interaction (update at most every 32ms ~30fps)
  const lastStoreUpdateRef = useRef<number>(0);
  const STORE_UPDATE_THROTTLE_MS = 32;
  // Throttle playhead updates during playback to reduce React re-renders
  const lastPlayheadUpdateRef = useRef<number>(0);
  const PLAYHEAD_UPDATE_THROTTLE_MS = 16;
  // Live transform state for immediate visual feedback during interaction
  const [liveTransform, setLiveTransform] = useState<{
    position: { x: number; y: number };
    scale: { x: number; y: number };
  } | null>(null);

  // Track interaction target type (video clip or text clip)
  const [interactionTargetType, setInteractionTargetType] = useState<
    "clip" | "text-clip" | "shape-clip" | null
  >(null);
  const interactionTargetIdRef = useRef<string | null>(null);

  // Video element cache for native hardware-accelerated frame decoding (thumbnails/scrubbing)
  // Much more reliable than MediaBunny's CanvasSink for random-access seeking
  const videoElementCacheRef = useRef<
    Map<string, { video: HTMLVideoElement; url: string; lastUsed: number }>
  >(new Map());
  const remoteBlobCacheRef = useRef<Map<string, Blob>>(new Map());

  // Persistent decoder cache for efficient playback (legacy - kept for fallback)
  const decoderCacheRef = useRef<
    Map<
      string,
      {
        input: { [Symbol.dispose]?: () => void };
        sink: unknown;
        mediaId: string;
        lastUsed: number;
      }
    >
  >(new Map());

  // Track canvas size changes for resize handles positioning
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width, height });
        if (width > 0 && height > 0) {
          offscreenCanvasRef.current = new OffscreenCanvas(width, height);
          offscreenCtxRef.current = offscreenCanvasRef.current.getContext("2d");
        }
      }
    });

    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, []);

  // Project store - subscribe to the entire project to ensure re-renders
  // when any part of the project changes (including clips)
  const project = useProjectStore((state) => state.project);
  const getMediaItem = useProjectStore((state) => state.getMediaItem);

  const resolveMediaBlob = useCallback(
    async (
      mediaItem: ReturnType<typeof getMediaItem>,
    ): Promise<Blob | null> => {
      if (!mediaItem) return null;
      if (mediaItem.blob instanceof Blob) return mediaItem.blob;
      if (!mediaItem.originalUrl) return null;

      const cached = remoteBlobCacheRef.current.get(mediaItem.id);
      if (cached) return cached;

      try {
        // Cross-origin hosts that lack CORS (Kie tempfile, R2 buckets,
        // Grok aiquickdraw) get rewritten to /api/studio/media-proxy
        // so the fetch doesn't trip the browser's CORS wall.
        const response = await fetch(rewriteToProxy(mediaItem.originalUrl), {
          mode: "cors",
        });
        if (!response.ok) return null;
        const blob = await response.blob();
        remoteBlobCacheRef.current.set(mediaItem.id, blob);
        return blob;
      } catch {
        return null;
      }
    },
    [],
  );

  // Get text clips from TitleEngine
  //
  // Voidspace captions live on `track-captions` but render through
  // the SAME title-engine path as user-created text clips — they
  // were previously filtered out here as a leftover from the old
  // subtitle-canvas-renderer days. The filter caused captions to
  // appear on the timeline (so the user thinks they exist) but never
  // be drawn on the preview / export canvas. Drop the filter so
  // captions flow through the standard render pipeline.
  const getTitleEngine = useEngineStore((state) => state.getTitleEngine);
  const allTextClips = useMemo(() => {
    const titleEngine = getTitleEngine();
    return titleEngine?.getAllTextClips() || [];
  }, [getTitleEngine, project.modifiedAt]);

  const getGraphicsEngine = useEngineStore((state) => state.getGraphicsEngine);
  const allShapeClips = useMemo(() => {
    const graphicsEngine = getGraphicsEngine();
    const shapes = graphicsEngine?.getAllShapeClips() || [];
    const svgs = graphicsEngine?.getAllSVGClips() || [];
    const stickers = graphicsEngine?.getAllStickerClips() || [];
    return [...shapes, ...svgs, ...stickers];
  }, [getGraphicsEngine, project.modifiedAt]);

  // Get subtitles from project timeline
  const allSubtitles = useMemo(() => {
    return project.timeline.subtitles || [];
  }, [project.timeline.subtitles]);

  const updateClipTransform = useProjectStore(
    (state) => state.updateClipTransform,
  );
  const updateTextTransform = useProjectStore(
    (state) => state.updateTextTransform,
  );
  const updateShapeTransform = useProjectStore(
    (state) => state.updateShapeTransform,
  );
  const timelineTracks = project.timeline.tracks;
  const settings = project.settings;

  // Keep a ref to timelineTracks for use in playback effect without causing re-runs
  const timelineTracksRef = useRef(timelineTracks);
  useEffect(() => {
    timelineTracksRef.current = timelineTracks;
  }, [timelineTracks]);

  useEffect(() => {
    const audioGraph = audioGraphRef.current;
    if (!audioGraph) return;

    const tracksWithAudio = timelineTracks.filter(
      (t) => t.type === "audio" || t.type === "video",
    );

    for (const track of tracksWithAudio) {
      const shouldMute = Boolean(track.muted || track.hidden);
      const shouldSolo = Boolean(track.solo && !track.hidden);
      audioGraph.setTrackMuted(track.id, shouldMute);
      audioGraph.setTrackSolo(track.id, shouldSolo);
    }
  }, [timelineTracks]);

  // Invalidate RAM Preview cache on real timeline structure changes
  // (not reference identity changes from Voidspace live-reload during playback).
  // Also include caption / text-clip CONTENT (style, highlight colour, font,
  // size, position, text) — without it, editing a caption updates the paused
  // preview (renderFrameDirectly reads live clips) but PLAYBACK keeps blitting
  // cached frames rendered with the OLD style until a page refresh clears the
  // cache. The signature only changes on real content edits, so live-reload
  // ticks during generation (same content, new refs) still keep the cache.
  const prevTracksHashRef = useRef('');
  useEffect(() => {
    // Bridge-stored looks (Inspector/agent video effects + color grading)
    // never touch clip.effects, so the hash must consume the bridge's own
    // state version or cached playback frames outlive every effect change.
    let bridgeVersion = 0;
    try { bridgeVersion = getEffectsBridge().getStateVersion(); } catch { /* bridge unavailable */ }
    const tracksHash = timelineTracks.map(t =>
      `${t.id}:${t.clips.map(c => `${c.id}|${c.startTime}|${c.duration}|${c.inPoint ?? ''}|${c.outPoint ?? ''}|${(c as any).blendMode ?? ''}|${JSON.stringify(c.keyframes || [])}|${JSON.stringify(c.effects || [])}|${JSON.stringify((c as any).emphasisAnimation ?? null)}`).join(',')}`
    ).join('|') + `#eb${bridgeVersion}`;
    const textHash = allTextClips.map((tc: any) =>
      `${tc.id}|${tc.text}|${tc.style?.color || ''}|${tc.style?.fontSize || ''}|${tc.style?.fontFamily || ''}|${tc.style?.fontWeight || ''}|${tc.style?.strokeColor || ''}|${tc.style?.strokeWidth ?? ''}|${tc.captionHighlight ? 1 : 0}|${tc.captionHighlightColor || ''}|${tc.captionAnimation || ''}|${tc.transform?.position?.x ?? ''}|${tc.transform?.position?.y ?? ''}`
    ).join('~');
    const hash = `${tracksHash}##${textHash}`;
    if (hash === prevTracksHashRef.current) return;
    prevTracksHashRef.current = hash;
    const cache = ramCacheRef.current;
    cache.invalidate();
    setRamCacheCount(0);
    setRamCacheState([], 0);
    // modifiedAt dep: bridge-effect mutations bump modifiedAt WITHOUT
    // changing the tracks array reference — without this dep the effect
    // never re-runs to observe the new bridge state version.
  }, [timelineTracks, allTextClips, project.modifiedAt]);

  // Keep a ref to allTextClips for use in playback effect
  const allTextClipsRef = useRef(allTextClips);
  useEffect(() => {
    allTextClipsRef.current = allTextClips;
  }, [allTextClips]);

  const allShapeClipsRef = useRef(allShapeClips);
  useEffect(() => {
    allShapeClipsRef.current = allShapeClips;
  }, [allShapeClips]);

  // Keep a ref to isScrubbing for use in playback loop
  const isScrubbingRef = useRef(false);

  const selectedItems = useUIStore((state) => state.selectedItems);
  const cropMode = useUIStore((state) => state.cropMode);
  const cropClipId = useUIStore((state) => state.cropClipId);
  const setCropMode = useUIStore((state) => state.setCropMode);
  const exportState = useUIStore((state) => state.exportState);
  const motionPathMode = useUIStore((state) => state.motionPathMode);
  const motionPathClipId = useUIStore((state) => state.motionPathClipId);
  const select = useUIStore((state) => state.select);

  const {
    playheadPosition,
    playbackState,
    playbackRate,
    isScrubbing,
    pause,
    togglePlayback,
    setPlayheadPosition,
    previewQuality,
    setPreviewQuality,
  } = useTimelineStore();

  useEffect(() => {
    isScrubbingRef.current = isScrubbing;
  }, [isScrubbing]);

  const isPlaying = playbackState === "playing";

  const motionPathClip = React.useMemo(() => {
    if (!motionPathMode || !motionPathClipId) return null;
    for (const track of project.timeline.tracks) {
      const clip = track.clips.find((c) => c.id === motionPathClipId);
      if (clip) return clip;
    }
    return null;
  }, [motionPathMode, motionPathClipId, project.timeline.tracks]);

  const [motionPathConfig, setMotionPathConfig] = React.useState<MotionPathConfig | null>(null);

  React.useEffect(() => {
    if (motionPathClip) {
      setMotionPathConfig({
        clipId: motionPathClip.id,
        enabled: true,
        pathType: "bezier",
        points: [],
        showPath: true,
        autoOrient: false,
        alignOrigin: [0.5, 0.5],
      });
    } else {
      setMotionPathConfig(null);
    }
  }, [motionPathClip]);

  const handleMotionPathPointMove = React.useCallback(
    (index: number, x: number, y: number) => {
      setMotionPathConfig((prev) => {
        if (!prev) return prev;
        const newPoints = [...prev.points];
        newPoints[index] = { ...newPoints[index], x, y };
        return { ...prev, points: newPoints };
      });
    },
    []
  );

  const handleMotionPathPointAdd = React.useCallback(
    (point: GSAPMotionPathPoint) => {
      setMotionPathConfig((prev) => {
        if (!prev) return prev;
        const newPoints = [...prev.points, point].sort((a, b) => a.time - b.time);
        return { ...prev, points: newPoints };
      });
    },
    []
  );

  const handleMotionPathPointRemove = React.useCallback((index: number) => {
    setMotionPathConfig((prev) => {
      if (!prev) return prev;
      const newPoints = prev.points.filter((_, i) => i !== index);
      return { ...prev, points: newPoints };
    });
  }, []);

  const handleMotionPathControlPointMove = React.useCallback(
    (pointIndex: number, handleType: "cp1" | "cp2", x: number, y: number) => {
      setMotionPathConfig((prev) => {
        if (!prev) return prev;
        const newPoints = [...prev.points];
        const point = newPoints[pointIndex];
        if (!point.controlPoints) {
          point.controlPoints = { cp1: { x: 0, y: 0 }, cp2: { x: 0, y: 0 } };
        }
        point.controlPoints[handleType] = { x, y };
        return { ...prev, points: newPoints };
      });
    },
    []
  );

  const particleEngine = React.useMemo(() => getParticleEngine(), []);
  const [particleUpdateTrigger, setParticleUpdateTrigger] = React.useState(
    () => particleEngine.getChangeVersion()
  );

  React.useEffect(() => {
    const unsubscribe = particleEngine.onEffectsChange(() => {
      setParticleUpdateTrigger(particleEngine.getChangeVersion());
    });
    return unsubscribe;
  }, [particleEngine]);

  const particleEffects = React.useMemo(() => {
    return particleEngine.getAllEffects();
  }, [particleEngine, particleUpdateTrigger]);

  // Calculate the actual end time for playback (where clips actually end)
  // This needs to recalculate whenever the timeline changes
  // Includes video/audio/image clips, text clips, and shape clips
  const actualEndTime = React.useMemo(() => {
    const tracks = project.timeline.tracks;
    let maxEnd = 0;

    for (const track of tracks) {
      for (const clip of track.clips) {
        const end = clip.startTime + clip.duration;
        if (end > maxEnd) maxEnd = end;
      }
    }

    for (const textClip of allTextClips) {
      const end = textClip.startTime + textClip.duration;
      if (end > maxEnd) maxEnd = end;
    }

    for (const shapeClip of allShapeClips) {
      const end = shapeClip.startTime + shapeClip.duration;
      if (end > maxEnd) maxEnd = end;
    }

    return maxEnd;
  }, [project.timeline.tracks, allTextClips, allShapeClips]);

  // RenderBridge is guaranteed to be initialized before Preview renders (see EditorInterface)
  useEffect(() => {
    if (renderBridgeInitialized.current) return;

    const bridge = getRenderBridge();
    if (canvasRef.current) {
      bridge.setCanvas(canvasRef.current);
    }
    renderBridgeInitialized.current = true;
    setIsRenderBridgeReady(true);
  }, []);

  useEffect(() => {
    return () => {
      for (const entry of decoderCacheRef.current.values()) {
        entry.input[Symbol.dispose]?.();
      }
      decoderCacheRef.current.clear();

      for (const entry of videoElementCacheRef.current.values()) {
        entry.video.src = "";
        URL.revokeObjectURL(entry.url);
      }
      videoElementCacheRef.current.clear();

      if (videoElementRef.current) {
        videoElementRef.current.pause();
        videoElementRef.current.src = "";
        videoElementRef.current = null;
      }
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
      currentVideoMediaIdRef.current = null;
    };
  }, []);

  // Set canvas internal resolution ONLY when project settings change
  // This follows the WebGPU best practice of keeping internal resolution fixed
  // and using CSS/transforms for display scaling (prevents flickering during resize)
  // Using useLayoutEffect to ensure canvas size is set before first paint
  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Always ensure canvas has correct size
    if (canvas.width !== settings.width || canvas.height !== settings.height) {
      canvas.width = settings.width;
      canvas.height = settings.height;
    }
  }, [settings.width, settings.height]);

  useEffect(() => {
    if (isRenderBridgeReady && canvasRef.current) {
      const bridge = getRenderBridge();
      bridge.setCanvas(canvasRef.current);
    }
  }, [isRenderBridgeReady]);

  /**
   * Initialize WebGPU renderer for GPU-accelerated rendering (once on mount)
   */
  useEffect(() => {
    if (rendererInitializedRef.current || !canvasRef.current) return;

    const initializeRenderer = async () => {
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const factory = RendererFactory.getInstance();
        // canvas2d, deliberately: the current WebGPU impl renders offscreen
        // then does a FULL GPU→CPU readback every frame (copyTextureToBuffer
        // + mapAsync + row copy + createImageBitmap) just to drawImage the
        // result onto a 2D canvas — strictly slower than compositing on
        // canvas2d directly, it stalls frame pacing (visible stutter), and
        // its branch also breaks image↔video z-order + lacks blend modes.
        // Re-prefer "webgpu" only if the renderer presents directly to the
        // visible canvas instead of reading back.
        const renderer = await factory.createRenderer({
          canvas,
          width: settings.width,
          height: settings.height,
          preferredRenderer: "canvas2d",
        });

        rendererRef.current = renderer;
        rendererInitializedRef.current = true;
        setRendererType(renderer.type);

        renderer.onDeviceLost(() => {
          console.warn("[Preview] GPU device lost, attempting recovery...");
          renderer.recreateDevice().then((success) => {
            if (!success) {
              console.error("[Preview] Failed to recover GPU device");
              setRendererType("canvas2d");
            }
          });
        });
      } catch (error) {
        console.warn("[Preview] Failed to initialize GPU renderer:", error);
        setRendererType("canvas2d");
      }
    };

    initializeRenderer();

    return () => {
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
        rendererInitializedRef.current = false;
      }
    };
  }, []);

  /**
   * Handle canvas resize events
   *
   * Update preview at 60fps when dragging to resize
   */
  useEffect(() => {
    if (rendererRef.current && canvasRef.current) {
      const canvas = canvasRef.current;
      if (
        canvas.width !== settings.width ||
        canvas.height !== settings.height
      ) {
        rendererRef.current.resize(settings.width, settings.height);
      }
    }
  }, [settings.width, settings.height]);

  const rateRef = useRef(playbackRate);
  const startPositionRef = useRef(playheadPosition);

  // MediaBunny playback resources - map of clipId to resources for multi-track playback
  const playbackResourcesRef = useRef<
    Map<
      string,
      {
        input: { [Symbol.dispose]?: () => void };
        sink: unknown;
        mediaId: string;
        clipId: string;
        trackIndex: number;
      }
    >
  >(new Map());

  const imageBitmapCacheRef = useRef<Map<string, ImageBitmap>>(new Map());
  // Clip ids whose image bitmap is currently being resolved on-demand, so
  // the compositor doesn't spawn duplicate decode jobs for the same frame.
  const imageDecodeInFlightRef = useRef<Set<string>>(new Set());
  // Per-clip LAST decoded frame. When one track's decoder misses a frame
  // (GOP seek latency, warmup right after init, transient null from the
  // sink) the compositor reuses that clip's previous frame instead of
  // dropping the whole layer for a frame — a one-frame layer dropout reads
  // as a flicker, the worst kind of glitch on multi-track timelines.
  const lastClipFrameRef = useRef<Map<string, ImageBitmap>>(new Map());
  // PLAYBACK render scale (paused/scrub renders stay full-res). Consumed by
  // initClipResources for decode dims and by the multi-track compositor for
  // its offscreen dims. Sourced from the Preview Quality gauge at play start
  // ("auto" = 0.5) — the gauge existed but was never wired to anything.
  const playbackScaleRef = useRef<number>(1);
  const lastPlaybackScaleRef = useRef<number>(1);
  // Watchdog that recovers the multi-track loop if a frame's decode
  // (MediaBunny getCanvas / createImageBitmap) HANGS — otherwise
  // `isProcessingFrame` stays true forever and playback freezes (the
  // "preview wedges / only pause→play unsticks it" bug).
  const frameWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    rateRef.current = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    if (!isPlaying) {
      startPositionRef.current = playheadPosition;
    }
  }, [isPlaying, playheadPosition]);

  const cleanupPlaybackResources = useCallback(() => {
    if (frameWatchdogRef.current) {
      clearInterval(frameWatchdogRef.current);
      frameWatchdogRef.current = null;
    }
    const resources = playbackResourcesRef.current;
    for (const [, resource] of resources) {
      resource.input[Symbol.dispose]?.();
    }
    playbackResourcesRef.current = new Map();

    for (const [, bitmap] of imageBitmapCacheRef.current) {
      bitmap.close();
    }
    imageBitmapCacheRef.current = new Map();

    for (const [, bitmap] of lastClipFrameRef.current) {
      try { bitmap.close(); } catch { /* already closed */ }
    }
    lastClipFrameRef.current = new Map();
  }, []);

  const cleanupAudioResources = useCallback(() => {
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch {
        // Ignore errors if already stopped
      }
      audioSourceRef.current.disconnect();
      audioSourceRef.current = null;
    }
    if (audioGraphRef.current) {
      audioGraphRef.current.stopScheduler();
      audioGraphRef.current.stopAllClips();
    }
  }, []);

  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = isMuted ? 0 : 1;
    }
    if (audioGraphRef.current) {
      audioGraphRef.current.setPreviewMuted(isMuted);
    }
  }, [isMuted]);

  /**
   * Render overlay clips (text and shapes) respecting proper z-ordering with video/image tracks.
   * Track order determines layering: lower track index = rendered on top.
   *
   * @param mode - "below-video" renders only overlays that should appear below video tracks
   * "above-video" renders only overlays that should appear above video tracks
   * "all" renders all overlays (legacy behavior for when no video is present)
   */
  const renderOverlayClipsInTrackOrder = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      tracks: Track[],
      shapeClips: (ShapeClip | SVGClip | StickerClip)[],
      textClips: TextClip[],
      time: number,
      canvasWidth: number,
      canvasHeight: number,
      mode: "below-video" | "above-video" | "all" = "all",
    ) => {
      const videoImageTrackIndices = tracks
        .map((t, idx) => ({ track: t, originalIndex: idx }))
        .filter(
          ({ track }) =>
            (track.type === "video" || track.type === "image") && !track.hidden,
        )
        .map(({ originalIndex }) => originalIndex);

      const lowestVideoIndex =
        videoImageTrackIndices.length > 0
          ? Math.min(...videoImageTrackIndices)
          : Infinity;
      const highestVideoIndex =
        videoImageTrackIndices.length > 0
          ? Math.max(...videoImageTrackIndices)
          : -1;

      const overlayTracksWithIndex = tracks
        .map((t, idx) => ({ track: t, originalIndex: idx }))
        .filter(
          ({ track }) =>
            (track.type === "text" || track.type === "graphics") &&
            !track.hidden,
        );

      // CAPTIONS RULE: any track of type "text" is always treated as
      // an above-video overlay regardless of its array position. The
      // chat's additive Firestore merge can append the captions track
      // at the END of the tracks array (highest originalIndex), which
      // would otherwise route it through the below-video pass and
      // hide subtitles beneath the video frame. Forcing text tracks
      // into the above-video pass keeps preview behaviour aligned
      // with the export pipeline (see video-engine.renderFrame's
      // trackTypeRank fix). Graphics tracks keep the existing
      // index-relative semantics because shapes / SVGs / stickers
      // are sometimes intentionally placed UNDER footage as a
      // background layer.
      const tracksToRender = overlayTracksWithIndex.filter(
        ({ track, originalIndex }) => {
          const isTextOverlay = track.type === "text";
          if (mode === "below-video") {
            if (isTextOverlay) return false;
            return originalIndex > highestVideoIndex;
          } else if (mode === "above-video") {
            if (isTextOverlay) return true;
            return originalIndex < lowestVideoIndex;
          }
          return true;
        },
      );

      tracksToRender.sort((a, b) => b.originalIndex - a.originalIndex);

      for (const { track } of tracksToRender) {
        if (track.type === "graphics") {
          const trackShapeClips = shapeClips.filter(
            (sc) => sc.trackId === track.id,
          );
          for (const shapeClip of trackShapeClips) {
            renderShapeClipToCanvas(
              ctx,
              shapeClip,
              canvasWidth,
              canvasHeight,
              time,
            );
          }
        } else if (track.type === "text") {
          const trackTextClips = textClips.filter(
            (tc) => tc.trackId === track.id,
          );
          for (const textClip of trackTextClips) {
            renderTextClipToCanvas(
              ctx,
              textClip,
              canvasWidth,
              canvasHeight,
              time,
            );
          }
        }
      }
    },
    [],
  );

  /**
   * Set up audio playback from the AUDIO TRACK at a given timeline position
   * Uses RealtimeAudioGraph for real-time audio effects (reverb, delay, EQ, compressor)
   *
   * Audio effects can be on either:
   * 1. The audio clip on the audio track (preferred)
   * 2. A linked video clip on the video track (same mediaId, same startTime)
   *
   * @param timelinePosition - The current position in the timeline
   */
  const setupAudioFromAudioTrack = useCallback(
    async (timelinePosition: number): Promise<void> => {
      const tracks = timelineTracksRef.current;
      const audioTracks = tracks.filter((t) => t.type === "audio" && !t.hidden);
      const videoTracks = tracks.filter(
        (t) => (t.type === "video" || t.type === "image") && !t.hidden,
      );
      const tracksWithAudio = [...audioTracks, ...videoTracks];

      if (!audioGraphRef.current) {
        audioGraphRef.current = getRealtimeAudioGraph();
      }
      const audioGraph = audioGraphRef.current;
      audioGraph.setPreviewMuted(isMuted);

      const projectStore = useProjectStore.getState();
      const speedEngine = getSpeedEngine();
      const scheduledClips: AudioClipSchedule[] = [];

      for (const audioTrack of tracksWithAudio) {
        audioGraph.createTrack({
          trackId: audioTrack.id,
          volume: 1,
          pan: 0,
          muted: audioTrack.muted || false,
          solo: audioTrack.solo || false,
          effects: [],
        });

        if (audioTrack.muted) {
          continue;
        }

        for (const audioClip of audioTrack.clips) {
          const clipEnd = audioClip.startTime + audioClip.duration;

          if (
            timelinePosition >= audioClip.startTime &&
            timelinePosition < clipEnd
          ) {
            const mediaItem = getMediaItem(audioClip.mediaId);
            if (!mediaItem) {
              continue;
            }

            const mediaBlob = await resolveMediaBlob(mediaItem);
            if (!mediaBlob) continue;

            // Prefer dedicated audio-track clips over linked video-track clones.
            if (audioTrack.type !== "audio") {
              const linkedAudioClipExists = audioTracks.some((at) =>
                at.clips.some(
                  (ac) =>
                    ac.mediaId === audioClip.mediaId &&
                    Math.abs(ac.startTime - audioClip.startTime) < 0.01,
                ),
              );
              if (linkedAudioClipExists) {
                continue;
              }
            }

            let audioBuffer = audioBufferCacheRef.current.get(
              getAudioBufferCacheKey(audioClip.mediaId, audioClip.audioTrackIndex),
            );
            if (!audioBuffer) {
              try {
                const audioContext = audioGraph.getAudioContext();
                const loaded = await loadAudioBuffer(
                  audioContext,
                  mediaBlob,
                  audioClip.audioTrackIndex ?? 0,
                );
                if (!loaded) {
                  continue;
                }
                audioBuffer = loaded;
                audioBufferCacheRef.current.set(
                  getAudioBufferCacheKey(audioClip.mediaId, audioClip.audioTrackIndex),
                  audioBuffer,
                );
              } catch (error) {
                console.warn(
                  `[Preview] Failed to decode audio for clip ${audioClip.id}:`,
                  error,
                );
                continue;
              }
            }

            const audioClipData = projectStore.getClip(audioClip.id);
            let audioEffects = audioClipData?.audioEffects || [];

            if (audioEffects.length === 0) {
              for (const videoTrack of videoTracks) {
                for (const videoClip of videoTrack.clips) {
                  if (
                    videoClip.mediaId === audioClip.mediaId &&
                    Math.abs(videoClip.startTime - audioClip.startTime) < 0.01
                  ) {
                    const videoClipData = projectStore.getClip(videoClip.id);
                    const linkedEffects = videoClipData?.audioEffects || [];
                    if (linkedEffects.length > 0) {
                      audioEffects = linkedEffects;
                      break;
                    }
                  }
                }
                if (audioEffects.length > 0) break;
              }
            }

            const enabledEffects = audioEffects.filter(
              (e: Effect) => e.enabled,
            );

            audioGraph.updateTrackEffects(audioTrack.id, enabledEffects);

            const clipLocalTime = timelinePosition - audioClip.startTime;
            const isReverse = speedEngine.isReverse(audioClip.id);

            let mediaOffset = (audioClip.inPoint || 0) + clipLocalTime;
            if (isReverse) {
              mediaOffset = audioBuffer.duration - mediaOffset;
              mediaOffset = Math.max(0, mediaOffset);
            }

            scheduledClips.push({
              clipId: audioClip.id,
              trackId: audioTrack.id,
              audioBuffer,
              startTime: audioClip.startTime,
              endTime: clipEnd,
              mediaOffset,
              volume: audioClip.volume ?? 1,
              pan: 0,
              effects: enabledEffects,
              speed: audioClip.speed ?? 1,
              // Volume keyframes + fades so scrub/paused audio matches
              // playback (this path used to drop the volume envelope).
              automationVolume: (audioClipData?.keyframes ?? [])
                .filter((k) => k.property === "volume")
                .map((k) => ({
                  time: k.time,
                  value: typeof k.value === "number" ? k.value : 1,
                }))
                .sort((a, b) => a.time - b.time),
              fadeIn: audioClipData?.fade?.fadeIn,
              fadeOut: audioClipData?.fade?.fadeOut,
            });
          }
        }
      }

      if (scheduledClips.length > 0) {
        await audioGraph.resume();
        audioGraph.scheduleClips(scheduledClips);
      }
    },
    [getMediaItem, isMuted, resolveMediaBlob],
  );

  const preDecodeAllAudioBuffers = useCallback(async (): Promise<void> => {
    const tracks = timelineTracksRef.current;
    const audioTracks = tracks.filter((t) => t.type === "audio" && !t.hidden);
    const videoTracks = tracks.filter(
      (t) => (t.type === "video" || t.type === "image") && !t.hidden,
    );

    if (!audioGraphRef.current) {
      audioGraphRef.current = getRealtimeAudioGraph();
    }
    const audioGraph = audioGraphRef.current;
    const audioContext = audioGraph.getAudioContext();

    const allTracks = [...audioTracks, ...videoTracks];

    // Decode in PARALLEL — this runs at play start and used to be a serial
    // await-per-clip loop, so pressing Play on a long timeline stalled for
    // the sum of every clip's fetch+decode. Dedupe by cache key so the same
    // media on multiple clips decodes once.
    const jobs: Promise<void>[] = [];
    const inFlight = new Set<string>();
    for (const track of allTracks) {
      for (const clip of track.clips) {
        const cacheKey = getAudioBufferCacheKey(clip.mediaId, clip.audioTrackIndex);
        if (audioBufferCacheRef.current.has(cacheKey) || inFlight.has(cacheKey)) {
          continue;
        }

        const mediaItem = getMediaItem(clip.mediaId);
        if (!mediaItem) {
          continue;
        }
        if (mediaItem.type === "image") continue; // images carry no audio

        inFlight.add(cacheKey);
        jobs.push((async () => {
          const mediaBlob = await resolveMediaBlob(mediaItem);
          if (!mediaBlob) return;
          try {
            const audioBuffer = await loadAudioBuffer(
              audioContext,
              mediaBlob,
              clip.audioTrackIndex ?? 0,
            );
            if (audioBuffer) {
              audioBufferCacheRef.current.set(cacheKey, audioBuffer);
            }
          } catch {
            /* undecodable clip — scheduler skips it */
          }
        })());
      }
    }
    await Promise.all(jobs);
  }, [getMediaItem, resolveMediaBlob]);

  const getAudioClipsForScheduler = useCallback(
    (time: number): AudioClipSchedule[] => {
      const projectStore = useProjectStore.getState();

      /**
       * NESTED SEQUENCES ARE FLATTENED BEFORE SCHEDULING.
       *
       * A compound instance's `mediaId` names a sequence, so the buffer lookup
       * below misses and the clip is skipped — the sequence played SILENTLY in
       * preview while the exported file had sound. That split is the exact
       * failure `compoundIdOfClip` exists to prevent, and it had opened up
       * again one layer down.
       *
       * The ref, not the store's tracks: it is the live copy this scheduler is
       * driven from. Only flattened when the project actually has compounds, so
       * the ordinary timeline does not allocate on a hot path.
       */
      const liveTracks = timelineTracksRef.current;
      const proj = projectStore.project;
      const tracks = proj?.compoundClips?.length
        ? flattenCompoundAudio({
            ...proj,
            timeline: { ...proj.timeline, tracks: liveTracks },
          }).tracks
        : liveTracks;

      const tracksWithAudio = tracks.filter(
        (t) => (t.type === "audio" || t.type === "video") && !t.hidden && !t.muted,
      );
      const schedules: AudioClipSchedule[] = [];

      for (const track of tracksWithAudio) {
        for (const clip of track.clips) {
          const clipEnd = clip.startTime + clip.duration;
          if (clipEnd <= time || clip.startTime > time + 1) {
            continue;
          }

          const audioBuffer = audioBufferCacheRef.current.get(
            getAudioBufferCacheKey(clip.mediaId, clip.audioTrackIndex),
          );
          if (!audioBuffer) {
            continue;
          }

          const clipData = projectStore.getClip(clip.id);
          const audioEffects = (clipData?.audioEffects || []).filter(
            (e: Effect) => e.enabled,
          );

          schedules.push({
            clipId: clip.id,
            trackId: track.id,
            audioBuffer,
            startTime: clip.startTime,
            endTime: clipEnd,
            mediaOffset: clip.inPoint || 0,
            volume: clip.volume ?? 1,
            pan: 0,
            effects: audioEffects,
            speed: clip.speed ?? 1,
            // Volume keyframes + fades → scheduled gain envelope (live).
            // SOURCE: the NATIVE clip.keyframes rows with property "volume"
            // (value = gain, 1 = unity) — the SAME store the Inspector's
            // Keyframes panel and the timeline VOL overlay edit. Do NOT read
            // a separate clip.automation.volume here; that parallel store was
            // removed to keep timeline / inspector / agent in sync.
            automationVolume: (clipData?.keyframes ?? [])
              .filter((k) => k.property === "volume")
              .map((k) => ({
                time: k.time,
                value: typeof k.value === "number" ? k.value : 1,
              }))
              .sort((a, b) => a.time - b.time),
            fadeIn: clipData?.fade?.fadeIn,
            fadeOut: clipData?.fade?.fadeOut,
          });
        }
      }

      return schedules;
    },
    [],
  );

  // LIVE volume: while playing, re-apply gain to already-scheduled sources
  // whenever the project changes (volume-line drag, clip volume, fades).
  // scheduleClip snapshots gain once, so without this an edit mid-playback
  // is inaudible until the next play.
  useEffect(() => {
    if (!isPlaying) return;
    const graph = audioGraphRef.current;
    if (!graph || typeof (graph as any).updateClipGain !== "function") return;
    try {
      const t = getMasterClock().currentTime;
      for (const s of getAudioClipsForScheduler(t)) {
        (graph as any).updateClipGain(s);
      }
    } catch { /* best-effort live update */ }
  }, [isPlaying, project.modifiedAt, getAudioClipsForScheduler]);

  /**
   * Decode a single frame from a clip at a specific time using native video element
   * Native video elements provide reliable hardware-accelerated random-access seeking
   */
  const decodeClipFrame = useCallback(
    async (
      clip: {
        id: string;
        mediaId: string;
        startTime: number;
        inPoint?: number;
      },
      time: number,
      canvasWidth: number,
      canvasHeight: number,
    ): Promise<ImageBitmap | null> => {
      const mediaItem = getMediaItem(clip.mediaId);
      if (!mediaItem) return null;
      const mediaBlob = await resolveMediaBlob(mediaItem);
      if (!mediaBlob) return null;

      if (mediaItem.type === "image") {
        try {
          return await decodeImageFittedToCanvas(mediaBlob, canvasWidth, canvasHeight);
        } catch {
          return null;
        }
      }

      try {
        const clipLocalTime = time - clip.startTime;
        const speedEngine = getSpeedEngine();
        const adjustedLocalTime = speedEngine.getSourceTimeAtPlaybackTime(
          clip.id,
          clipLocalTime,
        );
        const mediaTime = (clip.inPoint || 0) + adjustedLocalTime;

        const cacheKey = clip.mediaId;
        let cached = videoElementCacheRef.current.get(cacheKey);

        if (!cached) {
          const url = URL.createObjectURL(mediaBlob);
          const video = document.createElement("video");
          video.src = url;
          video.muted = true;
          video.playsInline = true;
          video.preload = "auto";
          video.crossOrigin = "anonymous";

          await new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(
              () => reject(new Error("Video load timeout")),
              10000,
            );
            video.onloadedmetadata = () => {
              clearTimeout(timeoutId);
              resolve();
            };
            video.onerror = () => {
              clearTimeout(timeoutId);
              reject(new Error("Video load failed"));
            };
          });

          cached = { video, url, lastUsed: Date.now() };
          videoElementCacheRef.current.set(cacheKey, cached);

          if (videoElementCacheRef.current.size > 8) {
            let oldestKey = "";
            let oldestTime = Infinity;
            for (const [key, entry] of videoElementCacheRef.current.entries()) {
              if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestKey = key;
              }
            }
            if (oldestKey) {
              const oldEntry = videoElementCacheRef.current.get(oldestKey);
              if (oldEntry) {
                oldEntry.video.src = "";
                URL.revokeObjectURL(oldEntry.url);
                videoElementCacheRef.current.delete(oldestKey);
              }
            }
          }
        }

        cached.lastUsed = Date.now();
        const { video } = cached;

        const clampedTime = Math.max(
          0,
          Math.min(mediaTime, video.duration - 0.001),
        );
        if (Math.abs(video.currentTime - clampedTime) > 0.01) {
          video.currentTime = clampedTime;
          await new Promise<void>((resolve) => {
            const onSeeked = () => {
              video.removeEventListener("seeked", onSeeked);
              resolve();
            };
            video.addEventListener("seeked", onSeeked);
            setTimeout(resolve, 500);
          });
        }

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = canvasWidth;
        tempCanvas.height = canvasHeight;
        const tempCtx = tempCanvas.getContext("2d");
        if (!tempCtx) return null;

        const videoAspect = video.videoWidth / video.videoHeight;
        const canvasAspect = canvasWidth / canvasHeight;
        let drawWidth = canvasWidth;
        let drawHeight = canvasHeight;
        let offsetX = 0;
        let offsetY = 0;

        if (videoAspect > canvasAspect) {
          drawHeight = canvasWidth / videoAspect;
          offsetY = (canvasHeight - drawHeight) / 2;
        } else {
          drawWidth = canvasHeight * videoAspect;
          offsetX = (canvasWidth - drawWidth) / 2;
        }

        tempCtx.fillStyle = "#000000";
        tempCtx.fillRect(0, 0, canvasWidth, canvasHeight);
        tempCtx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);

        return await createImageBitmap(tempCanvas);
      } catch {
        const cached = videoElementCacheRef.current.get(clip.mediaId);
        if (cached) {
          cached.video.src = "";
          if (cached.url.startsWith("blob:")) {
            URL.revokeObjectURL(cached.url);
          }
          videoElementCacheRef.current.delete(clip.mediaId);
        }
        return null;
      }
    },
    [getMediaItem, resolveMediaBlob],
  );

  // Render a single frame using MediaBunny (for scrubbing/seeking)
  const renderFrameDirectly = useCallback(
    async (time: number): Promise<boolean> => {
      const canvas = canvasRef.current;
      if (!canvas) return false;

      if (canvas.width === 0 || canvas.height === 0) {
        canvas.width = settings.width;
        canvas.height = settings.height;
      }

      const mainCtx = canvas.getContext("2d");
      if (!mainCtx) return false;

      /**
       * ── A NESTED SEQUENCE IS RENDERED BY THE CANONICAL COMPOSITOR ────────
       *
       * A compound clip is a whole timeline, not a media blob, so the preview's
       * own painter has nothing to draw for it: `compositeTracksToCtx` is pure
       * painting over frames the caller already resolved, and there is no file
       * to decode. Left alone it draws a hole.
       *
       * Upstream's answer, taken as-is, and it is better than resolving the
       * compound per-clip and feeding it into the frame map: when a sequence is
       * on screen, render the WHOLE frame through the same engine the export
       * uses and blit it. The preview is then identical to the exported file by
       * construction — nesting, timing, effects, transforms and all — instead
       * of identical only in the parts both paths happen to implement the same
       * way. That divergence is what once made captions visible on screen and
       * absent from the render, and a nested sequence has far more surface for
       * it than a caption does.
       *
       * Only while a compound is actually active, so an ordinary project keeps
       * the fast path and pays nothing.
       */
      const hasActiveCompound = timelineTracks.some((track) =>
        !track.hidden &&
        track.clips.some(
          (clip) =>
            !!compoundIdOfClip(clip) &&
            time >= clip.startTime &&
            time < clip.startTime + clip.duration,
        ),
      );
      if (hasActiveCompound) {
        const frame = await getRenderBridge().renderFrame(time);
        if (frame) {
          mainCtx.clearRect(0, 0, canvas.width, canvas.height);
          mainCtx.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
          return true;
        }
      }

      if (
        !offscreenCanvasRef.current ||
        offscreenCanvasRef.current.width !== canvas.width ||
        offscreenCanvasRef.current.height !== canvas.height
      ) {
        offscreenCanvasRef.current = new OffscreenCanvas(
          canvas.width,
          canvas.height,
        );
        offscreenCtxRef.current = offscreenCanvasRef.current.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
      }

      const ctx =
        offscreenCtxRef.current as unknown as CanvasRenderingContext2D;
      if (!ctx) return false;

      const videoTracks = timelineTracks.filter(
        (t) => (t.type === "video" || t.type === "image") && !t.hidden,
      );

      let hasRenderedFrame = false;
      let shouldClearCanvas = true;

      const activeShapeClips = getActiveShapeClips(allShapeClips, time);
      const activeTextClips = getActiveTextClips(allTextClips, time);

      if (!hasRenderedFrame) {
        const hasVideoContent = videoTracks.some((track) =>
          track.clips.some(
            (clip) =>
              time >= clip.startTime && time < clip.startTime + clip.duration,
          ),
        );

        if (
          shouldClearCanvas &&
          (hasVideoContent ||
            activeShapeClips.length > 0 ||
            activeTextClips.length > 0)
        ) {
          ctx.fillStyle = hasVideoContent
            ? "#000000"
            : isDark
              ? "#0f0f11"
              : "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          shouldClearCanvas = false;
        }

        // Decode + effect each active video/image clip into a frame map,
        // then paint via the ONE shared z-order compositor (same painter as
        // playback + export). Decode/effects (async) happen here; the shared
        // fn is pure synchronous painting.
        const frameMap = new Map<string, ImageBitmap>();
        for (const track of timelineTracks) {
          if (track.type !== "video" && track.type !== "image") continue;
          if (track.hidden) continue;
          for (const clip of track.clips) {
            if (!(time >= clip.startTime && time < clip.startTime + clip.duration)) continue;
            const frame = await decodeClipFrame(clip, time, canvas.width, canvas.height);
            if (!frame) continue;
            try {
              const processed = await applyEffectsToFrame(clip.id, frame);
              frameMap.set(clip.id, processed.width > 0 && processed.height > 0 ? processed : frame);
            } catch {
              frameMap.set(clip.id, frame);
            }
          }
        }
        compositeTracksToCtx(ctx, {
          tracks: timelineTracks,
          time,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          frameProvider: (clip) => frameMap.get(clip.id) ?? null,
          textClips: activeTextClips,
          shapeClips: activeShapeClips,
        });
        if (frameMap.size > 0 || activeTextClips.length > 0 || activeShapeClips.length > 0) {
          hasRenderedFrame = true;
        }
      }

      // Blit whenever ANY overlay layer (caption/text/shape) was drawn, so a
      // caption with no decodable video at the playhead still appears paused.
      const drewOverlays =
        activeTextClips.length > 0 || activeShapeClips.length > 0;
      if ((hasRenderedFrame || drewOverlays) && offscreenCanvasRef.current) {
        mainCtx.clearRect(0, 0, canvas.width, canvas.height);
        mainCtx.drawImage(offscreenCanvasRef.current, 0, 0);
      }

      return hasRenderedFrame || drewOverlays;
    },
    [
      timelineTracks,
      getMediaItem,
      decodeClipFrame,
      settings.width,
      settings.height,
      allTextClips,
      allShapeClips,
      renderOverlayClipsInTrackOrder,
      isDark,
    ],
  );

  const renderFrameDirectlyRef = useRef(renderFrameDirectly);
  useEffect(() => {
    renderFrameDirectlyRef.current = renderFrameDirectly;
  }, [renderFrameDirectly]);

  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const playheadPositionRef = useRef(playheadPosition);
  useEffect(() => {
    playheadPositionRef.current = playheadPosition;
  }, [playheadPosition]);

  useEffect(() => {
    setImageLoadCallback(() => {
      if (!isPlayingRef.current) {
        renderFrameDirectlyRef.current(playheadPositionRef.current);
      }
    });
    return () => setImageLoadCallback(null);
  }, []);

  const renderFallbackFrame = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (canvas.width === 0 || canvas.height === 0) {
        canvas.width = settings.width;
        canvas.height = settings.height;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const emptyBg = isDark ? "#0f0f11" : "#ffffff";
      const emptyText = isDark ? "#52525b" : "#a1a1aa";
      const textPrimary = isDark ? "#ffffff" : "#18181b";
      const textSecondary = isDark ? "#a1a1aa" : "#71717a";

      const activeShapeClips = getActiveShapeClips(allShapeClips, time);
      const activeTextClips = getActiveTextClips(allTextClips, time);

      const videoTracks = timelineTracks.filter(
        (t) => (t.type === "video" || t.type === "image") && !t.hidden,
      );

      const hasVideoContent = videoTracks.some((track) =>
        track.clips.some(
          (clip) =>
            time >= clip.startTime && time < clip.startTime + clip.duration,
        ),
      );

      ctx.fillStyle = hasVideoContent
        ? isDark
          ? "#18181b"
          : "#f4f4f5"
        : emptyBg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let hasRenderedContent = false;

      const allRenderableTracks = timelineTracks
        .map((track, idx) => ({ track, originalIndex: idx }))
        .filter(
          ({ track }) =>
            (track.type === "video" ||
              track.type === "image" ||
              track.type === "text" ||
              track.type === "graphics") &&
            !track.hidden,
        )
        .sort((a, b) => b.originalIndex - a.originalIndex);

      for (const { track } of allRenderableTracks) {
        if (track.type === "video" || track.type === "image") {
          for (const clip of track.clips) {
            const clipStart = clip.startTime;
            const clipEnd = clip.startTime + clip.duration;

            if (time >= clipStart && time < clipEnd) {
              const mediaItem = getMediaItem(clip.mediaId);
              if (mediaItem) {
                hasRenderedContent = true;
                ctx.fillStyle = textPrimary;
                ctx.font = "bold 24px Inter, sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(
                  mediaItem.name,
                  canvas.width / 2,
                  canvas.height / 2,
                );
                ctx.font = "16px Inter, sans-serif";
                ctx.fillStyle = textSecondary;
                ctx.fillText(
                  `${formatTime(time)} / ${formatTime(clip.duration)}`,
                  canvas.width / 2,
                  canvas.height / 2 + 30,
                );
              } else if ((clip as ClipWithPlaceholder).isPlaceholder) {
                hasRenderedContent = true;
                ctx.fillStyle = textSecondary;
                ctx.font = "bold 20px Inter, sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(
                  "Drop media here",
                  canvas.width / 2,
                  canvas.height / 2,
                );
                ctx.font = "14px Inter, sans-serif";
                ctx.fillStyle = emptyText;
                ctx.fillText(
                  "Replace this placeholder with your content",
                  canvas.width / 2,
                  canvas.height / 2 + 28,
                );
              }
            }
          }
        } else if (track.type === "graphics") {
          const trackShapeClips = activeShapeClips.filter(
            (sc) => sc.trackId === track.id,
          );
          for (const shapeClip of trackShapeClips) {
            renderShapeClipToCanvas(
              ctx,
              shapeClip,
              canvas.width,
              canvas.height,
              time,
            );
            hasRenderedContent = true;
          }
        } else if (track.type === "text") {
          const trackTextClips = activeTextClips.filter(
            (tc) => tc.trackId === track.id,
          );
          for (const textClip of trackTextClips) {
            renderTextClipToCanvas(
              ctx,
              textClip,
              canvas.width,
              canvas.height,
              time,
            );
            hasRenderedContent = true;
          }
        }
      }

      const audioTracks = timelineTracks.filter(
        (t) => t.type === "audio" && !t.hidden,
      );
      const hasActiveAudioClip = audioTracks.some((track) =>
        track.clips.some(
          (clip) =>
            time >= clip.startTime && time < clip.startTime + clip.duration,
        ),
      );

      if (
        !hasRenderedContent &&
        activeTextClips.length === 0 &&
        activeShapeClips.length === 0 &&
        !hasActiveAudioClip
      ) {
        ctx.fillStyle = emptyText;
        ctx.font = "24px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          "Import media to get started",
          canvas.width / 2,
          canvas.height / 2,
        );
      }
    },
    [
      timelineTracks,
      getMediaItem,
      settings.width,
      settings.height,
      allTextClips,
      allShapeClips,
      isDark,
    ],
  );

  // Check if we can use native video element playback (much faster, hardware-accelerated)
  const canUseNativeVideoPlayback = useCallback(
    (
      startPosition: number,
    ): {
      canUse: boolean;
      clips: Array<{
        clip: (typeof timelineTracks)[0]["clips"][0];
        mediaItem: NonNullable<ReturnType<typeof getMediaItem>>;
      }>;
      imageClips?: Array<{
        clip: (typeof timelineTracks)[0]["clips"][0];
        trackIndex: number;
      }>;
    } => {
      const tracks = timelineTracksRef.current;
      const videoTracks = tracks.filter((t) => t.type === "video" && !t.hidden);

      // Effects/emphasis parity gate. The native fast path draws frames
      // straight to the canvas: it can't run the EffectsBridge pass at all,
      // and it skips emphasis for IMAGE clips. Any still-visible clip
      // carrying a bridge look (video effects / color grading), a
      // clip.effects entry, or an image with an emphasis animation must go
      // through the multi-track compositor — otherwise the user's applied
      // effects show while paused but disappear during playback.
      try {
        const eb = getEffectsBridge();
        for (const track of tracks) {
          if (track.hidden) continue;
          for (const clip of track.clips) {
            if (clip.startTime + clip.duration <= startPosition) continue;
            if ((clip.effects?.length ?? 0) > 0 || eb.hasClipEffects(clip.id)) {
              return { canUse: false, clips: [] };
            }
            // A blend mode needs the compositing path (native <video> draws
            // opaque, no globalCompositeOperation).
            const bm = (clip as { blendMode?: string }).blendMode;
            if (bm && bm !== "normal") {
              return { canUse: false, clips: [] };
            }
            const emph = (clip as any).emphasisAnimation;
            const isImage = getMediaItem(clip.mediaId)?.type === "image";
            if (isImage && emph && emph.type && emph.type !== "none") {
              return { canUse: false, clips: [] };
            }
          }
        }
      } catch { /* bridge unavailable — keep the fast path */ }

      const allVideoClips: Array<{
        clip: (typeof tracks)[0]["clips"][0];
        mediaItem: NonNullable<ReturnType<typeof getMediaItem>>;
      }> = [];
      const speedEngine = getSpeedEngine();

      for (const track of videoTracks) {
        for (const clip of track.clips) {
          if (clip.startTime + clip.duration > startPosition) {
            const mediaItem = getMediaItem(clip.mediaId);
            const hasPlayableSource =
              mediaItem?.blob instanceof Blob ||
              (typeof mediaItem?.originalUrl === "string" &&
                mediaItem.originalUrl.length > 0);

            if (mediaItem?.type === "video" && hasPlayableSource) {
              const clipSpeed = speedEngine.getClipSpeed(clip.id);
              const isReverse = speedEngine.isReverse(clip.id);
              if (clipSpeed !== 1 || isReverse) {
                return { canUse: false, clips: [] };
              }
              allVideoClips.push({ clip, mediaItem });
            }
          }
        }
      }

      if (allVideoClips.length === 0) return { canUse: false, clips: [] };

      allVideoClips.sort((a, b) => a.clip.startTime - b.clip.startTime);

      // Check for overlapping clips (multi-layer) - can't use native playback for compositing
      for (let i = 0; i < allVideoClips.length - 1; i++) {
        const current = allVideoClips[i];
        const next = allVideoClips[i + 1];
        const currentEnd = current.clip.startTime + current.clip.duration;
        if (next.clip.startTime < currentEnd) {
          return { canUse: false, clips: [] };
        }
      }

      // Note: Text/graphics overlays are now supported in native video playback
      // They are rendered using CPU canvas2D after the video frame

      // Collect image clips for background compositing (don't disable native playback).
      // Image MEDIA also lands on video-type tracks (drag-drop, agent auto-placement);
      // those clips are skipped by the video collector above (media-type check), so
      // classify by media type here too or they render black during playback.
      const imageClips: Array<{
        clip: (typeof tracks)[0]["clips"][0];
        trackIndex: number;
      }> = [];
      tracks.forEach((track) => {
        if (track.hidden) return;
        if (track.type !== "image" && track.type !== "video") return;
        const trackIndex = tracks.indexOf(track);
        for (const clip of track.clips) {
          if (
            track.type === "image" ||
            getMediaItem(clip.mediaId)?.type === "image"
          ) {
            imageClips.push({ clip, trackIndex });
          }
        }
      });

      return { canUse: true, clips: allVideoClips, imageClips };
    },
    [getMediaItem],
  );

  // Start native video playback using hardware-accelerated video elements (handles multiple clips)
  const startNativeVideoPlayback = useCallback(
    async (
      clips: Array<{
        clip: (typeof timelineTracks)[0]["clips"][0];
        mediaItem: NonNullable<ReturnType<typeof getMediaItem>>;
      }>,
      imageClips: Array<{
        clip: (typeof timelineTracks)[0]["clips"][0];
        trackIndex: number;
      }>,
      startPosition: number,
      onEnd: () => void,
    ): Promise<() => void> => {
      const canvas = canvasRef.current;
      if (!canvas || clips.length === 0) {
        onEnd();
        return () => {};
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        onEnd();
        return () => {};
      }

      nativePlaybackActiveRef.current = true;

      const imageBitmapCache = new Map<string, ImageBitmap>();
      for (const { clip } of imageClips) {
        const mediaItem = getMediaItem(clip.mediaId);
        const mediaBlob = await resolveMediaBlob(mediaItem);
        if (mediaItem?.type === "image" && mediaBlob) {
          try {
            const bitmap = await createImageBitmap(mediaBlob);
            imageBitmapCache.set(clip.id, bitmap);
          } catch (error) {
            console.warn(`Failed to cache image bitmap for ${clip.id}:`, error);
          }
        }
      }

      await preDecodeAllAudioBuffers();

      const videoCache = new Map<
        string,
        { video: HTMLVideoElement; url: string }
      >();
      const loadPromises: Promise<void>[] = [];

      for (const { clip, mediaItem } of clips) {
        if (!videoCache.has(clip.mediaId)) {
          const mediaBlob = await resolveMediaBlob(mediaItem);
          // Fallback to a proxy-routed remote URL when the blob fetch
          // returned null (CORS / 404 / 0 bytes). The element decoder
          // will at least play the audio; without the rewrite the
          // direct cross-origin URL hits the same CORS wall.
          const url = mediaBlob
            ? URL.createObjectURL(mediaBlob)
            : rewriteToProxy(mediaItem.originalUrl || "") || "";
          if (!url) continue;

          const video = document.createElement("video");
          video.src = url;
          video.muted = true;
          video.playsInline = true;
          video.preload = "auto";
          video.crossOrigin = "anonymous";

          videoCache.set(clip.mediaId, { video, url });

          loadPromises.push(
            new Promise<void>((resolve, reject) => {
              video.onloadedmetadata = () => resolve();
              video.onerror = () =>
                reject(new Error(`Video load failed for ${clip.mediaId}`));
              setTimeout(() => resolve(), 5000); // Don't fail on timeout, just continue
            }),
          );
        }
      }

      await Promise.all(loadPromises);

      const masterClock = getMasterClock();
      masterClock.setDuration(actualEndTime);
      masterClock.seek(startPosition);

      if (!audioGraphRef.current) {
        audioGraphRef.current = getRealtimeAudioGraph();
      }
      const audioGraph = audioGraphRef.current;
      audioGraph.setPreviewMuted(isMuted);

      const tracksWithAudio = timelineTracksRef.current.filter(
        (t) => (t.type === "audio" || t.type === "video") && !t.hidden,
      );
      for (const audioTrack of tracksWithAudio) {
        audioGraph.createTrack({
          trackId: audioTrack.id,
          volume: 1,
          pan: 0,
          muted: audioTrack.muted || false,
          solo: audioTrack.solo || false,
          effects: [],
        });
      }

      await audioGraph.resume();
      audioGraph.seekTo(startPosition);
      await masterClock.play();
      // ONE schedule builder for every playback path. This inline builder
      // used to hardcode volume:1 and drop volume keyframes + fades — so on
      // the native fast path (any plain video clip) the timeline's volume
      // line was silently ignored, live AND after pause+replay.
      // getAudioClipsForScheduler reads clip.volume, the native "volume"
      // keyframes, fades, audio effects, and honors track mute.
      audioGraph.startScheduler(getAudioClipsForScheduler);

      let isActive = true;
      let rafId: number | null = null;
      let currentClipId: string | null = null;

      const findClipAtTime = (time: number) => {
        for (const { clip, mediaItem } of clips) {
          if (time >= clip.startTime && time < clip.startTime + clip.duration) {
            return { clip, mediaItem };
          }
        }
        return null;
      };

      const drawFrameBody = async () => {
        if (!isActive || !nativePlaybackActiveRef.current) return;

        const currentPlayhead = masterClock.currentTime;

        // ── RAM cache: hit path for native playback ──
        const _nfn = Math.round(currentPlayhead * 30);
        ramCacheRef.current.setAnchor(_nfn);
        const _ncached = ramCacheRef.current.get(_nfn);
        if (_ncached) {
          ctx.drawImage(_ncached, 0, 0, canvas.width, canvas.height);
          const _nph = performance.now();
          if (_nph - lastPlayheadUpdateRef.current >= PLAYHEAD_UPDATE_THROTTLE_MS) {
            lastPlayheadUpdateRef.current = _nph;
            setPlayheadPosition(currentPlayhead);
          }
          rafId = requestAnimationFrame(() => { drawFrame(); });
          return;
        }

        if (currentPlayhead >= actualEndTime) {
          cleanup();
          const _endRange = ramCacheRef.current.getCachedRange();
          setRamCacheCount(_endRange.length);
          setRamCacheState(_endRange, Math.ceil(actualEndTime * 30));
          setPlayheadPosition(0);
          startPositionRef.current = 0;
          onEnd();
          return;
        }

        if (!masterClock.isPlaying) {
          cleanup();
          if (!isScrubbingRef.current) {
            onEnd();
          }
          return;
        }

        const activeClip = findClipAtTime(currentPlayhead);

        if (!activeClip) {
          ctx.fillStyle = "#000000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const sortedImageClipsNoVideo = [...imageClips].sort(
            (a, b) => b.trackIndex - a.trackIndex,
          );
          for (const { clip: imgClip } of sortedImageClipsNoVideo) {
            if (
              currentPlayhead >= imgClip.startTime &&
              currentPlayhead < imgClip.startTime + imgClip.duration
            ) {
              const bitmap = imageBitmapCache.get(imgClip.id);
              if (bitmap) {
                const latestImgClip = (() => {
                  for (const track of timelineTracksRef.current) {
                    const found = track.clips.find((c) => c.id === imgClip.id);
                    if (found) return found;
                  }
                  return imgClip;
                })();
                const imgClipLocalTime = currentPlayhead - imgClip.startTime;
                const imgTransform = getAnimatedTransform(
                  (latestImgClip.transform as ClipTransform) || DEFAULT_TRANSFORM,
                  latestImgClip.keyframes,
                  imgClipLocalTime,
                );
                drawFrameWithTransform(
                  ctx,
                  bitmap,
                  imgTransform,
                  canvas.width,
                  canvas.height,
                );
              }
            }
          }

          const activeShapeClipsNoVideo = getActiveShapeClips(
            allShapeClipsRef.current,
            currentPlayhead,
          );
          const activeTextClipsNoVideo = getActiveTextClips(
            allTextClipsRef.current,
            currentPlayhead,
          );

          if (activeShapeClipsNoVideo.length > 0 || activeTextClipsNoVideo.length > 0) {
            renderOverlayClipsInTrackOrder(
              ctx,
              timelineTracksRef.current,
              activeShapeClipsNoVideo,
              activeTextClipsNoVideo,
              currentPlayhead,
              canvas.width,
              canvas.height,
              "all",
            );
          }

          const nowNoClip = performance.now();
          if (nowNoClip - lastPlayheadUpdateRef.current >= PLAYHEAD_UPDATE_THROTTLE_MS) {
            lastPlayheadUpdateRef.current = nowNoClip;
            setPlayheadPosition(currentPlayhead);
          }
          rafId = requestAnimationFrame(() => { drawFrame(); });
          return;
        }

        const { clip } = activeClip;
        const cached = videoCache.get(clip.mediaId);

        if (!cached) {
          const nowNoCached = performance.now();
          if (nowNoCached - lastPlayheadUpdateRef.current >= PLAYHEAD_UPDATE_THROTTLE_MS) {
            lastPlayheadUpdateRef.current = nowNoCached;
            setPlayheadPosition(currentPlayhead);
          }
          rafId = requestAnimationFrame(() => { drawFrame(); });
          return;
        }

        const { video } = cached;

        const clipLocalTime = currentPlayhead - clip.startTime;
        const targetMediaTime = (clip.inPoint || 0) + clipLocalTime;

        if (currentClipId !== clip.id) {
          currentClipId = clip.id;
          // Pause every OTHER scene video so only ONE decoder runs at a time.
          // Previously outgoing clips kept decoding for the whole timeline →
          // escalating GPU/CPU contention → growing drift → constant re-seeks
          // → progressively worse glitching. (RC3)
          for (const [mid, c] of videoCache) {
            if (mid !== clip.mediaId && !c.video.paused) {
              try { c.video.pause(); } catch { /* noop */ }
            }
          }
          // Seek the incoming clip to its in-point so its first drawn frame is
          // correct (the readiness guard below skips drawing until the seek
          // resolves, so no stale frame leaks).
          if (Math.abs(video.currentTime - targetMediaTime) > 0.15) {
            try { video.currentTime = targetMediaTime; } catch { /* noop */ }
          }
          if (video.paused) video.play().catch(() => {});
        }

        // Ongoing drift correction — LOOSE. Hard-seeking on every >0.1s drift
        // (the old value) fought the element's own decode clock every frame,
        // and each seek blanks/stales the frame. Only correct a real
        // divergence, and never seek while a seek is already in flight. (RC2)
        const drift = Math.abs(video.currentTime - targetMediaTime);
        if (drift > 0.4 && !video.seeking) {
          try { video.currentTime = targetMediaTime; } catch { /* noop */ }
        }

        // READINESS GUARD (RC1): drawing a <video> that isn't decode-ready
        // (mid-seek, or only HAVE_METADATA at a fresh boundary) is a silent
        // no-op → the black fillRect below is what showed = black flashes +
        // random stale frames. If it's not ready, DON'T repaint — leave the
        // last good composite on screen (paused frame / previous frame),
        // advance the playhead, and try again next frame. Also means unready
        // frames are never captured into the RAM cache (they'd bake in).
        const videoReady =
          video.readyState >= 2 /* HAVE_CURRENT_DATA */ &&
          !video.seeking &&
          video.videoWidth > 0;
        if (!videoReady) {
          const nowP = performance.now();
          if (nowP - lastPlayheadUpdateRef.current >= PLAYHEAD_UPDATE_THROTTLE_MS) {
            lastPlayheadUpdateRef.current = nowP;
            setPlayheadPosition(currentPlayhead);
          }
          rafId = requestAnimationFrame(() => { drawFrame(); });
          return;
        }

        const latestClip = (() => {
          for (const track of timelineTracksRef.current) {
            const found = track.clips.find((c) => c.id === clip.id);
            if (found) return found;
          }
          return clip;
        })();

        let transform = getAnimatedTransform(
          (latestClip.transform as ClipTransform) || DEFAULT_TRANSFORM,
          latestClip.keyframes,
          clipLocalTime,
        );

        if (latestClip.emphasisAnimation && latestClip.emphasisAnimation.type !== "none") {
          const emphasisState = applyEmphasisAnimation(
            latestClip.emphasisAnimation,
            clipLocalTime,
          );
          transform = {
            ...transform,
            opacity: transform.opacity * emphasisState.opacity,
            scale: {
              x: transform.scale.x * emphasisState.scale * emphasisState.scaleX,
              y: transform.scale.y * emphasisState.scale * emphasisState.scaleY,
            },
            position: {
              x: transform.position.x + emphasisState.offsetX * canvas.width,
              y: transform.position.y + emphasisState.offsetY * canvas.height,
            },
            rotation: transform.rotation + emphasisState.rotation,
          };
        }

        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Sort by track index descending (higher index = background = render first)
        const sortedImageClips = [...imageClips].sort(
          (a, b) => b.trackIndex - a.trackIndex,
        );
        for (const { clip: imgClip } of sortedImageClips) {
          if (
            currentPlayhead >= imgClip.startTime &&
            currentPlayhead < imgClip.startTime + imgClip.duration
          ) {
            const bitmap = imageBitmapCache.get(imgClip.id);
            if (bitmap) {
              const latestImgClip = (() => {
                for (const track of timelineTracksRef.current) {
                  const found = track.clips.find((c) => c.id === imgClip.id);
                  if (found) return found;
                }
                return imgClip;
              })();
              const imgClipLocalTime = currentPlayhead - imgClip.startTime;
              const imgTransform = getAnimatedTransform(
                (latestImgClip.transform as ClipTransform) || DEFAULT_TRANSFORM,
                latestImgClip.keyframes,
                imgClipLocalTime,
              );
              drawFrameWithTransform(
                ctx,
                bitmap,
                imgTransform,
                canvas.width,
                canvas.height,
              );
            }
          }
        }

        const allShapeClipsData = allShapeClipsRef.current;
        const activeShapeClips = getActiveShapeClips(
          allShapeClipsData,
          currentPlayhead,
        );
        const activeTextClips = getActiveTextClips(
          allTextClipsRef.current,
          currentPlayhead,
        );

        drawFrameWithTransform(ctx, video, transform, canvas.width, canvas.height);

        // Use CPU canvas2D for all overlays - more reliable than GPU compositing
        // Render all text/graphics overlays (they're above the video since backgrounds are separate)
        if (activeShapeClips.length > 0 || activeTextClips.length > 0) {
          renderOverlayClipsInTrackOrder(
            ctx,
            timelineTracksRef.current,
            activeShapeClips,
            activeTextClips,
            currentPlayhead,
            canvas.width,
            canvas.height,
            "all",
          );
        }

        // ── RAM cache: store frame from native playback ──
        const _sfn = Math.round(currentPlayhead * 30);
        try {
          const _id = ctx.getImageData(0, 0, canvas.width, canvas.height);
          createImageBitmap(_id).then((bmp) => {
            ramCacheRef.current.set(_sfn, bmp);
            if (_sfn % 30 === 0) {
              const range = ramCacheRef.current.getCachedRange();
              setRamCacheState(range, Math.ceil(actualEndTime * 30));
              setRamCacheCount(range.length);
            }
          }).catch(() => {});
        } catch {}

        const nowPlayhead = performance.now();
        if (nowPlayhead - lastPlayheadUpdateRef.current >= PLAYHEAD_UPDATE_THROTTLE_MS) {
          lastPlayheadUpdateRef.current = nowPlayhead;
          setPlayheadPosition(currentPlayhead);
        }

        rafId = requestAnimationFrame(() => {
          drawFrame();
        });
      };

      // Loop-survival wrapper. drawFrameBody self-reschedules at its END, so
      // any throw inside it used to kill the RAF chain silently (no pause, no
      // cleanup) — the canvas froze on the last frame, which is pure #000000
      // whenever the playhead sat in a gap. One bad frame must not kill the
      // only scheduler: retry a bounded number of consecutive failures, then
      // stop playback CLEANLY (same path as the masterClock-stopped exit) so
      // the paused renderer takes the canvas back.
      let consecutiveFrameErrors = 0;
      const drawFrame = async () => {
        try {
          await drawFrameBody();
          consecutiveFrameErrors = 0;
        } catch (e) {
          consecutiveFrameErrors += 1;
          if (
            consecutiveFrameErrors <= 30 &&
            isActive &&
            nativePlaybackActiveRef.current
          ) {
            console.warn("[Preview] native frame failed (retrying):", e);
            rafId = requestAnimationFrame(() => { drawFrame(); });
          } else {
            console.warn("[Preview] native playback stopped after repeated frame errors:", e);
            cleanup();
            if (!isScrubbingRef.current) onEnd();
          }
        }
      };

      const cleanup = () => {
        isActive = false;
        nativePlaybackActiveRef.current = false;
        if (rafId) cancelAnimationFrame(rafId);

        for (const [, { video, url }] of videoCache) {
          video.pause();
          video.src = "";
          if (url.startsWith("blob:")) {
            URL.revokeObjectURL(url);
          }
        }
        videoCache.clear();

        for (const [, bitmap] of imageBitmapCache) {
          bitmap.close();
        }
        imageBitmapCache.clear();

        videoElementRef.current = null;
        currentVideoMediaIdRef.current = null;
        masterClock.stop();
        audioGraph.stopScheduler();
      };

      rafId = requestAnimationFrame(() => { drawFrame(); });

      return cleanup;
    },
    [
      actualEndTime,
      getMediaItem,
      isMuted,
      preDecodeAllAudioBuffers,
      setPlayheadPosition,
    ],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    if (canvas.width === 0 || canvas.height === 0) {
      canvas.width = settings.width;
      canvas.height = settings.height;
    }

    if (!isPlaying) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      cleanupPlaybackResources();
      cleanupAudioResources();
      return;
    }

    if (actualEndTime <= 0) {
      pause();
      return;
    }

    frameDropCountRef.current = 0;
    frameTotalCountRef.current = 0;

    let isActive = true;
    let nativeCleanup: (() => void) | null = null;
    const playbackStartPosition = startPositionRef.current;

    const findAllClipsAtTime = (time: number) => {
      const tracks = timelineTracksRef.current;
      const results: Array<{
        clip: (typeof tracks)[0]["clips"][0];
        track: (typeof tracks)[0];
        trackIndex: number;
      }> = [];

      tracks.forEach((track, originalIndex) => {
        if (
          (track.type === "video" || track.type === "image") &&
          !track.hidden
        ) {
          for (const clip of track.clips) {
            if (
              time >= clip.startTime &&
              time < clip.startTime + clip.duration
            ) {
              results.push({ clip, track, trackIndex: originalIndex });
            }
          }
        }
      });

      return results.sort((a, b) => a.trackIndex - b.trackIndex);
    };

    const initClipResources = async (
      clip: (typeof timelineTracksRef.current)[0]["clips"][0],
      trackIndex: number,
    ) => {
      const mediaItem = getMediaItem(clip.mediaId);
      if (!mediaItem) {
        return null;
      }

      // Images don't need MediaBunny resources - they're rendered directly via createImageBitmap
      if (mediaItem.type === "image") {
        return null;
      }

      const blob = await resolveMediaBlob(mediaItem);
      if (!blob) {
        return null;
      }

      try {
        const mediabunny = await import("mediabunny");
        const { Input, ALL_FORMATS, BlobSource, CanvasSink } = mediabunny;

        const input = new Input({
          source: new BlobSource(blob),
          formats: ALL_FORMATS,
        });

        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) {
          input[Symbol.dispose]?.();
          return null;
        }

        const canDecode = await videoTrack.canDecode();
        if (!canDecode) {
          input[Symbol.dispose]?.();
          return null;
        }

        // Decode at the PLAYBACK scale, not full project res — playback is
        // upscaled from a smaller composite anyway (paused renders stay
        // full-res via a separate path), and smaller decode = faster seeks,
        // cheaper createImageBitmap, snappier boundaries.
        const s = playbackScaleRef.current || 1;
        const sinkWidth = Math.max(2, Math.round((settings.width || 1920) * s));
        const sinkHeight = Math.max(2, Math.round((settings.height || 1080) * s));
        const sink = new CanvasSink(videoTrack, {
          width: sinkWidth,
          height: sinkHeight,
          fit: "contain",
          poolSize: getAdaptivePoolSize(sinkWidth, sinkHeight),
        });

        return {
          input,
          sink,
          mediaId: clip.mediaId,
          clipId: clip.id,
          trackIndex,
        };
      } catch (error) {
        console.error(
          `[Preview] Failed to init resources for clip ${clip.id}:`,
          error,
        );
        return null;
      }
    };

    const preCacheAllImageBitmaps = async () => {
      const tracks = timelineTracksRef.current;
      // Video-type tracks can hold image MEDIA too — the per-clip media-type
      // check below keeps real videos out of the bitmap cache.
      const imageTracks = tracks.filter(
        (t) => (t.type === "image" || t.type === "video") && !t.hidden,
      );

      // Resolve + decode in PARALLEL so a slideshow of many stills (imported
      // AE templates place 16+ placeholder/photo frames) is ready fast.
      const jobs: Promise<void>[] = [];
      for (const track of imageTracks) {
        for (const clip of track.clips) {
          if (imageBitmapCacheRef.current.has(clip.id)) continue;
          const mediaItem = getMediaItem(clip.mediaId);
          if (mediaItem?.type !== "image") continue;
          jobs.push(
            (async () => {
              try {
                // resolveMediaBlob FETCHES from originalUrl when the blob
                // isn't resident — imported / local-asset media has a URL
                // but often no in-memory blob, so the old blob-only check
                // skipped them and they rendered BLACK.
                const blob = await resolveMediaBlob(mediaItem);
                if (!blob) return;
                const bitmap = await decodeImageFittedToCanvas(
                  blob,
                  canvas.width,
                  canvas.height,
                );
                imageBitmapCacheRef.current.set(clip.id, bitmap);
              } catch (error) {
                console.warn(
                  `[Preview] Failed to pre-cache image clip ${clip.id}:`,
                  error,
                );
              }
            })(),
          );
        }
      }
      await Promise.all(jobs);
    };

    const startMultiTrackPlayback = async () => {
      const initialClips = findAllClipsAtTime(playbackStartPosition);
      const activeTextClips = getActiveTextClips(
        allTextClipsRef.current,
        playbackStartPosition,
      );
      const activeShapeClips = getActiveShapeClips(
        allShapeClipsRef.current,
        playbackStartPosition,
      );

      const audioTracks = timelineTracksRef.current.filter(
        (t) => t.type === "audio" && !t.hidden,
      );
      const hasActiveAudioClip = audioTracks.some((track) =>
        track.clips.some(
          (clip) =>
            playbackStartPosition >= clip.startTime &&
            playbackStartPosition < clip.startTime + clip.duration,
        ),
      );

      const hasAnyVisualContent =
        initialClips.length > 0 ||
        activeTextClips.length > 0 ||
        activeShapeClips.length > 0;
      const hasAnyContent = hasAnyVisualContent || hasActiveAudioClip;

      if (!hasAnyContent && actualEndTime <= 0) {
        pause();
        return;
      }

      await preCacheAllImageBitmaps();

      for (const { clip, trackIndex } of initialClips) {
        if (!playbackResourcesRef.current.has(clip.id)) {
          const resources = await initClipResources(clip, trackIndex);
          if (resources) {
            playbackResourcesRef.current.set(clip.id, resources);
          }
        }
      }

      const hasTextOrShapeContent =
        activeTextClips.length > 0 || activeShapeClips.length > 0;
      if (
        playbackResourcesRef.current.size === 0 &&
        !hasTextOrShapeContent &&
        !hasActiveAudioClip &&
        actualEndTime <= 0
      ) {
        pause();
        return;
      }

      await preDecodeAllAudioBuffers();

      if (!audioGraphRef.current) {
        audioGraphRef.current = getRealtimeAudioGraph();
      }
      const audioGraph = audioGraphRef.current;
      audioGraph.setPreviewMuted(isMuted);

      const tracksWithAudio = timelineTracksRef.current.filter(
        (t) => (t.type === "audio" || t.type === "video") && !t.hidden,
      );
      for (const track of tracksWithAudio) {
        audioGraph.createTrack({
          trackId: track.id,
          volume: 1,
          pan: 0,
          muted: track.muted || false,
          solo: track.solo || false,
          effects: [],
        });
      }

      await audioGraph.resume();

      const mainCtx = canvas.getContext("2d");
      if (!mainCtx) {
        console.error("[Preview] Failed to get 2D context");
        pause();
        return;
      }

      // ── Playback render scale ─────────────────────────────────────────
      // Composite at a REDUCED resolution during playback and upscale the
      // blit — the paused/scrub renderer stays full-res so stills are crisp.
      // This finally consumes the Preview Quality gauge ("auto" = 0.5);
      // it also drives decode dims in initClipResources.
      const previewScale = Math.max(
        0.125,
        Math.min(1, useTimelineStore.getState().getPreviewScale() || 0.5),
      );
      playbackScaleRef.current = previewScale;
      if (lastPlaybackScaleRef.current !== previewScale) {
        // Cached frames from a previous playback are at a different
        // resolution — mixing them with fresh frames would shimmer.
        try { ramCacheRef.current.invalidate(); } catch { /* cache optional */ }
        lastPlaybackScaleRef.current = previewScale;
      }
      const offW = Math.max(2, Math.round(canvas.width * previewScale));
      const offH = Math.max(2, Math.round(canvas.height * previewScale));
      if (
        !offscreenCanvasRef.current ||
        offscreenCanvasRef.current.width !== offW ||
        offscreenCanvasRef.current.height !== offH
      ) {
        offscreenCanvasRef.current = new OffscreenCanvas(offW, offH);
        offscreenCtxRef.current = offscreenCanvasRef.current.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
      }
      // Bind LOCALS for the whole playback run: the ResizeObserver can swap
      // offscreenCanvasRef mid-play (panel resize), which would silently
      // split "canvas we draw into" from "canvas we blit from".
      const offscreen = offscreenCanvasRef.current;

      // ── Non-blocking decoder init (the clip-boundary glitch fix) ──────
      // Awaiting initClipResources INSIDE the frame loop stalled a visible
      // frame at every clip boundary (demux open + decoder configure on the
      // critical path — the "video glitches at audio boundaries" report:
      // scenes start a video clip and its audio cue together). Init now runs
      // in the background, and a lookahead prewarms decoders BEFORE the
      // playhead reaches them, so boundaries cost nothing.
      const initInFlight = new Map<string, Promise<void>>();
      const kickInitClip = (
        clip: Parameters<typeof initClipResources>[0],
        trackIndex: number,
      ) => {
        if (playbackResourcesRef.current.has(clip.id) || initInFlight.has(clip.id)) return;
        if (getMediaItem(clip.mediaId)?.type !== "video") return; // images use the bitmap cache
        const p = initClipResources(clip, trackIndex)
          .then((res) => {
            if (!res) return;
            if (isActive) playbackResourcesRef.current.set(clip.id, res);
            else res.input[Symbol.dispose]?.();
          })
          .catch(() => { /* clip skips frames until retried */ })
          .finally(() => { initInFlight.delete(clip.id); });
        initInFlight.set(clip.id, p);
      };
      const PREWARM_SEC = 2;

      const ctx = offscreenCtxRef.current as unknown as CanvasRenderingContext2D;
      if (!ctx) {
        console.error("[Preview] Failed to get offscreen 2D context");
        pause();
        return;
      }

      const masterClock = getMasterClock();
      masterClock.setDuration(actualEndTime);
      masterClock.seek(playbackStartPosition);

      audioGraph.seekTo(playbackStartPosition);
      await masterClock.play();
      audioGraph.startScheduler(getAudioClipsForScheduler);

      const frameDuration = 1000 / 30;
      let lastFrameTimestamp = performance.now();
      let frameCount = 0;
      let isProcessingFrame = false;
      // Frame generation + deadline power the hung-frame watchdog. Each
      // frame takes a generation; the watchdog bumps it to invalidate a
      // stuck frame so the resumed decode can't double-schedule the loop.
      let frameGen = 0;
      let frameStartedAt = 0;
      const FRAME_HANG_MS = 3000;

      if (frameWatchdogRef.current) clearInterval(frameWatchdogRef.current);
      frameWatchdogRef.current = setInterval(() => {
        if (!isActive) return;
        if (isProcessingFrame && performance.now() - frameStartedAt > FRAME_HANG_MS) {
          // A decode hung. Invalidate the stuck frame + restart the loop
          // so playback keeps moving instead of freezing on one frame.
          console.warn("[Preview] frame watchdog: decode hung, skipping frame");
          frameGen++;
          isProcessingFrame = false;
          if (masterClock.isPlaying) {
            animationRef.current = requestAnimationFrame(processMultiTrackFrame);
          }
        }
      }, 750);

      const processMultiTrackFrame = async () => {
        if (!isActive) {
          cleanupPlaybackResources();
          masterClock.pause();
          return;
        }

        if (isProcessingFrame) {
          return;
        }
        isProcessingFrame = true;
        const myGen = ++frameGen;
        frameStartedAt = performance.now();

        const currentPlayhead = masterClock.currentTime;

        // ── RAM cache: hit path for multi-track playback ──
        const _mfn = Math.round(currentPlayhead * 30);
        ramCacheRef.current.setAnchor(_mfn);
        const _mcached = ramCacheRef.current.get(_mfn);
        if (_mcached) {
          const mainCanvas = canvasRef.current;
          const mainCtx = mainCanvas?.getContext('2d');
          if (mainCanvas && mainCtx) {
            mainCtx.drawImage(_mcached, 0, 0, mainCanvas.width, mainCanvas.height);
          }
          masterClock.reportVideoTime(currentPlayhead);
          const _mph = performance.now();
          if (_mph - lastPlayheadUpdateRef.current >= PLAYHEAD_UPDATE_THROTTLE_MS) {
            lastPlayheadUpdateRef.current = _mph;
            setPlayheadPosition(currentPlayhead);
          }
          if (myGen !== frameGen) return; // superseded by watchdog — abandon
          isProcessingFrame = false;
          if (isActive) animationRef.current = requestAnimationFrame(processMultiTrackFrame);
          return;
        }

        try {
          if (currentPlayhead >= actualEndTime) {
            isProcessingFrame = false;
            cleanupPlaybackResources();
            cleanupAudioResources();
            masterClock.stop();
            const _endRange = ramCacheRef.current.getCachedRange();
            setRamCacheCount(_endRange.length);
            setRamCacheState(_endRange, Math.ceil(actualEndTime * 30));
            setPlayheadPosition(0);
            startPositionRef.current = 0;
            pause();
            return;
          }

          if (!masterClock.isPlaying) {
            isProcessingFrame = false;
            cleanupPlaybackResources();
            cleanupAudioResources();
            if (!isScrubbingRef.current) {
              pause();
            }
            return;
          }

          const activeClips = findAllClipsAtTime(currentPlayhead);
          const currentTextClips = getActiveTextClips(
            allTextClipsRef.current,
            currentPlayhead,
          );
          const currentShapeClips = getActiveShapeClips(
            allShapeClipsRef.current,
            currentPlayhead,
          );

          const audioTracksForFrame = timelineTracksRef.current.filter(
            (t) => t.type === "audio" && !t.hidden,
          );
          const hasCurrentAudioClip = audioTracksForFrame.some((track) =>
            track.clips.some(
              (clip) =>
                currentPlayhead >= clip.startTime &&
                currentPlayhead < clip.startTime + clip.duration,
            ),
          );

          const hasVisualContent =
            activeClips.length > 0 ||
            currentTextClips.length > 0 ||
            currentShapeClips.length > 0;
          const hasAnyContentAtPlayhead =
            hasVisualContent || hasCurrentAudioClip;

          if (!hasAnyContentAtPlayhead) {
            const nextClipTime = findNextClipStartTime(currentPlayhead);
            const nextTextTime = findNextTextClipStartTime(currentPlayhead);
            const nextShapeTime = findNextShapeClipStartTime(currentPlayhead);
            const nextAudioTime = findNextAudioClipStartTime(currentPlayhead);

            const nextTimes = [
              nextClipTime,
              nextTextTime,
              nextShapeTime,
              nextAudioTime,
            ].filter((t): t is number => t !== null && t < actualEndTime);
            const nextTime =
              nextTimes.length > 0 ? Math.min(...nextTimes) : null;

            if (nextTime !== null) {
              masterClock.seek(nextTime);
              audioGraph.seekTo(nextTime);
              isProcessingFrame = false;
              animationRef.current = requestAnimationFrame(
                processMultiTrackFrame,
              );
              return;
            } else {
              isProcessingFrame = false;
              cleanupPlaybackResources();
              cleanupAudioResources();
              if (!isScrubbingRef.current) {
                masterClock.stop();
                setPlayheadPosition(0);
                startPositionRef.current = 0;
                pause();
              }
              return;
            }
          }

          // Fire — never await — init for clips that just became active.
          for (const { clip, trackIndex } of activeClips) {
            kickInitClip(clip, trackIndex);
          }

          // Prewarm decoders for clips STARTING within the lookahead window
          // so they're ready before the playhead arrives.
          const upcomingClipIds = new Set<string>();
          {
            const allTracks = timelineTracksRef.current;
            for (let ti = 0; ti < allTracks.length; ti++) {
              const t = allTracks[ti];
              if ((t.type !== "video" && t.type !== "image") || t.hidden) continue;
              for (const c of t.clips) {
                if (
                  c.startTime > currentPlayhead &&
                  c.startTime <= currentPlayhead + PREWARM_SEC
                ) {
                  upcomingClipIds.add(c.id);
                  kickInitClip(c, ti);
                }
              }
            }
          }

          const activeClipIds = new Set(activeClips.map((c) => c.clip.id));
          for (const [clipId, resources] of playbackResourcesRef.current) {
            // Keep prewarmed upcoming clips — disposing them here would undo
            // the lookahead and re-pay the init at the boundary.
            if (!activeClipIds.has(clipId) && !upcomingClipIds.has(clipId)) {
              resources.input[Symbol.dispose]?.();
              playbackResourcesRef.current.delete(clipId);
            }
          }

          const sortedClips = [...activeClips].sort(
            (a, b) => b.trackIndex - a.trackIndex,
          );

          const imageClipFrames: Array<{
            clip: (typeof sortedClips)[0]["clip"];
            transform: ClipTransform;
            frame: ImageBitmap;
          }> = [];

          const videoClipPromises: Array<
            Promise<{
              clip: (typeof sortedClips)[0]["clip"];
              transform: ClipTransform;
              frame: ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
            } | null>
          > = [];

          for (const { clip, track } of sortedClips) {
            if (!isActive) continue;

            const clipLocalTime = currentPlayhead - clip.startTime;

            let transform = getAnimatedTransform(
              (clip.transform as ClipTransform) || DEFAULT_TRANSFORM,
              clip.keyframes,
              clipLocalTime,
            );

            if (
              clip.emphasisAnimation &&
              clip.emphasisAnimation.type !== "none"
            ) {
              const emphasisState = applyEmphasisAnimation(
                clip.emphasisAnimation,
                clipLocalTime,
              );
              transform = {
                ...transform,
                opacity: transform.opacity * emphasisState.opacity,
                scale: {
                  x:
                    transform.scale.x *
                    emphasisState.scale *
                    emphasisState.scaleX,
                  y:
                    transform.scale.y *
                    emphasisState.scale *
                    emphasisState.scaleY,
                },
                position: {
                  x:
                    transform.position.x + emphasisState.offsetX * canvas.width,
                  y:
                    transform.position.y +
                    emphasisState.offsetY * canvas.height,
                },
                rotation: transform.rotation + emphasisState.rotation,
              };
            }

            const isImageMedia =
              track.type === "image" ||
              getMediaItem(clip.mediaId)?.type === "image";
            if (isImageMedia) {
              const cachedBitmap = imageBitmapCacheRef.current.get(clip.id);
              if (cachedBitmap) {
                // IMAGE clips must get the effects pass too — this branch
                // used to push the raw bitmap, so brightness/contrast/
                // grading applied to an image showed while PAUSED (path A
                // runs applyEffectsToFrame unconditionally) but vanished
                // the moment playback started.
                let imgFrame: ImageBitmap | HTMLCanvasElement | OffscreenCanvas = cachedBitmap;
                try {
                  if (getEffectsBridge().hasClipEffects(clip.id) || (clip.effects?.length ?? 0) > 0) {
                    imgFrame = await applyEffectsToFrame(clip.id, cachedBitmap);
                  }
                } catch { /* effects pass failed — show the raw frame */ }
                imageClipFrames.push({ clip, transform, frame: imgFrame });
              } else if (!imageDecodeInFlightRef.current.has(clip.id)) {
                // Not cached yet (pre-cache raced / fetch failed / clip added
                // mid-play). Resolve in the background so it fills in on a
                // later frame instead of staying a black hole.
                imageDecodeInFlightRef.current.add(clip.id);
                const mi = getMediaItem(clip.mediaId);
                void (async () => {
                  try {
                    const blob = await resolveMediaBlob(mi);
                    if (blob) {
                      const bmp = await decodeImageFittedToCanvas(blob, canvas.width, canvas.height);
                      imageBitmapCacheRef.current.set(clip.id, bmp);
                    }
                  } catch { /* try again next tick */ }
                  finally { imageDecodeInFlightRef.current.delete(clip.id); }
                })();
              }
              continue;
            }

            videoClipPromises.push(
              (async () => {
                const resources = playbackResourcesRef.current.get(clip.id);
                if (!resources) return null;

                const speedEngine = getSpeedEngine();
                const adjustedLocalTime =
                  speedEngine.getSourceTimeAtPlaybackTime(
                    clip.id,
                    clipLocalTime,
                  );
                const mediaTime = (clip.inPoint || 0) + adjustedLocalTime;

                // A decode miss must not drop this clip's layer for a frame
                // (one-frame flicker) — fall back to the clip's LAST frame.
                const heldFrame = () => {
                  const held = lastClipFrameRef.current.get(clip.id);
                  return held ? { clip, transform, frame: held } : null;
                };

                try {
                  // Await the real decoded frame (no artificial timeout). An
                  // earlier 50ms race abandoned slow decodes and returned a
                  // STALE held frame, which made one blend layer visibly FREEZE
                  // while the other advanced. Awaiting keeps both layers in
                  // sync (frame-correct); a genuinely hung decode is still
                  // caught by the frame watchdog. Real smoothness comes from
                  // read-ahead buffering (planned), not from dropping frames.
                  const frameResult = await (
                    resources.sink as {
                      getCanvas: (time: number) => Promise<{
                        canvas: HTMLCanvasElement | OffscreenCanvas;
                        timestamp: number;
                        duration: number;
                      } | null>;
                    }
                  ).getCanvas(mediaTime);

                  if (!isActive) return null;

                  if (frameResult?.canvas) {
                    let processedFrame:
                      | ImageBitmap
                      | HTMLCanvasElement
                      | OffscreenCanvas = frameResult.canvas;

                    try {
                      const frameBitmap = await createImageBitmap(
                        frameResult.canvas,
                      );
                      // Same dual check as path C — bridge-stored looks
                      // never populate clip.effects.
                      const clipHasEffects = (clip.effects && clip.effects.length > 0)
                        || (() => { try { return getEffectsBridge().hasClipEffects(clip.id); } catch { return false; } })();
                      processedFrame = clipHasEffects
                        ? await applyEffectsToFrame(clip.id, frameBitmap)
                        : frameBitmap;
                    } catch {}

                    // Remember this clip's newest frame for miss fallback.
                    // Only bitmaps: a raw sink canvas is pooled + reused, so
                    // holding it would show future frames' pixels.
                    if (processedFrame instanceof ImageBitmap) {
                      const prev = lastClipFrameRef.current.get(clip.id);
                      if (prev && prev !== processedFrame) {
                        try { prev.close(); } catch { /* already closed */ }
                      }
                      lastClipFrameRef.current.set(clip.id, processedFrame);
                    }

                    return { clip, transform, frame: processedFrame };
                  }
                  return heldFrame();
                } catch (error) {
                  const errorMessage =
                    error instanceof Error ? error.message : String(error);
                  if (errorMessage.includes("disposed") || !isActive) {
                    return null;
                  }
                  console.warn(
                    `[Preview] Failed to get frame for clip ${clip.id}:`,
                    error,
                  );
                }
                return heldFrame();
              })(),
            );
          }

          const videoFrameResults = await Promise.all(videoClipPromises);
          // The decode awaits above are where a frame can hang long enough for
          // the watchdog to supersede it. Bail BEFORE compositing/painting so a
          // stale frame never flashes over the one that replaced it.
          if (myGen !== frameGen) return;
          const validVideoFrames = videoFrameResults.filter(
            (f): f is NonNullable<typeof f> => f !== null,
          );

          const validFrames = [...imageClipFrames, ...validVideoFrames];

          // COMPLETENESS GATE — the fix for the blend BLACKOUT. Every active
          // video layer must have a frame (fresh or its own held one) before
          // we paint. If a layer is still missing (decode not ready / warming),
          // painting would clear to black and composite only the ready layers —
          // so a blend layer would composite against BLACK (the blackout) and
          // that bad frame would get cached. Instead we HOLD the last COMPLETE
          // composite and retry next frame. Text/shape-only frames (no video
          // layers expected) are always "complete".
          const expectedVideoLayers = videoClipPromises.length;
          const composeComplete = validVideoFrames.length >= expectedVideoLayers;

          if (
            composeComplete &&
            (validFrames.length > 0 ||
              currentTextClips.length > 0 ||
              currentShapeClips.length > 0)
          ) {
            // Composite in PROJECT coordinates into the scaled offscreen —
            // every renderer keeps receiving canvas.width/height while the
            // backing store is previewScale× smaller.
            ctx.setTransform(previewScale, 0, 0, previewScale, 0, 0);
            ctx.fillStyle = "#000000";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const activeShapeClips = getActiveShapeClips(
              allShapeClipsRef.current,
              currentPlayhead,
            );
            const activeTextClips = getActiveTextClips(
              allTextClipsRef.current,
              currentPlayhead,
            );
            const tracks = timelineTracksRef.current;

            // Paint via the ONE shared z-order compositor. Frames were already
            // decoded + effected into `validFrames`; hand them in by clip id.
            // (The shared fn recomputes transform/emphasis from the same clips
            // with the same inputs → identical to validFrames' baked transform.)
            const frameByClip = new Map<
              string,
              ImageBitmap | HTMLCanvasElement | OffscreenCanvas
            >();
            for (const f of validFrames) frameByClip.set(f.clip.id, f.frame);
            compositeTracksToCtx(ctx, {
              tracks,
              time: currentPlayhead,
              canvasWidth: canvas.width,
              canvasHeight: canvas.height,
              frameProvider: (clip) => frameByClip.get(clip.id) ?? null,
              textClips: activeTextClips,
              shapeClips: activeShapeClips,
            });

            // Upscale-blit the scaled composite onto the full-res main canvas.
            mainCtx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);

            try {
              lastGoodFrameRef.current?.close();
              const _bmp = await createImageBitmap(offscreen);
              lastGoodFrameRef.current = _bmp;
              // ── RAM cache: store the composited frame (playback-scale) ──
              const _smfn = Math.round(currentPlayhead * 30);
              downscaleAndCache(offscreen, _smfn);
              if (_smfn % 10 === 0) {
                const range = ramCacheRef.current.getCachedRange();
                setRamCacheState(range, Math.ceil(actualEndTime * 30));
                setRamCacheCount(range.length);
              }
            } catch {}
          } else if (lastGoodFrameRef.current) {
            ctx.setTransform(previewScale, 0, 0, previewScale, 0, 0);
            ctx.drawImage(
              lastGoodFrameRef.current,
              0,
              0,
              canvas.width,
              canvas.height,
            );

            mainCtx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
          }

          frameCount++;
          masterClock.reportVideoTime(currentPlayhead);
          const nowMulti = performance.now();
          if (nowMulti - lastPlayheadUpdateRef.current >= PLAYHEAD_UPDATE_THROTTLE_MS) {
            lastPlayheadUpdateRef.current = nowMulti;
            setPlayheadPosition(currentPlayhead);
          }

          const now = performance.now();
          const elapsed = now - lastFrameTimestamp;
          const targetTime = frameDuration / rateRef.current;

          const delay = Math.max(0, targetTime - elapsed);
          lastFrameTimestamp = now;

          // Superseded by the watchdog while we were awaiting a slow decode:
          // the new frame owns the loop now, so don't reset the guard or
          // reschedule (that would run two loops at once).
          if (myGen !== frameGen) return;
          isProcessingFrame = false;

          if (isActive) {
            if (delay > 0) {
              setTimeout(() => {
                if (isActive) {
                  animationRef.current = requestAnimationFrame(
                    processMultiTrackFrame,
                  );
                }
              }, delay);
            } else {
              animationRef.current = requestAnimationFrame(
                processMultiTrackFrame,
              );
            }
          }
        } catch (error) {
          if (myGen !== frameGen) return;
          isProcessingFrame = false;
          console.error("[Preview] Multi-track frame error:", error);
          cleanupPlaybackResources();
          pause();
        }
      };

      animationRef.current = requestAnimationFrame(processMultiTrackFrame);
    };

    const findNextClipStartTime = (afterTime: number): number | null => {
      const tracks = timelineTracksRef.current;
      const videoTracks = tracks.filter(
        (t) => (t.type === "video" || t.type === "image") && !t.hidden,
      );
      let nextStart: number | null = null;

      for (const track of videoTracks) {
        for (const clip of track.clips) {
          if (clip.startTime > afterTime) {
            if (nextStart === null || clip.startTime < nextStart) {
              nextStart = clip.startTime;
            }
          }
        }
      }

      return nextStart;
    };

    const findNextTextClipStartTime = (afterTime: number): number | null => {
      const textClips = allTextClipsRef.current;
      let nextStart: number | null = null;

      for (const clip of textClips) {
        if (clip.startTime > afterTime) {
          if (nextStart === null || clip.startTime < nextStart) {
            nextStart = clip.startTime;
          }
        }
      }

      return nextStart;
    };

    const findNextShapeClipStartTime = (afterTime: number): number | null => {
      const shapeClips = allShapeClipsRef.current;
      let nextStart: number | null = null;

      for (const clip of shapeClips) {
        if (clip.startTime > afterTime) {
          if (nextStart === null || clip.startTime < nextStart) {
            nextStart = clip.startTime;
          }
        }
      }

      return nextStart;
    };

    const findNextAudioClipStartTime = (afterTime: number): number | null => {
      const tracks = timelineTracksRef.current;
      const audioTracks = tracks.filter((t) => t.type === "audio" && !t.hidden);
      let nextStart: number | null = null;

      for (const track of audioTracks) {
        for (const clip of track.clips) {
          if (clip.startTime > afterTime) {
            if (nextStart === null || clip.startTime < nextStart) {
              nextStart = clip.startTime;
            }
          }
        }
      }

      return nextStart;
    };

    // ────────────────────────────────────────────────────────────────────
    // TWO PLAYBACK PATHS — this is deliberate; don't "unify" them blindly.
    //
    //  • NATIVE (startNativeVideoPlayback): the fast path for the COMMON case
    //    — a single sequence of plain video clips (+ optional image bg + text
    //    /shape overlays). Uses hardware <video> decode straight to the
    //    canvas, one decoder active at a time. Cheap + smooth. NO effects,
    //    blend modes, overlapping video layers, or speed changes.
    //
    //  • MULTI-TRACK (startMultiTrackPlayback / processMultiTrackFrame): the
    //    full COMPOSITOR. Decodes every layer via mediabunny CanvasSink and
    //    composites in z-order. Handles what native can't: simultaneous video
    //    layers (overlaps), blend modes, clip.effects / EffectsBridge looks,
    //    image emphasis, and speed/reverse. This is also the seam where
    //    NESTED track-group rendering will plug in later (see the z-order loop
    //    in processMultiTrackFrame).
    //
    // canUseNativeVideoPlayback() below is the AUTHORITATIVE gate: it returns
    // canUse:false (→ multi-track) the moment any of those complex features is
    // present. So native is a strict optimization of the simple case, not a
    // parallel implementation to keep in sync feature-for-feature.
    // ────────────────────────────────────────────────────────────────────
    const startPlayback = async () => {
      const nativeCheck = canUseNativeVideoPlayback(playbackStartPosition);

      if (nativeCheck.canUse && nativeCheck.clips.length > 0) {
        try {
          nativeCleanup = await startNativeVideoPlayback(
            nativeCheck.clips,
            nativeCheck.imageClips || [],
            playbackStartPosition,
            () => pause(),
          );
          return nativeCleanup;
        } catch (error) {
          console.warn(
            "[Preview] Native video playback failed, falling back to MediaBunny:",
            error,
          );
        }
      }
      await startMultiTrackPlayback();
    };

    startPlayback().catch((error) => {
      console.error("[Preview] startPlayback error:", error);
    });

    return () => {
      isActive = false;
      nativePlaybackActiveRef.current = false;
      if (frameWatchdogRef.current) {
        clearInterval(frameWatchdogRef.current);
        frameWatchdogRef.current = null;
      }
      const masterClock = getMasterClock();
      if (masterClock.isPlaying || masterClock.isPaused) {
        startPositionRef.current = masterClock.currentTime;
      }
      if (nativeCleanup) {
        nativeCleanup();
        nativeCleanup = null;
      }
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      if (videoElementRef.current) {
        videoElementRef.current.pause();
        videoElementRef.current.src = "";
        videoElementRef.current = null;
      }
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
      masterClock.pause();
      cleanupAudioResources();
    };
  }, [
    isPlaying,
    canUseNativeVideoPlayback,
    startNativeVideoPlayback,
    actualEndTime,
    setPlayheadPosition,
    pause,
    getMediaItem,
    cleanupPlaybackResources,
    cleanupAudioResources,
    setupAudioFromAudioTrack,
    preDecodeAllAudioBuffers,
    getAudioClipsForScheduler,
    isMuted,
    settings.width,
    settings.height,
  ]);

  const lastModifiedAtRef = useRef<number>(project.modifiedAt);
  // Paused-render bookkeeping for the self-healing watchdog below: the key of
  // the last frame that actually PAINTED, whether a paused render is running,
  // and how long the interaction flag has been observed stuck.
  const lastPausedPaintKeyRef = useRef<string>("");
  const pausedRenderInFlightRef = useRef<boolean>(false);
  const stuckInteractionTicksRef = useRef<number>(0);

  useEffect(() => {
    if (isPlaying) return;

    lastModifiedAtRef.current = project.modifiedAt;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Identifies THIS frame request; recorded only after a paint completes so
    // the watchdog can tell "painted" from "skipped/failed".
    const renderKey = `${playheadPosition}|${project.modifiedAt}|${isDark}`;

    const renderFrame = async () => {
      pausedRenderInFlightRef.current = true;
      try {
        const rendered = await renderFrameDirectly(playheadPosition);
        if (!rendered) {
          renderFallbackFrame(playheadPosition);
        }
      } catch (e) {
        // A rejected direct render used to skip the fallback entirely
        // (unhandled rejection), leaving whatever was on the canvas — black
        // after a playback gap. Always land on SOME deliberate frame.
        console.warn("[Preview] paused frame render failed — using fallback:", e);
        try {
          renderFallbackFrame(playheadPosition);
        } catch { /* keep the last frame — never leave a half-drawn canvas */ }
      } finally {
        pausedRenderInFlightRef.current = false;
        lastPausedPaintKeyRef.current = renderKey;
      }
    };

    // COMPLETELY skip rendering during resize/move interactions
    // The last rendered frame stays visible, preventing black flashing
    if (!isInteractingRef.current) {
      void renderFrame();
    }

    // Self-healing watchdog: if this frame request never painted (a skipped
    // render, a wedged async render, or — the big one — isInteractingRef
    // stuck true because the pointer was released before the scoped mouseup
    // listener attached), retry until the canvas reflects current state. The
    // stuck flag otherwise blocks EVERY future paused repaint → the preview
    // freezes on the last frame forever (black, if that frame was a playback
    // gap). Cleared on every effect re-run; never runs during playback.
    const watchdog = window.setInterval(() => {
      if (lastPausedPaintKeyRef.current === renderKey) {
        stuckInteractionTicksRef.current = 0;
        return; // painted — nothing to heal
      }
      if (pausedRenderInFlightRef.current) return; // render still running
      if (isInteractingRef.current) {
        stuckInteractionTicksRef.current += 1;
        // No real drag goes this long without a pointer release; the flag is
        // stranded. Clear it so rendering can resume.
        if (stuckInteractionTicksRef.current >= 4) {
          console.warn("[Preview] interaction flag stuck — clearing and repainting");
          isInteractingRef.current = false;
          stuckInteractionTicksRef.current = 0;
          void renderFrame();
        }
        return;
      }
      stuckInteractionTicksRef.current = 0;
      void renderFrame();
    }, 2000);

    return () => window.clearInterval(watchdog);
  }, [
    playheadPosition,
    isPlaying,
    renderFrameDirectly,
    renderFallbackFrame,
    project.modifiedAt,
    isDark,
  ]);

  const selectedClipId = useMemo(() => {
    const clipSelection = selectedItems.find((item) => item.type === "clip");
    return clipSelection?.id || null;
  }, [selectedItems]);

  const selectedClip = useMemo(() => {
    if (!selectedClipId) return null;
    for (const track of timelineTracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) return clip;
    }
    return null;
  }, [selectedClipId, timelineTracks]);

  const clipAtPlayhead = useMemo(() => {
    const videoTracks = timelineTracks.filter(
      (t) => (t.type === "video" || t.type === "image") && !t.hidden,
    );
    for (const track of videoTracks) {
      for (const clip of track.clips) {
        const clipStart = clip.startTime;
        const clipEnd = clip.startTime + clip.duration;
        if (playheadPosition >= clipStart && playheadPosition < clipEnd) {
          return clip;
        }
      }
    }
    return null;
  }, [timelineTracks, playheadPosition]);

  const selectedTextClipId = useMemo(() => {
    const textClipSelection = selectedItems.find(
      (item) => item.type === "text-clip",
    );
    return textClipSelection?.id || null;
  }, [selectedItems]);

  const selectedTextClip = useMemo<TextClip | null>(() => {
    if (!selectedTextClipId) return null;
    return allTextClips.find((clip) => clip.id === selectedTextClipId) || null;
  }, [selectedTextClipId, allTextClips]);

  const activeTextClip = selectedTextClip;

  const clipBounds = useMemo(() => {
    const clip = selectedClip || clipAtPlayhead;
    if (!clip || !canvasRef.current || !overlayRef.current) return null;

    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const overlayRect = overlay.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    const clipTransform = clip.transform || {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      opacity: 1,
      anchor: { x: 0.5, y: 0.5 },
    };

    const transform = liveTransform
      ? {
          ...clipTransform,
          position: liveTransform.position,
          scale: liveTransform.scale,
        }
      : clipTransform;

    const canvasWidth = settings.width;
    const canvasHeight = settings.height;

    const canvasAspect = canvasWidth / canvasHeight;
    const elementAspect = canvasRect.width / canvasRect.height;

    let actualWidth: number;
    let actualHeight: number;
    let letterboxOffsetX = 0;
    let letterboxOffsetY = 0;

    if (elementAspect > canvasAspect) {
      actualHeight = canvasRect.height;
      actualWidth = actualHeight * canvasAspect;
      letterboxOffsetX = (canvasRect.width - actualWidth) / 2;
    } else {
      actualWidth = canvasRect.width;
      actualHeight = actualWidth / canvasAspect;
      letterboxOffsetY = (canvasRect.height - actualHeight) / 2;
    }

    const displayScale = actualWidth / canvasWidth;

    const clipWidth = canvasWidth * transform.scale.x * displayScale;
    const clipHeight = canvasHeight * transform.scale.y * displayScale;

    const offsetX = transform.position.x * displayScale;
    const offsetY = transform.position.y * displayScale;

    const canvasOffsetX = canvasRect.left - overlayRect.left + letterboxOffsetX;
    const canvasOffsetY = canvasRect.top - overlayRect.top + letterboxOffsetY;

    const centerX = canvasOffsetX + actualWidth / 2 + offsetX;
    const centerY = canvasOffsetY + actualHeight / 2 + offsetY;

    return {
      x: centerX - clipWidth / 2,
      y: centerY - clipHeight / 2,
      width: clipWidth,
      height: clipHeight,
      centerX,
      centerY,
      displayScale,
    };
  }, [
    selectedClip,
    clipAtPlayhead,
    settings.width,
    settings.height,
    canvasSize,
    liveTransform,
  ]);

  const textClipBounds = useMemo(() => {
    if (!selectedTextClip || !canvasRef.current || !overlayRef.current)
      return null;

    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const overlayRect = overlay.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    const { transform, style, text } = selectedTextClip;

    const canvasWidth = settings.width;
    const canvasHeight = settings.height;

    const canvasAspect = canvasWidth / canvasHeight;
    const elementAspect = canvasRect.width / canvasRect.height;

    let actualWidth: number;
    let actualHeight: number;
    let letterboxOffsetX = 0;
    let letterboxOffsetY = 0;

    if (elementAspect > canvasAspect) {
      actualHeight = canvasRect.height;
      actualWidth = actualHeight * canvasAspect;
      letterboxOffsetX = (canvasRect.width - actualWidth) / 2;
    } else {
      actualWidth = canvasRect.width;
      actualHeight = actualWidth / canvasAspect;
      letterboxOffsetY = (canvasRect.height - actualHeight) / 2;
    }

    const displayScale = actualWidth / canvasWidth;

    const lines = text.split("\n");
    const lineHeight = style.fontSize * style.lineHeight;
    const estimatedHeight = lines.length * lineHeight;
    const estimatedWidth =
      style.fontSize * Math.max(...lines.map((l) => l.length)) * 0.6;

    const textWidth = estimatedWidth * transform.scale.x * displayScale;
    const textHeight = estimatedHeight * transform.scale.y * displayScale;

    const posX = transform.position.x * canvasWidth * displayScale;
    const posY = transform.position.y * canvasHeight * displayScale;

    const canvasOffsetX = canvasRect.left - overlayRect.left + letterboxOffsetX;
    const canvasOffsetY = canvasRect.top - overlayRect.top + letterboxOffsetY;

    const centerX = canvasOffsetX + posX;
    const centerY = canvasOffsetY + posY;

    return {
      x: centerX - textWidth / 2,
      y: centerY - textHeight / 2,
      width: textWidth,
      height: textHeight,
      centerX,
      centerY,
      displayScale,
      isTextClip: true,
    };
  }, [selectedTextClip, settings.width, settings.height, canvasSize]);

  const selectedShapeClipId = useMemo(() => {
    const shapeClipSelection = selectedItems.find(
      (item) => item.type === "shape-clip",
    );
    return shapeClipSelection?.id || null;
  }, [selectedItems]);

  const selectedShapeClip = useMemo<
    ShapeClip | SVGClip | StickerClip | null
  >(() => {
    if (!selectedShapeClipId) return null;
    return (
      allShapeClips.find((clip) => clip.id === selectedShapeClipId) || null
    );
  }, [selectedShapeClipId, allShapeClips]);

  const activeShapeClip = selectedShapeClip;

  const [hoveredGraphicClipId, setHoveredGraphicClipId] = useState<string | null>(null);

  const activeGraphicClips = useMemo(() => {
    // getActiveShapeClips returns all graphic clip types (shapes, SVGs, and stickers)
    return getActiveShapeClips(allShapeClips, playheadPosition);
  }, [allShapeClips, playheadPosition]);

  const shapeClipBounds = useMemo(() => {
    if (!selectedShapeClip || !canvasRef.current || !overlayRef.current)
      return null;

    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const overlayRect = overlay.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    const { transform } = selectedShapeClip;
    const shapeSize = 200;

    const canvasWidth = settings.width;
    const canvasHeight = settings.height;

    const canvasAspect = canvasWidth / canvasHeight;
    const elementAspect = canvasRect.width / canvasRect.height;

    let actualWidth: number;
    let actualHeight: number;
    let letterboxOffsetX = 0;
    let letterboxOffsetY = 0;

    if (elementAspect > canvasAspect) {
      actualHeight = canvasRect.height;
      actualWidth = actualHeight * canvasAspect;
      letterboxOffsetX = (canvasRect.width - actualWidth) / 2;
    } else {
      actualWidth = canvasRect.width;
      actualHeight = actualWidth / canvasAspect;
      letterboxOffsetY = (canvasRect.height - actualHeight) / 2;
    }

    const displayScale = actualWidth / canvasWidth;

    const shapeWidth = shapeSize * transform.scale.x * displayScale;
    const shapeHeight = shapeSize * transform.scale.y * displayScale;

    const posX = transform.position.x * canvasWidth * displayScale;
    const posY = transform.position.y * canvasHeight * displayScale;

    const canvasOffsetX = canvasRect.left - overlayRect.left + letterboxOffsetX;
    const canvasOffsetY = canvasRect.top - overlayRect.top + letterboxOffsetY;

    const centerX = canvasOffsetX + posX;
    const centerY = canvasOffsetY + posY;

    return {
      x: centerX - shapeWidth / 2,
      y: centerY - shapeHeight / 2,
      width: shapeWidth,
      height: shapeHeight,
      centerX,
      centerY,
      displayScale,
      isShapeClip: true,
    };
  }, [selectedShapeClip, settings.width, settings.height, canvasSize]);

  const getGraphicClipDisplayBounds = useCallback(
    (clip: ShapeClip | SVGClip | StickerClip) => {
      if (!canvasRef.current || !overlayRef.current) return null;

      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      const overlayRect = overlay.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();

      const { transform } = clip;
      // Approximation of the displayed clip size in canvas-coordinate units,
      // consistent with the value used in shapeClipBounds for the resize overlay.
      const shapeSize = 200;

      const canvasWidth = settings.width;
      const canvasHeight = settings.height;

      const canvasAspect = canvasWidth / canvasHeight;
      const elementAspect = canvasRect.width / canvasRect.height;

      let actualWidth: number;
      let actualHeight: number;
      let letterboxOffsetX = 0;
      let letterboxOffsetY = 0;

      if (elementAspect > canvasAspect) {
        actualHeight = canvasRect.height;
        actualWidth = actualHeight * canvasAspect;
        letterboxOffsetX = (canvasRect.width - actualWidth) / 2;
      } else {
        actualWidth = canvasRect.width;
        actualHeight = actualWidth / canvasAspect;
        letterboxOffsetY = (canvasRect.height - actualHeight) / 2;
      }

      const displayScale = actualWidth / canvasWidth;

      const shapeWidth = shapeSize * transform.scale.x * displayScale;
      const shapeHeight = shapeSize * transform.scale.y * displayScale;

      const posX = transform.position.x * canvasWidth * displayScale;
      const posY = transform.position.y * canvasHeight * displayScale;

      const canvasOffsetX = canvasRect.left - overlayRect.left + letterboxOffsetX;
      const canvasOffsetY = canvasRect.top - overlayRect.top + letterboxOffsetY;

      const centerX = canvasOffsetX + posX;
      const centerY = canvasOffsetY + posY;

      return {
        x: centerX - shapeWidth / 2,
        y: centerY - shapeHeight / 2,
        width: shapeWidth,
        height: shapeHeight,
        centerX,
        centerY,
      };
    },
    [settings.width, settings.height],
  );

  const findGraphicClipAtPoint = useCallback(
    (clientX: number, clientY: number): ShapeClip | SVGClip | StickerClip | null => {
      if (!overlayRef.current) return null;
      const overlayRect = overlayRef.current.getBoundingClientRect();
      const pointX = clientX - overlayRect.left;
      const pointY = clientY - overlayRect.top;

      for (let i = activeGraphicClips.length - 1; i >= 0; i--) {
        const clip = activeGraphicClips[i];
        const bounds = getGraphicClipDisplayBounds(clip);
        if (!bounds) continue;

        if (
          pointX >= bounds.x &&
          pointX <= bounds.x + bounds.width &&
          pointY >= bounds.y &&
          pointY <= bounds.y + bounds.height
        ) {
          return clip;
        }
      }
      return null;
    },
    [activeGraphicClips, getGraphicClipDisplayBounds],
  );

  const selectedSubtitleId = useMemo(() => {
    const subtitleSelection = selectedItems.find(
      (item) => item.type === "subtitle",
    );
    return subtitleSelection?.id || null;
  }, [selectedItems]);

  const selectedSubtitleObj = useMemo<Subtitle | null>(() => {
    if (!selectedSubtitleId) return null;
    return allSubtitles.find((sub) => sub.id === selectedSubtitleId) || null;
  }, [selectedSubtitleId, allSubtitles]);

  const subtitleBounds = useMemo(() => {
    if (!selectedSubtitleObj || !canvasRef.current || !overlayRef.current)
      return null;
    if (
      playheadPosition < selectedSubtitleObj.startTime ||
      playheadPosition >= selectedSubtitleObj.endTime
    )
      return null;

    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const overlayRect = overlay.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    const fontSize = selectedSubtitleObj.style?.fontSize || 24;
    const position = selectedSubtitleObj.style?.position || "bottom";
    const lines = selectedSubtitleObj.text.split("\n");
    const lineHeight = fontSize * 1.3;
    const totalHeight = lines.length * lineHeight;

    const canvasWidth = settings.width;
    const canvasHeight = settings.height;

    const canvasAspect = canvasWidth / canvasHeight;
    const elementAspect = canvasRect.width / canvasRect.height;

    let actualWidth: number;
    let actualHeight: number;
    let letterboxOffsetX = 0;
    let letterboxOffsetY = 0;

    if (elementAspect > canvasAspect) {
      actualHeight = canvasRect.height;
      actualWidth = actualHeight * canvasAspect;
      letterboxOffsetX = (canvasRect.width - actualWidth) / 2;
    } else {
      actualWidth = canvasRect.width;
      actualHeight = actualWidth / canvasAspect;
      letterboxOffsetY = (canvasRect.height - actualHeight) / 2;
    }

    const displayScale = actualWidth / canvasWidth;

    let baseY: number;
    if (position === "top") {
      baseY = fontSize * 2;
    } else if (position === "center") {
      baseY = canvasHeight / 2 - totalHeight / 2;
    } else {
      baseY = canvasHeight - fontSize * 2 - totalHeight;
    }

    const subtitleWidth = canvasWidth * 0.8 * displayScale;
    const subtitleHeight = totalHeight * displayScale;

    const canvasOffsetX = canvasRect.left - overlayRect.left + letterboxOffsetX;
    const canvasOffsetY = canvasRect.top - overlayRect.top + letterboxOffsetY;

    const centerX = canvasOffsetX + actualWidth / 2;
    const topY = canvasOffsetY + baseY * displayScale;

    return {
      x: centerX - subtitleWidth / 2,
      y: topY,
      width: subtitleWidth,
      height: subtitleHeight,
      centerX,
      centerY: topY + subtitleHeight / 2,
      displayScale,
    };
  }, [
    selectedSubtitleObj,
    settings.width,
    settings.height,
    canvasSize,
    playheadPosition,
  ]);

  const handleHandleMouseDown = useCallback(
    (e: React.MouseEvent, handle: HandlePosition) => {
      e.stopPropagation();
      e.preventDefault();

      const clip = selectedClip || clipAtPlayhead;
      if (!clip) return;

      const transform = clip.transform || {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        opacity: 1,
        anchor: { x: 0.5, y: 0.5 },
      };

      isInteractingRef.current = true;
      setInteractionMode("resize");
      setActiveHandle(handle);
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [selectedClip, clipAtPlayhead],
  );

  const handleClipMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      const clip = selectedClip || clipAtPlayhead;
      if (!clip) return;

      const transform = clip.transform || {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        opacity: 1,
        anchor: { x: 0.5, y: 0.5 },
      };

      isInteractingRef.current = true;
      setInteractionMode("move");
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [selectedClip, clipAtPlayhead],
  );

  const handleTextClipMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      if (!activeTextClip) return;

      const { transform } = activeTextClip;

      isInteractingRef.current = true;
      setInteractionMode("move");
      setInteractionTargetType("text-clip");
      interactionTargetIdRef.current = activeTextClip.id;
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [activeTextClip],
  );

  const handleTextHandleMouseDown = useCallback(
    (e: React.MouseEvent, handle: HandlePosition) => {
      e.stopPropagation();
      e.preventDefault();

      if (!activeTextClip) return;

      const { transform } = activeTextClip;

      isInteractingRef.current = true;
      setInteractionMode("resize");
      setActiveHandle(handle);
      setInteractionTargetType("text-clip");
      interactionTargetIdRef.current = activeTextClip.id;
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [activeTextClip],
  );

  const handleShapeClipMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      if (!activeShapeClip) return;

      const { transform } = activeShapeClip;

      isInteractingRef.current = true;
      setInteractionMode("move");
      setInteractionTargetType("shape-clip");
      interactionTargetIdRef.current = activeShapeClip.id;
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [activeShapeClip],
  );

  const handleShapeHandleMouseDown = useCallback(
    (e: React.MouseEvent, handle: HandlePosition) => {
      e.stopPropagation();
      e.preventDefault();

      if (!activeShapeClip) return;

      const { transform } = activeShapeClip;

      isInteractingRef.current = true;
      setInteractionMode("resize");
      setActiveHandle(handle);
      setInteractionTargetType("shape-clip");
      interactionTargetIdRef.current = activeShapeClip.id;
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [activeShapeClip],
  );

  const handleGraphicsMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (interactionMode !== "none") {
        setHoveredGraphicClipId(null);
        return;
      }

      const clip = findGraphicClipAtPoint(e.clientX, e.clientY);
      setHoveredGraphicClipId(clip ? clip.id : null);
    },
    [interactionMode, findGraphicClipAtPoint],
  );

  const handleGraphicsClick = useCallback(
    (e: React.MouseEvent) => {
      if (interactionMode !== "none") return;

      const clip = findGraphicClipAtPoint(e.clientX, e.clientY);
      if (clip) {
        select({ type: "shape-clip", id: clip.id });
        e.stopPropagation();
      }
    },
    [interactionMode, findGraphicClipAtPoint, select],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (interactionMode === "none" || !interactionStartRef.current) return;

      if (
        interactionTargetType === "text-clip" &&
        textClipBounds &&
        activeTextClip
      ) {
        const deltaX = e.clientX - interactionStartRef.current.x;
        const deltaY = e.clientY - interactionStartRef.current.y;
        const { displayScale } = textClipBounds;

        let newTransform: {
          position?: { x: number; y: number };
          scale?: { x: number; y: number };
        } = {};

        if (interactionMode === "move") {
          const newX =
            interactionStartRef.current.transform.x +
            deltaX / displayScale / settings.width;
          const newY =
            interactionStartRef.current.transform.y +
            deltaY / displayScale / settings.height;
          newTransform = { position: { x: newX, y: newY } };
        } else if (interactionMode === "resize" && activeHandle) {
          const startTransform = interactionStartRef.current.transform;
          let newScaleX = startTransform.scaleX;
          let newScaleY = startTransform.scaleY;

          const scaleDeltaX = deltaX / displayScale / 100;
          const scaleDeltaY = deltaY / displayScale / 100;

          switch (activeHandle) {
            case "e":
            case "se":
            case "ne":
              newScaleX = Math.max(0.1, startTransform.scaleX + scaleDeltaX);
              if (lockAspectRatio) newScaleY = newScaleX;
              break;
            case "w":
            case "sw":
            case "nw":
              newScaleX = Math.max(0.1, startTransform.scaleX - scaleDeltaX);
              if (lockAspectRatio) newScaleY = newScaleX;
              break;
            case "s":
              newScaleY = Math.max(0.1, startTransform.scaleY + scaleDeltaY);
              if (lockAspectRatio) newScaleX = newScaleY;
              break;
            case "n":
              newScaleY = Math.max(0.1, startTransform.scaleY - scaleDeltaY);
              if (lockAspectRatio) newScaleX = newScaleY;
              break;
          }

          newTransform = {
            position: { x: startTransform.x, y: startTransform.y },
            scale: { x: newScaleX, y: newScaleY },
          };
        }

        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(() => {
            const now = performance.now();
            if (
              now - lastStoreUpdateRef.current >= STORE_UPDATE_THROTTLE_MS &&
              interactionTargetIdRef.current
            ) {
              lastStoreUpdateRef.current = now;
              updateTextTransform(interactionTargetIdRef.current, newTransform);
            }
            rafIdRef.current = null;
          });
        }
        return;
      }

      if (
        interactionTargetType === "shape-clip" &&
        shapeClipBounds &&
        activeShapeClip
      ) {
        const deltaX = e.clientX - interactionStartRef.current.x;
        const deltaY = e.clientY - interactionStartRef.current.y;
        const { displayScale } = shapeClipBounds;

        let newTransform: {
          position?: { x: number; y: number };
          scale?: { x: number; y: number };
        } = {};

        if (interactionMode === "move") {
          const newX =
            interactionStartRef.current.transform.x +
            deltaX / displayScale / settings.width;
          const newY =
            interactionStartRef.current.transform.y +
            deltaY / displayScale / settings.height;
          newTransform = { position: { x: newX, y: newY } };
        } else if (interactionMode === "resize" && activeHandle) {
          const startTransform = interactionStartRef.current.transform;
          let newScaleX = startTransform.scaleX;
          let newScaleY = startTransform.scaleY;

          const scaleDeltaX = deltaX / displayScale / 100;
          const scaleDeltaY = deltaY / displayScale / 100;

          switch (activeHandle) {
            case "e":
            case "se":
            case "ne":
              newScaleX = Math.max(0.1, startTransform.scaleX + scaleDeltaX);
              if (lockAspectRatio) newScaleY = newScaleX;
              break;
            case "w":
            case "sw":
            case "nw":
              newScaleX = Math.max(0.1, startTransform.scaleX - scaleDeltaX);
              if (lockAspectRatio) newScaleY = newScaleX;
              break;
            case "s":
              newScaleY = Math.max(0.1, startTransform.scaleY + scaleDeltaY);
              if (lockAspectRatio) newScaleX = newScaleY;
              break;
            case "n":
              newScaleY = Math.max(0.1, startTransform.scaleY - scaleDeltaY);
              if (lockAspectRatio) newScaleX = newScaleY;
              break;
          }

          newTransform = {
            position: { x: startTransform.x, y: startTransform.y },
            scale: { x: newScaleX, y: newScaleY },
          };
        }

        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(() => {
            const now = performance.now();
            if (
              now - lastStoreUpdateRef.current >= STORE_UPDATE_THROTTLE_MS &&
              interactionTargetIdRef.current
            ) {
              lastStoreUpdateRef.current = now;
              updateShapeTransform(
                interactionTargetIdRef.current,
                newTransform,
              );
            }
            rafIdRef.current = null;
          });
        }
        return;
      }

      if (!clipBounds) return;
      const clip = selectedClip || clipAtPlayhead;
      if (!clip) return;

      const deltaX = e.clientX - interactionStartRef.current.x;
      const deltaY = e.clientY - interactionStartRef.current.y;
      const { displayScale } = clipBounds;

      let newTransform: {
        position?: { x: number; y: number };
        scale?: { x: number; y: number };
      } = {};

      if (interactionMode === "move") {
        const newX =
          interactionStartRef.current.transform.x + deltaX / displayScale;
        const newY =
          interactionStartRef.current.transform.y + deltaY / displayScale;

        newTransform = { position: { x: newX, y: newY } };
      } else if (interactionMode === "resize" && activeHandle) {
        const startTransform = interactionStartRef.current.transform;
        let newScaleX = startTransform.scaleX;
        let newScaleY = startTransform.scaleY;
        let newX = startTransform.x;
        let newY = startTransform.y;

        const scaleDeltaX = deltaX / displayScale / (settings.width / 2);
        const scaleDeltaY = deltaY / displayScale / (settings.height / 2);

        switch (activeHandle) {
          case "e":
            newScaleX = Math.max(0.1, startTransform.scaleX + scaleDeltaX);
            if (lockAspectRatio) newScaleY = newScaleX;
            break;
          case "w":
            newScaleX = Math.max(0.1, startTransform.scaleX - scaleDeltaX);
            if (lockAspectRatio) newScaleY = newScaleX;
            newX = startTransform.x + deltaX / displayScale / 2;
            break;
          case "s":
            newScaleY = Math.max(0.1, startTransform.scaleY + scaleDeltaY);
            if (lockAspectRatio) newScaleX = newScaleY;
            break;
          case "n":
            newScaleY = Math.max(0.1, startTransform.scaleY - scaleDeltaY);
            if (lockAspectRatio) newScaleX = newScaleY;
            newY = startTransform.y + deltaY / displayScale / 2;
            break;
          case "se":
            if (lockAspectRatio) {
              const avgDelta = (scaleDeltaX + scaleDeltaY) / 2;
              newScaleX = Math.max(0.1, startTransform.scaleX + avgDelta);
              newScaleY = newScaleX;
            } else {
              newScaleX = Math.max(0.1, startTransform.scaleX + scaleDeltaX);
              newScaleY = Math.max(0.1, startTransform.scaleY + scaleDeltaY);
            }
            break;
          case "sw":
            if (lockAspectRatio) {
              const avgDelta = (-scaleDeltaX + scaleDeltaY) / 2;
              newScaleX = Math.max(0.1, startTransform.scaleX + avgDelta);
              newScaleY = newScaleX;
            } else {
              newScaleX = Math.max(0.1, startTransform.scaleX - scaleDeltaX);
              newScaleY = Math.max(0.1, startTransform.scaleY + scaleDeltaY);
            }
            newX = startTransform.x + deltaX / displayScale / 2;
            break;
          case "ne":
            if (lockAspectRatio) {
              const avgDelta = (scaleDeltaX - scaleDeltaY) / 2;
              newScaleX = Math.max(0.1, startTransform.scaleX + avgDelta);
              newScaleY = newScaleX;
            } else {
              newScaleX = Math.max(0.1, startTransform.scaleX + scaleDeltaX);
              newScaleY = Math.max(0.1, startTransform.scaleY - scaleDeltaY);
            }
            newY = startTransform.y + deltaY / displayScale / 2;
            break;
          case "nw":
            if (lockAspectRatio) {
              const avgDelta = (-scaleDeltaX - scaleDeltaY) / 2;
              newScaleX = Math.max(0.1, startTransform.scaleX + avgDelta);
              newScaleY = newScaleX;
            } else {
              newScaleX = Math.max(0.1, startTransform.scaleX - scaleDeltaX);
              newScaleY = Math.max(0.1, startTransform.scaleY - scaleDeltaY);
            }
            newX = startTransform.x + deltaX / displayScale / 2;
            newY = startTransform.y + deltaY / displayScale / 2;
            break;
        }

        newTransform = {
          position: { x: newX, y: newY },
          scale: { x: newScaleX, y: newScaleY },
        };
      }

      pendingTransformRef.current = {
        clipId: clip.id,
        transform: newTransform,
      };

      const currentTransform = clip.transform || {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
      };
      setLiveTransform({
        position: newTransform.position || currentTransform.position,
        scale: newTransform.scale || currentTransform.scale,
      });

      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          const now = performance.now();
          if (
            pendingTransformRef.current &&
            now - lastStoreUpdateRef.current >= STORE_UPDATE_THROTTLE_MS
          ) {
            lastStoreUpdateRef.current = now;
            updateClipTransform(
              pendingTransformRef.current.clipId,
              pendingTransformRef.current.transform,
            );
          }
          rafIdRef.current = null;
        });
      }
    },
    [
      interactionMode,
      activeHandle,
      clipBounds,
      selectedClip,
      clipAtPlayhead,
      updateClipTransform,
      settings.width,
      settings.height,
      lockAspectRatio,
      interactionTargetType,
      textClipBounds,
      activeTextClip,
      updateTextTransform,
    ],
  );

  const handleMouseUp = useCallback(() => {
    if (pendingTransformRef.current) {
      updateClipTransform(
        pendingTransformRef.current.clipId,
        pendingTransformRef.current.transform,
      );
      pendingTransformRef.current = null;
    }
    setInteractionTargetType(null);
    interactionTargetIdRef.current = null;
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const wasInteracting = isInteractingRef.current;
    isInteractingRef.current = false;
    setInteractionMode("none");
    setActiveHandle(null);
    interactionStartRef.current = null;
    setLiveTransform(null);

    if (wasInteracting) {
      renderFrameDirectly(playheadPosition);
    }
  }, [updateClipTransform, renderFrameDirectly, playheadPosition]);

  const handleCropChange = useCallback(
    (crop: { x: number; y: number; width: number; height: number }) => {
      if (cropClipId) {
        updateClipTransform(cropClipId, { crop });
      }
    },
    [cropClipId, updateClipTransform],
  );

  const handleCropComplete = useCallback(() => {
    setCropMode(false);
  }, [setCropMode]);

  const handleCropCancel = useCallback(() => {
    setCropMode(false);
  }, [setCropMode]);

  useEffect(() => {
    if (interactionMode !== "none") {
      const handleGlobalMouseUp = () => {
        if (pendingTransformRef.current) {
          updateClipTransform(
            pendingTransformRef.current.clipId,
            pendingTransformRef.current.transform,
          );
          pendingTransformRef.current = null;
        }
        if (rafIdRef.current) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }

        const wasInteracting = isInteractingRef.current;
        isInteractingRef.current = false;
        setInteractionMode("none");
        setActiveHandle(null);
        interactionStartRef.current = null;
        setLiveTransform(null);

        if (wasInteracting) {
          renderFrameDirectly(playheadPosition);
        }
      };

      window.addEventListener("mouseup", handleGlobalMouseUp);
      return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
    }
  }, [
    interactionMode,
    renderFrameDirectly,
    playheadPosition,
    updateClipTransform,
  ]);

  // SAFETY NET for the interaction flag. The scoped listener above only
  // exists while `interactionMode !== "none"`, i.e. after a React re-render —
  // but isInteractingRef is set SYNCHRONOUSLY in the pointer-down handlers. A
  // fast click releases the mouse before that listener attaches, the mouseup
  // is missed, and the flag stays true forever: every paused repaint is then
  // skipped and the preview freezes on its last frame (pure black if that
  // frame was a playback gap) — the "preview went black" bug. Listen for the
  // release unconditionally and, AFTER the scoped handler has had its chance
  // to run (setTimeout 0), clean up anything it left behind.
  useEffect(() => {
    const settle = () => {
      setTimeout(() => {
        if (!isInteractingRef.current) return; // scoped handler already cleaned up
        if (pendingTransformRef.current) {
          updateClipTransform(
            pendingTransformRef.current.clipId,
            pendingTransformRef.current.transform,
          );
          pendingTransformRef.current = null;
        }
        if (rafIdRef.current) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        isInteractingRef.current = false;
        setInteractionMode("none");
        setActiveHandle(null);
        interactionStartRef.current = null;
        setLiveTransform(null);
        renderFrameDirectly(playheadPosition);
      }, 0);
    };
    window.addEventListener("pointerup", settle);
    window.addEventListener("pointercancel", settle);
    window.addEventListener("blur", settle);
    return () => {
      window.removeEventListener("pointerup", settle);
      window.removeEventListener("pointercancel", settle);
      window.removeEventListener("blur", settle);
    };
  }, [renderFrameDirectly, playheadPosition, updateClipTransform]);

  const handleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!document.fullscreenElement) {
      setZoomLevel(1);
      container
        .requestFullscreen()
        .then(() => {
          setIsFullscreen(true);
        })
        .catch((err) => {
          console.error("Error entering fullscreen:", err);
        });
    } else {
      document
        .exitFullscreen()
        .then(() => {
          setIsFullscreen(false);
        })
        .catch((err) => {
          console.error("Error exiting fullscreen:", err);
        });
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const showResizeHandles = !isPlaying && selectedClip && clipBounds;

  const showTextClipHandles = !isPlaying && selectedTextClip && textClipBounds;

  const showShapeClipHandles =
    !isPlaying && selectedShapeClip && shapeClipBounds;

  const showSubtitleOverlay =
    !isPlaying && selectedSubtitleObj && subtitleBounds;

  const cropClip = useMemo(() => {
    if (!cropMode || !cropClipId) return null;

    for (const track of timelineTracks) {
      const clip = track.clips.find((c) => c.id === cropClipId);
      if (clip) return clip;
    }
    return null;
  }, [cropMode, cropClipId, timelineTracks]);

  const cropMediaData = useMemo(() => {
    if (!cropMode || !cropClipId || !cropClip) return null;

    const mediaItem = getMediaItem(cropClip.mediaId);
    if (!mediaItem) return null;

    let src: string | null = null;
    if (mediaItem.blob instanceof Blob) {
      src = URL.createObjectURL(mediaItem.blob);
    } else if (mediaItem.originalUrl) {
      // Route through the proxy so cross-origin assets (Kie tempfile,
      // R2 buckets) load without CORS errors.
      src = rewriteToProxy(mediaItem.originalUrl);
    }

    if (!src) return null;

    return {
      src,
      type: mediaItem.type as "video" | "image",
    };
  }, [cropMode, cropClipId, cropClip, getMediaItem]);

  const cropVideoSrc = cropMediaData?.src ?? null;
  const cropMediaType = cropMediaData?.type ?? "video";

  const shouldShowCropMode = cropMode && cropClipId && cropClip && cropVideoSrc;

  return (
    <div
      ref={containerRef}
      data-tour="preview"
      className="flex-1 bg-background flex flex-col relative group overflow-hidden"
    >
      {/* Crop Mode View - Full Screen Overlay */}
      {shouldShowCropMode && (
        <CropModeView
          clip={cropClip!}
          videoSrc={cropVideoSrc}
          mediaType={cropMediaType}
          currentTime={playheadPosition}
          canvasWidth={canvasSize.width}
          canvasHeight={canvasSize.height}
          onCropChange={handleCropChange}
          onComplete={handleCropComplete}
          onCancel={handleCropCancel}
        />
      )}

      {/* Video Area */}
      {/* min-h-0 is load-bearing. A flex item defaults to min-height:auto, so
          this would not shrink below the 450px stage inside it — dragging the
          timeline up squeezed the column but the video area held its size and
          pushed the control row (with the transport) off the bottom. With the
          floor removed, the stage collapses toward nothing and the control row,
          which never shrinks, stays on screen. */}
      {/* min-h-0 lets this shrink below its content; the padding is HORIZONTAL
          only because vertical padding would not shrink with it. Flex reduces a
          item's content box, never its padding — so `p-4` left an immovable
          32px here, which pushed the control row down into the timeline and
          produced exactly the overlap it looked like. The stage is centred, so
          it keeps its breathing room from the free space rather than padding. */}
      <div
        ref={stageAreaRef}
        className={`flex-1 min-h-0 overflow-hidden relative flex items-center justify-center bg-background-secondary/30 transition-all duration-300 ${
          isFullscreen ? "px-0" : "px-4"
        } ${zoomLevel > 1 ? "overflow-auto" : ""}`}
        onMouseMove={interactionMode !== "none" ? handleMouseMove : undefined}
        onMouseUp={handleMouseUp}
      >
        {/* THE PICTURE HOLDS STILL WHEN THE CHROME MOVES.
            The stage below is a FIXED size (450px tall × the project aspect,
            capped at 800px) centred in whatever room is left. So collapsing the
            Assets column — which gives this area ~276px more on its left —
            moved the centre, and the video jumped ~138px sideways for no
            reason: the stage never uses the extra width, it only re-centres in
            it. This wrapper cancels that, clamped so the stage can never be
            pushed out of the area. No transition: the whole point is that
            nothing animates, because nothing should appear to move. */}
        {/* BACKGROUND WORK, OUTSIDE THE PICTURE.
            Mounted on the stage AREA rather than inside the frame, so the card
            sits in the letterboxing and never covers the shot. It used to be a
            full-screen scrim in the middle of the frame that told the user to
            wait — for work that blocks nothing and that they can keep cutting
            through. See ProcessingOverlay's own note. */}
        <ProcessingOverlay />

        <div
          ref={stageWrapRef}
          className="shrink-0"
          style={{ transform: `translateX(${stageOffset}px)` }}
        >
        <div
          ref={overlayRef}
          className={`relative bg-black overflow-hidden transition-all duration-300 ${
            isFullscreen
              ? "rounded-none ring-0 shadow-none"
              : "shadow-2xl rounded-xl ring-1 ring-border shadow-[0_0_50px_rgba(0,0,0,0.5)]"
          }`}
          style={
            isFullscreen
              ? {
                  // Fit the PROJECT's shape inside the screen, letterboxing
                  // whichever axis is spare. This used to be 100% x 100%, which
                  // on a landscape monitor handed a 9:16 project a 16:9 element
                  // box — the frame was then squeezed into the wrong shape and
                  // the sides of the picture were lost.
                  //
                  // Each axis is the smaller of "all the room there is" and
                  // "what the other axis allows at this aspect", so the box is
                  // always exactly the project's ratio and never overflows.
                  // The flex parent centres it.
                  width: `min(100%, calc(100vh * ${settings.width} / ${settings.height}))`,
                  height: `min(100%, calc(100vw * ${settings.height} / ${settings.width}))`,
                  maxWidth: "none",
                }
              : {
                  height: `${450 * zoomLevel}px`,
                  width: `calc(${450 * zoomLevel}px * ${settings.width} / ${settings.height})`,
                  maxWidth: `${800 * zoomLevel}px`,
                }
          }
          onMouseMove={!isPlaying ? handleGraphicsMouseMove : undefined}
          onClick={!isPlaying ? handleGraphicsClick : undefined}
          onMouseLeave={() => setHoveredGraphicClipId(null)}
        >
          <canvas
            ref={canvasRef}
            width={settings.width}
            height={settings.height}
            className="w-full h-full object-contain bg-black"
            style={{
              cursor: hoveredGraphicClipId && !isPlaying ? "pointer" : "default",
            }}
          />

          {/* Live recording preview — webcam shown INSIDE the player window
              (framed to the project aspect) while recording, so the user sees
              exactly what the take will look like on the timeline. */}
          <InlineRecordingPreview />

          {/* Motion Path Overlay */}
          {motionPathMode && motionPathConfig && motionPathClip && (
            <div className="absolute inset-0 pointer-events-auto z-30">
              <MotionPathOverlay
                config={motionPathConfig}
                canvasWidth={settings.width}
                canvasHeight={settings.height}
                currentTime={playheadPosition - motionPathClip.startTime}
                clipDuration={motionPathClip.duration}
                onPointMove={handleMotionPathPointMove}
                onPointAdd={handleMotionPathPointAdd}
                onPointRemove={handleMotionPathPointRemove}
                onControlPointMove={handleMotionPathControlPointMove}
                disabled={isPlaying}
              />
            </div>
          )}

          {/* Particle Effects Renderer */}
          {particleEffects.length > 0 && (
            <div className="absolute inset-0 pointer-events-none z-20">
              <ParticleRenderer
                effects={particleEffects}
                width={settings.width}
                height={settings.height}
                currentTime={playheadPosition}
                isPlaying={isPlaying}
              />
            </div>
          )}

          {/* Export Overlay */}
          {exportState.isExporting && (
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
              <div className="bg-background-secondary/95 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl border border-border">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                    <Loader2 size={20} className="text-primary animate-spin" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">
                      Exporting Video
                    </h3>
                    <p className="text-xs text-text-muted">
                      {exportState.phase || "Preparing..."}
                    </p>
                  </div>
                </div>

                <div className="mb-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-text-secondary">
                      Export Progress
                    </span>
                    <span className="text-[10px] text-text-muted font-mono">
                      {Math.round(exportState.progress)}%
                    </span>
                  </div>
                  <div className="h-2 bg-black/30 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-primary to-primary-hover transition-all duration-300"
                      style={{ width: `${exportState.progress}%` }}
                    />
                  </div>
                </div>

                <p className="text-[10px] text-text-muted text-center">
                  Please wait while your video is being exported...
                </p>
              </div>
            </div>
          )}

          {/* Resize/Transform Overlay */}
          {!cropMode && showResizeHandles && clipBounds && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: clipBounds.x,
                top: clipBounds.y,
                width: clipBounds.width,
                height: clipBounds.height,
              }}
            >
              {/* Selection border */}
              <div className="absolute inset-0 border-2 border-primary pointer-events-none" />

              {/* Move handle (center) */}
              <div
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-primary/80 rounded-full flex items-center justify-center cursor-move pointer-events-auto hover:bg-primary transition-colors"
                onMouseDown={handleClipMouseDown}
                title="Drag to move"
              >
                <Move size={14} className="text-white" />
              </div>

              {/* Aspect ratio lock toggle */}
              <button
                className={`absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 text-[10px] rounded pointer-events-auto transition-colors ${
                  lockAspectRatio
                    ? "bg-primary text-white"
                    : "bg-background-tertiary text-text-secondary border border-border hover:bg-background-elevated"
                }`}
                onClick={() => setLockAspectRatio(!lockAspectRatio)}
                title={
                  lockAspectRatio ? "Unlock aspect ratio" : "Lock aspect ratio"
                }
              >
                {lockAspectRatio ? "🔒 Locked" : "🔓 Free"}
              </button>

              {/* Corner resize handles */}
              <div
                className="absolute -left-2 -top-2 w-4 h-4 bg-white border-2 border-primary rounded-sm cursor-nw-resize pointer-events-auto hover:bg-primary hover:border-white transition-colors"
                onMouseDown={(e) => handleHandleMouseDown(e, "nw")}
              />
              <div
                className="absolute -right-2 -top-2 w-4 h-4 bg-white border-2 border-primary rounded-sm cursor-ne-resize pointer-events-auto hover:bg-primary hover:border-white transition-colors"
                onMouseDown={(e) => handleHandleMouseDown(e, "ne")}
              />
              <div
                className="absolute -left-2 -bottom-2 w-4 h-4 bg-white border-2 border-primary rounded-sm cursor-sw-resize pointer-events-auto hover:bg-primary hover:border-white transition-colors"
                onMouseDown={(e) => handleHandleMouseDown(e, "sw")}
              />
              <div
                className="absolute -right-2 -bottom-2 w-4 h-4 bg-white border-2 border-primary rounded-sm cursor-se-resize pointer-events-auto hover:bg-primary hover:border-white transition-colors"
                onMouseDown={(e) => handleHandleMouseDown(e, "se")}
              />

              {/* Edge resize handles */}
              <div
                className="absolute left-1/2 -translate-x-1/2 -top-2 w-6 h-4 bg-white border-2 border-primary rounded-sm cursor-n-resize pointer-events-auto hover:bg-primary hover:border-white transition-colors"
                onMouseDown={(e) => handleHandleMouseDown(e, "n")}
              />
              <div
                className="absolute left-1/2 -translate-x-1/2 -bottom-2 w-6 h-4 bg-white border-2 border-primary rounded-sm cursor-s-resize pointer-events-auto hover:bg-primary hover:border-white transition-colors"
                onMouseDown={(e) => handleHandleMouseDown(e, "s")}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -left-2 w-4 h-6 bg-white border-2 border-primary rounded-sm cursor-w-resize pointer-events-auto hover:bg-primary hover:border-white transition-colors"
                onMouseDown={(e) => handleHandleMouseDown(e, "w")}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -right-2 w-4 h-6 bg-white border-2 border-primary rounded-sm cursor-e-resize pointer-events-auto hover:bg-primary hover:border-white transition-colors"
                onMouseDown={(e) => handleHandleMouseDown(e, "e")}
              />
            </div>
          )}

          {/* Text Clip Resize/Transform Overlay */}
          {showTextClipHandles && textClipBounds && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: textClipBounds.x,
                top: textClipBounds.y,
                width: textClipBounds.width,
                height: textClipBounds.height,
              }}
            >
              {/* Selection border - cyan for text clips */}
              <div className="absolute inset-0 border-2 border-cyan-500 pointer-events-none" />

              {/* Move handle (center) */}
              <div
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-cyan-500/80 rounded-full flex items-center justify-center cursor-move pointer-events-auto hover:bg-cyan-500 transition-colors"
                onMouseDown={handleTextClipMouseDown}
                title="Drag to move text"
              >
                <Move size={14} className="text-white" />
              </div>

              {/* Aspect ratio lock toggle */}
              <button
                className={`absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 text-[10px] rounded pointer-events-auto transition-colors ${
                  lockAspectRatio
                    ? "bg-cyan-500 text-white"
                    : "bg-background-tertiary text-text-secondary border border-border hover:bg-background-elevated"
                }`}
                onClick={() => setLockAspectRatio(!lockAspectRatio)}
                title={
                  lockAspectRatio ? "Unlock aspect ratio" : "Lock aspect ratio"
                }
              >
                {lockAspectRatio ? "🔒 Locked" : "🔓 Free"}
              </button>

              {/* Corner resize handles */}
              <div
                className="absolute -left-2 -top-2 w-4 h-4 bg-white border-2 border-cyan-500 rounded-sm cursor-nw-resize pointer-events-auto hover:bg-cyan-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleTextHandleMouseDown(e, "nw")}
              />
              <div
                className="absolute -right-2 -top-2 w-4 h-4 bg-white border-2 border-cyan-500 rounded-sm cursor-ne-resize pointer-events-auto hover:bg-cyan-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleTextHandleMouseDown(e, "ne")}
              />
              <div
                className="absolute -left-2 -bottom-2 w-4 h-4 bg-white border-2 border-cyan-500 rounded-sm cursor-sw-resize pointer-events-auto hover:bg-cyan-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleTextHandleMouseDown(e, "sw")}
              />
              <div
                className="absolute -right-2 -bottom-2 w-4 h-4 bg-white border-2 border-cyan-500 rounded-sm cursor-se-resize pointer-events-auto hover:bg-cyan-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleTextHandleMouseDown(e, "se")}
              />

              {/* Edge resize handles */}
              <div
                className="absolute left-1/2 -translate-x-1/2 -top-2 w-6 h-4 bg-white border-2 border-cyan-500 rounded-sm cursor-n-resize pointer-events-auto hover:bg-cyan-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleTextHandleMouseDown(e, "n")}
              />
              <div
                className="absolute left-1/2 -translate-x-1/2 -bottom-2 w-6 h-4 bg-white border-2 border-cyan-500 rounded-sm cursor-s-resize pointer-events-auto hover:bg-cyan-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleTextHandleMouseDown(e, "s")}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -left-2 w-4 h-6 bg-white border-2 border-cyan-500 rounded-sm cursor-w-resize pointer-events-auto hover:bg-cyan-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleTextHandleMouseDown(e, "w")}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -right-2 w-4 h-6 bg-white border-2 border-cyan-500 rounded-sm cursor-e-resize pointer-events-auto hover:bg-cyan-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleTextHandleMouseDown(e, "e")}
              />
            </div>
          )}

          {/* Shape Clip Resize/Transform Overlay */}
          {showShapeClipHandles && shapeClipBounds && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: shapeClipBounds.x,
                top: shapeClipBounds.y,
                width: shapeClipBounds.width,
                height: shapeClipBounds.height,
              }}
            >
              {/* Selection border - green for shape clips */}
              <div className="absolute inset-0 border-2 border-green-500 pointer-events-none" />

              {/* Move handle (center) */}
              <div
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-green-500/80 rounded-full flex items-center justify-center cursor-move pointer-events-auto hover:bg-green-500 transition-colors"
                onMouseDown={handleShapeClipMouseDown}
                title="Drag to move shape"
              >
                <Move size={14} className="text-white" />
              </div>

              {/* Aspect ratio lock toggle */}
              <button
                className={`absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 text-[10px] rounded pointer-events-auto transition-colors ${
                  lockAspectRatio
                    ? "bg-green-500 text-white"
                    : "bg-background-tertiary text-text-secondary border border-border hover:bg-background-elevated"
                }`}
                onClick={() => setLockAspectRatio(!lockAspectRatio)}
                title={
                  lockAspectRatio ? "Unlock aspect ratio" : "Lock aspect ratio"
                }
              >
                {lockAspectRatio ? "🔒 Locked" : "🔓 Free"}
              </button>

              {/* Corner resize handles */}
              <div
                className="absolute -left-2 -top-2 w-4 h-4 bg-white border-2 border-green-500 rounded-sm cursor-nw-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "nw")}
              />
              <div
                className="absolute -right-2 -top-2 w-4 h-4 bg-white border-2 border-green-500 rounded-sm cursor-ne-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "ne")}
              />
              <div
                className="absolute -left-2 -bottom-2 w-4 h-4 bg-white border-2 border-green-500 rounded-sm cursor-sw-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "sw")}
              />
              <div
                className="absolute -right-2 -bottom-2 w-4 h-4 bg-white border-2 border-green-500 rounded-sm cursor-se-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "se")}
              />

              {/* Edge resize handles */}
              <div
                className="absolute left-1/2 -translate-x-1/2 -top-2 w-6 h-4 bg-white border-2 border-green-500 rounded-sm cursor-n-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "n")}
              />
              <div
                className="absolute left-1/2 -translate-x-1/2 -bottom-2 w-6 h-4 bg-white border-2 border-green-500 rounded-sm cursor-s-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "s")}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -left-2 w-4 h-6 bg-white border-2 border-green-500 rounded-sm cursor-w-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "w")}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -right-2 w-4 h-6 bg-white border-2 border-green-500 rounded-sm cursor-e-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "e")}
              />
            </div>
          )}

          {/* Subtitle Selection Overlay */}
          {showSubtitleOverlay && subtitleBounds && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: subtitleBounds.x,
                top: subtitleBounds.y,
                width: subtitleBounds.width,
                height: subtitleBounds.height,
              }}
            >
              {/* Selection border - yellow/orange for subtitles */}
              <div className="absolute inset-0 border-2 border-yellow-500 rounded-lg pointer-events-none animate-pulse" />
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-yellow-500 rounded text-[10px] font-medium text-black whitespace-nowrap">
                Subtitle Selected - Edit in Inspector
              </div>
            </div>
          )}

          {/* Graphic Clip Hover Indicators */}
          {!cropMode && !isPlaying &&
            activeGraphicClips.map((clip) => {
              if (clip.id === selectedShapeClipId) return null;
              if (clip.id !== hoveredGraphicClipId) return null;
              const bounds = getGraphicClipDisplayBounds(clip);
              if (!bounds) return null;
              return (
                <div
                  key={clip.id}
                  className="absolute pointer-events-none z-10"
                  style={{
                    left: bounds.x,
                    top: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                  }}
                >
                  <div className="absolute inset-0 border-2 border-dashed border-white/80 rounded-sm" />
                  <div
                    aria-hidden="true"
                    className="absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-black/70 rounded text-[10px] text-white whitespace-nowrap"
                  >
                    Click to select
                  </div>
                </div>
              );
            })}
        </div>
        </div>
      </div>

      {/* Player Controls with integrated Scrub Bar */}
      <div
        className={`border-t border-border transition-all duration-300 ${
          isFullscreen
            ? "absolute bottom-0 left-0 right-0 z-50 bg-background-secondary backdrop-blur-sm"
            : "z-20 bg-background-secondary"
        }`}
      >
        {/* Controls row. The transport sits HERE, with the picture it drives,
            and is centred absolutely rather than as a flex child — the badge on
            the left and the settings cluster on the right are different widths,
            so a plain justify-between would park play/pause off-centre and it
            would drift every time a badge appeared or a label changed length.
            The row survives any timeline resize (see EditorInterface's floor),
            so playback controls never leave the screen. */}
        <div className="h-12 shrink-0 px-6 grid grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-3">
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          {/* The playhead time lives on the TRANSPORT, next to the controls
              that move it. It was printed here as well, so the same number sat
              in two toolbars a few pixels apart — and the two used different
              formats, which made them read as two different values. */}
          {rendererType !== "none" && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                rendererType === "webgpu"
                  ? "bg-green-500/20 text-green-400"
                  : "bg-gray-500/20 text-gray-400"
              }`}
              title={`Rendering with ${rendererType.toUpperCase()}`}
            >
              {rendererType.toUpperCase()}
            </span>
          )}
        </div>

        {/* Centre column. `auto` width means the transport takes exactly the
            room it needs and the two 1fr columns split what is left equally —
            so it is geometrically centred no matter how wide the badge or the
            settings cluster get, and the three columns can never overlap the
            way an absolutely-placed element could.
            The right track is minmax(max-content,1fr), not a plain 1fr: equal
            columns meant the settings cluster could never be wider than the
            near-empty badge column, and one pixel of shortfall wrapped
            "Prerender" and "RAM 4G" onto a second line inside a 48px row. It
            now keeps its natural width and the left column gives up the
            difference, so the transport drifts off dead-centre on a narrow
            window instead of the controls breaking. */}
        <div className="flex items-center justify-center">
          <Transport />
        </div>

        <div className="flex gap-2 items-center justify-end whitespace-nowrap">
          <button
            onClick={() => setIsMuted(!isMuted)}
            className={`p-2 rounded-lg hover:bg-background-elevated transition-colors ${
              isMuted
                ? "text-red-500"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>

          {/* Preview Quality */}
          <div className="relative">
            <button
              onClick={() => setShowQualityMenu(!showQualityMenu)}
              className="px-2 py-1 rounded-lg text-xs font-mono text-text-secondary hover:text-text-primary hover:bg-background-elevated transition-colors"
              title="Preview Quality (lower = smoother playback)"
            >
              <div className="flex items-center gap-1">
                <Gauge size={14} />
                <span>{QUALITY_OPTIONS.find((q) => q.value === previewQuality)?.label ?? "Auto"}</span>
              </div>
            </button>
            {showQualityMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowQualityMenu(false)}
                />
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-background-elevated border border-border rounded-lg shadow-xl py-1 z-50 min-w-[80px]">
                  {QUALITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setPreviewQuality(opt.value);
                        setShowQualityMenu(false);
                      }}
                      className={`w-full px-3 py-1.5 text-xs font-mono text-left hover:bg-background-secondary transition-colors ${
                        previewQuality === opt.value
                          ? "text-primary"
                          : "text-text-secondary"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Prerender — frame-by-frame deterministic cache fill (no gaps) */}
          <button
            onClick={async () => {
              if (prerenderActive) {
                prerenderCancelRef.current = true;
                return;
              }
              if (isPlaying) togglePlayback();
              const startFrom = playheadPositionRef.current;
              prerenderCancelRef.current = false;
              setPrerenderActive(true);
              setPrerenderProgress(0);

              const fps = 30;
              const startFn = Math.round(startFrom * fps);
              const endFn = Math.max(startFn + 1, Math.ceil(actualEndTime * fps));

              try {
                for (let fn = startFn; fn < endFn; fn++) {
                  if (prerenderCancelRef.current) break;
                  // Memory-budget guard
                  const stats = ramCacheRef.current.getStats();
                  if (stats.memoryBytes > stats.maxMemoryBytes * 0.95) {
                    console.log('[RAM] prerender stopping at frame', fn, '— memory budget reached');
                    break;
                  }
                  // Skip already-cached frames
                  if (ramCacheRef.current.get(fn)) {
                    if (fn % 50 === 0) setPrerenderProgress((fn - startFn) / (endFn - startFn));
                    continue;
                  }
                  // Render this frame deterministically (await completion)
                  const t = fn / fps;
                  await renderFrameDirectlyRef.current(t);
                  // Capture the rendered frame from offscreen and cache it
                  if (offscreenCanvasRef.current) {
                    downscaleAndCache(offscreenCanvasRef.current, fn);
                  }
                  // Yield to browser every 5 frames so UI stays responsive
                  if (fn % 5 === 0) {
                    setPrerenderProgress((fn - startFn) / (endFn - startFn));
                    const range = ramCacheRef.current.getCachedRange();
                    setRamCacheCount(range.length);
                    setRamCacheState(range, endFn);
                    await new Promise(r => setTimeout(r, 0));
                  }
                }
              } catch (e) {
                console.warn('[RAM] prerender error:', e);
              }

              // Final state push
              const finalRange = ramCacheRef.current.getCachedRange();
              setRamCacheCount(finalRange.length);
              setRamCacheState(finalRange, endFn);
              setPlayheadPosition(startFrom);
              // Re-render the original frame so the canvas matches the playhead
              await renderFrameDirectlyRef.current(startFrom);
              setPrerenderActive(false);
              setPrerenderProgress(0);
              prerenderCancelRef.current = false;
              console.log('[RAM] prerender done. cached:', finalRange.length, 'frames, mem:', Math.round(ramCacheRef.current.getStats().memoryBytes / 1024 / 1024), 'MB');
            }}
            className={`px-2 py-1 rounded-lg text-xs font-mono transition-colors ${
              prerenderActive
                ? "text-amber-400 hover:text-amber-300 bg-amber-500/10"
                : "text-text-secondary hover:text-text-primary hover:bg-background-elevated"
            }`}
            title={prerenderActive
              ? "Click to cancel prerender"
              : "Prerender — render every frame deterministically into the cache"
            }
          >
            <div className="flex items-center gap-1">
              {prerenderActive ? (
                <span>⚡ {Math.round(prerenderProgress * 100)}%</span>
              ) : (
                <span>⚡ Prerender</span>
              )}
            </div>
          </button>

          {/* RAM Preview indicator + limit selector */}
          <div className="relative">
            <button
              onClick={() => setShowRamMenu(!showRamMenu)}
              className={`px-2 py-1 rounded-lg text-xs font-mono transition-colors ${
                ramCacheCount > 0
                  ? "text-green-400 hover:text-green-300 hover:bg-background-elevated"
                  : "text-text-secondary hover:text-text-primary hover:bg-background-elevated"
              }`}
              title={`RAM Preview: ${ramCacheCount} frames cached (${ramMaxGB} GB limit). Click to configure.`}
            >
              <div className="flex items-center gap-1">
                {ramCacheCount > 0 && <span className="w-1.5 h-1.5 rounded-full bg-green-400" />}
                <span>RAM {ramMaxGB}G</span>
              </div>
            </button>
            {showRamMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowRamMenu(false)} />
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-background-elevated border border-border rounded-lg shadow-xl py-1 z-50 min-w-[100px]">
                  {[0.5, 1, 2, 4, 8, 16, 32].map((gb) => (
                    <button
                      key={gb}
                      onClick={() => { useSettingsStore.getState().setRamPreviewMaxGB(gb); setShowRamMenu(false); }}
                      className={`w-full px-3 py-1.5 text-xs font-mono text-left hover:bg-background-secondary transition-colors ${
                        ramMaxGB === gb ? "text-primary" : "text-text-secondary"
                      }`}
                    >
                      {gb >= 1 ? `${gb} GB` : `${gb * 1024} MB`}
                    </button>
                  ))}
                  <div className="border-t border-border mt-1 pt-1">
                    <button
                      onClick={() => { ramCacheRef.current.clear(); setRamCacheCount(0); setShowRamMenu(false); }}
                      className="w-full px-3 py-1.5 text-xs font-mono text-left text-red-400 hover:bg-background-secondary transition-colors"
                    >
                      Clear cache
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Zoom Control */}
          <div className="relative">
            <button
              onClick={() => setShowZoomMenu(!showZoomMenu)}
              className="px-2 py-1 rounded-lg text-xs font-mono text-text-secondary hover:text-text-primary hover:bg-background-elevated transition-colors"
              title="Preview Zoom"
            >
              <div className="flex items-center gap-1">
                <ZoomIn size={14} />
                <span>{Math.round(zoomLevel * 100)}%</span>
              </div>
            </button>
            {showZoomMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowZoomMenu(false)}
                />
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-background-elevated border border-border rounded-lg shadow-xl py-1 z-50 min-w-[80px]">
                  {ZOOM_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setZoomLevel(opt.value);
                        setShowZoomMenu(false);
                      }}
                      className={`w-full px-3 py-1.5 text-xs font-mono text-left hover:bg-background-secondary transition-colors ${
                        zoomLevel === opt.value
                          ? "text-primary"
                          : "text-text-secondary"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* No mx-* here: the flex row already supplies gap-2 on both sides,
              and the extra margin was 16px the cluster could not spare. */}
          <div className="w-px h-4 bg-border shrink-0" />
          {/* ONE expand control, and it does the obvious thing: real
              fullscreen. There were two buttons here — a monitor icon for
              fullscreen and an expand icon for an in-app "maximize" — sitting
              side by side with near-identical meaning, so the expand arrows
              (the one people reach for) gave the lesser of the two. */}
          <button
            onClick={handleFullscreen}
            title={isFullscreen ? "Exit full screen (Esc)" : "Full screen"}
            className={`p-2 rounded-lg transition-colors ${
              isFullscreen
                ? "text-primary bg-primary/20"
                : "text-text-secondary hover:text-text-primary hover:bg-background-elevated"
            }`}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
};

export default Preview;
