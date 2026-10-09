import type { MediaItem } from "@openreel/core";
import { useProjectStore } from "../stores/project-store";

/**
 * Bring a file the host names by URL into this project's media library, or
 * reuse it when it is already there.
 *
 * Extracted from the `voidspace:replace-clip-media` RPC so a board update
 * (services/board-updates.ts) imports a take exactly the way the chat's
 * regenerate flow does: the same id scheme (`media-<trackKind>-<hash(url)>`),
 * so a take sent by the board and the same take sent by the chat are ONE
 * library item, not two.
 */

/** Stable, short hash of a URL — the id suffix of url-imported media. */
export function stableUrlHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function urlMediaId(url: string, trackKind: string): string {
  return `media-${trackKind || "asset"}-${stableUrlHash(url)}`;
}

/**
 * A blob's real playable length, so a swap fits the clip to the NEW media
 * instead of keeping the old outPoint (a black tail when the take is shorter).
 */
export function probeBlobDuration(blob: Blob | null, mediaType: "video" | "audio"): Promise<number> {
  return new Promise((resolve) => {
    if (!blob || typeof document === "undefined") return resolve(0);
    let settled = false;
    const el = document.createElement(mediaType === "video" ? "video" : "audio");
    const obj = URL.createObjectURL(blob);
    const done = (d: number) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(obj); } catch { /* already gone */ }
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    el.src = obj;
  });
}

export interface EnsureUrlMediaOptions {
  url: string;
  /** The kind of track the media is for ("video", "narration", "audio"…) — names the id. */
  trackKind: string;
  /** Defaults to "video" on a video track, "audio" otherwise. */
  mediaType?: "video" | "audio" | "image";
  name?: string;
  posterUrl?: string;
  /** Known length; skips the probe. */
  durationSec?: number;
  /** Written as the item's length when nothing could be measured. */
  fallbackDuration?: number;
}

/**
 * Returns the library item for `url`, importing it when missing.
 *
 * `duration` is what is KNOWN about the media — the passed value, the probe, or
 * the existing item's metadata — and 0 when nothing could be measured; callers
 * decide their own fallback (the replace RPC keeps the old clip's window).
 */
export async function ensureUrlMedia(opts: EnsureUrlMediaOptions): Promise<{
  mediaId: string;
  item: MediaItem;
  duration: number;
}> {
  const { url, trackKind } = opts;
  const mediaType = opts.mediaType ?? (trackKind === "video" ? "video" : "audio");
  const mediaId = urlMediaId(url, trackKind);
  let duration = typeof opts.durationSec === "number" && opts.durationSec > 0 ? opts.durationSec : 0;
  const proj = useProjectStore.getState().project;
  const existing = proj.mediaLibrary?.items?.find((m) => m.id === mediaId) ?? null;
  if (existing) {
    if (!duration) duration = Number(existing.metadata?.duration) || 0;
    return { mediaId, item: existing, duration };
  }
  let blob: Blob | null = null;
  try {
    const r = await fetch(url);
    if (r.ok) blob = await r.blob();
  } catch { /* hydrate later */ }
  if (!duration && mediaType !== "image") duration = await probeBlobDuration(blob, mediaType);
  const resolvedDur = mediaType === "image" ? 0 : (duration || opts.fallbackDuration || 0);
  const item = {
    id: mediaId,
    name: opts.name || `Replaced ${trackKind || "asset"}`,
    type: mediaType,
    fileHandle: null,
    blob,
    metadata: { duration: resolvedDur, fileSize: blob?.size ?? 0, sampleRate: 44100, channels: 2 },
    // The scene's poster (first frame), so the Assets panel shows a real
    // thumbnail instead of a blank placeholder.
    thumbnailUrl: opts.posterUrl || (mediaType === "image" ? url : null),
    waveformData: null,
    originalUrl: url,
    category: mediaType === "image"
      ? "Frames"
      : trackKind === "video" ? "Scene Videos" : trackKind === "narration" ? "Narration" : "Audio",
    role: trackKind || "asset",
  } as unknown as MediaItem;
  useProjectStore.setState((s) => ({
    project: {
      ...s.project,
      mediaLibrary: { ...s.project.mediaLibrary, items: [...(s.project.mediaLibrary?.items ?? []), item] },
      modifiedAt: Date.now(),
    },
  }));
  return { mediaId, item, duration };
}
