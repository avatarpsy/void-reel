import React, { useRef, useState, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { Clip } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";

interface Props {
  clip: Clip;
  /** Whether the clip is selected — rubber-band editing is only active on
   *  the selected clip (Premiere/AE behavior), so the line's hit-band
   *  never swallows clip drag-to-move on unselected clips. */
  isSelected: boolean;
  /** True while the parent clip is being moved/trimmed — suppress edits. */
  interactionLocked: boolean;
}

/** Max displayable gain (×). Unity (1.0) sits at 50% height. */
const MAX_GAIN = 2;

type Point = { time: number; value: number };

/**
 * After Effects / Premiere–style volume rubber-band drawn over an audio
 * clip. On the SELECTED clip: drag the flat line to set clip gain;
 * double-click to drop a keyframe; drag keyframes to shape volume over
 * time; alt/right-click a keyframe to remove it. On unselected clips it's
 * display-only (no pointer capture), so normal clip move/select still work.
 *
 * Edits route through the action-executor (audio/setVolume,
 * audio/addAutomation) so they're undoable, snapshot-safe, and audible
 * (the realtime graph schedules a gain envelope from them).
 */
export const VolumeAutomationOverlay: React.FC<Props> = ({ clip, isSelected, interactionLocked }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const committed: Point[] = (clip.automation?.volume ?? [])
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
    .map((p) => ({ time: p.time, value: p.value }))
    .sort((a, b) => a.time - b.time);
  const baseVolume = Number.isFinite(clip.volume) ? clip.volume : 1;
  const interactive = isSelected && !interactionLocked;

  const [draftPoints, setDraftPoints] = useState<Point[] | null>(null);
  const [draftVolume, setDraftVolume] = useState<number | null>(null);
  const [dragging, setDragging] = useState<null | "line" | "point">(null);
  const dragIndexRef = useRef<number>(-1);
  const draftPointsRef = useRef<Point[] | null>(null);
  const draftVolumeRef = useRef<number | null>(null);
  const baseRef = useRef<Point[]>(committed);
  if (!dragging) baseRef.current = committed;

  const points = draftPoints ?? committed;
  const volume = draftVolume ?? baseVolume;
  const hasPoints = points.length > 0;

  const dispatch = useCallback(
    async (action: { type: string; params: Record<string, unknown> }) => {
      const store = useProjectStore.getState();
      const exec = (store as unknown as {
        actionExecutor?: { execute: (a: unknown, p: unknown) => Promise<{ success?: boolean }> };
      }).actionExecutor;
      if (!exec) return;
      try {
        const r = await exec.execute(
          { type: action.type, id: uuidv4(), timestamp: Date.now(), params: action.params },
          store.project,
        );
        if (r?.success) {
          useProjectStore.setState({ project: { ...store.project, modifiedAt: Date.now() } });
        }
      } catch (e) {
        console.warn("[volume-automation] dispatch failed", e);
      }
    },
    [],
  );

  const yToValue = (clientY: number): number => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return baseVolume;
    const frac = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return Math.max(0, Math.min(MAX_GAIN, frac * MAX_GAIN));
  };
  const xToTime = (clientX: number): number => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || clip.duration <= 0) return 0;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return frac * clip.duration;
  };
  // Clamp to [0,100] so an out-of-range gain (e.g. agent-set >MAX_GAIN)
  // pins to the top edge instead of drawing off-box.
  const valToPct = (v: number) => Math.max(0, Math.min(100, (1 - v / MAX_GAIN) * 100));
  const timeToPct = (t: number) => (clip.duration > 0 ? Math.max(0, Math.min(100, (t / clip.duration) * 100)) : 0);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      if (dragging === "line") {
        const v = yToValue(e.clientY);
        draftVolumeRef.current = v;
        setDraftVolume(v);
      } else {
        const idx = dragIndexRef.current;
        const arr = (draftPointsRef.current ?? baseRef.current).map((p) => ({ ...p }));
        if (arr[idx]) {
          arr[idx] = { time: xToTime(e.clientX), value: yToValue(e.clientY) };
          draftPointsRef.current = arr;
          setDraftPoints(arr);
        }
      }
    };
    const onUp = () => {
      if (dragging === "line") {
        const v = draftVolumeRef.current;
        if (v != null) void dispatch({ type: "audio/setVolume", params: { clipId: clip.id, volume: v } });
      } else {
        const pts = draftPointsRef.current;
        if (pts) {
          const sorted = pts.slice().sort((a, b) => a.time - b.time);
          void dispatch({ type: "audio/addAutomation", params: { clipId: clip.id, points: sorted } });
        }
      }
      draftVolumeRef.current = null;
      draftPointsRef.current = null;
      setDraftVolume(null);
      setDraftPoints(null);
      setDragging(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, clip.id, clip.duration]);

  const startLineDrag = (e: React.MouseEvent) => {
    if (!interactive || hasPoints) return;
    e.stopPropagation();
    e.preventDefault();
    draftVolumeRef.current = volume;
    setDraftVolume(volume);
    setDragging("line");
  };

  const startPointDrag = (index: number) => (e: React.MouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.altKey || e.button === 2) {
      const next = committed.filter((_, i) => i !== index);
      void dispatch({ type: "audio/addAutomation", params: { clipId: clip.id, points: next } });
      return;
    }
    baseRef.current = committed;
    dragIndexRef.current = index;
    draftPointsRef.current = committed.map((p) => ({ ...p }));
    setDraftPoints(draftPointsRef.current);
    setDragging("point");
  };

  const addPoint = (e: React.MouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    const next = [...committed, { time: xToTime(e.clientX), value: yToValue(e.clientY) }].sort(
      (a, b) => a.time - b.time,
    );
    void dispatch({ type: "audio/addAutomation", params: { clipId: clip.id, points: next } });
  };

  const lineY = valToPct(volume);
  const path = hasPoints
    ? (() => {
        const segs: string[] = [`M 0 ${valToPct(points[0].value).toFixed(2)}`];
        for (const p of points) segs.push(`L ${timeToPct(p.time).toFixed(2)} ${valToPct(p.value).toFixed(2)}`);
        segs.push(`L 100 ${valToPct(points[points.length - 1].value).toFixed(2)}`);
        return segs.join(" ");
      })()
    : `M 0 ${lineY.toFixed(2)} L 100 ${lineY.toFixed(2)}`;

  return (
    <div
      ref={boxRef}
      className="absolute inset-0 z-20"
      style={{ pointerEvents: interactive ? "auto" : "none" }}
      onDoubleClick={addPoint}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg className="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 100">
        {interactive && !hasPoints && (
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={12}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: "ns-resize", pointerEvents: "stroke" }}
            onMouseDown={startLineDrag}
          />
        )}
        <path
          d={path}
          fill="none"
          stroke="#facc15"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: "none" }}
          opacity={isSelected ? 0.95 : 0.6}
        />
      </svg>
      {points.map((p, i) => (
        <div
          key={`${i}-${p.time.toFixed(3)}`}
          onMouseDown={startPointDrag(i)}
          title="Drag to adjust · Alt/right-click to remove"
          className="absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rotate-45 bg-yellow-300 border border-yellow-600 shadow-sm hover:scale-125 transition-transform"
          style={{
            left: `${timeToPct(p.time)}%`,
            top: `${valToPct(p.value)}%`,
            cursor: "pointer",
            pointerEvents: interactive ? "auto" : "none",
          }}
        />
      ))}
    </div>
  );
};
