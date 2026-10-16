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
import { saveMediaToCloudFor, type CloudKind, type CloudSaveOptions } from "./cloud-save-host";

export type { CloudKind, CloudSaveOptions } from "./cloud-save-host";

/**
 * `opts.projectId` files the take under that id instead of the open project
 * (the shot recorder has a board, not a project). Without it, behaviour is
 * unchanged: the open project's id, or nothing is stored.
 */
export async function saveMediaToCloud(
  blob: Blob,
  label: string,
  ext: string,
  kind: CloudKind,
  opts?: CloudSaveOptions,
): Promise<{ url: string } | null> {
  const projectId = opts?.projectId ?? useVoidspaceStore.getState().sceneList?.sceneListId;
  return saveMediaToCloudFor(blob, label, ext, kind, { ...opts, projectId });
}
