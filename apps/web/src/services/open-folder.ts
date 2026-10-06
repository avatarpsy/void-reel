/**
 * Open — or failing that, REPORT — the user's Voidspace folder and media library.
 *
 * Opening a file-manager window needs a process on the user's own desktop. When
 * Voidspace runs on their machine (the normal local install) the SERVER is that
 * process, and `explorer` / `open` / `xdg-open` puts a real window on screen —
 * Windows, macOS and Linux alike. The server decides this from whether the
 * request arrived over loopback, which is the honest test.
 *
 * When it can't — hosted deployment, or a container with no desktop — there is
 * no way to open anything, so we hand over the PATH instead and say why. The
 * one outcome that is never acceptable is the button appearing to do nothing,
 * which is exactly how the previous desktop-app-only version behaved for the
 * majority of users.
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

export interface RevealResult {
  /** True when a file-manager window actually opened on the user's screen. */
  opened: boolean;
  /** Absolute path on the machine running the server, when it is known. */
  path?: string;
  /** Why it couldn't open — 'container' | 'remote' | 'missing' | 'failed'. */
  reason?: string;
  error?: string;
}

/**
 * The user's Voidspace folder — AI-generated media, recordings, renders.
 *
 * @param subPath Optional folder INSIDE it (e.g. a project id).
 */
export async function revealVoidspaceFolder(subPath?: string): Promise<RevealResult> {
  return reveal(subPath ? { subPath } : {});
}

/**
 * The shared MEDIA LIBRARY. It lives outside the Voidspace folder — usually on
 * a bigger drive — so it has its own target rather than a subPath.
 */
export async function revealMediaLibrary(): Promise<RevealResult> {
  return reveal({ target: "library" });
}

async function reveal(body: Record<string, string>): Promise<RevealResult> {
  const vs = useVoidspaceStore.getState();
  const token = await vs.getIdToken?.();
  if (!token) return { opened: false, error: "Not signed in." };

  try {
    const res = await fetch(`${apiBase()}/api/studio/open-folder`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      return {
        opened: false,
        error: json?.statusMessage || json?.error || `Couldn't reach the folder (HTTP ${res.status}).`,
      };
    }
    return {
      opened: json?.opened === true,
      path: json?.path || undefined,
      reason: json?.reason,
      error: json?.error,
    };
  } catch (e: any) {
    return { opened: false, error: e?.message ?? String(e) };
  }
}
