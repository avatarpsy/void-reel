/**
 * CAPTION OWNERSHIP — which captions a clip edit may touch.
 *
 * A text clip either BELONGS to one media clip (`linkedClipId`: the narration
 * or scene clip whose speech it captions) or it is TIMELINE-ANCHORED (typed
 * lyrics, titles, the end card). The rules are deliberately few:
 *
 *   remove owner  → its captions go too (and are reported)
 *   move owner    → its captions move by the same amount
 *   trim owner    → its captions stay on the words (shift by the in-point
 *                   change) and only those now wholly outside the clip go
 *   replace media → nothing happens to captions
 *
 * An unlinked caption is never moved or deleted by any of these. That is the
 * fix for 7 Oct (project bb319c0e): sweeps chose captions by TIME and mapped
 * clips to scenes by SORT INDEX, so trimming added footage deleted typed lyrics.
 *
 * Backward compatibility: projects saved before `linkedClipId` existed carry
 * none. The loader's own per-scene captions (`caption-<sceneKey>-<n>`) are
 * then linked by that scene key — to `clip-narration-<key>`, else
 * `clip-video-<key>`, else `clip-image-<key>` — never by position. Every other
 * text clip without a link is unlinked.
 */

export interface CaptionLike {
  readonly id: string;
  readonly startTime: number;
  readonly duration: number;
  readonly text?: string;
  readonly linkedClipId?: string;
}

/** A media clip's placement: where it sits and which part of its media shows. */
export interface ClipWindow {
  readonly startTime: number;
  readonly inPoint: number;
  readonly duration: number;
}

const EPS = 0.001;

/** `caption-<sceneKey>-<n>` → `<sceneKey>`; anything else → null. */
export function loaderCaptionSceneKey(captionId: string): string | null {
  const m = /^caption-(.+)-\d+$/.exec(captionId);
  return m ? m[1] : null;
}

/** The clip a loader scene caption belongs to, in preference order. */
export function sceneCaptionOwnerId(
  sceneKey: string,
  clipExists: (clipId: string) => boolean,
): string | null {
  for (const id of [
    `clip-narration-${sceneKey}`,
    `clip-video-${sceneKey}`,
    `clip-image-${sceneKey}`,
  ]) {
    if (clipExists(id)) return id;
  }
  return null;
}

/** The clip this caption belongs to, or null when it is timeline-anchored. */
export function captionOwnerId(
  caption: CaptionLike,
  clipExists: (clipId: string) => boolean,
): string | null {
  if (typeof caption.linkedClipId === "string" && caption.linkedClipId) {
    return caption.linkedClipId;
  }
  const key = loaderCaptionSceneKey(caption.id);
  return key ? sceneCaptionOwnerId(key, clipExists) : null;
}

export function captionsOwnedBy<T extends CaptionLike>(
  ownerId: string,
  captions: readonly T[],
  clipExists: (clipId: string) => boolean,
): T[] {
  return captions.filter((c) => captionOwnerId(c, clipExists) === ownerId);
}

/**
 * What an owner's move/trim does to its captions.
 *
 * A caption was cued to a moment of the owner's MEDIA. After the edit that
 * moment plays `(after.startTime - before.startTime) - (after.inPoint -
 * before.inPoint)` seconds later, so the caption shifts by exactly that. A
 * caption that overlapped the owner before and lies wholly outside it after is
 * removed; one that was already outside (placed there on purpose) is left be.
 */
export function planOwnedCaptions<T extends CaptionLike>(
  captions: readonly T[],
  before: ClipWindow,
  after: ClipWindow,
): { moved: Array<{ caption: T; startTime: number }>; removed: T[] } {
  const shift =
    after.startTime - before.startTime - (after.inPoint - before.inPoint);
  const overlaps = (s: number, e: number, w: ClipWindow) =>
    e > w.startTime + EPS && s < w.startTime + w.duration - EPS;
  const moved: Array<{ caption: T; startTime: number }> = [];
  const removed: T[] = [];
  for (const c of captions) {
    const s = c.startTime;
    const e = c.startTime + c.duration;
    const ns = Math.max(0, s + shift);
    const ne = ns + c.duration;
    if (overlaps(s, e, before) && !overlaps(ns, ne, after)) {
      removed.push(c);
    } else if (Math.abs(ns - s) > EPS) {
      moved.push({ caption: c, startTime: Math.round(ns * 1000) / 1000 });
    }
  }
  return { moved, removed };
}

/** The shape every tool result uses to report a caption it removed. */
export function describeCaption(c: CaptionLike): {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
} {
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    id: c.id,
    text: typeof c.text === "string" ? c.text.slice(0, 80) : "",
    startTime: r(c.startTime),
    endTime: r(c.startTime + c.duration),
  };
}
