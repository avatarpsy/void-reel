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
  textsPlaced?: number;
  slotCount?: number;
  timelineComp?: string;
  compNames?: string[];
}

interface ManifestTimeline {
  comp: string;
  width: number;
  height: number;
  framerate: number;
  durationSec: number;
  clips: Array<{
    label: string; url: string; kind: string; startSec: number; durationSec: number; mediaInSec: number; blend?: string;
    transformBase?: { opacity?: number; scaleX?: number; scaleY?: number; rotation?: number; posX?: number; posY?: number };
    keyframes?: Array<{ property: string; time: number; value: number; easing: string }>;
  }>;
  texts: Array<{ text: string; startSec: number; durationSec: number }>;
  slots: Array<{ name: string; startSec: number; durationSec: number }>;
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

/** Tracks this import creates carry this name prefix so a RE-RUN can drop
 *  exactly its own previous tracks and never a track the user built. */
const AE_TRACK_PREFIX = "AE·"; // "AE·"

/** A visible "drop a photo here" card at the comp's aspect — fills empty
 *  template photo slots so the preview reads as a slideshow instead of
 *  rendering black where the (not-yet-supplied) photos go. One image,
 *  reused for every slot. */
async function makePhotoPlaceholderBlob(w: number, h: number): Promise<Blob | null> {
  try {
    if (typeof document === "undefined") return null;
    const scale = Math.min(1, 960 / Math.max(w || 1920, h || 1080));
    const cw = Math.max(320, Math.round((w || 1920) * scale));
    const ch = Math.max(180, Math.round((h || 1080) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const g = ctx.createLinearGradient(0, 0, cw, ch);
    g.addColorStop(0, "#20293c");
    g.addColorStop(1, "#0e1420");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
    ctx.strokeStyle = "rgba(255,255,255,0.30)";
    ctx.lineWidth = Math.max(2, Math.round(cw * 0.006));
    ctx.setLineDash([Math.round(cw * 0.03), Math.round(cw * 0.02)]);
    const m = Math.round(cw * 0.045);
    ctx.strokeRect(m, m, cw - 2 * m, ch - 2 * m);
    ctx.setLineDash([]);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.font = `600 ${Math.round(ch * 0.1)}px sans-serif`;
    ctx.fillText("🖼  Photo slot", cw / 2, ch * 0.43);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `400 ${Math.round(ch * 0.05)}px sans-serif`;
    ctx.fillText("drop an image here or ask the agent", cw / 2, ch * 0.57);
    return await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/png"));
  } catch {
    return null;
  }
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
  let manifest: { ok: boolean; slug: string; items: ManifestItem[]; projectMeta?: any; timeline?: ManifestTimeline | null };
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
  const mediaIdByUrl = new Map<string, string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress?.({ phase: "importing", detail: item.name, current: i + 1, total: items.length });
    try {
      // Skip when this exact durable URL is already in the library
      // (re-running the import must not duplicate assets).
      const existing = (useProjectStore.getState().project.mediaLibrary?.items ?? [])
        .find((m: any) => m.originalUrl === item.url);
      if (existing) {
        mediaIdByUrl.set(item.url, existing.id);
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
      mediaIdByUrl.set(item.url, created.id);
      if (item.role === "footage") footageIds.push(created.id);
    } catch (e) {
      console.warn("[adobe-import] asset import failed:", item?.name, e);
    }
  }

  // ── Faithful timeline from the .aep main comp (when parsed) ──────────
  let placed = 0;
  let textsPlaced = 0;
  let slotsPlaced = 0;
  const tl = manifest.timeline;
  if (tl && (tl.clips.length > 0 || tl.texts.length > 0)) {
    onProgress?.({ phase: "placing", detail: `Rebuilding "${tl.comp}" (${tl.clips.length} clips, ${tl.texts.length} titles)…` });

    // Match the canvas to the AE composition so layer positions (parsed in
    // comp pixels → centre-offset) and the comp aspect line up.
    if (tl.width > 0 && tl.height > 0) {
      try { await useProjectStore.getState().updateSettings({ width: tl.width, height: tl.height }); } catch { /* keep existing size */ }
    }

    // Re-run idempotence: drop ONLY the tracks a PREVIOUS import created
    // (tagged with AE_TRACK_PREFIX). Never touches user-built/renamed
    // tracks — the reviewer's data-loss concern.
    try {
      const tracksNow = [...(useProjectStore.getState().project.timeline?.tracks ?? [])];
      for (const t of tracksNow) {
        if (String(t.name || "").startsWith(AE_TRACK_PREFIX)) {
          await useProjectStore.getState().removeTrack(t.id);
        }
      }
    } catch (e) {
      console.warn("[adobe-import] previous-import cleanup failed:", e);
    }

    // Helper: create a fresh track of a type and tag it as import-owned.
    const newAeTrack = async (type: "audio" | "image" | "video", label: string): Promise<string | null> => {
      const store = useProjectStore.getState();
      const before = new Set((store.project.timeline?.tracks ?? []).map((t: any) => t.id));
      const tRes = await store.addTrack(type);
      if (!tRes.success) return null;
      const fresh = useProjectStore.getState().project.timeline?.tracks?.find(
        (t: any) => t.type === type && !before.has(t.id),
      );
      if (!fresh) return null;
      try { useProjectStore.getState().renameTrack(fresh.id, `${AE_TRACK_PREFIX}${label}`); } catch { /* naming is cosmetic */ }
      return fresh.id;
    };

    // ── Photo slots FIRST — so after footage tracks prepend above them,
    // they sit at the BACK (photo = scene background in AE). Empty slots
    // otherwise render black; a visible placeholder card reads as a real
    // slideshow frame the user/agent then replaces. ────────────────────
    if (tl.slots && tl.slots.length > 0) {
      try {
        const blob = await makePhotoPlaceholderBlob(tl.width, tl.height);
        if (blob) {
          const file = new File([blob], "photo-placeholder.png", { type: "image/png" });
          const before = new Set(useProjectStore.getState().project.mediaLibrary.items.map((m: any) => m.id));
          const res = await useProjectStore.getState().importMedia(file);
          if (res.success) {
            const ph = useProjectStore.getState().project.mediaLibrary.items.find((m: any) => !before.has(m.id)) as any;
            if (ph) {
              useProjectStore.setState((s: any) => ({
                project: {
                  ...s.project,
                  mediaLibrary: {
                    ...s.project.mediaLibrary,
                    items: s.project.mediaLibrary.items.map((m: any) =>
                      m.id === ph.id ? { ...m, name: "Photo slot — replace me", category: `Imported: ${manifest.slug}` } : m,
                    ),
                  },
                  modifiedAt: Date.now(),
                },
              }));
              const lanes: Array<{ trackId: string; lastEnd: number }> = [];
              for (const s of [...tl.slots].sort((a, b) => a.startSec - b.startSec)) {
                let lane = lanes.find((L) => L.lastEnd <= s.startSec + 0.01);
                if (!lane) {
                  const tid = await newAeTrack("image", "Photos");
                  if (!tid) continue;
                  lane = { trackId: tid, lastEnd: 0 };
                  lanes.push(lane);
                }
                const r = await useProjectStore.getState().addClip(lane.trackId, ph.id, s.startSec, s.durationSec);
                if (r.success) { slotsPlaced++; lane.lastEnd = s.startSec + s.durationSec; }
              }
            }
          }
        }
      } catch (e) {
        console.warn("[adobe-import] photo-slot placement failed:", e);
      }
    }

    // Lane packing per SOURCE: clips arrive bottom-most first, so groups
    // are created in z-order (addTrack PREPENDS → later groups render on
    // top, matching AE). Within a group, first-fit lanes keep the track
    // count proportional to real simultaneous overlap (~2 per source)
    // instead of chaining one track per clip through scene transitions.
    const groups = new Map<string, ManifestTimeline["clips"]>();
    for (const c of tl.clips) {
      if (!mediaIdByUrl.get(c.url)) continue;
      const g = groups.get(c.url) ?? [];
      g.push(c);
      groups.set(c.url, g);
    }
    for (const [url, clipsOfUrl] of groups) {
      const mediaId = mediaIdByUrl.get(url)!;
      const m = useProjectStore.getState().getMediaItem(mediaId) as any;
      const trackType = (m?.type === "audio" ? "audio" : m?.type === "image" ? "image" : "video") as
        "audio" | "image" | "video";
      const mediaDur = typeof m?.metadata?.duration === "number" && m.metadata.duration > 0 ? m.metadata.duration : null;
      const lanes: Array<{ trackId: string; lastEnd: number }> = [];
      const label = trackType === "audio" ? "Audio" : trackType === "image" ? "Image" : "Video";
      for (const c of [...clipsOfUrl].sort((a, b) => a.startSec - b.startSec)) {
        const dur = mediaDur && trackType !== "image" ? Math.min(c.durationSec, mediaDur) : c.durationSec;
        let lane = lanes.find((L) => L.lastEnd <= c.startSec + 0.01);
        if (!lane) {
          const tid = await newAeTrack(trackType, label);
          if (!tid) continue;
          lane = { trackId: tid, lastEnd: 0 };
          lanes.push(lane);
        }
        try {
          const before = new Set((useProjectStore.getState().project.timeline?.tracks?.find((t: any) => t.id === lane.trackId)?.clips ?? []).map((x: any) => x.id));
          const r = await useProjectStore.getState().addClip(lane.trackId, mediaId, c.startSec, dur);
          if (r.success) {
            placed++;
            lane.lastEnd = c.startSec + dur;
            const made = (useProjectStore.getState().project.timeline?.tracks?.find((t: any) => t.id === lane.trackId)?.clips ?? []).find((x: any) => !before.has(x.id));
            if (made?.id) {
              const store = useProjectStore.getState();
              // AE decorative overlays composite via screen/add.
              if (c.blend && c.blend !== "normal") {
                try { store.updateClipBlendMode(made.id, c.blend as any); } catch { /* non-fatal */ }
              }
              // AE layer transform (static) → clip transform.
              const b = c.transformBase;
              if (b) {
                const patch: any = {};
                if (typeof b.opacity === "number") patch.opacity = b.opacity;
                if (typeof b.scaleX === "number" || typeof b.scaleY === "number") patch.scale = { x: b.scaleX ?? 1, y: b.scaleY ?? b.scaleX ?? 1 };
                if (typeof b.rotation === "number") patch.rotation = b.rotation;
                if (typeof b.posX === "number" || typeof b.posY === "number") patch.position = { x: b.posX ?? 0, y: b.posY ?? 0 };
                if (Object.keys(patch).length) { try { store.updateClipTransform(made.id, patch); } catch { /* non-fatal */ } }
              }
              // AE keyframes → clip.keyframes (position/scale/rotation/opacity).
              if (c.keyframes && c.keyframes.length) {
                const kfs = c.keyframes.map((k, idx) => ({ id: `aep-kf-${made.id}-${idx}`, property: k.property, time: k.time, value: k.value, easing: k.easing as any }));
                try { store.updateClipKeyframes(made.id, kfs as any); } catch { /* non-fatal */ }
              }
            }
          } else {
            console.warn("[adobe-import] timeline clip failed:", c.label, (r as any).error);
          }
        } catch (e) {
          console.warn("[adobe-import] timeline clip threw:", c.label, e);
        }
      }
    }

    // Titles → caption clips (the same primitive lyric captions use).
    // Idempotent by (text, start); a REPAIR pass re-adds any title a
    // mid-import loader tick clobbered (blob merge can momentarily
    // rebuild text clips from a stale snapshot).
    const titleExists = (t: ManifestTimeline["texts"][number]) =>
      (useProjectStore.getState().project as any).textClips?.some(
        (tc: any) => tc.text === t.text && Math.abs((tc.startTime ?? 0) - t.startSec) < 0.05,
      );
    const placeTitles = async () => {
      for (const t of tl.texts) {
        if (titleExists(t)) continue;
        try {
          await useProjectStore.getState().addSubtitle({
            id: `aep-text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            text: t.text,
            startTime: t.startSec,
            endTime: t.startSec + Math.max(0.5, t.durationSec),
          } as any);
        } catch (e) {
          console.warn("[adobe-import] title placement failed:", t.text, e);
        }
      }
    };
    // The remote-blob echo can clobber engine text clips that weren't in
    // the last save (the loader rebuilds textClips from the blob each
    // tick). Converge: place → force-save (blob now has them) → wait for
    // the echo → repair anything dropped → force-save again.
    const forceSaveSafe = async () => {
      try {
        const { autoSaveManager } = await import("./auto-save");
        await autoSaveManager.forceSave(useProjectStore.getState().project);
      } catch (e) {
        console.warn("[adobe-import] force-save failed:", e);
      }
    };
    await placeTitles();
    await forceSaveSafe();
    await new Promise((r) => setTimeout(r, 4000)); // let the remote echo land
    await placeTitles(); // repair anything the echo clobbered
    await forceSaveSafe();
    textsPlaced = tl.texts.filter((t) => titleExists(t)).length;
  } else if (footageIds.length > 0) {
    // No parsable comp — fall back to sequential footage placement.
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
    textsPlaced,
    slotCount: slotsPlaced,
    timelineComp: tl?.comp,
    compNames: manifest.projectMeta?.compNames ?? [],
  };
}
