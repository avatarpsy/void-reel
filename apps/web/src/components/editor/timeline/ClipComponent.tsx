import React, { useRef, useState, useEffect, useLayoutEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import { Image } from "lucide-react";
import type { Clip, Track } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { ensureMediaWaveform } from "../../../services/waveform-service";
import { ensureMediaFilmstrip } from "../../../services/filmstrip-service";
import { calculateSnap, getClipStyle } from "./utils";
import { WaveformCanvas } from "./WaveformCanvas";
import { VolumeAutomationOverlay } from "./VolumeAutomationOverlay";
import { ClipContextMenu } from "./ClipContextMenu";
import { ContextMenu, ContextMenuTrigger } from "@openreel/ui";
import { useEditMonitorStore, formatFrameDelta } from "../../../stores/edit-monitor-store";
import {
  canSlip,
  clampFade,
  clampSlipIn,
  commitFade,
  commitSlip,
  geomOf,
  patchClips,
  sourceDurationOf,
  useFineEditDrag,
  sourceSpan,
  SLIP_CURSOR,
  type ClipGeom,
} from "./fine-edit";

interface ClipComponentProps {
  clip: Clip;
  track: Track;
  allTracks: Track[];
  pixelsPerSecond: number;
  isSelected: boolean;
  trackHeights: Map<string, number>;
  timelineRef: React.RefObject<HTMLDivElement>;
  onSelect: (clipId: string, addToSelection: boolean) => void;
  onMoveClip: (
    clipId: string,
    newStartTime: number,
    targetTrackId?: string,
  ) => void;
  onSnapIndicator: (time: number | null) => void;
  onTrimClip?: (
    clipId: string,
    edge: "left" | "right",
    newTime: number,
  ) => void;
  /** Fired on trim-handle release — commits the gesture to undo history. */
  onTrimEnd?: (clipId: string) => void;
}

/** The source-anchored filmstrip: fixed 64px tiles, each the frame at its
 *  source time. Shared by the clip body and the slip ghost. */
const FilmstripTiles: React.FC<{
  band: { tiles: { url: string }[]; width: number };
  offsetPx: number;
  className: string;
}> = ({ band, offsetPx, className }) => (
  <div
    className={`absolute top-0 bottom-0 flex ${className}`}
    style={{ width: `${band.width}px`, transform: `translateX(${offsetPx}px)` }}
  >
    {band.tiles.map((tile, i) => (
      <div
        key={i}
        className="h-full flex-none bg-cover bg-center"
        style={{ width: "64px", backgroundImage: `url(${tile.url})` }}
      />
    ))}
  </div>
);

const AUTO_SCROLL_THRESHOLD = 80;
const AUTO_SCROLL_SPEED = 10;
const DRAG_THRESHOLD = 5;

export const ClipComponent: React.FC<ClipComponentProps> = ({
  clip,
  track,
  allTracks,
  pixelsPerSecond,
  isSelected,
  trackHeights,
  timelineRef,
  onSelect,
  onMoveClip,
  onSnapIndicator,
  onTrimClip,
  onTrimEnd,
}) => {
  const { getMediaItem, setMediaWaveform, setMediaFilmstrip } = useProjectStore();
  const { snapSettings } = useUIStore();
  const { playheadPosition } = useTimelineStore();
  const mediaItem = getMediaItem(clip.mediaId);
  const [isDragging, setIsDragging] = useState(false);
  const [isPendingDrag, setIsPendingDrag] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragYOffset, setDragYOffset] = useState(0);
  const [isInvalidDrop, setIsInvalidDrop] = useState(false);
  const [isTrimming, setIsTrimming] = useState(false);
  const [trimEdge, setTrimEdge] = useState<"left" | "right" | null>(null);
  const trimStartRef = useRef<{
    mouseX: number;
    startTime: number;
    duration: number;
  }>({
    mouseX: 0,
    startTime: clip.startTime,
    duration: clip.duration,
  });
  const dragStartRef = useRef<{ mouseY: number; clipY: number; scrollTop: number }>({
    mouseY: 0,
    clipY: 0,
    scrollTop: 0,
  });
  const mousePositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pendingDropRef = useRef<{ time: number; targetTrackId?: string }>({ time: 0 });
  const dragPendingRef = useRef<{ active: boolean; startX: number; startY: number }>({
    active: false,
    startX: 0,
    startY: 0,
  });
  const clipRef = useRef<HTMLDivElement>(null);

  // ── Fine edits (see fine-edit.ts): Alt+drag slip, corner fade handles ──
  const fps = useProjectStore((s) => s.project.settings.frameRate) || 30;
  const setMonitor = useEditMonitorStore((s) => s.setMonitor);
  const slippable = canSlip(mediaItem) && !track.locked;
  const [isSlipping, setIsSlipping] = useState(false);
  const slipRef = useRef({ mouseX: 0, orig: geomOf(clip) as ClipGeom, span: 0, srcDur: Infinity, lastIn: 0 });
  const [fadeDrag, setFadeDrag] = useState<"in" | "out" | null>(null);
  const fadeRef = useRef({ mouseX: 0, orig: { fadeIn: 0, fadeOut: 0 }, last: { fadeIn: 0, fadeOut: 0 } });
  // Alt held over the clip → show the slip cursor before the press.
  const [hovered, setHovered] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    if (!hovered) return;
    const sync = (e: KeyboardEvent) => setAltHeld(e.altKey);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
    };
  }, [hovered]);

  const left = clip.startTime * pixelsPerSecond;
  const width = clip.duration * pixelsPerSecond;

  const isVideo = track.type === "video";
  const isAudio = track.type === "audio";
  const isImage = track.type === "image";
  const clipStyle = getClipStyle(track.type);

  const handleClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (isDragging || isPendingDrag) return;
    e.stopPropagation();
    onSelect(clip.id, e.shiftKey || e.metaKey);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (track.locked || isTrimming) return;
    e.stopPropagation();

    // Alt + drag = SLIP: same place, same length, different frames.
    if (e.altKey && slippable) {
      e.preventDefault();
      const orig = geomOf(clip);
      slipRef.current = {
        mouseX: e.clientX,
        orig,
        span: sourceSpan(clip),
        srcDur: sourceDurationOf(mediaItem),
        lastIn: orig.inPoint,
      };
      onSelect(clip.id, false);
      setIsSlipping(true);
      return;
    }

    const rect = clipRef.current?.parentElement?.getBoundingClientRect();
    const clipRect = clipRef.current?.getBoundingClientRect();
    if (!rect || !clipRect) return;

    const clickX = e.clientX - rect.left;
    const clipStartX = clip.startTime * pixelsPerSecond;
    setDragOffset(clickX - clipStartX);

    dragStartRef.current = {
      mouseY: e.clientY,
      clipY: clipRect.top - rect.top,
      scrollTop: timelineRef.current?.scrollTop || 0,
    };
    mousePositionRef.current = { x: e.clientX, y: e.clientY };
    dragPendingRef.current = { active: true, startX: e.clientX, startY: e.clientY };
    setDragYOffset(0);
    setIsInvalidDrop(false);
    setIsPendingDrag(true);
  };

  const handleTrimMouseDown =
    (edge: "left" | "right") => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if (track.locked || !onTrimClip) return;
      e.stopPropagation();
      setIsTrimming(true);
      setTrimEdge(edge);
      trimStartRef.current = {
        mouseX: e.clientX,
        startTime: clip.startTime,
        duration: clip.duration,
      };
      document.body.style.cursor = "ew-resize";
    };

  useLayoutEffect(() => {
    if (!isPendingDrag) return;

    const handlePendingMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragPendingRef.current.startX;
      const dy = e.clientY - dragPendingRef.current.startY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance >= DRAG_THRESHOLD) {
        dragPendingRef.current.active = false;
        // A fast gesture can release before React's next scheduled render.
        // Install the active drag's layout listeners in this same event.
        flushSync(() => { setIsPendingDrag(false); setIsDragging(true); });
      }
    };

    const handlePendingMouseUp = (e: MouseEvent) => {
      dragPendingRef.current.active = false;
      setIsPendingDrag(false);
      onSelect(clip.id, e.shiftKey || e.metaKey);
    };

    window.addEventListener("mousemove", handlePendingMouseMove);
    window.addEventListener("mouseup", handlePendingMouseUp);

    return () => {
      window.removeEventListener("mousemove", handlePendingMouseMove);
      window.removeEventListener("mouseup", handlePendingMouseUp);
    };
  }, [isPendingDrag, clip.id, onSelect]);

  useLayoutEffect(() => {
    if (!isDragging) return;

    let animationFrameId: number | null = null;

    const scrollLoop = () => {
      if (!timelineRef.current) {
        animationFrameId = requestAnimationFrame(scrollLoop);
        return;
      }

      const timeline = timelineRef.current;
      const timelineRect = timeline.getBoundingClientRect();
      const mouseY = mousePositionRef.current.y;
      const timelineTop = timelineRect.top;
      const timelineBottom = timelineRect.bottom;
      const canScrollUp = timeline.scrollTop > 0;
      const canScrollDown = timeline.scrollTop < timeline.scrollHeight - timeline.clientHeight;

      const distanceFromTop = mouseY - timelineTop;
      const distanceFromBottom = timelineBottom - mouseY;

      if (distanceFromTop < AUTO_SCROLL_THRESHOLD && canScrollUp) {
        timeline.scrollTop -= AUTO_SCROLL_SPEED;
      } else if (distanceFromBottom < AUTO_SCROLL_THRESHOLD && canScrollDown) {
        timeline.scrollTop += AUTO_SCROLL_SPEED;
      }

      animationFrameId = requestAnimationFrame(scrollLoop);
    };

    animationFrameId = requestAnimationFrame(scrollLoop);

    const handleMouseMove = (e: MouseEvent) => {
      mousePositionRef.current.x = e.clientX;
      mousePositionRef.current.y = e.clientY;

      const rect = clipRef.current?.parentElement?.getBoundingClientRect();
      const timelineRect = timelineRef.current?.getBoundingClientRect();
      if (!rect || !timelineRect) return;

      const x = e.clientX - rect.left - dragOffset;
      const rawTime = Math.max(0, x / pixelsPerSecond);

      const dragSnapSettings = { ...snapSettings, snapToPlayhead: false };
      const snapResult = calculateSnap(
        rawTime,
        clip.id,
        allTracks,
        playheadPosition,
        dragSnapSettings,
        pixelsPerSecond,
        clip.duration,
      );
      const currentScrollTop = timelineRef.current?.scrollTop || 0;
      const scrollDelta = currentScrollTop - dragStartRef.current.scrollTop;
      const yDelta = (e.clientY - dragStartRef.current.mouseY) + scrollDelta;
      setDragYOffset(yDelta);

      const scrollTop = timelineRef.current?.scrollTop || 0;
      const mouseY = e.clientY - timelineRect.top + scrollTop;
      let targetTrackId: string | undefined;
      let hoveredTrackType: string | undefined;
      let cumulativeY = 0;

      for (const t of allTracks) {
        const height = trackHeights.get(t.id) || 60;
        if (mouseY >= cumulativeY && mouseY < cumulativeY + height) {
          hoveredTrackType = t.type;
          if (t.type === track.type && t.id !== track.id) {
            targetTrackId = t.id;
          }
          break;
        }
        cumulativeY += height;
      }

      const isOverDifferentTrackType = hoveredTrackType !== undefined && hoveredTrackType !== track.type;
      setIsInvalidDrop(isOverDifferentTrackType);

      pendingDropRef.current = { time: snapResult.time, targetTrackId };
      onMoveClip(clip.id, snapResult.time, undefined);
      onSnapIndicator(snapResult.snapped && snapResult.snapPoint ? snapResult.snapPoint.time : null);
    };

    const handleMouseUp = (event: MouseEvent) => {
      // The first move may only cross the drag threshold. Always commit the
      // actual release position, even when no further move event was delivered.
      handleMouseMove(event);
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }

      const { time, targetTrackId } = pendingDropRef.current;
      if (targetTrackId) {
        onMoveClip(clip.id, time, targetTrackId);
      }

      setIsDragging(false);
      setDragYOffset(0);
      setIsInvalidDrop(false);
      onSnapIndicator(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [
    isDragging,
    dragOffset,
    pixelsPerSecond,
    clip.id,
    track.id,
    track.type,
    allTracks,
    trackHeights,
    timelineRef,
    playheadPosition,
    snapSettings,
    onMoveClip,
    onSnapIndicator,
  ]);

  useLayoutEffect(() => {
    if (!isTrimming || !trimEdge || !onTrimClip) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - trimStartRef.current.mouseX;
      const deltaTime = deltaX / pixelsPerSecond;

      if (trimEdge === "left") {
        const newStartTime = Math.max(
          0,
          trimStartRef.current.startTime + deltaTime,
        );
        const maxStartTime =
          trimStartRef.current.startTime + trimStartRef.current.duration - 0.1;
        const clampedStartTime = Math.min(newStartTime, maxStartTime);
        onTrimClip(clip.id, "left", clampedStartTime);
      } else {
        const newEndTime =
          trimStartRef.current.startTime +
          trimStartRef.current.duration +
          deltaTime;
        const minEndTime = trimStartRef.current.startTime + 0.1;
        const clampedEndTime = Math.max(newEndTime, minEndTime);
        onTrimClip(clip.id, "right", clampedEndTime);
      }
    };

    const handleMouseUp = () => {
      setIsTrimming(false);
      setTrimEdge(null);
      document.body.style.cursor = "";
      // Commit the gesture as ONE undoable history entry.
      onTrimEnd?.(clip.id);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isTrimming, trimEdge, clip.id, pixelsPerSecond, onTrimClip, onTrimEnd]);

  // SLIP — grabbing the film: drag right and the frames move right, so the
  // clip starts on an EARLIER source frame. Frame-quantised, held inside the
  // source, shown two-up in the viewer, committed as one undo step.
  const showSlip = (inPoint: number) => {
    const { orig, span } = slipRef.current;
    setMonitor({
      title: "Slip",
      badge: formatFrameDelta(inPoint - orig.inPoint, fps),
      frames: [
        { mediaId: clip.mediaId, time: inPoint, label: "First frame" },
        { mediaId: clip.mediaId, time: Math.max(inPoint, inPoint + span - 1 / fps), label: "Last frame" },
      ],
    });
  };
  useLayoutEffect(() => {
    if (isSlipping) showSlip(slipRef.current.orig.inPoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSlipping]);
  useFineEditDrag(
    isSlipping,
    SLIP_CURSOR,
    (e) => {
      const sess = slipRef.current;
      const want = Math.round((sess.orig.inPoint - (e.clientX - sess.mouseX) / pixelsPerSecond) * fps) / fps;
      const inPoint = clampSlipIn(want, sess.span, sess.srcDur);
      if (Math.abs(inPoint - sess.lastIn) < 1e-9) return;
      sess.lastIn = inPoint;
      patchClips({ [clip.id]: { inPoint, outPoint: inPoint + sess.span } });
      showSlip(inPoint);
    },
    (commit) => {
      const sess = slipRef.current;
      setIsSlipping(false);
      setMonitor(null);
      void commitSlip(clip.id, sess.orig, commit ? sess.lastIn : sess.orig.inPoint);
    },
  );

  // FADES — the corner handle sits at the end of the ramp; pull it inward to
  // lengthen the fade. clip.fade is the audio fade playback and export apply.
  const handleFadeMouseDown = (which: "in" | "out") => (e: React.MouseEvent) => {
    if (e.button !== 0 || track.locked) return;
    e.stopPropagation();
    e.preventDefault();
    const cur = { fadeIn: clip.fade?.fadeIn ?? 0, fadeOut: clip.fade?.fadeOut ?? 0 };
    fadeRef.current = { mouseX: e.clientX, orig: cur, last: cur };
    onSelect(clip.id, false);
    setFadeDrag(which);
  };
  useFineEditDrag(
    fadeDrag !== null,
    "ew-resize",
    (e) => {
      const sess = fadeRef.current;
      const dx = (e.clientX - sess.mouseX) / pixelsPerSecond;
      const q = (v: number) => Math.round(v * fps) / fps;
      const { fadeIn: fi, fadeOut: fo } = sess.orig;
      sess.last =
        fadeDrag === "in"
          ? { fadeIn: clampFade(q(fi + dx), fo, clip.duration), fadeOut: fo }
          : { fadeIn: fi, fadeOut: clampFade(q(fo - dx), fi, clip.duration) };
      patchClips({ [clip.id]: { fade: sess.last } });
    },
    (commit) => {
      const sess = fadeRef.current;
      setFadeDrag(null);
      void commitFade(clip.id, sess.orig, commit ? sess.last : sess.orig);
    },
  );

  // Lazily generate + cache waveform peaks for any audio/video media
  // that arrived without them (remote Voidspace assets, agent-added
  // clips). Deduped + concurrency-limited in the service; the store
  // patch is runtime-only (not persisted). Drives the envelope below
  // and is not mode-gated, so waveforms show in video mode too.
  useEffect(() => {
    if (!mediaItem) return;
    // Only treat a NON-EMPTY waveform as "done" — a zero-length array (a past
    // failed decode) must not block regeneration.
    if ((mediaItem.waveformData?.length ?? 0) > 0) return;
    if (mediaItem.type !== "audio" && mediaItem.type !== "video") return;
    let cancelled = false;
    const projectId = useProjectStore.getState().project.id;
    void ensureMediaWaveform(mediaItem, projectId).then((res) => {
      if (cancelled || !res) return;
      setMediaWaveform(mediaItem.id, res.peaks);
      // The decoder also gave us the REAL audio length — heal a clip whose
      // stored duration was wrong (e.g. an 11s narration saved as 1s).
      if (res.duration > 0) {
        useProjectStore.getState().healClipDurationFromMedia(clip.id, mediaItem.id, res.duration);
      }
    });
    return () => {
      cancelled = true;
    };
    // `!!mediaItem?.blob` matters: an early attempt can fail while the blob
    // is still hydrating (remote project just loaded); when the blob lands
    // this retriggers so the real waveform replaces the placeholder line.
  }, [mediaItem?.id, mediaItem?.waveformData, mediaItem?.type, !!mediaItem?.blob, clip.id, setMediaWaveform]);

  // Lazily generate filmstrip thumbnails for VIDEO media that arrived
  // without them (remote scene videos) — otherwise the clip falls back to
  // a single tiled poster that stretches on trim instead of revealing
  // frames anchored to media time.
  useEffect(() => {
    if (!mediaItem || mediaItem.type !== "video") return;
    if ((mediaItem.filmstripThumbnails?.length ?? 0) > 0) return;
    let cancelled = false;
    const projectId = useProjectStore.getState().project.id;
    void ensureMediaFilmstrip(mediaItem, projectId).then((thumbs) => {
      if (!cancelled && thumbs && thumbs.length > 0) {
        setMediaFilmstrip(mediaItem.id, thumbs);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mediaItem?.id, mediaItem?.filmstripThumbnails, mediaItem?.type, !!mediaItem?.blob, setMediaFilmstrip]);

  // Trim-accurate waveform window (fractions of the source). The dense
  // canvas render itself is memoized inside <WaveformCanvas>.
  const wavePeaks = mediaItem?.waveformData ?? null;
  // Source length for the window DENOMINATOR. The peaks array is the domain
  // being indexed, so derive the length from it (100 samples/sec) whenever
  // peaks exist — metadata.duration is 0 or a placeholder for many
  // Voidspace/AI assets, and the old `|| 0` guard then collapsed the window
  // to [0,1]: the WHOLE file stretched across the clip, so trimming looked
  // like the waveform was SHRINKING instead of being cropped.
  // The window denominator MUST be the MAX of all duration signals — never
  // smaller than the trimmable numerator (clip.outPoint). For VIDEO,
  // peaks.length/100 (the decoded audio-track length) can be SHORTER than
  // clip.outPoint (which is the storyboard sceneDuration, never healed for
  // video the way audio is), so a plain `peaksDur || metadata` denominator
  // let waveEndFrac exceed 1 → WaveformCanvas clamps it to 1 → the window
  // FREEZES while the clip width shrinks on trim → the whole waveform
  // rescales ("stretch as a whole") instead of cropping. Taking the max
  // guarantees waveEndFrac ≤ 1, so the window always tracks the trim. Audio
  // is unaffected (heal makes all three equal).
  const peaksDur = wavePeaks && wavePeaks.length > 0 ? wavePeaks.length / 100 : 0;
  const sourceDuration = Math.max(
    peaksDur,
    mediaItem?.metadata?.duration || 0,
    clip.outPoint || 0,
  );
  const waveStartFrac = sourceDuration > 0 ? clip.inPoint / sourceDuration : 0;
  const waveEndFrac =
    sourceDuration > 0 && clip.outPoint > 0
      ? clip.outPoint / sourceDuration
      : 1;

  const hasFilmstrip = (mediaItem?.filmstripThumbnails?.length ?? 0) > 0;
  // `clip.mediaId` is typed as required but a malformed/partially-written clip
  // can reach the timeline without one (interrupted save, a bridge call that
  // failed mid-way, hand-edited project_state). Calling .slice on it threw
  // inside render, which the ErrorBoundary turned into "timeline failed to
  // load" for the WHOLE project — one bad clip taking down every good one.
  // Degrade to a placeholder label instead.
  const clipName = mediaItem?.name || clip.mediaId?.slice(0, 8) || "untitled clip";

  const isInteracting = isDragging || isTrimming || isSlipping || fadeDrag !== null;

  // Filmstrip — a SOURCE-ANCHORED band, not per-clip-window tiles. Each tile is
  // a fixed 64px cell whose frame is the source time at that band position
  // (tileIndex·64 / pxPerSec, in SOURCE coordinates spanning [0, sourceDur]).
  // The band is rendered ONCE (memoised on the strip + zoom, NOT on trim state)
  // and positioned inside the clip's overflow-hidden box via translateX(
  // -inPoint·pps). Because a LEFT trim moves startTime and inPoint by the SAME
  // delta (see handleTrimClip), clipLeft(startTime·pps) + bandOffset(-inPoint·
  // pps) = (startTime−inPoint)·pps is INVARIANT — so frames never slide under a
  // left trim; the clip's left edge just advances and clips earlier frames. A
  // RIGHT trim changes neither startTime nor inPoint, so the band is untouched
  // and the right edge clips later frames. Left and right are now identical:
  // trimming reveals/hides frames at the moving edge, it never re-tiles or
  // slides them — and it's pure CSS during the drag (no per-frame recompute).
  const filmstripBand = useMemo(() => {
    if (!isVideo || !hasFilmstrip) return { tiles: [] as { url: string }[], width: 0 };
    const strip = mediaItem!.filmstripThumbnails!;
    const TILE_W = 64;
    const pxPerSec = pixelsPerSecond || 1;
    // Full source span so BOTH edges always have frames to reveal. Falls back to
    // the clip's own out-point when the media duration is unknown (rare for
    // video). The strip only has N thumbnails, so cap the cell count — extra
    // cells would just repeat the last thumbnail.
    const sourceDur =
      (mediaItem?.metadata?.duration ?? 0) > 0
        ? mediaItem!.metadata!.duration
        : (clip.outPoint || clip.duration || 1);
    const rawCount = Math.ceil((sourceDur * pxPerSec) / TILE_W);
    const count = Math.max(1, Math.min(rawCount, 600));
    const tiles: { url: string }[] = [];
    for (let i = 0; i < count; i++) {
      const mediaT = (i * TILE_W) / pxPerSec; // ABSOLUTE source time
      let thumbIndex = 0;
      let bestDist = Infinity;
      for (let k = 0; k < strip.length; k++) {
        const d = Math.abs(strip[k].timestamp - mediaT);
        if (d < bestDist) {
          bestDist = d;
          thumbIndex = k;
        } else if (strip[k].timestamp > mediaT) break;
      }
      tiles.push({ url: strip[thumbIndex].url });
    }
    return { tiles, width: count * TILE_W };
    // Deliberately NOT keyed on inPoint / startTime / width — the band is fixed
    // in source space; trimming only moves the CSS window over it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, hasFilmstrip, pixelsPerSecond, mediaItem?.filmstripThumbnails, mediaItem?.metadata?.duration]);

  const fadeIn = clip.fade?.fadeIn ?? 0;
  const fadeOut = clip.fade?.fadeOut ?? 0;
  const fadeInPx = Math.min(fadeIn * pixelsPerSecond, width);
  const fadeOutPx = Math.min(fadeOut * pixelsPerSecond, width);
  const showFadeHandles = (isAudio || isVideo) && width >= 40 && !track.locked;
  const ghostSrcDur = sourceDurationOf(mediaItem);

  // The handle hangs INWARD from the end of its ramp, so it sits exactly where
  // the fade ends and moves 1:1 with the pointer — no jump when grabbed.
  const fadeHandle = (which: "in" | "out", x: number, len: number) => (
    <div
      data-fade-handle={which}
      onMouseDown={handleFadeMouseDown(which)}
      onClick={(e) => e.stopPropagation()}
      title={
        len > 0
          ? `Sound fades ${which} over ${len.toFixed(2)}s — drag to change`
          : `Drag ${which === "in" ? "right" : "left"} to fade the sound ${which}`
      }
      className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white border border-black/60 shadow z-30 cursor-ew-resize transition-opacity ${
        fadeDrag === which || len > 0 ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      }`}
      style={{ left: `${which === "in" ? Math.min(x, width - 10) : Math.max(x - 10, 0)}px` }}
    />
  );

  return (
    <>
    {/* While slipping: the WHOLE source, faded, behind the clip — how much
        picture is left on either side of the window. */}
    {isSlipping && (
      <div
        data-slip-ghost
        className="absolute top-1 bottom-1 z-[5] rounded-lg border border-dashed border-white/40 bg-white/5 overflow-hidden pointer-events-none"
        style={{
          left: `${(clip.startTime - (clip.inPoint || 0)) * pixelsPerSecond}px`,
          width: `${(Number.isFinite(ghostSrcDur) ? ghostSrcDur : sourceSpan(clip)) * pixelsPerSecond}px`,
        }}
      >
        {isVideo && filmstripBand.tiles.length > 0 && (
          <FilmstripTiles band={filmstripBand} offsetPx={0} className="opacity-30" />
        )}
      </div>
    )}
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={clipRef}
          data-clip-id={clip.id}
          data-track-id={track.id}
          title={slippable ? `${clipName}\nDrag to move · Alt+drag to slip` : clipName}
          onMouseEnter={(e) => { setHovered(true); setAltHeld(e.altKey); }}
          onMouseLeave={() => { setHovered(false); setAltHeld(false); }}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          className={`clip-component group absolute top-1 bottom-1 rounded-lg overflow-hidden shadow-sm ${
            isDragging
              ? `cursor-grabbing z-50 ${isInvalidDrop ? "opacity-50 ring-2 ring-red-500 border-red-500" : "opacity-90 shadow-xl"}`
              : "cursor-grab"
          } ${
            isSelected && !isDragging
              ? "ring-2 ring-primary border-primary z-10"
              : !isDragging ? "border-opacity-30 hover:border-opacity-60 hover:brightness-110" : ""
          } ${clipStyle.bg} border ${clipStyle.border} ${
            track.locked ? "cursor-not-allowed opacity-60" : ""
          }`}
          style={{
            transform: isDragging
              ? `translate(${left}px, ${dragYOffset}px)`
              : `translateX(${left}px)`,
            width: `${width}px`,
            ...(isSlipping || (altHeld && slippable && !isDragging) ? { cursor: SLIP_CURSOR } : {}),
            ...(isSlipping ? { zIndex: 20 } : {}),
            willChange: isInteracting ? 'transform, width' : 'auto',
            transition: isInteracting ? 'none' : 'opacity 150ms, box-shadow 150ms',
            pointerEvents: isDragging ? 'none' : 'auto',
          }}
        >
      {/* Real filmstrip — FIXED-WIDTH tiles (Premiere/Resolve behaviour). Each
          tile is a constant FILMSTRIP_TILE_W px wide and shows the frame at the
          media time under its left edge (inPoint + xpx/pixelsPerSecond). Because
          the tile width never changes, bg-cover never rescales the frame on
          trim — trimming just reveals/hides tiles at the edges and re-anchors
          the frames. (The old flex-1 tiles filled the clip width, so every
          frame rescaled as the clip resized = the "zoom" on trim.) */}
      {isVideo && hasFilmstrip && filmstripBand.tiles.length > 0 && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {/* Band offset so source-time inPoint sits at the clip's left edge.
              (startTime−inPoint) is trim-invariant, so frames stay put. */}
          <FilmstripTiles
            band={filmstripBand}
            offsetPx={-(clip.inPoint || 0) * pixelsPerSecond}
            className="opacity-70"
          />
        </div>
      )}

      {/* No real filmstrip yet (remote scene video, strip still generating) —
          a clean flat gradient. Deliberately NOT a stretched poster: tiling
          one poster with bg-cover rescaled it as the clip width changed and
          read as a confusing ZOOM on trim. The lazy generator fills the real
          strip in a moment. */}
      {isVideo && !hasFilmstrip && (
        <div className="absolute inset-0 bg-gradient-to-r from-primary/15 to-primary/5 pointer-events-none" />
      )}

      {isImage && (
        <div className="absolute inset-0 bg-gradient-to-r from-purple-500/20 to-purple-500/10 flex items-center justify-center pointer-events-none">
          {mediaItem?.thumbnailUrl ? (
            <img
              src={mediaItem.thumbnailUrl}
              alt={clipName}
              className="h-full object-cover opacity-60"
            />
          ) : (
            <Image size={24} className="text-purple-400/50" />
          )}
        </div>
      )}

      <div className="w-full h-full flex flex-col justify-end px-2 pb-1 relative z-10 pointer-events-none">
        <span
          className={`text-[10px] font-medium truncate drop-shadow-md ${
            isSelected ? clipStyle.selectedText : clipStyle.text
          }`}
        >
          {clipName}
        </span>
      </div>

      {(isAudio || isVideo) && (
        <>
          <div className={`absolute inset-x-0 pointer-events-none ${isAudio ? "inset-y-0 px-px" : "bottom-0 h-2/5 px-px opacity-50"}`}>
            {wavePeaks && wavePeaks.length > 0 ? (
              <WaveformCanvas
                peaks={wavePeaks}
                startFrac={waveStartFrac}
                endFrac={waveEndFrac}
                color={isAudio ? "#7cb6ff" : "#9af0bf"}
              />
            ) : isAudio ? (
              <svg
                className="w-full h-full"
                preserveAspectRatio="none"
                viewBox="0 0 100 40"
              >
                <path
                  d="M0,20 Q10,14 20,20 T40,20 T60,20 T80,20 T100,20"
                  stroke="currentColor"
                  className="text-blue-400/40"
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            ) : null}
          </div>
          {isAudio && (
            <div className="absolute inset-x-0 top-1 flex justify-center opacity-0 group-hover:opacity-60 transition-opacity pointer-events-none">
              <div className="flex gap-0.5">
                <div className="w-1 h-1 rounded-full bg-blue-300" />
                <div className="w-1 h-1 rounded-full bg-blue-300" />
                <div className="w-1 h-1 rounded-full bg-blue-300" />
              </div>
            </div>
          )}
        </>
      )}

      {/* Volume rubber-band line — audio AND video clips. A video clip's
          embedded audio carries the SAME native openreel `clip.volume` +
          `clip.keyframes(property:"volume")` model as an audio clip, so the
          identical overlay (flat-drag → audio/setVolume, click → add volume
          keyframe, drag points → curve) drives video volume consistently:
          it shows in the Inspector's Volume keyframes, round-trips on save,
          and flat volume applies in both preview and export. Images have no
          audio, so they stay excluded. */}
      {(isAudio || isVideo) && clip.duration > 0 && (
        <VolumeAutomationOverlay
          clip={clip}
          isSelected={isSelected}
          interactionLocked={isDragging || isTrimming}
        />
      )}

      {clip.keyframes && clip.keyframes.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-3 flex items-center pointer-events-none">
          {clip.keyframes.map((kf) => {
            if (kf.time < 0 || kf.time > clip.duration) return null;
            const posPercent = (kf.time / clip.duration) * 100;
            return (
              <div
                key={kf.id}
                className="absolute w-2 h-2 bg-yellow-400 rotate-45 border border-yellow-600"
                style={{ left: `${posPercent}%`, marginLeft: "-4px" }}
                title={`${kf.property} @ ${kf.time.toFixed(2)}s`}
              />
            );
          })}
        </div>
      )}

      {isSelected && (
        <div className="absolute inset-0 border-2 border-primary rounded-lg pointer-events-none shadow-[inset_0_0_10px_rgba(34,197,94,0.2)]" />
      )}

      {/* Audio fade ramps — the shaded corners are the shape the volume takes. */}
      {(fadeInPx > 0 || fadeOutPx > 0) && (
        <svg
          data-fade-ramps
          className="absolute inset-0 w-full h-full pointer-events-none z-10"
          viewBox={`0 0 ${Math.max(1, width)} 100`}
          preserveAspectRatio="none"
        >
          {fadeInPx > 0 && (
            <>
              <polygon points={`0,0 ${fadeInPx},0 0,100`} className="fill-black/45" />
              <line x1="0" y1="100" x2={fadeInPx} y2="0" className="stroke-white/70" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            </>
          )}
          {fadeOutPx > 0 && (
            <>
              <polygon points={`${width - fadeOutPx},0 ${width},0 ${width},100`} className="fill-black/45" />
              <line x1={width - fadeOutPx} y1="0" x2={width} y2="100" className="stroke-white/70" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            </>
          )}
        </svg>
      )}

      {showFadeHandles && fadeHandle("in", fadeInPx, fadeIn)}
      {showFadeHandles && fadeHandle("out", width - fadeOutPx, fadeOut)}

      {/* Live readout while a fine edit is in progress. */}
      {(isSlipping || fadeDrag) && (
        <div
          data-fine-edit-badge
          className="absolute top-1 left-1/2 -translate-x-1/2 z-40 px-1.5 py-0.5 rounded bg-black/80 text-white text-[10px] font-mono whitespace-nowrap pointer-events-none"
        >
          {isSlipping
            ? `Slip ${formatFrameDelta((clip.inPoint || 0) - slipRef.current.orig.inPoint, fps)}`
            : `Fade ${fadeDrag} ${(fadeDrag === "in" ? fadeIn : fadeOut).toFixed(2)}s`}
        </div>
      )}

      {(isVideo || isImage || isAudio) && onTrimClip && (
        <>
          <div
            onMouseDown={handleTrimMouseDown("left")}
            className={`absolute left-0 top-0 bottom-0 w-3 cursor-ew-resize z-20 opacity-0 group-hover:opacity-100 transition-opacity ${
              isAudio ? "hover:bg-blue-400/50" : isVideo ? "hover:bg-green-400/50" : "hover:bg-purple-400/50"
            }`}
            onClick={(e) => e.stopPropagation()}
            title="Drag to adjust start"
          />
          <div
            onMouseDown={handleTrimMouseDown("right")}
            className={`absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize z-20 opacity-0 group-hover:opacity-100 transition-opacity ${
              isAudio ? "hover:bg-blue-400/50" : isVideo ? "hover:bg-green-400/50" : "hover:bg-purple-400/50"
            }`}
            onClick={(e) => e.stopPropagation()}
            title="Drag to adjust end"
          />
        </>
      )}

        </div>
      </ContextMenuTrigger>
      <ClipContextMenu clip={clip} track={track} />
    </ContextMenu>
    </>
  );
};
