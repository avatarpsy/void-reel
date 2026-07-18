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
import { loadMediaBlob } from "./media-storage";
import { fetchMediaBlob } from "./voidspace-loader";

const THUMB_COUNT = 10;
const THUMB_H = 54;
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

async function resolveBlob(item: MediaItem): Promise<Blob | null> {
  if (item.blob instanceof Blob) return item.blob;
  const persisted = await loadMediaBlob(item.id).catch(() => null);
  if (persisted) return persisted;
  if (item.originalUrl) {
    return await fetchMediaBlob(item.originalUrl).catch(() => null);
  }
  return null;
}

/** Generate (or return existing) filmstrip thumbnails for a video item. */
export function ensureMediaFilmstrip(
  item: MediaItem | null | undefined,
): Promise<FilmstripThumbnail[] | null> {
  if (!item || item.type !== "video") return Promise.resolve(null);
  if (item.filmstripThumbnails && item.filmstripThumbnails.length > 0) {
    return Promise.resolve(item.filmstripThumbnails as FilmstripThumbnail[]);
  }
  if (item.isPlaceholder || item.isPending) return Promise.resolve(null);
  const lastFail = failedAt.get(item.id);
  if (lastFail && Date.now() - lastFail < FAIL_RETRY_MS) {
    return Promise.resolve(null);
  }
  const existing = inFlight.get(item.id);
  if (existing) return existing;

  const job = (async (): Promise<FilmstripThumbnail[] | null> => {
    await acquireSlot();
    let objectUrl: string | null = null;
    try {
      const blob = await resolveBlob(item);
      if (!blob) {
        failedAt.set(item.id, Date.now());
        return null;
      }
      objectUrl = URL.createObjectURL(blob);
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("metadata timeout")), 15000);
        video.onloadedmetadata = () => { clearTimeout(t); resolve(); };
        video.onerror = () => { clearTimeout(t); reject(new Error("video load error")); };
      });
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (duration <= 0 || !video.videoWidth) {
        failedAt.set(item.id, Date.now());
        return null;
      }
      const aspect = video.videoWidth / Math.max(1, video.videoHeight);
      const w = Math.max(2, Math.round(THUMB_H * aspect));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = THUMB_H;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        failedAt.set(item.id, Date.now());
        return null;
      }
      const thumbs: FilmstripThumbnail[] = [];
      for (let i = 0; i < THUMB_COUNT; i++) {
        const t = (duration * (i + 0.5)) / THUMB_COUNT;
        await new Promise<void>((resolve, reject) => {
          const to = setTimeout(() => reject(new Error("seek timeout")), 8000);
          video.onseeked = () => { clearTimeout(to); resolve(); };
          video.onerror = () => { clearTimeout(to); reject(new Error("seek error")); };
          video.currentTime = Math.min(Math.max(0, t), Math.max(0, duration - 0.05));
        });
        ctx.drawImage(video, 0, 0, w, THUMB_H);
        const tile: Blob | null = await new Promise((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/jpeg", 0.6),
        );
        if (tile) thumbs.push({ timestamp: t, url: URL.createObjectURL(tile) });
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      releaseSlot();
    }
  })();

  inFlight.set(item.id, job);
  void job.finally(() => inFlight.delete(item.id));
  return job;
}
