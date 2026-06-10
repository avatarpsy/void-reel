/**
 * Save a raw recording (webcam / screen / audio) to the user's LOCAL folder
 * via the website's existing `save-render` endpoint (kind=recordings). The
 * editor is served same-origin under /studio and shares the Firebase session,
 * so it authenticates with the user's ID token and the (locally-running) Nuxt
 * server writes the bytes into `<outputDir>/voidspace-projects/<id>/recordings/`.
 *
 * Best-effort + non-blocking: returns the durable local-asset serve URL (so the
 * recording survives IndexedDB eviction and reopens later), or null if it can't
 * save (no open project, no outputDir, not authed). Callers keep the in-editor
 * IndexedDB copy regardless — this is the durability backup, not the primary.
 */
import { useVoidspaceStore } from "../stores/voidspace-store";

/** Parent origin when embedded in the website iframe; else same origin. */
function apiBase(): string {
  if (typeof window !== "undefined") {
    try {
      if (window.parent && window.parent !== window) {
        return window.parent.location.origin;
      }
    } catch {
      /* cross-origin access blocked — fall through to relative */
    }
  }
  return "";
}

/** The user's configured Storage location (shared via same-origin localStorage). */
function resolveOutputDir(): string {
  try {
    const raw = localStorage.getItem("voidspace.studio.settings");
    if (raw) {
      const s = JSON.parse(raw);
      const dir = typeof s?.outputDir === "string" ? s.outputDir.trim() : "";
      if (dir) return dir;
    }
  } catch {
    /* ignore malformed settings */
  }
  return "~/Voidspace";
}

export interface SavedRecording {
  url: string; // /api/studio/local-asset serve URL (durable)
  localPath?: string; // absolute path on disk (for the success toast)
}

/**
 * Persist a media blob to the user's LOCAL folder, DISK-ONLY (no GCS / no
 * Firebase). `kind` selects the save-render bucket → per-type subfolder:
 *   - "recordings" → recordings/   (raw webcam/screen takes — local-only)
 *   - "sfx"        → sfx/          (generated sound-effects)
 *   - "music"      → music/        (kept Suno AI audio: cover/extend/vocals/
 *                                   instrumental/stems/wav — see suno/index.ts)
 *   - "narration"  → narrations/   (recorded VOICE takes — the user's mic-only
 *                                   recording; lands in the Library under Voice)
 * save-render.post.ts derives canvas-free files and returns a durable
 * /api/studio/local-asset serve URL that survives reload + Kie's 3-day TTL.
 * Best-effort + non-blocking: null if no open project / no outputDir / not authed.
 */
export async function saveMediaToDisk(
  blob: Blob,
  label: string,
  ext: string,
  kind: "recordings" | "sfx" | "music" | "narration" = "recordings",
): Promise<SavedRecording | null> {
  try {
    if (!blob || blob.size === 0) return null;
    const store = useVoidspaceStore.getState();
    const projectId = store.sceneList?.sceneListId;
    if (!projectId) return null; // no project folder to write under yet
    const token = await store.getIdToken();
    if (!token) return null;

    const qs = new URLSearchParams({
      kind,
      ext,
      outputDir: resolveOutputDir(),
      projectId,
      title: label,
    });
    const res = await fetch(`${apiBase()}/api/studio/save-render?${qs.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: blob,
    });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    if (!j || j.skipped || !j.localServeUrl) return null;
    return { url: j.localServeUrl as string, localPath: j.localPath as string | undefined };
  } catch (e) {
    console.warn("[recording-save] disk save failed:", e);
    return null;
  }
}

/** Back-compat wrapper — recordings are the default disk kind. */
export async function saveRecordingToDisk(
  blob: Blob,
  label: string,
  ext: string,
): Promise<SavedRecording | null> {
  return saveMediaToDisk(blob, label, ext, "recordings");
}
