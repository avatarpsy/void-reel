import { getWaveformGenerator } from "@openreel/core";
import type { MediaItem } from "@openreel/core";
import { loadMediaBlob } from "./media-storage";
import { fetchMediaBlob } from "./voidspace-loader";

/**
 * Lazy, deduped, concurrency-limited waveform peak generation.
 *
 * The project serializer strips `waveformData` to null on save
 * (project-serializer.ts) so peaks are never persisted into the
 * Firestore project blob — keeping it well under the ~900KB limit no
 * matter how many audio clips a project carries. That means on every
 * load, AND for every remote-loaded Voidspace asset (music, narration,
 * SFX) and agent-added clip, `MediaItem.waveformData` starts as null.
 *
 * This service fills that gap uniformly: given any audio/video media
 * item without peaks, it resolves a Blob (persisted IndexedDB blob →
 * in-memory blob → remote URL via the CORS proxy) and runs it through
 * the core WaveformGenerator, which memoizes in RAM and caches in
 * IndexedDB keyed by mediaId — so a reload re-reads peaks instead of
 * re-decoding the audio.
 *
 * Generation is triggered lazily by the timeline clip the first time a
 * clip referencing the media is mounted, so we only ever decode media
 * that is actually on the timeline, and many clips sharing one media
 * collapse to a single in-flight job.
 */

/** Waveform resolution (samples/sec). Matches the media-bridge import path. */
const SAMPLES_PER_SECOND = 100;

/** Cap concurrent decodes so a project with many audio clips doesn't
 *  spin up dozens of mediabunny/decodeAudioData jobs at once. */
const MAX_CONCURRENT = 3;

/** In-flight jobs keyed by mediaId — collapses duplicate requests
 *  (e.g. several clips referencing the same track). */
const inFlight = new Map<string, Promise<Float32Array | null>>();

/** mediaIds whose last attempt failed, with WHEN — retried after a
 * cooldown instead of never. A permanent blacklist froze the placeholder
 * sine for the whole session when the FIRST attempt raced a not-yet-ready
 * auth token / still-hydrating blob (the "inconsistent waveform" glitch).
 * Old comment: don't retry on
 *  every re-render (a 401/404/missing source won't fix itself within a
 *  session; the user re-adding the asset mints a fresh id). */
const failedAt = new Map<string, number>();
const FAIL_RETRY_MS = 20_000;

let active = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  active--;
  const next = waiters.shift();
  if (next) {
    active++;
    next();
  }
}

async function resolveBlob(item: MediaItem): Promise<Blob | null> {
  if (item.blob) return item.blob;
  const persisted = await loadMediaBlob(item.id).catch(() => null);
  if (persisted) return persisted;
  if (item.originalUrl) {
    return await fetchMediaBlob(item.originalUrl).catch(() => null);
  }
  return null;
}

/**
 * Ensure peaks exist for an audio/video media item. Resolves to the
 * peaks Float32Array (also cached on disk), or null if the media has no
 * audio / no resolvable source. Safe to call repeatedly — deduped.
 */
export function ensureMediaWaveform(
  item: MediaItem | undefined | null,
): Promise<Float32Array | null> {
  if (!item) return Promise.resolve(null);
  if (item.waveformData) return Promise.resolve(item.waveformData);
  if (item.type !== "audio" && item.type !== "video") {
    return Promise.resolve(null);
  }
  if (item.isPlaceholder || item.isPending) return Promise.resolve(null);
  const lastFail = failedAt.get(item.id);
  if (lastFail && Date.now() - lastFail < FAIL_RETRY_MS) {
    return Promise.resolve(null);
  }

  const existing = inFlight.get(item.id);
  if (existing) return existing;

  const job = (async (): Promise<Float32Array | null> => {
    await acquireSlot();
    try {
      const blob = await resolveBlob(item);
      if (!blob) {
        failedAt.set(item.id, Date.now());
        return null;
      }
      const waveform = await getWaveformGenerator().generateWaveform(
        blob,
        item.id,
        { samplesPerSecond: SAMPLES_PER_SECOND, enableCaching: true },
      );
      const peaks = waveform?.peaks ?? null;
      if (!peaks) failedAt.set(item.id, Date.now());
      else failedAt.delete(item.id);
      return peaks;
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
