import React, { useRef, useState, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { Clip } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";

interface Props {
  clip: Clip;
  /** Rubber-band editing is only active on the selected clip (so an
   *  unselected clip can still be grabbed and moved). */
  isSelected: boolean;
  /** True while the parent clip is being moved/trimmed — suppress edits. */
  interactionLocked: boolean;
}

/** Max displayable gain (×). Unity (1.0) sits at the 50% line. */
const MAX_GAIN = 2;
/** Movement (px) before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

type Point = { time: number; value: number };

/**
 * Audition / Premiere–style volume envelope drawn over the SELECTED audio
 * clip. Interactions (all undoable via the action-executor):
 *   • Click the line          → add a keyframe at that point
 *   • Drag the line (no keys)  → set the clip's overall gain
 *   • Drag a keyframe          → move it in time + value
 *   • Alt / right / dbl-click  → remove a keyframe
 *
 * The overlay ROOT is pointer-events:none — only the thin line hit-band
 * and the keyframe handles capture the mouse — so empty clip area still
 * passes through to the clip for drag-to-move even while selected. A press
 * is classified as click-vs-drag with a small threshold, so a click on the
 * line reliably adds a keyframe (the old double-click was eaten by the
 * line's own mousedown handler — that was the "keyframes don't work" bug).
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
  // gesture: what's being pressed + whether it has crossed the drag threshold
  const gesture = useRef<
    | { kind: "line"; startX: number; startY: number; moved: boolean }
    | { kind: "point"; index: number; startX: number; startY: number; moved: boolean }
    | null
  >(null);
  const [active, setActive] = useState(false); // drives the global-listener effect
  const draftPointsRef = useRef<Point[] | null>(null);
  const draftVolumeRef = useRef<number | null>(null);
  const committedRef = useRef<Point[]>(committed);
  if (!active) committedRef.current = committed;

  const points = draftPoints ?? committed;
  const volume = draftVolume ?? baseVolume;
  const hasPoints = points.length > 0;

  const dispatch = useCallback(
    async (type: string, params: Record<string, unknown>) => {
      const store = useProjectStore.getState();
      const exec = (store as unknown as {
        actionExecutor?: { execute: (a: unknown, p: unknown) => Promise<{ success?: boolean }> };
      }).actionExecutor;
      if (!exec) return;
      try {
        const r = await exec.execute({ type, id: uuidv4(), timestamp: Date.now(), params }, store.project);
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
  const valToPct = (v: number) => Math.max(0, Math.min(100, (1 - v / MAX_GAIN) * 100));
  const timeToPct = (t: number) =>
    clip.duration > 0 ? Math.max(0, Math.min(100, (t / clip.duration) * 100)) : 0;

  // Value of the envelope at a given time (for inserting a keyframe on the line).
  const valueAtTime = (t: number): number => {
    if (!hasPoints) return volume;
    if (t <= points[0].time) return points[0].value;
    const last = points[points.length - 1];
    if (t >= last.time) return last.value;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      if (t >= a.time && t <= b.time) {
        const span = Math.max(1e-6, b.time - a.time);
        return a.value + (b.value - a.value) * ((t - a.time) / span);
      }
    }
    return volume;
  };

  useEffect(() => {
    if (!active) return;
    const onMove = (e: MouseEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (!g.moved) {
        const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
        if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) g.moved = true;
        else return;
      }
      if (g.kind === "line") {
        const v = yToValue(e.clientY);
        draftVolumeRef.current = v;
        setDraftVolume(v);
      } else {
        const arr = (draftPointsRef.current ?? committedRef.current).map((p) => ({ ...p }));
        if (arr[g.index]) {
          arr[g.index] = { time: xToTime(e.clientX), value: yToValue(e.clientY) };
          draftPointsRef.current = arr;
          setDraftPoints(arr);
        }
      }
    };
    const onUp = (e: MouseEvent) => {
      const g = gesture.current;
      gesture.current = null;
      setActive(false);
      if (!g) return;
      if (g.kind === "line") {
        if (g.moved && draftVolumeRef.current != null) {
          void dispatch("audio/setVolume", { clipId: clip.id, volume: draftVolumeRef.current });
        } else if (!g.moved) {
          // click on the line → add a keyframe there
          const t = xToTime(e.clientX);
          const next = [...committedRef.current, { time: t, value: valueAtTime(t) }].sort(
            (a, b) => a.time - b.time,
          );
          void dispatch("audio/addAutomation", { clipId: clip.id, points: next });
        }
      } else {
        if (g.moved && draftPointsRef.current) {
          const sorted = draftPointsRef.current.slice().sort((a, b) => a.time - b.time);
          void dispatch("audio/addAutomation", { clipId: clip.id, points: sorted });
        }
        // a click (no move) on a keyframe is a no-op (use alt/right/dbl to remove)
      }
      draftVolumeRef.current = null;
      draftPointsRef.current = null;
      setDraftVolume(null);
      setDraftPoints(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, clip.id, clip.duration]);

  const onLineDown = (e: React.MouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    committedRef.current = committed;
    gesture.current = { kind: "line", startX: e.clientX, startY: e.clientY, moved: false };
    setActive(true);
  };

  const onPointDown = (index: number) => (e: React.MouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    if (e.altKey || e.button === 2) {
      void dispatch("audio/addAutomation", {
        clipId: clip.id,
        points: committed.filter((_, i) => i !== index),
      });
      return;
    }
    committedRef.current = committed;
    draftPointsRef.current = committed.map((p) => ({ ...p }));
    gesture.current = { kind: "point", index, startX: e.clientX, startY: e.clientY, moved: false };
    setActive(true);
  };

  const removePoint = (index: number) => (e: React.MouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    void dispatch("audio/addAutomation", {
      clipId: clip.id,
      points: committed.filter((_, i) => i !== index),
    });
  };

  const lineY = valToPct(volume);
  const path = hasPoints
    ? (() => {
        const s = [`M 0 ${valToPct(points[0].value).toFixed(2)}`];
        for (const p of points) s.push(`L ${timeToPct(p.time).toFixed(2)} ${valToPct(p.value).toFixed(2)}`);
        s.push(`L 100 ${valToPct(points[points.length - 1].value).toFixed(2)}`);
        return s.join(" ");
      })()
    : `M 0 ${lineY.toFixed(2)} L 100 ${lineY.toFixed(2)}`;

  // Display-only on unselected clips: faint line, no interaction.
  return (
    <div ref={boxRef} className="absolute inset-0" style={{ pointerEvents: "none" }}>
      <svg
        className="w-full h-full overflow-visible"
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
        style={{ filter: interactive ? "drop-shadow(0 0 2px rgba(251,191,36,0.5))" : "none" }}
      >
        {/* unity (0 dB) reference, shown while selected */}
        {interactive && (
          <line
            x1="0"
            y1="50"
            x2="100"
            y2="50"
            stroke="rgba(255,255,255,0.18)"
            strokeWidth={0.5}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* wide invisible hit-band for grabbing the line (click=add key, drag=gain) */}
        {interactive && (
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={14}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: hasPoints ? "copy" : "ns-resize", pointerEvents: "stroke" }}
            onMouseDown={onLineDown}
          />
        )}
        {/* visible envelope line */}
        <path
          d={path}
          fill="none"
          stroke="#fbbf24"
          strokeWidth={interactive ? 2 : 1.5}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: "none" }}
          opacity={isSelected ? 0.95 : 0.55}
        />
      </svg>
      {interactive &&
        points.map((p, i) => (
          <div
            key={`${i}-${p.time.toFixed(3)}`}
            onMouseDown={onPointDown(i)}
            onDoubleClick={removePoint(i)}
            onContextMenu={removePoint(i)}
            title="Drag to adjust · Alt / right-click / double-click to remove"
            className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rotate-45 bg-amber-300 border border-amber-600 shadow-[0_0_4px_rgba(251,191,36,0.6)] hover:scale-125 hover:bg-amber-200 transition-transform"
            style={{
              left: `${timeToPct(p.time)}%`,
              top: `${valToPct(p.value)}%`,
              cursor: "grab",
              pointerEvents: "auto",
            }}
          />
        ))}
    </div>
  );
};
