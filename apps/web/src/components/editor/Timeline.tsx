import React, {
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Undo2,
  Redo2,
  Layers,
  Maximize2,
  Film,
  Music,
  Image,
  Type,
  Shapes,
  Scissors,
  ChevronUp,
  ChevronDown,
  Trash2,
  Plus,
  ChevronDown as ChevronDownIcon,
  Magnet,
  Info,
  Rows3,
  Rows2,
} from "lucide-react";
import { useProjectStore } from "../../stores/project-store";
import { useTimelineStore } from "../../stores/timeline-store";
import { useUIStore } from "../../stores/ui-store";
import { resolveDroppedMediaId } from "../../services/library-drop";
import { toast } from "../../stores/notification-store";
import { useEngineStore } from "../../stores/engine-store";
import { getPlaybackBridge } from "../../bridges/playback-bridge";
import {
  IconButton,
  Popover,
  PopoverTrigger,
  PopoverContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@openreel/ui";
import {
  Playhead,
  TimeRuler,
  TrackHeader,
  TrackLane,
  BeatMarkerOverlay,
  MarkerIndicator,
  getTrackInfo,
  getKeyframeLaneHeight,
} from "./timeline/index";
import { Transport } from "./Transport";

export const Timeline: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);

  const {
    project,
    undo,
    redo,
    canUndo,
    canRedo,
    splitClip,
    removeClip,
    addTrack,
    reorderTrack,
    deleteShapeClip,
    deleteSVGClip,
    deleteTextClip,
    removeMarker,
    updateMarker,
    updateClipKeyframes,
  } = useProjectStore();
  const tracks = project.timeline.tracks;

  const [draggedTrackId, setDraggedTrackId] = React.useState<string | null>(
    null,
  );

  const {
    playheadPosition,
    playbackState,
    pixelsPerSecond,
    scrollX,
    scrollY,
    viewportWidth,
    setScrollX,
    setScrollY,
    setViewportDimensions,
    zoomIn,
    zoomOut,
    setZoom,
    trackHeight,
    setTrackHeight,
    setTrackHeightById,
    getTrackHeight,
    isTrackExpanded,
    expandedTracks,
  } = useTimelineStore();

  // Effective row height: base lane + the in-flow keyframe lane when
  // expanded. Every cumulative-Y computation (drag targeting, box
  // selection, total height) must use this, or rows below an expanded
  // track are hit-tested against the wrong Y ranges.
  const getEffectiveTrackHeight = useCallback(
    (track: (typeof tracks)[number]) =>
      getTrackHeight(track.id) + getKeyframeLaneHeight(track, isTrackExpanded(track.id)),
    [getTrackHeight, isTrackExpanded],
  );

  const [showLayersPanel, setShowLayersPanel] = useState(false);

  const { select, selectMultiple, clearSelection, getSelectedClipIds, snapSettings, toggleSnap } =
    useUIStore();
  const selectedClipIds = getSelectedClipIds();

  const { getTitleEngine, getGraphicsEngine } = useEngineStore();
  const titleEngine = getTitleEngine();
  const allTextClips = useMemo(() => {
    return titleEngine?.getAllTextClips() ?? [];
  }, [titleEngine, project.modifiedAt]);

  const getTextClipsForTrack = useCallback(
    (trackId: string) => {
      return allTextClips.filter((tc) => tc.trackId === trackId);
    },
    [allTextClips],
  );

  const graphicsEngine = getGraphicsEngine();
  const allShapeClips = useMemo(() => {
    const shapes = graphicsEngine?.getAllShapeClips() ?? [];
    const svgs = graphicsEngine?.getAllSVGClips() ?? [];
    const stickers = graphicsEngine?.getAllStickerClips() ?? [];
    return [...shapes, ...svgs, ...stickers];
  }, [graphicsEngine, project.modifiedAt]);

  const getShapeClipsForTrack = useCallback(
    (trackId: string) => {
      return allShapeClips.filter((sc) => sc.trackId === trackId);
    },
    [allShapeClips],
  );
  const [isBoxSelecting, setIsBoxSelecting] = React.useState(false);
  const [selectionBox, setSelectionBox] = React.useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  // A marquee drag (mousedown→drag→mouseup) also emits a trailing `click` on the
  // timeline background, whose handler (handleBackgroundClick) clears the
  // selection — so the box would select clips and then instantly deselect them.
  // Set this on a real drag so the very next background click is ignored.
  const suppressNextBgClickRef = React.useRef(false);

  const timelineDuration = useMemo(() => {
    let maxEnd = 0;
    for (const track of tracks) {
      for (const clip of track.clips) {
        const end = clip.startTime + clip.duration;
        if (end > maxEnd) maxEnd = end;
      }
    }
    return Math.max(maxEnd, 60); // Minimum 60 seconds
  }, [tracks]);

  const totalTracksHeight = useMemo(() => {
    let height = 0;
    for (const track of tracks) {
      height += getEffectiveTrackHeight(track);
    }
    return height;
  }, [tracks, getEffectiveTrackHeight, expandedTracks]);

  const trackHeightsMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const track of tracks) {
      map.set(track.id, getEffectiveTrackHeight(track));
    }
    return map;
  }, [tracks, getEffectiveTrackHeight, expandedTracks]);

  const handleTrackDragStart = useCallback(
    (e: React.DragEvent, trackId: string) => {
      e.dataTransfer.setData("trackId", trackId);
      e.dataTransfer.effectAllowed = "move";
      setDraggedTrackId(trackId);
    },
    [],
  );

  const handleTrackDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleTrackDrop = useCallback(
    async (e: React.DragEvent, targetTrackId: string) => {
      e.preventDefault();
      const sourceTrackId = e.dataTransfer.getData("trackId");
      setDraggedTrackId(null);

      if (sourceTrackId && sourceTrackId !== targetTrackId) {
        const targetIndex = tracks.findIndex((t) => t.id === targetTrackId);
        if (targetIndex !== -1) {
          await reorderTrack(sourceTrackId, targetIndex);
        }
      }
    },
    [tracks, reorderTrack],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportDimensions(
          entry.contentRect.width,
          entry.contentRect.height,
        );
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [setViewportDimensions]);

  useEffect(() => {
    if (playbackState !== "playing") return;

    const playheadPixels = playheadPosition * pixelsPerSecond;
    const visibleEnd = scrollX + viewportWidth - 150;

    if (playheadPixels > visibleEnd && tracksRef.current) {
      const newScrollX = playheadPixels - viewportWidth + 200;
      tracksRef.current.scrollLeft = Math.max(0, newScrollX);
    }
  }, [playheadPosition, playbackState, pixelsPerSecond, scrollX, viewportWidth]);

  const handleSelectClip = useCallback(
    (clipId: string, addToSelection: boolean) => {
      const isTextClip = allTextClips.some((tc) => tc.id === clipId);
      if (isTextClip) {
        const textClip = allTextClips.find((tc) => tc.id === clipId);
        select(
          { type: "text-clip", id: clipId, trackId: textClip?.trackId },
          addToSelection,
        );
        return;
      }
      const isShapeClip = allShapeClips.some((sc) => sc.id === clipId);
      if (isShapeClip) {
        const shapeClip = allShapeClips.find((sc) => sc.id === clipId);
        select(
          { type: "shape-clip", id: clipId, trackId: shapeClip?.trackId },
          addToSelection,
        );
        return;
      }

      let trackId: string | undefined;
      for (const track of tracks) {
        if (track.clips.some((c) => c.id === clipId)) {
          trackId = track.id;
          break;
        }
      }
      select({ type: "clip", id: clipId, trackId }, addToSelection);
    },
    [tracks, select, allTextClips, allShapeClips],
  );

  const [selectedKeyframeIds, setSelectedKeyframeIds] = useState<string[]>([]);

  const handleKeyframeSelect = useCallback(
    (keyframeId: string, addToSelection: boolean) => {
      if (addToSelection) {
        setSelectedKeyframeIds((prev) =>
          prev.includes(keyframeId)
            ? prev.filter((id) => id !== keyframeId)
            : [...prev, keyframeId]
        );
      } else {
        setSelectedKeyframeIds([keyframeId]);
      }
    },
    []
  );

  const handleKeyframeMove = useCallback(
    (keyframeId: string, newTime: number) => {
      for (const track of tracks) {
        for (const clip of track.clips) {
          const keyframe = clip.keyframes?.find((kf) => kf.id === keyframeId);
          if (keyframe) {
            const updatedKeyframes = clip.keyframes?.map((kf) =>
              kf.id === keyframeId ? { ...kf, time: Math.max(0, newTime) } : kf
            );
            if (updatedKeyframes) {
              updateClipKeyframes(clip.id, updatedKeyframes);
            }
            return;
          }
        }
      }
    },
    [tracks, updateClipKeyframes]
  );

  const handleKeyframeDelete = useCallback(
    (keyframeId: string) => {
      for (const track of tracks) {
        for (const clip of track.clips) {
          const keyframe = clip.keyframes?.find((kf) => kf.id === keyframeId);
          if (keyframe) {
            const updatedKeyframes = clip.keyframes?.filter(
              (kf) => kf.id !== keyframeId
            );
            if (updatedKeyframes) {
              updateClipKeyframes(clip.id, updatedKeyframes);
            }
            setSelectedKeyframeIds((prev) =>
              prev.filter((id) => id !== keyframeId)
            );
            return;
          }
        }
      }
    },
    [tracks, updateClipKeyframes]
  );

  const handleSplit = useCallback(async () => {
    if (selectedClipIds.length === 1) {
      await splitClip(selectedClipIds[0], playheadPosition);
    }
  }, [selectedClipIds, playheadPosition, splitClip]);

  const handleDelete = useCallback(async () => {
    if (selectedClipIds.length === 0) return;

    for (const id of selectedClipIds) {
      const textClip = allTextClips.find((tc) => tc.id === id);
      if (textClip) {
        deleteTextClip(id);
        continue;
      }

      const graphicClip = allShapeClips.find((gc) => gc.id === id);
      if (graphicClip) {
        if (graphicClip.type === "svg") {
          deleteSVGClip(id);
        } else {
          deleteShapeClip(id);
        }
        continue;
      }

      removeClip(id);
    }
    clearSelection();
  }, [
    selectedClipIds,
    removeClip,
    clearSelection,
    allTextClips,
    allShapeClips,
    deleteTextClip,
    deleteShapeClip,
    deleteSVGClip,
  ]);

  const handleBackgroundClick = useCallback(() => {
    // Swallow the click that trails a marquee drag — otherwise it would clear
    // the selection the box just made. A genuine empty click (no drag) leaves
    // the flag false and still deselects.
    if (suppressNextBgClickRef.current) {
      suppressNextBgClickRef.current = false;
      return;
    }
    clearSelection();
  }, [clearSelection]);

  const handleBoxSelectionStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".clip-component")) return;

      const rect = tracksRef.current?.getBoundingClientRect();
      if (!rect) return;

      // Fresh gesture — clear any stale suppress flag left by a prior drag that
      // ended without a trailing background click (e.g. released off-timeline).
      suppressNextBgClickRef.current = false;

      // Convert viewport coordinates to timeline coordinates by accounting for scroll position
      const x = e.clientX - rect.left + scrollX;
      const y = e.clientY - rect.top + scrollY;

      setIsBoxSelecting(true);
      setSelectionBox({
        startX: x,
        startY: y,
        currentX: x,
        currentY: y,
      });
    },
    [scrollX, scrollY],
  );

  const handleBoxSelectionMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isBoxSelecting || !selectionBox) return;

      const rect = tracksRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left + scrollX;
      const y = e.clientY - rect.top + scrollY;

      setSelectionBox({
        ...selectionBox,
        currentX: x,
        currentY: y,
      });
    },
    [isBoxSelecting, selectionBox, scrollX, scrollY],
  );

  const handleBoxSelectionEnd = useCallback(() => {
    if (!isBoxSelecting || !selectionBox) {
      setIsBoxSelecting(false);
      setSelectionBox(null);
      return;
    }

    // If the pointer actually moved, this was a drag (not a click) — swallow the
    // trailing background `click` so it doesn't clear what we're about to select.
    const dragDist = Math.max(
      Math.abs(selectionBox.currentX - selectionBox.startX),
      Math.abs(selectionBox.currentY - selectionBox.startY),
    );
    if (dragDist > 3) suppressNextBgClickRef.current = true;

    // Intersect the marquee with each clip's ACTUAL rendered rect. Doing it in
    // viewport coordinates (getBoundingClientRect) is bulletproof — it needs no
    // assumptions about track heights, keyframe lanes, gaps, ruler offset, or
    // scroll, all of which the old content-coordinate math got subtly wrong
    // (why the box selected nothing across tracks). selectionBox.startX/Y are
    // CONTENT coords, so map them back to the viewport via tracksRef + scroll.
    // Any overlap (even 1px) counts — the AABB test below is a strict overlap,
    // not containment, so a clip the box merely grazes is still selected.
    const container = tracksRef.current;
    const selectedItems: {
      type: "clip" | "text-clip" | "shape-clip";
      id: string;
      trackId: string;
    }[] = [];
    if (container) {
      const cr = container.getBoundingClientRect();
      const toViewX = (cx: number) => cx + cr.left - scrollX;
      const toViewY = (cy: number) => cy + cr.top - scrollY;
      const bx1 = toViewX(Math.min(selectionBox.startX, selectionBox.currentX));
      const bx2 = toViewX(Math.max(selectionBox.startX, selectionBox.currentX));
      const by1 = toViewY(Math.min(selectionBox.startY, selectionBox.currentY));
      const by2 = toViewY(Math.max(selectionBox.startY, selectionBox.currentY));
      const seen = new Set<string>();
      container.querySelectorAll<HTMLElement>("[data-clip-id]").forEach((el) => {
        const r = el.getBoundingClientRect();
        // AABB overlap in viewport space.
        if (bx1 < r.right && bx2 > r.left && by1 < r.bottom && by2 > r.top) {
          const id = el.getAttribute("data-clip-id");
          const trackId = el.getAttribute("data-track-id") || "";
          // Captions (text-clip) and graphics (shape-clip) carry a kind so the
          // selection gets the right type — the store keys highlight, move and
          // delete off it. Regular media clips default to "clip".
          const kind =
            (el.getAttribute("data-clip-kind") as
              | "text-clip"
              | "shape-clip"
              | null) || "clip";
          if (id && !seen.has(id)) {
            seen.add(id);
            selectedItems.push({ type: kind, id, trackId });
          }
        }
      });
    }

    if (selectedItems.length > 0) {
      selectMultiple(selectedItems);
    } else {
      clearSelection();
    }

    setIsBoxSelecting(false);
    setSelectionBox(null);
  }, [
    isBoxSelecting,
    selectionBox,
    scrollX,
    scrollY,
    selectMultiple,
    clearSelection,
  ]);

  useEffect(() => {
    if (!isBoxSelecting) return;

    const handleMouseUp = () => handleBoxSelectionEnd();
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [isBoxSelecting, handleBoxSelectionEnd]);

  // Ctrl/⌘ + mouse-wheel = zoom the timeline (same as the +/- buttons), zooming
  // around the cursor so the time under the pointer stays put — like Premiere.
  // Trackpad pinch also arrives as ctrlKey wheel events, so pinch-zoom works
  // too. Attached natively with { passive:false } because React's synthetic
  // onWheel is passive and can't preventDefault the browser's page zoom.
  useEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain scroll is untouched
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left; // px into the scrolling content
      const { pixelsPerSecond: curPps, scrollX: curScrollX } =
        useTimelineStore.getState();
      const timeAtCursor = (curScrollX + cursorX) / (curPps || 1);
      // wheel up → zoom in, down → zoom out; exp keeps it smooth + symmetric.
      const factor = Math.exp(-e.deltaY * 0.0015);
      setZoom(curPps * factor);
      // Re-anchor scroll so the same time stays under the cursor (setZoom clamps,
      // so read back the applied value). onScroll syncs the store from scrollLeft.
      const appliedPps = useTimelineStore.getState().pixelsPerSecond;
      el.scrollLeft = Math.max(0, timeAtCursor * appliedPps - cursorX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  const handleDropMedia = useCallback(
    async (trackId: string, mediaId: string, startTime: number) => {
      const store = useProjectStore.getState();
      const { addClip, addClipToNewTrack, getMediaItem } = store;
      // Route by MEDIA type — an image dropped on a video lane goes to an
      // image track (audio → audio track, etc.), reusing an existing
      // same-type track with a free slot before creating one. Same type
      // mapping addClipToNewTrack uses; keeps video tracks video-only.
      const media = getMediaItem(mediaId);
      const targetType =
        media?.type === "image" ? "image"
        : media?.type === "audio" ? "audio"
        : "video";
      const target = trackId
        ? store.project.timeline.tracks.find((t) => t.id === trackId)
        : undefined;
      if (target && target.type !== targetType) {
        const estDur = media?.metadata?.duration && media.metadata.duration > 0
          ? media.metadata.duration
          : 5;
        const free = store.project.timeline.tracks.find(
          (t) =>
            t.type === targetType &&
            !t.clips.some(
              (c) => c.startTime < startTime + estDur && c.startTime + c.duration > startTime,
            ),
        );
        if (free) {
          await addClip(free.id, mediaId, startTime);
        } else {
          await addClipToNewTrack(mediaId, startTime);
        }
        return;
      }
      if (trackId) {
        await addClip(trackId, mediaId, startTime);
      } else {
        await addClipToNewTrack(mediaId, startTime);
      }
    },
    [],
  );

  const { moveClip } = useProjectStore();
  const handleMoveClip = useCallback(
    async (clipId: string, newStartTime: number, targetTrackId?: string) => {
      // MULTI-SELECT MOVE (Premiere-style): if the dragged clip is part of a
      // multi-selection, shift EVERY selected clip by the same time delta so
      // they move together as a group. (Before, only the dragged clip moved.)
      // Cross-track group moves are left to the single-clip path; this handles
      // the common same-track time-shift of N clips.
      const sel = getSelectedClipIds();
      if (!targetTrackId && sel.length > 1 && sel.includes(clipId)) {
        useProjectStore.setState((state) => {
          const tl = state.project.timeline;
          const dragged = tl.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
          if (!dragged) return {} as any;
          const delta = newStartTime - dragged.startTime;
          if (Math.abs(delta) < 1e-6) return {} as any;
          const selSet = new Set(sel);
          return {
            project: {
              ...state.project,
              timeline: {
                ...tl,
                tracks: tl.tracks.map((t) => ({
                  ...t,
                  clips: t.clips.map((c) =>
                    selSet.has(c.id)
                      ? { ...c, startTime: Math.max(0, c.startTime + delta) }
                      : c,
                  ),
                })),
              },
              modifiedAt: Date.now(),
            },
          };
        });
        return;
      }

      const graphicClip = allShapeClips.find((sc) => sc.id === clipId);
      if (graphicClip && graphicsEngine) {
        if (graphicClip.type === "sticker" || graphicClip.type === "emoji") {
          graphicsEngine.updateStickerClip(clipId, { startTime: newStartTime });
        } else if (graphicClip.type === "svg") {
          graphicsEngine.updateSVGClip(clipId, { startTime: newStartTime });
        } else {
          graphicsEngine.updateShapeClip(clipId, { startTime: newStartTime });
        }
        useProjectStore.setState((state) => ({
          project: { ...state.project, modifiedAt: Date.now() },
        }));
      } else {
        await moveClip(clipId, newStartTime, targetTrackId);
      }
    },
    [moveClip, allShapeClips, graphicsEngine, getSelectedClipIds],
  );

  const [snapIndicatorTime, setSnapIndicatorTime] = React.useState<
    number | null
  >(null);

  // The snap line is only meaningful mid-drag. Clear it on any mouseup so it
  // never lingers — trims on captions/graphics have no explicit trim-end hook.
  useEffect(() => {
    const clear = () => setSnapIndicatorTime(null);
    document.addEventListener("mouseup", clear);
    return () => document.removeEventListener("mouseup", clear);
  }, []);

  const handleSnapIndicator = useCallback((time: number | null) => {
    setSnapIndicatorTime(time);
  }, []);

  // Premiere-style trim snapping: snap the dragged edge to the nearest clip
  // start/end on ANY track — video / audio / narration / image AND captions
  // (text) + graphics (shape) — or the playhead, within the snap threshold.
  // NOTE captions/graphics do NOT live in track.clips (the title/graphics
  // engines own them), so calculateSnap can't see them — we gather edges from
  // allTextClips / allShapeClips explicitly. Grid snapping is intentionally OFF
  // for trims so a handle locks onto real content edges, not every whole second.
  // Drives the yellow snap line while engaged; returns the (maybe) snapped time.
  const snapTrimEdge = useCallback(
    (clipId: string, rawTime: number): number => {
      if (!snapSettings.enabled || !snapSettings.snapToClips) {
        setSnapIndicatorTime(null);
        return rawTime;
      }
      const threshold = snapSettings.snapThreshold / (pixelsPerSecond || 1);
      const edges: number[] = [];
      const pushEdges = (
        items: { id: string; startTime: number; duration: number }[],
      ) => {
        for (const c of items) {
          if (c.id === clipId) continue; // never snap a clip to its own edge
          edges.push(c.startTime, c.startTime + c.duration);
        }
      };
      for (const t of tracks) pushEdges(t.clips);
      pushEdges(allTextClips); // captions
      pushEdges(allShapeClips); // graphics
      if (snapSettings.snapToPlayhead) edges.push(playheadPosition);

      let best: number | null = null;
      let bestDist = threshold;
      for (const e of edges) {
        const d = Math.abs(e - rawTime);
        if (d <= bestDist) {
          bestDist = d;
          best = e;
        }
      }
      setSnapIndicatorTime(best);
      return best ?? rawTime;
    },
    [
      tracks,
      allTextClips,
      allShapeClips,
      playheadPosition,
      snapSettings,
      pixelsPerSecond,
    ],
  );

  const handleTrimTextClip = useCallback(
    (clipId: string, edge: "left" | "right", rawNewTime: number) => {
      if (!titleEngine) return;

      const textClip = allTextClips.find((tc) => tc.id === clipId);
      if (!textClip) return;

      const newTime = snapTrimEdge(clipId, rawNewTime);

      const oldDuration = textClip.duration;
      const newDuration =
        edge === "left"
          ? Math.max(0.1, textClip.startTime + textClip.duration - newTime)
          : Math.max(0.1, newTime - textClip.startTime);

      const adjustedKeyframes = textClip.keyframes.map((kf) => {
        if (kf.id.startsWith("kf-exit-")) {
          const relativeTime = kf.time - oldDuration;
          return { ...kf, time: newDuration + relativeTime };
        }
        return kf;
      });

      if (edge === "left") {
        titleEngine.updateTextClip(clipId, {
          startTime: newTime,
          duration: newDuration,
        });
      } else {
        titleEngine.updateTextClip(clipId, {
          duration: newDuration,
        });
      }

      useProjectStore
        .getState()
        .updateTextClipKeyframes(clipId, adjustedKeyframes);

      useProjectStore.setState((state) => ({
        project: { ...state.project, modifiedAt: Date.now() },
      }));
    },
    [titleEngine, allTextClips, snapTrimEdge],
  );

  const handleMoveTextClip = useCallback(
    (clipId: string, newStartTime: number) => {
      if (!titleEngine) return;

      const textClip = allTextClips.find((tc) => tc.id === clipId);
      if (!textClip) return;

      titleEngine.updateTextClip(clipId, {
        startTime: Math.max(0, newStartTime),
      });

      useProjectStore.setState((state) => ({
        project: { ...state.project, modifiedAt: Date.now() },
      }));
    },
    [titleEngine, allTextClips],
  );

  const handleTrimShapeClip = useCallback(
    (clipId: string, edge: "left" | "right", rawNewTime: number) => {
      if (!graphicsEngine) return;

      const graphicClip = allShapeClips.find((sc) => sc.id === clipId);
      if (!graphicClip) return;

      const newTime = snapTrimEdge(clipId, rawNewTime);
      const oldDuration = graphicClip.duration;
      const newDuration =
        edge === "left"
          ? Math.max(
              0.1,
              graphicClip.startTime + graphicClip.duration - newTime,
            )
          : Math.max(0.1, newTime - graphicClip.startTime);

      const updates =
        edge === "left"
          ? {
              startTime: newTime,
              duration: newDuration,
            }
          : {
              duration: newDuration,
            };

      const adjustedKeyframes = graphicClip.keyframes.map((kf) => {
        if (kf.id.startsWith("kf-exit-")) {
          const relativeTime = kf.time - oldDuration;
          return { ...kf, time: newDuration + relativeTime };
        }
        return kf;
      });

      if (graphicClip.type === "sticker" || graphicClip.type === "emoji") {
        graphicsEngine.updateStickerClip(clipId, updates);
      } else if (graphicClip.type === "svg") {
        graphicsEngine.updateSVGClip(clipId, updates);
      } else {
        graphicsEngine.updateShapeClip(clipId, updates);
      }

      useProjectStore.getState().updateClipKeyframes(clipId, adjustedKeyframes);

      useProjectStore.setState((state) => ({
        project: { ...state.project, modifiedAt: Date.now() },
      }));
    },
    [graphicsEngine, allShapeClips, snapTrimEdge],
  );

  // One trim GESTURE = one undoable history entry. The per-mousemove
  // updates below write the store directly (fast, no history spam); on
  // release we silently restore the gesture's original geometry and commit
  // the final values through the ActionExecutor so Ctrl+Z restores the
  // whole drag in one step (previously trims were not undoable at all).
  const trimSessionRef = useRef<{
    clipId: string;
    orig: { startTime: number; duration: number; inPoint: number; outPoint: number };
  } | null>(null);

  const handleTrimEnd = useCallback((clipId: string) => {
    setSnapIndicatorTime(null); // clear the snap line when the gesture ends
    const sess = trimSessionRef.current;
    trimSessionRef.current = null;
    if (!sess || sess.clipId !== clipId) return;
    const store = useProjectStore.getState();
    const clip = store.project.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    if (!clip) return;
    const finalGeom = {
      startTime: clip.startTime,
      duration: clip.duration,
      inPoint: clip.inPoint ?? 0,
      outPoint: clip.outPoint ?? (clip.inPoint ?? 0) + clip.duration,
    };
    const o = sess.orig;
    const changed =
      Math.abs(finalGeom.startTime - o.startTime) > 1e-6 ||
      Math.abs(finalGeom.duration - o.duration) > 1e-6 ||
      Math.abs(finalGeom.inPoint - o.inPoint) > 1e-6 ||
      Math.abs(finalGeom.outPoint - o.outPoint) > 1e-6;
    if (!changed) return;
    // Silently restore the pre-gesture geometry (keyframe adjustments made
    // during the drag stay — they track the final duration), then commit
    // the final geometry as ONE executor action so the inverse generator
    // captures the correct "before".
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          tracks: state.project.timeline.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((c) => (c.id === clipId ? { ...c, ...o } : c)),
          })),
        },
      },
    }));
    void store.trimClip(clipId, finalGeom.inPoint, finalGeom.outPoint, finalGeom.startTime);
  }, []);

  const handleTrimClip = useCallback(
    (clipId: string, edge: "left" | "right", rawNewTime: number) => {
      const clip = tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
      if (!clip) return;

      // Snap the dragged edge to nearby clip edges / playhead across all tracks.
      const newTime = snapTrimEdge(clipId, rawNewTime);

      // First tick of a new gesture — remember the original geometry for
      // the single undoable commit in handleTrimEnd.
      if (!trimSessionRef.current || trimSessionRef.current.clipId !== clipId) {
        trimSessionRef.current = {
          clipId,
          orig: {
            startTime: clip.startTime,
            duration: clip.duration,
            inPoint: clip.inPoint ?? 0,
            outPoint: clip.outPoint ?? (clip.inPoint ?? 0) + clip.duration,
          },
        };
      }

      const oldDuration = clip.duration;
      const oldInPoint = clip.inPoint ?? 0;
      const oldOutPoint = clip.outPoint ?? oldInPoint + clip.duration;

      // Premiere/Resolve trim bounds:
      //  • never overlap a neighbouring clip on the same track,
      //  • never extend past the SOURCE media (video/audio; stills have no
      //    intrinsic end). Previously the right handle could drag past EOF
      //    (frozen last frame / silent tail) and either handle could plough
      //    into the neighbour.
      const ownTrack = tracks.find((t) => t.clips.some((c) => c.id === clipId));
      const prevEnd = ownTrack
        ? ownTrack.clips
            .filter((c) => c.id !== clipId && c.startTime < clip.startTime)
            .reduce((m, c) => Math.max(m, c.startTime + c.duration), 0)
        : 0;
      const nextStart = ownTrack
        ? ownTrack.clips
            .filter((c) => c.id !== clipId && c.startTime > clip.startTime)
            .reduce((m, c) => Math.min(m, c.startTime), Infinity)
        : Infinity;
      const trimMedia = useProjectStore.getState().getMediaItem(clip.mediaId);
      const sourceDur =
        trimMedia && trimMedia.type !== "image" && (trimMedia.metadata?.duration ?? 0) > 0
          ? trimMedia.metadata.duration
          : Infinity;

      let updates: {
        startTime?: number;
        duration: number;
        inPoint?: number;
        outPoint?: number;
      };

      if (edge === "left") {
        // Hard stops: previous clip's end, and the media's own start
        // (startTime - oldInPoint is where source time 0 sits on the
        // timeline — dragging further left would freeze the first frame).
        const minTime = Math.max(prevEnd, clip.startTime - oldInPoint);
        const clampedTime = Math.max(newTime, minTime);
        const trimDelta = clampedTime - clip.startTime;
        const nextInPoint = Math.max(0, oldInPoint + trimDelta);
        const nextDuration = Math.max(0.1, oldOutPoint - nextInPoint);

        updates = {
          startTime: clampedTime,
          inPoint: nextInPoint,
          outPoint: oldOutPoint,
          duration: nextDuration,
        };
      } else {
        const maxDuration = Math.min(
          Number.isFinite(nextStart) ? Math.max(0.1, nextStart - clip.startTime) : Infinity,
          Number.isFinite(sourceDur) ? Math.max(0.1, sourceDur - oldInPoint) : Infinity,
        );
        const nextDuration = Math.min(
          Math.max(0.1, newTime - clip.startTime),
          maxDuration,
        );
        const nextOutPoint = oldInPoint + nextDuration;

        updates = {
          outPoint: nextOutPoint,
          duration: nextDuration,
        };
      }

      const newDuration = updates.duration;

      const adjustedKeyframes = clip.keyframes.map((kf) => {
        if (kf.id.startsWith("kf-exit-")) {
          const relativeTime = kf.time - oldDuration;
          return { ...kf, time: newDuration + relativeTime };
        }
        return kf;
      });

      useProjectStore.setState((state) => ({
        project: {
          ...state.project,
          timeline: {
            ...state.project.timeline,
            tracks: state.project.timeline.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((c) =>
                c.id === clipId
                  ? { ...c, ...updates, keyframes: adjustedKeyframes }
                  : c,
              ),
            })),
          },
          modifiedAt: Date.now(),
        },
      }));
    },
    [tracks, snapTrimEdge],
  );

  const visualOrderTracks = useMemo(() => tracks, [tracks]);

  return (
    <div
      data-tour="timeline"
      className="h-full bg-background border-t border-border flex flex-col"
    >
      <div className="h-12 border-b border-border flex items-center justify-between px-4 bg-background-secondary relative z-[100]">
        <div className="flex items-center gap-2">
          <div className="flex bg-background-tertiary rounded-lg p-1 border border-border">
            <IconButton
              icon={Undo2}
              onClick={undo}
              disabled={!canUndo()}
              title="Undo (Cmd+Z)"
            />
            <IconButton
              icon={Redo2}
              onClick={redo}
              disabled={!canRedo()}
              title="Redo (Cmd+Shift+Z)"
            />
          </div>

          <div className="w-px h-6 bg-border mx-1" />

          <div className="flex bg-background-tertiary rounded-lg p-1 border border-border gap-1">
            <button
              onClick={handleSplit}
              disabled={selectedClipIds.length !== 1}
              title="Split clip at playhead (S)"
              className={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${
                selectedClipIds.length === 1
                  ? "bg-orange-500/20 text-orange-700 dark:text-orange-400 hover:bg-orange-500/30 border border-orange-500/30"
                  : "text-text-muted opacity-50 cursor-not-allowed"
              }`}
            >
              <Scissors size={14} />
              <span className="text-[10px] font-medium">SPLIT</span>
            </button>
            <IconButton
              icon={Trash2}
              onClick={handleDelete}
              disabled={selectedClipIds.length === 0}
              title="Delete clip (Del)"
              className="hover:text-red-500"
            />
          </div>

          <div className="w-px h-6 bg-border mx-1" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors"
                title="Add new track"
              >
                <Plus size={14} />
                <span className="text-[11px] font-semibold">Add Track</span>
                <ChevronDownIcon size={12} className="ml-0.5 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-48">
              <DropdownMenuItem onClick={() => addTrack("video")}>
                <Film size={16} className="text-green-700 dark:text-green-400" />
                <span>Video Track</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addTrack("audio")}>
                <Music size={16} className="text-blue-700 dark:text-blue-400" />
                <span>Audio Track</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => addTrack("image")}>
                <Image size={16} className="text-purple-700 dark:text-purple-400" />
                <span>Image Track</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addTrack("text")}>
                <Type size={16} className="text-yellow-700 dark:text-yellow-400" />
                <span>Text Track</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addTrack("graphics")}>
                <Shapes size={16} className="text-pink-700 dark:text-pink-400" />
                <span>Graphics Track</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="w-px h-6 bg-border mx-1" />

          <Popover open={showLayersPanel} onOpenChange={setShowLayersPanel}>
            <PopoverTrigger asChild>
              <button
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors ${
                  showLayersPanel
                    ? "bg-primary/20 text-primary"
                    : "hover:bg-background-elevated text-text-secondary hover:text-text-primary"
                }`}
                title="Manage track layers"
              >
                <Layers size={14} />
                <span className="text-[10px] font-medium tracking-wide">LAYERS</span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={8}
              className="w-64 p-0 bg-background-secondary border-border"
            >
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-border bg-background-tertiary">
                <span className="text-xs font-semibold text-text-primary">
                  Track Layers
                </span>
              </div>
              <div className="p-2 max-h-60 overflow-y-auto">
                {tracks.length === 0 ? (
                  <p className="text-xs text-text-muted text-center py-6">
                    No tracks yet
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {tracks.map((track, index) => {
                      const info = getTrackInfo(track, index);
                      return (
                        <div
                          key={track.id}
                          className="flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-background-tertiary group transition-colors cursor-default"
                        >
                          <div
                            className={`w-7 h-7 rounded-md flex items-center justify-center ${info.bgLight}`}
                          >
                            <info.icon size={14} className={info.textColor} />
                          </div>
                          <span className="text-[11px] font-medium text-text-primary flex-1 truncate">
                            {track.name || info.label}
                          </span>
                          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() =>
                                index > 0 && reorderTrack(track.id, index - 1)
                              }
                              disabled={index === 0}
                              className="p-1.5 rounded-md hover:bg-background-elevated disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                              title="Move up"
                            >
                              <ChevronUp size={12} />
                            </button>
                            <button
                              onClick={() =>
                                index < tracks.length - 1 &&
                                reorderTrack(track.id, index + 1)
                              }
                              disabled={index === tracks.length - 1}
                              className="p-1.5 rounded-md hover:bg-background-elevated disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                              title="Move down"
                            >
                              <ChevronDown size={12} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>

          <div className="w-px h-6 bg-border mx-1" />

          <button
            onClick={toggleSnap}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors ${
              snapSettings.enabled
                ? "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30"
                : "hover:bg-background-elevated text-text-muted hover:text-text-secondary"
            }`}
            title={snapSettings.enabled ? "Disable snapping" : "Enable snapping"}
          >
            <Magnet size={14} />
            <span className="text-[10px] font-medium tracking-wide">SNAP</span>
          </button>

          <Popover>
            <PopoverTrigger asChild>
              <button
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-background-elevated text-text-muted hover:text-text-secondary transition-colors"
                title="Timeline behavior help"
              >
                <Info size={14} />
                <span className="text-[10px] font-medium tracking-wide">INFO</span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-3">
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-text-primary">How Timeline Editing Works</h4>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Drag a clip body to move it on the timeline. Drag clip edges to trim content.
                </p>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Edge trim does not change playback speed. It cuts from the start or end and keeps the same media rate.
                </p>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Snap aligns moves to nearby clip edges, the playhead, and timeline markers.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className="bg-background-tertiary px-3 py-1 rounded-lg border border-primary/20 shadow-[0_0_12px_rgba(34,197,94,0.12)]">
          <Transport />
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-background-tertiary rounded-lg border border-border overflow-hidden">
            <button
              onClick={() => { setTrackHeight(80); useTimelineStore.setState({ trackHeights: {} }); }}
              className={`w-8 h-8 flex items-center justify-center transition-colors border-r border-border ${
                trackHeight >= 60
                  ? "text-primary bg-primary/10"
                  : "text-text-secondary hover:text-text-primary hover:bg-background-elevated"
              }`}
              title="Large tracks"
            >
              <Rows3 size={14} />
            </button>
            <button
              onClick={() => { setTrackHeight(50); useTimelineStore.setState({ trackHeights: {} }); }}
              className={`w-8 h-8 flex items-center justify-center transition-colors ${
                trackHeight < 60
                  ? "text-primary bg-primary/10"
                  : "text-text-secondary hover:text-text-primary hover:bg-background-elevated"
              }`}
              title="Small tracks"
            >
              <Rows2 size={14} />
            </button>
          </div>
          <div className="flex items-center bg-background-tertiary rounded-lg border border-border overflow-hidden">
            <button
              onClick={zoomOut}
              className="w-8 h-8 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-elevated transition-colors border-r border-border"
              title="Zoom out"
            >
              <span className="text-base font-medium">−</span>
            </button>
            <span className="text-[11px] w-14 text-center font-mono text-text-secondary tabular-nums">
              {Math.round(pixelsPerSecond)}px/s
            </span>
            <button
              onClick={zoomIn}
              className="w-8 h-8 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-elevated transition-colors border-l border-border"
              title="Zoom in"
            >
              <span className="text-base font-medium">+</span>
            </button>
          </div>
          <IconButton icon={Maximize2} title="Maximize timeline" />
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 flex flex-col overflow-hidden relative"
        onClick={handleBackgroundClick}
      >
        <div className="flex shrink-0">
          <div className="w-32 h-8 bg-background-tertiary border-b border-r border-border shrink-0" />
          <div className="flex-1 overflow-hidden relative">
            <div
              style={{
                width: `${timelineDuration * pixelsPerSecond}px`,
                transform: `translateX(-${scrollX}px)`,
              }}
            >
              <TimeRuler
                duration={timelineDuration}
                pixelsPerSecond={pixelsPerSecond}
                scrollX={scrollX}
                viewportWidth={viewportWidth}
                onSeek={(time) => {
                  const bridge = getPlaybackBridge();
                  bridge.scrubTo(time);
                }}
                onScrubStart={() => {
                  const bridge = getPlaybackBridge();
                  bridge.startScrubbing();
                }}
                onScrubEnd={() => {
                  const bridge = getPlaybackBridge();
                  bridge.endScrubbing();
                }}
              />
            </div>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-32 bg-background-secondary border-r border-border shrink-0 z-20 shadow-lg overflow-hidden">
            <div
              className="flex flex-col"
              style={{ transform: `translateY(-${scrollY}px)` }}
            >
              {visualOrderTracks.map((track, i) => {
                const keyframeCount = track.clips.reduce(
                  (sum, clip) => sum + (clip.keyframes?.length || 0),
                  0
                );
                return (
                  <div
                    key={track.id}
                    className={draggedTrackId === track.id ? "opacity-50" : ""}
                  >
                    <TrackHeader
                      track={track}
                      index={i}
                      onDragStart={handleTrackDragStart}
                      onDragOver={handleTrackDragOver}
                      onDrop={handleTrackDrop}
                      keyframeCount={keyframeCount}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div
            ref={tracksRef}
            className="flex-1 bg-background relative overflow-auto custom-scrollbar"
            onScroll={(e) => {
              setScrollX(e.currentTarget.scrollLeft);
              setScrollY(e.currentTarget.scrollTop);
            }}
            onMouseDown={handleBoxSelectionStart}
            onMouseMove={handleBoxSelectionMove}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={async (e) => {
              e.preventDefault();

              const rect = tracksRef.current?.getBoundingClientRect();
              if (!rect) return;
              const x = e.clientX - rect.left + (tracksRef.current?.scrollLeft ?? 0);
              const rawTime = Math.max(0, x / pixelsPerSecond);

              const allClips = project.timeline.tracks.flatMap(t => t.clips);
              let snappedTime = rawTime;
              if (snapSettings.enabled) {
                const threshold = snapSettings.snapThreshold / pixelsPerSecond;
                let bestDist = Infinity;
                for (const clip of allClips) {
                  const clipEnd = clip.startTime + clip.duration;
                  const distToEnd = Math.abs(rawTime - clipEnd);
                  const distToStart = Math.abs(rawTime - clip.startTime);
                  if (distToEnd < threshold && distToEnd < bestDist) {
                    bestDist = distToEnd;
                    snappedTime = clipEnd;
                  }
                  if (distToStart < threshold && distToStart < bestDist) {
                    bestDist = distToStart;
                    snappedTime = clip.startTime;
                  }
                }
                if (snapSettings.snapToPlayhead) {
                  const distToPlayhead = Math.abs(rawTime - playheadPosition);
                  if (distToPlayhead < threshold && distToPlayhead < bestDist) {
                    snappedTime = playheadPosition;
                  }
                }
              }

              // External OS file drop (e.g. from Windows Explorer)
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                const { importMedia, addClipToNewTrack } = useProjectStore.getState();
                for (const file of Array.from(e.dataTransfer.files)) {
                  try {
                    const beforeIds = new Set(
                      useProjectStore.getState().project.mediaLibrary.items.map(i => i.id)
                    );
                    const result = await importMedia(file);
                    if (result.success) {
                      const newItem = useProjectStore
                        .getState()
                        .project.mediaLibrary.items.find(i => !beforeIds.has(i.id));
                      if (newItem) {
                        await addClipToNewTrack(newItem.id, snappedTime);
                        const track = useProjectStore
                          .getState()
                          .project.timeline.tracks.find(t =>
                            t.clips.some(c => c.mediaId === newItem.id)
                          );
                        if (track) {
                          toast.success(`Added to ${track.name}`, file.name);
                        }
                      }
                    }
                  } catch (err) {
                    console.error("[Timeline] External file drop failed:", err);
                  }
                }
                return;
              }

              // Internal drag from the assets panel OR the Library tab. Read
              // the payload SYNCHRONOUSLY (dataTransfer is cleared after the
              // event), then resolve it — a native item returns its mediaId
              // immediately; a Library item is imported here (async) first.
              try {
                const rawData = e.dataTransfer.getData("application/json");
                if (!rawData) return;
                const mediaId = await resolveDroppedMediaId(rawData);
                if (mediaId) handleDropMedia("", mediaId, snappedTime);
              } catch {
                // ignore
              }
            }}
          >
            <div
              style={{ width: `${timelineDuration * pixelsPerSecond}px` }}
              className="min-w-full"
            >
              {visualOrderTracks.map((track) => (
                <TrackLane
                  key={track.id}
                  track={track}
                  allTracks={visualOrderTracks}
                  pixelsPerSecond={pixelsPerSecond}
                  selectedClipIds={selectedClipIds}
                  textClips={getTextClipsForTrack(track.id)}
                  shapeClips={getShapeClipsForTrack(track.id)}
                  trackHeights={trackHeightsMap}
                  timelineRef={tracksRef}
                  onSelectClip={handleSelectClip}
                  onDropMedia={handleDropMedia}
                  onMoveClip={handleMoveClip}
                  onSnapIndicator={handleSnapIndicator}
                  onTrimClip={
                    track.type === "video" ||
                    track.type === "image" ||
                    track.type === "audio"
                      ? handleTrimClip
                      : undefined
                  }
                  onTrimEnd={
                    track.type === "video" ||
                    track.type === "image" ||
                    track.type === "audio"
                      ? handleTrimEnd
                      : undefined
                  }
                  onTrimTextClip={handleTrimTextClip}
                  onMoveTextClip={handleMoveTextClip}
                  onTrimShapeClip={handleTrimShapeClip}
                  scrollX={scrollX}
                  trackHeight={getTrackHeight(track.id)}
                  onResizeTrack={setTrackHeightById}
                  onKeyframeSelect={handleKeyframeSelect}
                  onKeyframeMove={handleKeyframeMove}
                  onKeyframeDelete={handleKeyframeDelete}
                  selectedKeyframeIds={selectedKeyframeIds}
                />
              ))}

              <BeatMarkerOverlay
                pixelsPerSecond={pixelsPerSecond}
                scrollX={scrollX}
                viewportWidth={viewportWidth}
                totalHeight={totalTracksHeight}
              />

              {project.timeline.markers.map((marker) => (
                <MarkerIndicator
                  key={marker.id}
                  marker={marker}
                  pixelsPerSecond={pixelsPerSecond}
                  scrollX={scrollX}
                  onSeek={(time) => {
                    const bridge = getPlaybackBridge();
                    bridge.scrubTo(time);
                  }}
                  onRemove={removeMarker}
                  onUpdate={updateMarker}
                />
              ))}

              {snapIndicatorTime !== null && (
                <div
                  className="absolute top-0 bottom-0 w-px bg-yellow-400 z-30 pointer-events-none"
                  style={{ left: `${snapIndicatorTime * pixelsPerSecond}px` }}
                >
                  <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-yellow-400 rounded-full" />
                </div>
              )}

              {isBoxSelecting && selectionBox && (
                <div
                  className="absolute border-2 border-primary bg-primary/10 pointer-events-none z-40"
                  style={{
                    // startX/startY are CONTENT coords (already include scroll).
                    // This box is absolutely positioned INSIDE the scrolling
                    // content, so it scrolls with it — use the content coords
                    // directly. Subtracting scroll here double-compensated and
                    // offset the box by the scroll amount (why it started in the
                    // wrong place once the timeline was scrolled).
                    left: Math.min(selectionBox.startX, selectionBox.currentX),
                    top: Math.min(selectionBox.startY, selectionBox.currentY),
                    width: Math.abs(
                      selectionBox.currentX - selectionBox.startX,
                    ),
                    height: Math.abs(
                      selectionBox.currentY - selectionBox.startY,
                    ),
                  }}
                />
              )}
            </div>
          </div>
        </div>

        <Playhead
          position={playheadPosition}
          pixelsPerSecond={pixelsPerSecond}
          scrollX={scrollX}
          headerOffset={128}
        />
      </div>
    </div>
  );
};

export default Timeline;
