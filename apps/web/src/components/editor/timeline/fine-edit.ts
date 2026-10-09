import { useLayoutEffect } from "react";
import type { Clip, MediaItem } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";

/**
 * FINE EDITS — the polish gestures on top of an AI-made cut (9 Oct 2026).
 *
 * One meaning per spot on a clip, so the hand learns it once:
 *   edge          → trim            (existing)
 *   seam          → ROLL the cut    (both clips change, nothing else moves)
 *   body          → move            (existing)
 *   Alt + body    → SLIP            (same place and length, different frames)
 *   top corners   → audio FADE in / out
 *   Alt + drop    → REPLACE the take under the pointer
 *
 * Every gesture follows the trim pattern: live updates write the store with no
 * history while the mouse moves, then on release the original geometry is put
 * back silently and the final values are committed as ONE executor action, so
 * Ctrl+Z undoes the whole drag in one step. The limits below are the only
 * place the rules live; the gestures and the keyboard nudges share them.
 */

export const MIN_CLIP = 0.1; // seconds a clip may shrink to under a roll

/** Length of the clip's source, or Infinity when unknown / a still image. */
export function sourceDurationOf(media: MediaItem | undefined): number {
  if (!media || media.type === "image") return Infinity;
  const d = media.metadata?.duration ?? 0;
  return d > 0 ? d : Infinity;
}

/** Source span the clip plays (differs from duration when retimed). */
export function sourceSpan(clip: Pick<Clip, "inPoint" | "outPoint" | "duration">): number {
  const s = (clip.outPoint ?? 0) - (clip.inPoint ?? 0);
  return s > 0 ? s : clip.duration;
}

/** A clip can be slipped when it has real source media with room to move. */
export function canSlip(media: MediaItem | undefined): boolean {
  return !!media && (media.type === "video" || media.type === "audio");
}

/** New in-point for a slip, held inside the source. */
export function clampSlipIn(wantIn: number, span: number, srcDur: number): number {
  const max = Number.isFinite(srcDur) ? Math.max(0, srcDur - span) : Infinity;
  return Math.min(Math.max(0, wantIn), max);
}

/** Two clips butt when the first ends where the second starts (± half a ms). */
export function areButted(a: Pick<Clip, "startTime" | "duration">, b: Pick<Clip, "startTime">): boolean {
  return Math.abs(a.startTime + a.duration - b.startTime) < 5e-4;
}

/** A cut can be rolled only between untimed clips (a retimed clip's source
 *  and timeline seconds differ, and the core roll moves both by one delta). */
export function canRoll(left: Clip, right: Clip): boolean {
  return (left.speed ?? 1) === 1 && (right.speed ?? 1) === 1;
}

/**
 * How far the cut between `left` and `right` may move. Positive = later.
 * Later: the outgoing clip needs source after its out-point, the incoming one
 * must keep MIN_CLIP. Earlier: the reverse, and the incoming clip cannot reach
 * before its source's first frame.
 */
export function clampRollDelta(delta: number, left: Clip, right: Clip, leftSrcDur: number): number {
  const leftRoom = Number.isFinite(leftSrcDur) ? leftSrcDur - (left.outPoint ?? left.duration) : Infinity;
  const maxLater = Math.min(leftRoom, right.duration - MIN_CLIP);
  const maxEarlier = Math.min(left.duration - MIN_CLIP, right.inPoint ?? 0);
  return Math.min(Math.max(delta, -Math.max(0, maxEarlier)), Math.max(0, maxLater));
}

/** Fade lengths: each at least 0, together never longer than the clip. */
export function clampFade(want: number, other: number, duration: number): number {
  return Math.min(Math.max(0, want), Math.max(0, duration - other));
}

export type ClipGeom = { startTime: number; duration: number; inPoint: number; outPoint: number };

export function geomOf(c: Clip): ClipGeom {
  return {
    startTime: c.startTime,
    duration: c.duration,
    inPoint: c.inPoint ?? 0,
    outPoint: c.outPoint ?? (c.inPoint ?? 0) + c.duration,
  };
}

export function findClip(clipId: string): Clip | undefined {
  return useProjectStore.getState().project.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
}

/** Live, history-free patch of one or more clips (drag in progress). */
export function patchClips(patches: Record<string, Partial<Clip>>): void {
  useProjectStore.setState((state) => ({
    project: {
      ...state.project,
      timeline: {
        ...state.project.timeline,
        tracks: state.project.timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((c) => (patches[c.id] ? { ...c, ...patches[c.id] } : c)),
        })),
      },
      modifiedAt: Date.now(),
    },
  }));
}

const actionId = (kind: string) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Release of a slip: restore, then ONE undoable clip/slip. */
export async function commitSlip(clipId: string, orig: ClipGeom, finalIn: number): Promise<void> {
  const delta = finalIn - orig.inPoint;
  patchClips({ [clipId]: { inPoint: orig.inPoint, outPoint: orig.outPoint } });
  if (Math.abs(delta) < 1e-6) return;
  await useProjectStore.getState().slipClip(clipId, delta);
}

/** Release of a roll: restore both, then ONE undoable clip/roll. */
export async function commitRoll(
  leftId: string,
  rightId: string,
  origLeft: ClipGeom,
  origRight: ClipGeom,
  delta: number,
): Promise<void> {
  patchClips({ [leftId]: { ...origLeft }, [rightId]: { ...origRight } });
  if (Math.abs(delta) < 1e-6) return;
  await useProjectStore.getState().rollEdit(leftId, rightId, delta);
}

/** Release of a fade drag: restore, then ONE undoable audio/setFade. */
export async function commitFade(
  clipId: string,
  orig: { fadeIn: number; fadeOut: number },
  final: { fadeIn: number; fadeOut: number },
): Promise<void> {
  patchClips({ [clipId]: { fade: orig } as Partial<Clip> });
  if (Math.abs(final.fadeIn - orig.fadeIn) < 1e-6 && Math.abs(final.fadeOut - orig.fadeOut) < 1e-6) return;
  await useProjectStore.getState().executeAction({
    type: "audio/setFade",
    id: actionId("fade"),
    timestamp: Date.now(),
    params: { clipId, fadeIn: final.fadeIn, fadeOut: final.fadeOut },
  } as never);
}

/**
 * The window listeners every fine-edit drag needs: move, release (commit) and
 * Escape (cancel), with the body cursor held for the whole gesture so it does
 * not flicker as the pointer leaves the element. `onMove` / `finish` are read
 * from the render that STARTED the gesture; keep live values in refs.
 */
export function useFineEditDrag(
  active: boolean,
  cursor: string,
  onMove: (e: MouseEvent) => void,
  finish: (commit: boolean) => void,
): void {
  useLayoutEffect(() => {
    if (!active) return;
    document.body.style.cursor = cursor;
    const end = (commit: boolean) => {
      document.body.style.cursor = "";
      finish(commit);
    };
    const onUp = () => end(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      end(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/** Cursor that says SLIP: a film frame with arrows both ways. */
export const SLIP_CURSOR =
  `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="6" width="10" height="12" rx="1.5"/><path d="M2 12h3M19 12h3M4 10l-2 2 2 2M20 10l2 2-2 2"/></g><g fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="6" width="10" height="12" rx="1.5"/><path d="M2 12h3M19 12h3M4 10l-2 2 2 2M20 10l2 2-2 2M9.5 8.5v1M14.5 8.5v1M9.5 14.5v1M14.5 14.5v1"/></g></svg>',
  )}") 12 12, ew-resize`;

/** Cursor that says ROLL: a cut line with arrows both ways. */
export const ROLL_CURSOR =
  `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4v16M14 4v16M3 12h4M17 12h4M5 10l-2 2 2 2M19 10l2 2-2 2"/></g><g fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4v16M14 4v16M3 12h4M17 12h4M5 10l-2 2 2 2M19 10l2 2-2 2"/></g></svg>',
  )}") 12 12, col-resize`;
