/**
 * "Open my Voidspace folder" — reveal the user's local media folder in their
 * OS file manager.
 *
 * Neither of the two places this code could run is able to do that itself: a
 * browser tab has no access to the desktop, and the website serves from a
 * container whose filesystem is not the user's. The only process that can open
 * a window on the user's machine is the Voidspace DESKTOP app, so the request
 * is dispatched to it over the device channel.
 *
 * Which is also why every failure here is reported rather than swallowed: the
 * most likely cause is simply that the desktop app is not running, and a button
 * that silently does nothing gives the user no way to work that out.
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

export interface OpenFolderResult {
  ok: boolean;
  /**
   * The destination path. Present on success AND — when the server knows it —
   * on failure, so the caller can show the user where to look when the desktop
   * app isn't there to open it for them.
   */
  path?: string;
  error?: string;
}

export interface OpenFolderOptions {
  /** A folder INSIDE the Voidspace root (e.g. a project id). */
  subPath?: string;
  /**
   * "library" opens the MEDIA LIBRARY instead of the Voidspace root. It lives
   * outside that root (usually on a bigger drive), so it can't be addressed by
   * subPath; the server resolves its absolute path from its own configuration.
   */
  target?: "voidspace" | "library";
}

export async function openVoidspaceFolder(
  opts: OpenFolderOptions | string = {},
): Promise<OpenFolderResult> {
  const { subPath, target } = typeof opts === "string" ? { subPath: opts, target: undefined } : opts;
  const vs = useVoidspaceStore.getState();
  const token = await vs.getIdToken?.();
  if (!token) return { ok: false, error: "Not signed in." };

  try {
    const res = await fetch(`${apiBase()}/api/studio/open-folder`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(subPath ? { subPath } : {}),
        ...(target === "library" ? { target: "library" } : {}),
      }),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok || body?.ok === false) {
      return {
        ok: false,
        path: body?.path,
        error: body?.error || body?.statusMessage
          || (res.status === 502
            ? "The Voidspace desktop app isn't reachable — start it and try again."
            : `Couldn't open the folder (HTTP ${res.status}).`),
      };
    }
    return { ok: true, path: body?.path };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
