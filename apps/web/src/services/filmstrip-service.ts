/**
 * Lazy filmstrip generation for video media that arrived WITHOUT
 * filmstripThumbnails — remote Voidspace scene videos and agent-added
 * clips (only locally-imported files get strips at import time). Without
 * a strip, the timeline clip falls back to a single tiled poster, which
 * stretches on trim instead of revealing frames — the opposite of the
 * Premiere/Resolve media-anchored behaviour the filmstrip renderer
 * implements when real timestamps exist.
 *
 * Mirrors waveform-service: deduped in-flight, concurrency-capped,
 * failure cooldown (never a permanent blacklist). Thumbnails are
 * session-scoped blob: URLs — the autosave recovery path already strips
 * dead blob: URLs and expects lazy regeneration ("the editor regenerates
 * it lazily from the source asset").
 */
import type { MediaItem, FilmstripThumbnail } from "@openreel/core";
import { getMediaEngine } from "@openreel/core";
import { loadMediaBlobForProject, saveMediaBlob } from "./media-storage";
import { fetchMediaBlob } from "./voidspace-loader";
import { useProjectStore } from "../stores/project-store";

const THUMB_COUNT = 10;
const THUMB_W = 96; // thumbnail width px (mediabunny derives height by aspect)
const FAIL_RETRY_MS = 20_000;
const MAX_CONCURRENT = 2;

const inFlight = new Map<string, Promise<FilmstripThumbnail[] | null>>();
const failedAt = new Map<string, number>();
let active = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}
function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

async function resolveBlob(item: MediaItem, projectId: string): Promise<Blob | null> {
  if (item.blob instanceof Blob) return item.blob;
  // Project-scoped so a colliding mediaId can't hand us another project's
  // video (which would build a filmstrip of the wrong footage).
  let blob = await loadMediaBlobForProject(projectId, item.id).catch(() => null);
  if (!blob && item.originalUrl) {
    blob = await fetchMediaBlob(item.originalUrl).catch(() => null);
  }
  if (blob) {
    // Cache the bytes back (feeds playback + retriggers effects) instead of
    // discarding them after building the strip. Same fix as waveform-service.
    try { useProjectStore.getState().setMediaBlob(item.id, blob); } catch { /* store gone */ }
    try { if (projectId) void saveMediaBlob(projectId, item.id, blob, (item.metadata ?? {}) as any); } catch { /* best-effort */ }
  }
  return blob;
}

/** Generate (or return existing) filmstrip thumbnails for a video item. */
export function ensureMediaFilmstrip(
  item: MediaItem | null | undefined,
  projectId = "",
): Promise<FilmstripThumbnail[] | null> {
  if (!item || item.type !== "video") return Promise.resolve(null);
  if (item.filmstripThumbnails && item.filmstripThumbnails.length > 0) {
    return Promise.resolve(item.filmstripThumbnails as FilmstripThumbnail[]);
  }
  if (item.isPlaceholder || item.isPending) return Promise.resolve(null);
  // Bypass the failure cooldown once the bytes are resident (blob hydrated
  // after a first blob-less attempt) — same fix the waveform service has,
  // so a remote video's strip isn't stranded for 20s after its blob lands.
  const hasBytes = item.blob instanceof Blob;
  const lastFail = failedAt.get(item.id);
  if (!hasBytes && lastFail && Date.now() - lastFail < FAIL_RETRY_MS) {
    return Promise.resolve(null);
  }
  const existing = inFlight.get(item.id);
  if (existing) return existing;

  const job = (async (): Promise<FilmstripThumbnail[] | null> => {
    await acquireSlot();
    try {
      const blob = await resolveBlob(item, projectId);
      if (!blob) {
        failedAt.set(item.id, Date.now());
        return null;
      }
      // Decode via mediabunny's CanvasSink — the SAME proven decoder the
      // import, waveform and playback paths use. The old raw <video> seek
      // loop failed silently on remote/AI MP4s (Infinity/NaN video.duration,
      // seeks that never fire `seeked`, drawImage before HAVE_CURRENT_DATA)
      // → no thumbnails → the flat gradient the user saw.
      const durHint = (item.metadata?.duration && item.metadata.duration > 0)
        ? item.metadata.duration
        : 8; // count is derived from this; frames past EOF just return null
      const interval = Math.max(0.4, durHint / THUMB_COUNT);
      const results = await getMediaEngine().generateFilmstripThumbnails(
        blob, durHint, THUMB_W, interval,
      );
      const thumbs: FilmstripThumbnail[] = [];
      for (const r of results) {
        if (r?.dataUrl) thumbs.push({ timestamp: r.timestamp, url: r.dataUrl });
      }
      if (thumbs.length === 0) {
        failedAt.set(item.id, Date.now());
        return null;
      }
      failedAt.delete(item.id);
      return thumbs;
    } catch {
      failedAt.set(item.id, Date.now());
      return null;
    } finally {
      releaseSlot();
    }
  })();

  inFlight.set(item.id, job);
  void job.finally(() => inFlight.delete(item.id));
  return job;
}
