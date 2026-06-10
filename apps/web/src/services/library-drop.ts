import { useProjectStore } from "../stores/project-store";
import { saveMediaBlob } from "./media-storage";

/**
 * Shared bridge that lets a card from the cross-project Library tab be dragged
 * onto the timeline EXACTLY like a native media item. The timeline's drop
 * handlers resolve a `mediaId` to a project MediaItem, but a Library asset
 * doesn't live in the project yet — so the drag carries `{ libraryItem }`
 * instead of `{ mediaId }`, and on drop we import the bytes into the project
 * here (the drop handler is async) and hand back the new mediaId, which then
 * drops onto the track via the normal path. Deduped by originalUrl so dragging
 * the same Library asset twice reuses the one MediaItem.
 *
 * Used by BOTH timeline drop targets (Timeline.tsx tracks-area + TrackLane).
 */
export interface DroppedLibraryItem {
  url: string;   // /api/studio/local-asset?... (same-origin; auth-stamped by the main.tsx fetch hook)
  kind: string;  // video | image | music | sfx | narration
  type: string;  // video | image | music | sfx | voice (coarse)
  label?: string;
}

/** Read a timeline drop payload that may be a native media item OR a Library
 *  item. Returns the project mediaId to place, importing the Library asset
 *  first if needed. Returns null if the payload is neither / import failed. */
export async function resolveDroppedMediaId(rawJson: string): Promise<string | null> {
  if (!rawJson) return null;
  let data: any;
  try { data = JSON.parse(rawJson); } catch { return null; }
  if (data && typeof data.mediaId === "string" && data.mediaId.trim()) {
    return data.mediaId; // native media item — already in the project
  }
  const li: DroppedLibraryItem | undefined = data?.libraryItem;
  if (!li || typeof li.url !== "string") return null;
  return importLibraryItemToProject(li);
}

/** Import a Library asset into the current project (IndexedDB + MediaItem) and
 *  return its mediaId. Idempotent by originalUrl. */
export async function importLibraryItemToProject(li: DroppedLibraryItem): Promise<string | null> {
  const store = useProjectStore.getState();
  const existing = store.project.mediaLibrary.items.find((m: any) => m.originalUrl === li.url);
  if (existing) return existing.id;
  try {
    // Same-origin local-asset fetch; the main.tsx hook stamps the auth token.
    const r = await fetch(li.url);
    if (!r.ok) return null;
    const blob = await r.blob();
    const ext = li.kind === "image" ? "jpg" : li.type === "video" ? "mp4" : "mp3";
    const safe = (li.label || li.kind).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48) || li.kind;
    const file = new File([blob], `${safe}.${ext}`, { type: blob.type || "application/octet-stream" });
    const before = new Set(store.project.mediaLibrary.items.map((i: any) => i.id));
    const result = await useProjectStore.getState().importMedia(file);
    if (!result.success) return null;
    const newItem = useProjectStore.getState().project.mediaLibrary.items.find((i: any) => !before.has(i.id));
    if (!newItem) return null;
    // Tag originalUrl (dedup + reload hydration) + a Library category, and
    // cache the blob under the new id so a reload restores it instantly.
    useProjectStore.setState((s: any) => ({
      project: {
        ...s.project,
        mediaLibrary: {
          ...s.project.mediaLibrary,
          items: s.project.mediaLibrary.items.map((m: any) =>
            m.id === newItem.id
              ? { ...m, originalUrl: m.originalUrl ?? li.url, category: m.category ?? "Library" }
              : m,
          ),
        },
        modifiedAt: Date.now(),
      },
    }));
    saveMediaBlob(useProjectStore.getState().project.id, newItem.id, blob, (newItem as any).metadata ?? {}).catch(() => {});
    return newItem.id;
  } catch {
    return null;
  }
}
