/**
 * Adobe AE / Premiere project import — editor side.
 *
 * The server (/api/studio/adobe-import) copies the pointed folder into the
 * user's LOCAL Voidspace storage (never the cloud), detects + converts
 * image sequences, materializes media into the standard local buckets and
 * returns a manifest of durable local-asset URLs. This service then:
 *
 *   1. imports every asset into the editor's media library through the
 *      NATIVE importMedia path (real durations/dimensions/thumbnails),
 *      tagged with a durable originalUrl + an "Imported: <slug>" category;
 *   2. lays main FOOTAGE onto the timeline sequentially (type-routed
 *      tracks — images to image tracks, videos to video tracks);
 *   3. leaves overlays (particles/alpha sequences) and tutorials
 *      library-only for the user/agent to place deliberately.
 */
import { useProjectStore } from "../stores/project-store";
import { useVoidspaceStore } from "../stores/voidspace-store";
import { fetchMediaBlob } from "./voidspace-loader";

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

export interface AdobeImportProgress {
  phase: "copying" | "importing" | "placing" | "done";
  detail: string;
  current?: number;
  total?: number;
}

export interface AdobeImportResult {
  ok: boolean;
  error?: string;
  slug?: string;
  assetsImported: number;
  clipsPlaced: number;
  compNames?: string[];
}

interface ManifestItem {
  kind: "video" | "image" | "music";
  filename: string;
  url: string;
  name: string;
  role: "footage" | "overlay" | "tutorial" | "sequence";
  bytes: number;
  group: string;
}

/** Find a same-type track with a free slot, else create one; returns the
 *  placed duration (sec) or null. Mirrors the add-clip RPC's routing. */
async function placeAuto(mediaId: string, startTime: number): Promise<number | null> {
  const store = useProjectStore.getState();
  const media = store.getMediaItem(mediaId) as any;
  if (!media) return null;
  const mType = media.type;
  const wantType = (mType === "audio" ? "audio" : mType === "image" ? "image" : "video") as
    "audio" | "image" | "video";
  const dur = typeof media.metadata?.duration === "number" && media.metadata.duration > 0
    ? media.metadata.duration
    : mType === "image" ? 4 : 5;
  const tracks = store.project.timeline?.tracks ?? [];
  const free = tracks.find(
    (t: any) =>
      t.type === wantType &&
      !(t.clips ?? []).some((c: any) => c.startTime < startTime + dur && c.startTime + c.duration > startTime),
  );
  if (free) {
    const r = await store.addClip(free.id, mediaId, startTime, mType === "image" ? dur : undefined);
    if (!r.success) console.warn("[adobe-import] addClip failed:", (r as any).error);
    return r.success ? dur : null;
  }
  const r = await store.addClipToNewTrack(mediaId, startTime);
  if (!r.success) console.warn("[adobe-import] addClipToNewTrack failed:", (r as any).error);
  return r.success ? dur : null;
}

export async function importAdobeProject(
  sourcePath: string,
  onProgress?: (p: AdobeImportProgress) => void,
): Promise<AdobeImportResult> {
  const vs = useVoidspaceStore.getState();
  const projectId = vs.sceneList?.sceneListId;
  if (!projectId) return { ok: false, error: "Open a project first.", assetsImported: 0, clipsPlaced: 0 };
  const token = await vs.getIdToken();
  if (!token) return { ok: false, error: "Not signed in.", assetsImported: 0, clipsPlaced: 0 };

  onProgress?.({ phase: "copying", detail: "Copying project into Voidspace storage & scanning…" });
  let manifest: { ok: boolean; slug: string; items: ManifestItem[]; projectMeta?: any };
  try {
    const res = await fetch(`${apiBase()}/api/studio/adobe-import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourcePath, projectId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Import failed (${res.status}): ${text.slice(0, 200)}`, assetsImported: 0, clipsPlaced: 0 };
    }
    manifest = await res.json();
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), assetsImported: 0, clipsPlaced: 0 };
  }

  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  if (items.length === 0) {
    return { ok: false, error: "No importable media found in that folder.", assetsImported: 0, clipsPlaced: 0 };
  }

  // ── Library import (native decode path) ──────────────────────────────
  let imported = 0;
  const footageIds: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress?.({ phase: "importing", detail: item.name, current: i + 1, total: items.length });
    try {
      // Skip when this exact durable URL is already in the library
      // (re-running the import must not duplicate assets).
      const existing = (useProjectStore.getState().project.mediaLibrary?.items ?? [])
        .find((m: any) => m.originalUrl === item.url);
      if (existing) {
        if (item.role === "footage") footageIds.push(existing.id);
        continue;
      }
      const blob = await fetchMediaBlob(item.url);
      if (!blob || blob.size === 0) continue;
      const file = new File([blob], item.filename, { type: blob.type || "application/octet-stream" });
      const before = new Set(
        useProjectStore.getState().project.mediaLibrary.items.map((m: any) => m.id),
      );
      const result = await useProjectStore.getState().importMedia(file);
      if (!result.success) continue;
      const created = useProjectStore
        .getState()
        .project.mediaLibrary.items.find((m: any) => !before.has(m.id)) as any;
      if (!created) continue;
      useProjectStore.setState((s: any) => ({
        project: {
          ...s.project,
          mediaLibrary: {
            ...s.project.mediaLibrary,
            items: s.project.mediaLibrary.items.map((m: any) =>
              m.id === created.id
                ? {
                    ...m,
                    originalUrl: m.originalUrl ?? item.url,
                    category: `Imported: ${manifest.slug}`,
                    name: item.name || m.name,
                  }
                : m,
            ),
          },
          modifiedAt: Date.now(),
        },
      }));
      imported++;
      if (item.role === "footage") footageIds.push(created.id);
    } catch (e) {
      console.warn("[adobe-import] asset import failed:", item?.name, e);
    }
  }

  // ── Timeline scaffold: footage in sequence after existing content ────
  let placed = 0;
  if (footageIds.length > 0) {
    onProgress?.({ phase: "placing", detail: "Arranging footage on the timeline…" });
    let startAt = 0;
    const proj = useProjectStore.getState().project;
    for (const tr of proj.timeline?.tracks ?? []) {
      for (const c of tr.clips ?? []) startAt = Math.max(startAt, c.startTime + c.duration);
    }
    for (const mediaId of footageIds) {
      try {
        const dur = await placeAuto(mediaId, startAt);
        if (dur) {
          placed++;
          startAt += dur;
        }
      } catch (e) {
        console.warn("[adobe-import] placement failed:", e);
      }
    }
  }

  onProgress?.({ phase: "done", detail: `${imported} assets imported, ${placed} placed` });
  return {
    ok: true,
    slug: manifest.slug,
    assetsImported: imported,
    clipsPlaced: placed,
    compNames: manifest.projectMeta?.compNames ?? [],
  };
}
