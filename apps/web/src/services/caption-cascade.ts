/**
 * Apply the caption-ownership rules (see @openreel/core caption-ownership.ts)
 * to the LIVE editor when the agent removes, moves or trims a media clip.
 *
 * Only captions linked to that clip are touched; everything goes through the
 * ActionExecutor so one Ctrl+Z restores the clip and its captions together.
 */
import {
  captionsOwnedBy,
  describeCaption,
  planOwnedCaptions,
  type ClipWindow,
  type TextClip,
} from "@openreel/core";
import { useProjectStore } from "../stores/project-store";
import { useEngineStore } from "../stores/engine-store";

export type DescribedCaption = ReturnType<typeof describeCaption>;

function liveTextClips(): TextClip[] {
  const engineClips = useEngineStore.getState().getTitleEngine()?.getAllTextClips() ?? [];
  return engineClips.length > 0
    ? engineClips
    : ((useProjectStore.getState().project.textClips ?? []) as TextClip[]);
}

export function timelineClipExists(clipId: string): boolean {
  return (useProjectStore.getState().project.timeline?.tracks ?? [])
    .some((t) => t.clips.some((c) => c.id === clipId));
}

export function clipWindow(clipId: string): ClipWindow | null {
  for (const t of useProjectStore.getState().project.timeline?.tracks ?? []) {
    const c = t.clips.find((cc) => cc.id === clipId);
    if (c) return { startTime: c.startTime, inPoint: c.inPoint ?? 0, duration: c.duration };
  }
  return null;
}

/** Captions owned by `clipId`. Call BEFORE removing the clip: a legacy
 *  caption's owner is derived from which scene clips exist. */
export function ownedCaptions(clipId: string): TextClip[] {
  return captionsOwnedBy(clipId, liveTextClips(), timelineClipExists);
}

async function removeCaptions(captions: readonly TextClip[]): Promise<DescribedCaption[]> {
  const store = useProjectStore.getState() as any;
  const removed: DescribedCaption[] = [];
  for (const c of captions) {
    const r = await store.removeTextClip(c.id);
    if (r?.success) removed.push(describeCaption(c));
  }
  return removed;
}

/** Run `fn` as ONE undo step (clip edit + its caption cascade). */
export async function asOneUndoStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const history = (useProjectStore.getState() as any).actionHistory;
  history?.beginGroup?.(label);
  try {
    return await fn();
  } finally {
    history?.endGroup?.();
  }
}

/** Remove the captions a just-removed clip owned (captured before removal). */
export function removeOwnedCaptions(captions: readonly TextClip[]): Promise<DescribedCaption[]> {
  return removeCaptions(captions);
}

/**
 * After `clipId` moved or was trimmed from `before`: shift its captions with
 * it and remove those now wholly outside it. Unlinked captions never move.
 */
export async function carryOwnedCaptions(
  clipId: string,
  before: ClipWindow,
  captions: readonly TextClip[],
): Promise<{ captionsRemoved: DescribedCaption[]; captionsMoved: number }> {
  const after = clipWindow(clipId);
  if (!after || captions.length === 0) return { captionsRemoved: [], captionsMoved: 0 };
  const plan = planOwnedCaptions(captions, before, after);
  const store = useProjectStore.getState() as any;
  let captionsMoved = 0;
  for (const m of plan.moved) {
    const r = await store.updateTextClip(m.caption.id, { startTime: m.startTime });
    if (r?.success) captionsMoved++;
  }
  const captionsRemoved = await removeCaptions(plan.removed);
  return { captionsRemoved, captionsMoved };
}
