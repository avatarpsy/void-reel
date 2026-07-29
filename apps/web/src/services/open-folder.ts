/**
 * WHERE the user's Voidspace folder and media library are on disk.
 *
 * This used to try to OPEN them in the OS file manager. It no longer does, and
 * that is deliberate: nothing in the web path can do it reliably. A browser tab
 * has no access to the desktop, and the website server is frequently a
 * container whose filesystem is not the user's machine at all. The only
 * component that could was the Voidspace DESKTOP app, dispatched over the
 * device channel — but most people using the web editor do not have it running,
 * so the action failed far more often than it succeeded.
 *
 * A button that usually does nothing is worse than no button. Reporting the
 * path works on every platform, for every user, with no extra software, and is
 * the thing they actually needed in order to go there themselves.
 */
import { useVoidspaceStore } from "../stores/voidspace-store";

/** Parent origin when embedded in the website iframe; else same origin. */
function apiBase(): string {
  if (typeof window !== "undefined") {
    try {
      if (window.parent && window.parent !== window) {
        return window.parent.location.origin;
      }
    } catch { /* cross-origin blocked — relative works same-origin */ }
  }
  return "";
}

export interface FolderPathResult {
  /** Absolute path on the machine running the server, when it is known. */
  path?: string;
  error?: string;
}

/**
 * The user's Voidspace folder (renders, recordings, per-project media).
 *
 * @param subPath Optional folder INSIDE it (e.g. a project id).
 */
export async function getVoidspaceFolderPath(subPath?: string): Promise<FolderPathResult> {
  return fetchPath(subPath ? { subPath } : {});
}

/**
 * The shared MEDIA LIBRARY. It lives outside the Voidspace folder — usually on
 * a bigger drive — so it has its own lookup rather than a subPath.
 */
export async function getMediaLibraryPath(): Promise<FolderPathResult> {
  return fetchPath({ target: "library" });
}

async function fetchPath(body: Record<string, string>): Promise<FolderPathResult> {
  const vs = useVoidspaceStore.getState();
  const token = await vs.getIdToken?.();
  if (!token) return { error: "Not signed in." };

  try {
    const res = await fetch(`${apiBase()}/api/studio/folder-path`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      return { error: json?.statusMessage || json?.error || `Couldn't look up the folder (HTTP ${res.status}).` };
    }
    return { path: json?.path || undefined, error: json?.error };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}
