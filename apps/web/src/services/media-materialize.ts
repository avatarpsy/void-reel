/**
 * Background materialization of blob-only timeline media.
 *
 * Media imported by drag/drop (or pasted) lives as a Blob in THIS browser's
 * IndexedDB with no durable URL — open the same project on any other
 * machine (or after storage eviction) and the clip renders a placeholder.
 * Production→localhost is the reported case, but any second device hits it.
 *
 * After every successful remote sync we sweep the timeline for clips whose
 * media has bytes locally but no reachable originalUrl, upload the bytes to
 * the user's durable storage (same save-render path the materialize-media
 * RPC uses) and repoint originalUrl — from then on the project is portable.
 *
 * Single-flight; each media id attempted once per session (a failed upload
 * retries next session rather than hammering); items already durable are
 * skipped by the same "reachable" test the materialize-media RPC uses.
 */
import { useProjectStore } from "../stores/project-store";
import { loadMediaBlob } from "./media-storage";
import { saveMediaToDisk } from "./recording-save";

let sweepInFlight = false;
const attempted = new Set<string>();

function isReachable(url: unknown): boolean {
  return typeof url === "string" && url.length > 0
    && (/^https?:\/\//i.test(url) || url.includes("/api/studio/local-asset"));
}

function guessExt(name: string | undefined, mime: string | undefined, type: string | undefined): string {
  const fromName = (name || "").split(".").pop()?.toLowerCase();
  if (fromName && /^(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|ogg)$/.test(fromName)) return fromName;
  if (mime?.includes("png")) return "png";
  if (mime?.includes("jpeg") || mime?.includes("jpg")) return "jpg";
  if (mime?.includes("webp")) return "webp";
  if (mime?.includes("mp4")) return "mp4";
  if (mime?.includes("webm")) return "webm";
  if (mime?.includes("mpeg") || mime?.includes("mp3")) return "mp3";
  if (mime?.includes("wav")) return "wav";
  if (type === "image") return "png";
  if (type === "audio") return "mp3";
  return "webm";
}

/** save-render kind per media type — images land lossless in frames/,
 *  audio in music/, video takes in recordings/. */
function kindFor(type: string | undefined): "image" | "music" | "recordings" {
  if (type === "image") return "image";
  if (type === "audio") return "music";
  return "recordings";
}

export async function sweepMaterializeTimelineMedia(): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const project = useProjectStore.getState().project;
    const usedMediaIds = new Set<string>();
    for (const track of project.timeline?.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.mediaId) usedMediaIds.add(clip.mediaId);
      }
    }
    for (const item of project.mediaLibrary?.items ?? []) {
      if (!usedMediaIds.has(item.id)) continue;         // library-only: publish covers it
      if (isReachable(item.originalUrl)) continue;      // already durable
      if (attempted.has(item.id)) continue;
      attempted.add(item.id);
      try {
        const blob = (item.blob instanceof Blob ? item.blob : null) ?? await loadMediaBlob(item.id);
        if (!blob) continue; // no bytes on this machine — nothing to upload
        const ext = guessExt(item.name, blob.type, (item as any).type);
        const saved = await saveMediaToDisk(blob, item.name || "timeline-media", ext, kindFor((item as any).type));
        if (saved?.url) {
          useProjectStore.setState((s: any) => ({
            project: {
              ...s.project,
              mediaLibrary: {
                ...s.project.mediaLibrary,
                items: (s.project.mediaLibrary?.items ?? []).map((m: any) =>
                  m.id === item.id ? { ...m, originalUrl: m.originalUrl ?? saved.url } : m,
                ),
              },
              modifiedAt: Date.now(),
            },
          }));
          console.log(`[media-materialize] ${item.name || item.id} → durable URL (project is now portable for this clip)`);
        }
      } catch (e) {
        console.warn(`[media-materialize] upload failed for ${item.id} (will retry next session):`, e);
      }
    }
  } finally {
    sweepInFlight = false;
  }
}
