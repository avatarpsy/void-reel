import type { Clip, MediaItem } from "@openreel/core";
import { useProjectStore } from "../stores/project-store";
import { useEngineStore } from "../stores/engine-store";
import { recordLiveSwap } from "./live-swap-authority";

/**
 * Swap the media under a clip for another take — the person's Alt+drop.
 *
 * Same contract as the agent's `replace_clip_media`: the clip keeps its id,
 * track, start, length, fades, volume, effects and captions; only its media
 * (and the in/out window, clamped to the new media) change. ONE
 * `clip/replaceMedia` action, so a single Ctrl+Z restores the old take.
 *
 * The window: alternate takes of one shot usually line up, so the old in-point
 * is kept when the new media is long enough; otherwise it slides back so the
 * visible length still fits. A new take SHORTER than the clip shortens the
 * clip rather than freezing on its last frame.
 */
export type ReplaceTakeResult = { ok: true } | { ok: false; reason: string };

/** Which media kinds can stand in for which. Pictures for pictures, sound for sound. */
export function takeKindsMatch(clipMedia: MediaItem | undefined, newMedia: MediaItem | undefined): boolean {
  if (!clipMedia || !newMedia) return false;
  const pic = (t: string) => t === "video" || t === "image";
  if (pic(clipMedia.type)) return pic(newMedia.type);
  return clipMedia.type === newMedia.type;
}

export function planTakeWindow(
  clip: Pick<Clip, "inPoint" | "outPoint" | "duration">,
  newMediaDuration: number,
  newIsStill: boolean,
): { inPoint: number; outPoint: number } {
  const span = Math.max(0.05, (clip.outPoint ?? 0) - (clip.inPoint ?? 0) || clip.duration);
  if (newIsStill || !(newMediaDuration > 0)) {
    return { inPoint: 0, outPoint: span };
  }
  if (newMediaDuration <= span) return { inPoint: 0, outPoint: newMediaDuration };
  const inPoint = Math.min(Math.max(0, clip.inPoint ?? 0), newMediaDuration - span);
  return { inPoint, outPoint: inPoint + span };
}

export async function replaceClipTake(clipId: string, newMediaId: string): Promise<ReplaceTakeResult> {
  const store = useProjectStore.getState();
  const clip = store.project.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  if (!clip) return { ok: false, reason: "That clip is no longer on the timeline." };
  if (clip.mediaId === newMediaId) return { ok: false, reason: "That clip already uses this media." };
  const oldMedia = store.getMediaItem(clip.mediaId);
  const newMedia = store.getMediaItem(newMediaId);
  if (!newMedia) return { ok: false, reason: "The new media is not in this project." };
  if (!takeKindsMatch(oldMedia, newMedia)) {
    const kind = (t?: string) => (t === "audio" ? "sound" : "picture");
    return {
      ok: false,
      reason: `A ${kind(newMedia.type)} can't replace a ${kind(oldMedia?.type)} clip — drop it on a ${kind(newMedia.type)} clip.`,
    };
  }
  const isStill = newMedia.type === "image";
  const { inPoint, outPoint } = planTakeWindow(clip, newMedia.metadata?.duration ?? 0, isStill);

  const result = await store.executeAction({
    type: "clip/replaceMedia",
    id: `replace-take-${Date.now().toString(36)}`,
    timestamp: Date.now(),
    params: { clipId, mediaId: newMediaId, inPoint, outPoint },
  } as never);
  if (!result.success) {
    return { ok: false, reason: result.error?.message ?? "The take could not be replaced." };
  }
  // The old take's decoded audio must not keep playing under the new picture.
  useEngineStore.getState().getPlaybackController()?.invalidateAudioForMedia(
    [clip.mediaId, newMediaId][Symbol.iterator](),
  );
  // A board-linked clip is rebuilt from its board shot; keep this choice.
  if (newMedia.originalUrl) recordLiveSwap(clipId, newMedia.originalUrl);
  return { ok: true };
}
