/**
 * A project media item as a URL something OUTSIDE this browser can fetch.
 *
 * Media dropped or recorded in the editor exists only as bytes in this
 * browser's storage. A render on the desktop, a provider, the agent — none of
 * them can read that. This returns the item's existing reachable URL when it
 * has one, and otherwise saves its bytes to the user's cloud once and records
 * the URL on the item, so the next caller gets it for free.
 *
 * One implementation for every caller: the agent's `materialize_media` bridge
 * message and the graphic inspector's image/video slots both use it.
 */
import { useProjectStore } from "../stores/project-store";
import { loadMediaBlobForProject } from "./media-storage";

export interface MaterializedMedia {
  url: string;
  durationSec: number | null;
  alreadyUploaded: boolean;
}

export class MaterializeError extends Error {}

export async function materializeProjectMedia(mediaId: string): Promise<MaterializedMedia> {
  const proj = useProjectStore.getState().project;
  const item: any = (proj.mediaLibrary?.items ?? []).find((m: any) => m.id === mediaId);
  if (!item) throw new MaterializeError("no media found for that id");

  const existing = typeof item.originalUrl === "string" ? item.originalUrl : "";
  const reachable = !!existing && (/^https?:\/\//i.test(existing) || existing.includes("/api/studio/local-asset"));
  if (reachable) return { url: existing, durationSec: item.duration ?? null, alreadyUploaded: true };

  const blob = await loadMediaBlobForProject(proj.id, mediaId);
  if (!blob) throw new MaterializeError("media bytes not found in local storage");

  const guessExt = (): string => {
    const fromName = String(item.name || "").split(".").pop() || "";
    if (fromName && fromName !== item.name && /^[a-z0-9]{2,5}$/i.test(fromName)) return fromName.toLowerCase();
    const t = String(blob.type || item.mimeType || "").toLowerCase();
    if (t.includes("png")) return "png";
    if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
    if (t.includes("webp")) return "webp";
    if (t.includes("webm")) return "webm";
    if (t.includes("mp4")) return "mp4";
    if (t.includes("quicktime") || t.includes("mov")) return "mov";
    if (t.includes("wav")) return "wav";
    if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
    if (t.includes("ogg")) return "ogg";
    return "webm"; // webcam/screen MediaRecorder default
  };
  const { saveMediaToCloud } = await import("./cloud-save");
  const saved = await saveMediaToCloud(
    blob,
    item.name || "media",
    guessExt(),
    item.type === "image" ? "image" : "recordings",
  );
  if (!saved?.url) {
    throw new MaterializeError("Could not save the media. Open and save the project first, then try again.");
  }
  useProjectStore.setState((s: any) => ({
    project: {
      ...s.project,
      mediaLibrary: {
        ...s.project.mediaLibrary,
        items: (s.project.mediaLibrary?.items ?? []).map((m: any) =>
          m.id === mediaId ? { ...m, originalUrl: m.originalUrl ?? saved.url } : m,
        ),
      },
      modifiedAt: Date.now(),
    },
  }));
  return { url: saved.url, durationSec: item.duration ?? null, alreadyUploaded: false };
}
