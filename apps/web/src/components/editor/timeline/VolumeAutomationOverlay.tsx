import React, { useRef, useState, useEffect, useCallback } from "react";
import type { Clip, Keyframe, EasingType } from "@openreel/core";
import { KeyframeEngine } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";

interface Props {
  clip: Clip;
  /** Rubber-band editing is only active on the selected clip (so an
   *  unselected clip can still be grabbed and moved). */
  isSelected: boolean;
  /** True while the parent clip is being moved/trimmed — suppress edits. */
  interactionLocked: boolean;
}

/** Max displayable gain (×). Mirrors the Inspector's "volume" property
 *  range (0–2, default 1). Unity (1.0) sits at the 50% line. */
const MAX_GAIN = 2;
/** Movement (px) before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

// Shared engine instance — same class the Inspector's KeyframesSection uses,
// so add/move/remove math is identical across both surfaces.
const keyframeEngine = new KeyframeEngine();

type Point = { id: string; time: number; value: number; easing: EasingType };

const clampGain = (v: number) => Math.max(0, Math.min(MAX_GAIN, v));

/** How many segments to sample when drawing an eased curve between
 *  keyframes. The native KeyframeEngine applies per-keyframe easing
 *  (ease-in/out, bezier handles, …); sampling it — instead of drawing a
 *  straight line between points — is what makes the timeline envelope
 *  match the Inspector keyframe editor and the actual rendered audio. */
const CURVE_SAMPLES = 64;

/**
 * Audition / Premiere–style volume envelope drawn over the SELECTED audio
 * clip.
 *
 * ┌─ SINGLE SOURCE OF TRUTH ───────────────────────────────────────────┐
 * │ This overlay reads & writes the SAME NATIVE openreel keyframes that  │
 * │ the Inspector's Keyframes panel uses: `clip.keyframes` rows with     │
 * │ `property === "volume"` (value = gain, 1 = unity, range 0–2), edited │
 * │ through `useProjectStore().updateClipKeyframes` + the shared         │
 * │ `KeyframeEngine`. There is NO separate automation store.            │
 * │                                                                     │
 * │ Consequences (the whole point of this design):                      │
 * │  • A keyframe added on the timeline shows up in the Inspector's      │
 * │    Animate-Property → "Volume" list, and vice-versa.                 │
 * │  • The agent's native keyframe tools operate on the same rows.       │
 * │  • Save / load (autosave clones the whole project) round-trips them. │
 * │                                                                     │
 * │ DO NOT reintroduce a parallel `clip.automation.volume` store — that  │
 * │ is exactly what desynced the timeline, Inspector, and agent before. │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Interactions (all flow through the native keyframe store):
 *   • Click the line          → add a volume keyframe at that point
 *   • Drag the line (no keys)  → set the clip's flat volume (audio/setVolume)
 *   • Drag a keyframe          → move it in time + value
 *   • Alt / right / dbl-click  → remove a keyframe
 *
 * The overlay ROOT is pointer-events:none — only the thin line hit-band
 * and the keyframe handles capture the mouse — so empty clip area still
 * passes through to the clip for drag-to-move even while selected.
 */
export const VolumeAutomationOverlay: React.FC<Props> = ({ clip, isSelected, interactionLocked }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const updateClipKeyframes = useProjectStore((s) => s.updateClipKeyframes);

  // The clip's native keyframe rows, split into the volume ones (what this
  // overlay draws/edits) and everything else (preserved untouched on write).
  const allKeyframes: Keyframe[] = (clip.keyframes ?? []).slice();
  const committed: Point[] = allKeyframes
    .filter((k) => k.property === "volume")
    .map((k) => ({
      id: k.id,
      time: k.time,
      value: typeof k.value === "number" ? k.value : 1,
      // Carry the keyframe's native easing so dragging a point preserves
      // its curve and so the drawn path can sample it (see curvePoints).
      easing: (k.easing ?? "linear") as EasingType,
    }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
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

  // ── Native keyframe writes (identical mechanism to KeyframesSection) ──
  // Merge a new set of VOLUME points back into the clip's full keyframe
  // list, preserving every non-volume keyframe and each volume row's
  // existing easing (new rows default to "linear").
  const commitVolumePoints = useCallback(
    (volumePoints: Point[]) => {
      const easingById = new Map<string, EasingType>();
      for (const k of clip.keyframes ?? []) {
        if (k.property === "volume") easingById.set(k.id, k.easing);
      }
      const others = (clip.keyframes ?? []).filter((k) => k.property !== "volume");
      const volumeRows: Keyframe[] = volumePoints.map((p) => ({
        id: p.id,
        time: p.time,
        property: "volume",
        value: clampGain(p.value),
        // Prefer the easing carried on the dragged point; fall back to the
        // committed row's easing, then linear. Never resets a curve.
        easing: p.easing ?? easingById.get(p.id) ?? ("linear" as EasingType),
      }));
      const merged = [...others, ...volumeRows].sort((a, b) => a.time - b.time);
      updateClipKeyframes(clip.id, merged);
    },
    [clip.id, clip.keyframes, updateClipKeyframes],
  );

  // Flat-line drag with no keyframes sets the clip's base volume. This is
  // the native per-clip `volume` field (the same value the Inspector audio
  // controls edit) — routed through the undoable audio/setVolume action.
  const setClipVolume = useCallback(
    async (vol: number) => {
      const store = useProjectStore.getState();
      const exec = (store as unknown as {
        actionExecutor?: { execute: (a: unknown, p: unknown) => Promise<{ success?: boolean }> };
      }).actionExecutor;
      if (!exec) return;
      try {
        const r = await exec.execute(
          { type: "audio/setVolume", id: `vol-${clip.id}-${Math.round(vol * 1000)}`, timestamp: 0, params: { clipId: clip.id, volume: clampGain(vol) } },
          store.project,
        );
        if (r?.success) {
          useProjectStore.setState({ project: { ...store.project } });
        }
      } catch (e) {
        console.warn("[volume-automation] setVolume failed", e);
      }
    },
    [clip.id],
  );

  const yToValue = (clientY: number): number => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return baseVolume;
    const frac = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return clampGain(frac * MAX_GAIN);
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

  // The current volume points as native Keyframe rows, so we can feed them
  // straight into the shared KeyframeEngine for both drawing and value
  // lookup — guaranteeing the timeline matches the Inspector + render.
  const asKeyframes = (pts: Point[]): Keyframe[] =>
    pts.map((p) => ({
      id: p.id,
      time: p.time,
      property: "volume",
      value: p.value,
      easing: p.easing ?? ("linear" as EasingType),
    }));

  // Value of the envelope at a given time (for inserting a keyframe on the
  // line) — delegates to KeyframeEngine.getValueAtTime, the SAME function
  // the render + Inspector use, so a keyframe dropped on the line lands
  // exactly on the eased curve (no more straight-line approximation).
  const valueAtTime = (t: number): number => {
    if (!hasPoints) return volume;
    const r = keyframeEngine.getValueAtTime(asKeyframes(points), t);
    return typeof r.value === "number" ? r.value : volume;
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
          arr[g.index] = { ...arr[g.index], time: xToTime(e.clientX), value: yToValue(e.clientY) };
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
          void setClipVolume(draftVolumeRef.current);
        } else if (!g.moved) {
          // click on the line → add a native volume keyframe there
          const t = xToTime(e.clientX);
          const kf = keyframeEngine.addKeyframe(clip.id, "volume", t, valueAtTime(t), "linear");
          updateClipKeyframes(
            clip.id,
            [...(clip.keyframes ?? []), kf].sort((a, b) => a.time - b.time),
          );
        }
      } else {
        if (g.moved && draftPointsRef.current) {
          commitVolumePoints(draftPointsRef.current);
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
      const target = committed[index];
      if (target) updateClipKeyframes(clip.id, keyframeEngine.removeKeyframe(clip.keyframes ?? [], target.id));
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
    const target = committed[index];
    if (target) updateClipKeyframes(clip.id, keyframeEngine.removeKeyframe(clip.keyframes ?? [], target.id));
  };

  const lineY = valToPct(volume);
  // Draw the envelope by SAMPLING the native KeyframeEngine across the clip,
  // so each segment shows its real easing curve (ease-in/out, bezier, …) —
  // identical to what the Inspector keyframe editor and the rendered audio
  // produce. A straight polyline between points (the old approach) silently
  // mismatched any non-linear keyframe.
  const path = hasPoints
    ? (() => {
        const kfs = asKeyframes(points);
        // Engine holds the first value before the first key and the last
        // value after the last key, so sampling 0..duration covers the
        // flat lead-in / lead-out for free.
        const s: string[] = [];
        for (let i = 0; i <= CURVE_SAMPLES; i++) {
          const t = clip.duration * (i / CURVE_SAMPLES);
          const r = keyframeEngine.getValueAtTime(kfs, t);
          const v = typeof r.value === "number" ? r.value : volume;
          s.push(`${i === 0 ? "M" : "L"} ${timeToPct(t).toFixed(2)} ${valToPct(v).toFixed(2)}`);
        }
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
        {/* Visible envelope line. On an UNSELECTED clip we only draw it
            when there's actual automation to show (informative); a flat
            unity line on every clip is just clutter. Selecting the clip
            always reveals the bright, editable line — that's the
            "select to edit volume" affordance. */}
        {(isSelected || hasPoints) && (
          <path
            d={path}
            fill="none"
            stroke="#fbbf24"
            strokeWidth={interactive ? 2 : 1.5}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: "none" }}
            opacity={isSelected ? 0.95 : 0.5}
          />
        )}
      </svg>
      {/* "Volume" hint on the selected clip so the line reads as editable. */}
      {interactive && (
        <div className="absolute top-0.5 left-1 text-[9px] font-medium text-amber-300/80 pointer-events-none select-none">
          VOL
        </div>
      )}
      {interactive &&
        points.map((p, i) => (
          <div
            key={p.id}
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
