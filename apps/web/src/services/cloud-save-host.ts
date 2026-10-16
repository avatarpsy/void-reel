/**
 * The host half of `cloud-save.ts`, with no editor stores attached.
 *
 * The page that embeds us (the website's studio page, or its board page for
 * `record.html`) exposes `__voidspaceSaveToCloud` — the website's
 * `studioCloudSave.ts`. This file only finds that function and calls it, so a
 * small page like the shot recorder can save a take without pulling in the
 * editor's project stores (and Firebase with them). The editor's callers keep
 * using `saveMediaToCloud` in `cloud-save.ts`, which fills in the open project.
 *
 * Returns the durable url, or null when the file could not be stored (not
 * embedded, no project id, the person said no, storage full, offline).
 */

export type CloudKind = "sfx" | "music" | "narration" | "image" | "recordings";

export interface CloudSaveOptions {
  /** Where the file is filed in the person's storage (a project or board id). */
  projectId?: string;
  /** Upload progress, 0..1, when the host reports it. */
  onProgress?: (fraction: number) => void;
  /**
   * The person pressed a button whose whole meaning is "store this" (the
   * recorder's "Use this take"), so the host skips its own upload prompt.
   * Never set it for an agent-initiated save.
   */
  confirmed?: boolean;
}

type HostSave = (
  blob: Blob,
  meta: {
    projectId: string;
    kind: CloudKind;
    ext: string;
    mimeType: string;
    title?: string;
    onProgress?: (fraction: number) => void;
    confirmed?: boolean;
  },
) => Promise<{ url: string } | null>;

function hostSave(): HostSave | null {
  try {
    const fn = (window.parent as any)?.__voidspaceSaveToCloud;
    return typeof fn === "function" ? (fn as HostSave) : null;
  } catch {
    return null; // not embedded same-origin
  }
}

/** True when the page that embeds us can store files in the person's cloud. */
export function canSaveToCloud(): boolean {
  return hostSave() !== null;
}

const MIME_FOR_EXT: Record<string, string> = {
  webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
};

export async function saveMediaToCloudFor(
  blob: Blob,
  label: string,
  ext: string,
  kind: CloudKind,
  opts: CloudSaveOptions,
): Promise<{ url: string } | null> {
  try {
    if (!blob || blob.size === 0) return null;
    const projectId = opts.projectId;
    const save = hostSave();
    if (!projectId || !save) return null;
    // Storage accepts media types only; a take recorded as audio-only webm is
    // still audio, so name it by what the blob says before falling back.
    const mimeType = blob.type && /^(audio|video|image)\//.test(blob.type)
      ? blob.type
      : MIME_FOR_EXT[ext] ?? (kind === "image" ? "image/png" : "audio/mpeg");
    const saved = await save(blob, {
      projectId,
      kind,
      ext,
      mimeType,
      title: label,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.confirmed ? { confirmed: true } : {}),
    });
    return saved?.url ? { url: saved.url } : null;
  } catch (e) {
    console.warn("[cloud-save] not stored:", e);
    return null;
  }
}
