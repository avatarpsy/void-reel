import { getWaveformGenerator } from "@openreel/core";
import type { MediaItem } from "@openreel/core";
import { loadMediaBlobForProject, saveMediaBlob } from "./media-storage";
import { fetchMediaBlob } from "./voidspace-loader";
import { useProjectStore } from "../stores/project-store";

/** Result of a waveform generation: the peaks plus the media's REAL
 *  duration (decoded from the audio itself — authoritative over a stale
 *  metadata.duration). */
export interface WaveformResult {
  peaks: Float32Array;
  duration: number;
}

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
const inFlight = new Map<string, Promise<WaveformResult | null>>();

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

async function resolveBlob(item: MediaItem, projectId: string): Promise<Blob | null> {
  if (item.blob instanceof Blob) return item.blob;
  // Project-scoped: never accept another project's blob under a colliding
  // mediaId (that would generate a waveform for the WRONG audio).
  let blob = await loadMediaBlobForProject(projectId, item.id).catch(() => null);
  if (!blob && item.originalUrl) {
    blob = await fetchMediaBlob(item.originalUrl).catch(() => null);
  }
  if (blob) {
    // CACHE THE BYTES BACK. Previously the fetched blob was used for
    // generation then discarded, so item.blob stayed null forever — the
    // effect never retriggered and the failure cooldown stranded the
    // placeholder. Writing it back flips !!item.blob (retrigger), feeds
    // playback, and persists to IndexedDB (scoped) for next load.
    try { useProjectStore.getState().setMediaBlob(item.id, blob); } catch { /* store gone */ }
    try { if (projectId) void saveMediaBlob(projectId, item.id, blob, (item.metadata ?? {}) as any); } catch { /* best-effort */ }
  }
  return blob;
}

/**
 * Ensure peaks exist for an audio/video media item. Resolves to the
 * peaks Float32Array (also cached on disk), or null if the media has no
 * audio / no resolvable source. Safe to call repeatedly — deduped.
 *
 * projectId scopes both the blob load and the waveform cache so two
 * projects sharing a mediaId can't cross-contaminate.
 */
export function ensureMediaWaveform(
  item: MediaItem | undefined | null,
  projectId = "",
): Promise<WaveformResult | null> {
  if (!item) return Promise.resolve(null);
  if (item.type !== "audio" && item.type !== "video") {
    return Promise.resolve(null);
  }
  if (item.isPlaceholder || item.isPending) return Promise.resolve(null);
  // Cooldown suppresses retries after a failure — BUT if the bytes are now
  // resident (blob hydrated after the first, blob-less attempt), bypass it.
  // Otherwise the placeholder sine stuck for the whole 20s window even
  // though the audio had arrived (the "waveform never appears" report).
  const hasBytes = item.blob instanceof Blob;
  const lastFail = failedAt.get(item.id);
  if (!hasBytes && lastFail && Date.now() - lastFail < FAIL_RETRY_MS) {
    return Promise.resolve(null);
  }

  const existing = inFlight.get(item.id);
  if (existing) return existing;

  const job = (async (): Promise<WaveformResult | null> => {
    await acquireSlot();
    try {
      const blob = await resolveBlob(item, projectId);
      if (!blob) {
        failedAt.set(item.id, Date.now());
        return null;
      }
      const waveform = await getWaveformGenerator().generateWaveform(
        blob,
        projectId ? `${projectId}::${item.id}` : item.id,
        { samplesPerSecond: SAMPLES_PER_SECOND, enableCaching: true },
      );
      const peaks = waveform?.peaks ?? null;
      if (!peaks) { failedAt.set(item.id, Date.now()); return null; }
      failedAt.delete(item.id);
      return { peaks, duration: waveform?.duration ?? 0 };
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
