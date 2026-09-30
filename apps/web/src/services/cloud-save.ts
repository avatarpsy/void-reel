/**
 * Put a media file in the person's CLOUD storage, when something needs it
 * there.
 *
 * ── WHERE THE EDITOR'S MEDIA LIVES ──────────────────────────────────────────
 *   • On this device: always. Every take, generation and render is kept in the
 *     editor's own on-device store (IndexedDB, `media-storage.ts`) the moment
 *     it exists. That is the local copy.
 *   • In the person's cloud storage: only when something beyond this tab needs
 *     it — the cross-project Library (kept voice, SFX, music takes), the agent
 *     asking for a durable clip, or timeline media another device must play
 *     (`media-materialize.ts`). Raw webcam/screen takes stay on the device.
 *   • On OUR server: never. This file replaced `recording-save.ts`, which
 *     posted every file to the website's server disk — a design from when that
 *     server ran on the person's own machine.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────
 * The editor is embedded same-origin in the website's studio page, which owns
 * the signed-in Firebase session. That page exposes `__voidspaceSaveToCloud`
 * (the website's `studioCloudSave.ts`): the server names and accounts the
 * object, the bytes go straight from this browser to the person's storage.
 *
 * Returns the durable url, or null when the file could not be stored (not
 * embedded, no open project, storage full, offline). Callers keep the on-device
 * copy either way.
 */
import { useVoidspaceStore } from "../stores/voidspace-store";

export type CloudKind = "sfx" | "music" | "narration" | "image" | "recordings";

type HostSave = (
  blob: Blob,
  meta: { projectId: string; kind: CloudKind; ext: string; mimeType: string; title?: string },
) => Promise<{ url: string } | null>;

function hostSave(): HostSave | null {
  try {
    const fn = (window.parent as any)?.__voidspaceSaveToCloud;
    return typeof fn === "function" ? (fn as HostSave) : null;
  } catch {
    return null; // not embedded same-origin
  }
}

const MIME_FOR_EXT: Record<string, string> = {
  webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
};

export async function saveMediaToCloud(
  blob: Blob,
  label: string,
  ext: string,
  kind: CloudKind,
): Promise<{ url: string } | null> {
  try {
    if (!blob || blob.size === 0) return null;
    const projectId = useVoidspaceStore.getState().sceneList?.sceneListId;
    const save = hostSave();
    if (!projectId || !save) return null;
    // Storage accepts media types only; a take recorded as audio-only webm is
    // still audio, so name it by what the blob says before falling back.
    const mimeType = blob.type && /^(audio|video|image)\//.test(blob.type)
      ? blob.type
      : MIME_FOR_EXT[ext] ?? (kind === "image" ? "image/png" : "audio/mpeg");
    const saved = await save(blob, { projectId, kind, ext, mimeType, title: label });
    return saved?.url ? { url: saved.url } : null;
  } catch (e) {
    console.warn("[cloud-save] not stored:", e);
    return null;
  }
}
