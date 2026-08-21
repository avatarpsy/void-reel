import { useProjectStore } from "../stores/project-store";
import { saveMediaBlob } from "./media-storage";
import { renderBlock, RenderBlockError } from "./render-block";
import { useProcessingStore } from "./processing-manager";

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
  url: string;   // /api/studio/local-asset?... (same-origin; auth-stamped by the main.tsx fetch hook) OR an absolute cloud URL (Firestore-sourced Library items)
  kind: string;  // video | image | music | sfx | narration
  type: string;  // video | image | music | sfx | voice (coarse)
  label?: string;
}

/** Parent origin when embedded in the website iframe; else same origin. */
function apiBase(): string {
  if (typeof window !== "undefined") {
    try {
      if (window.parent && window.parent !== window) return window.parent.location.origin;
    } catch { /* cross-origin — fall through */ }
  }
  return "";
}

/**
 * Fetch a Library asset's bytes. Handles BOTH url shapes the library returns:
 *   • relative `/api/studio/local-asset?...` — served from the caller's own
 *     disk partition; auth-stamped by the main.tsx fetch hook.
 *   • absolute https — Firestore-sourced items (agent/app/automation media on
 *     Firebase Storage / GCS). Direct fetch first; when the bucket lacks CORS
 *     headers, falls back to the website's media-proxy.
 */
export async function fetchLibraryBlob(url: string): Promise<Blob | null> {
  // blob:/data: URLs come from the Library's "On this device" section
  // (IndexedDB media minted as object URLs) — fetch directly, no prefixing.
  if (/^(blob:|data:)/i.test(url)) {
    try {
      const r = await fetch(url);
      return r.ok ? await r.blob() : null;
    } catch { return null; }
  }
  const absolute = /^https?:\/\//i.test(url);
  try {
    const r = await fetch(absolute ? url : `${apiBase()}${url}`);
    if (r.ok) return await r.blob();
    if (!absolute) return null;
  } catch {
    if (!absolute) return null;
  }
  try {
    const r = await fetch(`${apiBase()}/api/studio/media-proxy?url=${encodeURIComponent(url)}`);
    if (r.ok) return await r.blob();
  } catch { /* upstream unreachable */ }
  return null;
}

/**
 * A BLOCK dragged out of the library.
 *
 * Unlike every other droppable, this one has no file yet — a block is a design,
 * and the video only exists once it has been rendered on the user's machine.
 * The drop therefore RENDERS first and then behaves exactly like any other
 * import, which is what lets it land through the timeline's normal path with
 * its snapping, its track routing and its undo intact.
 */
export interface DroppedBlockItem {
  /** Block name in the library, e.g. `lt-clean-bar`. */
  name: string;
  /** Values for its slots. A plain drag has none and gets the design as drawn. */
  slots?: Record<string, string>;
  mode?: "overlay" | "bake";
  /** For a bake: the picture to burn the graphic into. */
  backdropUrl?: string;
  durationSec?: number;
  aspect?: string;
}

/** What a failed block drop failed WITH, for the UI to show. The drop handler
 *  can only return a mediaId or null, and "nothing happened" is the one outcome
 *  a user cannot act on — "the desktop app is not connected" they can. */
let lastBlockDropError = "";
export function lastBlockDropFailure(): string {
  return lastBlockDropError;
}

/** Read a timeline drop payload that may be a native media item, a Library
 *  item, OR a block from the block library. Returns the project mediaId to
 *  place, importing (and for a block, rendering) it first if needed. Returns
 *  null if the payload is none of those / the import failed. */
export async function resolveDroppedMediaId(rawJson: string): Promise<string | null> {
  if (!rawJson) return null;
  let data: any;
  try { data = JSON.parse(rawJson); } catch { return null; }
  if (data && typeof data.mediaId === "string" && data.mediaId.trim()) {
    return data.mediaId; // native media item — already in the project
  }
  const bi: DroppedBlockItem | undefined = data?.blockItem;
  if (bi && typeof bi.name === "string" && bi.name.trim()) {
    return importBlockToProject(bi);
  }
  const li: DroppedLibraryItem | undefined = data?.libraryItem;
  if (!li || typeof li.url !== "string") return null;
  return importLibraryItemToProject(li);
}

/** Does this media item already hold exactly this render? */
function sameGraphic(a: any, b: DroppedBlockItem): boolean {
  const g = a?.metadata?.graphic;
  if (!g || g.block !== b.name) return false;
  if ((g.mode ?? "overlay") !== (b.mode ?? "overlay")) return false;
  return JSON.stringify(g.slots ?? {}) === JSON.stringify(b.slots ?? {});
}

/**
 * Render a block and import the result as project media.
 *
 * Returns the new mediaId, which then drops onto the track through the normal
 * path. The clip it becomes gets its `screen` blend and its `graphic` metadata
 * automatically, because the MEDIA is tagged here and `clip/add` reads the tag —
 * see the note there. Nothing about this drop is special by the time it reaches
 * the timeline, and that is the point.
 */
export async function importBlockToProject(bi: DroppedBlockItem): Promise<string | null> {
  lastBlockDropError = "";
  const store = useProjectStore.getState();

  /**
   * ALREADY RENDERED ONCE. The same block with the same words IS the same file,
   * and these renders cost the user seconds on their own machine. The server
   * has an idempotency key for the same reason; this skips the round trip
   * entirely, which is what makes dragging the same lower third onto four shots
   * feel instant after the first.
   */
  const existing = store.project.mediaLibrary.items.find((m: any) => sameGraphic(m, bi));
  if (existing) return existing.id;

  const proc = useProcessingStore.getState();
  const taskId = proc.addTask(`block:${bi.name}`, "graphic-render");
  proc.updateTaskProgress(taskId, 10, `Rendering ${bi.name} on your computer...`);
  try {
    const rendered = await renderBlock({
      block: bi.name,
      slots: bi.slots,
      mode: bi.mode ?? "overlay",
      durationSec: bi.durationSec,
      backdropUrl: bi.backdropUrl,
      aspect: bi.aspect,
      /**
       * THE DESIGNER'S OWN CONTENT, when the user has typed nothing yet.
       *
       * A bare drag carries no values. Asking for `render` would draw nothing
       * into every slot and hand back an empty rectangle, which reads as the
       * feature being broken. Showing the block AS DESIGNED and letting them
       * edit the words afterwards is the only version of this that explains
       * itself.
       */
      useSampleContent: !bi.slots || Object.keys(bi.slots).length === 0,
    });
    proc.updateTaskProgress(taskId, 70, "Importing...");

    const blob = await fetchLibraryBlob(rendered.url);
    if (!blob) throw new RenderBlockError("Rendered, but the file could not be read back.");
    const ext = (bi.mode ?? "overlay") === "bake" ? "mp4" : "webm";
    const safe = bi.name.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48) || "graphic";
    const file = new File([blob], `${safe}.${ext}`, { type: blob.type || "video/webm" });
    const before = new Set(store.project.mediaLibrary.items.map((i: any) => i.id));
    const result = await useProjectStore.getState().importMedia(file);
    if (!result.success) throw new RenderBlockError("Rendered, but could not be imported.");
    const newItem = useProjectStore.getState().project.mediaLibrary.items.find(
      (i: any) => !before.has(i.id),
    );
    if (!newItem) throw new RenderBlockError("Imported, but the media item could not be found.");

    /**
     * TAG IT AS A GRAPHIC. This is the whole reason the rest of the system
     * treats it correctly: `clip/add` reads `metadata.graphic` and gives every
     * clip made from this file its `screen` blend, and the inspector reads it to
     * offer the block's slots for editing.
     */
    useProjectStore.setState((s: any) => ({
      project: {
        ...s.project,
        mediaLibrary: {
          ...s.project.mediaLibrary,
          items: s.project.mediaLibrary.items.map((m: any) =>
            m.id === newItem.id
              ? {
                  ...m,
                  originalUrl: m.originalUrl ?? rendered.url,
                  category: m.category ?? "Graphics",
                  metadata: {
                    ...m.metadata,
                    // The device measured it; a graphic trimmed to a guess cuts
                    // its own animation off.
                    ...(rendered.durationSec > 0 && !(m.metadata?.duration > 0)
                      ? { duration: rendered.durationSec }
                      : {}),
                    graphic: {
                      block: bi.name,
                      slots: bi.slots ?? {},
                      mode: bi.mode ?? "overlay",
                      ...(bi.aspect ? { aspect: bi.aspect } : {}),
                    },
                  },
                }
              : m,
          ),
        },
        modifiedAt: Date.now(),
      },
    }));
    saveMediaBlob(
      useProjectStore.getState().project.id,
      newItem.id,
      blob,
      (newItem as any).metadata ?? {},
    ).catch(() => {});
    proc.completeTask(taskId);
    return newItem.id;
  } catch (e: any) {
    lastBlockDropError = String(e?.message ?? e).slice(0, 200);
    proc.failTask(taskId, lastBlockDropError);
    return null;
  }
}

/** Import a Library asset into the current project (IndexedDB + MediaItem) and
 *  return its mediaId. Idempotent by originalUrl. */
export async function importLibraryItemToProject(li: DroppedLibraryItem): Promise<string | null> {
  const store = useProjectStore.getState();
  const existing = store.project.mediaLibrary.items.find((m: any) => m.originalUrl === li.url);
  if (existing) return existing.id;
  try {
    // Local-asset fetches are auth-stamped by the main.tsx hook; absolute
    // cloud URLs fall back to the media-proxy when CORS blocks them.
    const blob = await fetchLibraryBlob(li.url);
    if (!blob) return null;
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
