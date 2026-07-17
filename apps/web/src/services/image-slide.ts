/**
 * Image-clip placement — "a slideshow is just image clips".
 *
 * `addSlide()` places ONE image clip on a normal image track exactly the way a
 * drag-drop would: it reuses a compatible image track that has a free slot at
 * the requested time and only creates another image track when the placement
 * would overlap existing clips. The clip is placed ATOMICALLY — media, cover
 * fit, and an optional gentle Ken-Burns zoom go in as a single undoable action.
 *
 * This is deliberately NOT a separate "slideshow" feature: there are no special
 * track names, no append-only behaviour and no bespoke z-order engine. Users get
 * the identical result via normal drag-drop plus the Inspector (Motion presets,
 * Transitions). `add_slide` is kept only as a thin convenience alias for the
 * agent; for crossfades between clips, overlap the clips and use the normal
 * transition tools.
 */
import { useProjectStore } from "../stores/project-store";
import { fetchMediaBlob } from "./voidspace-loader";
import type { Keyframe, EasingType, Transform } from "@openreel/core";

const KB_EASE: EasingType = "ease-in-out";

export type SlideZoom = "in" | "out" | "none";
export type SlideFit = "cover" | "contain" | "stretch" | "none";

export interface AddSlideOptions {
  /** Media already in the library. Takes precedence over `url`. */
  mediaId?: string;
  /** Image URL to fetch + import when `mediaId` is not given. */
  url?: string;
  /** Display name for an imported URL. */
  name?: string;
  /** Exact placement time. Omitted → appended after the last image clip. */
  startTime?: number;
  /** Seconds on screen (default 4). */
  durationSec?: number;
  /** Gentle Ken-Burns zoom (default "in"). Pass "none" for a still. */
  zoom?: SlideZoom;
  /** Optional soft entrance fade in seconds (default 0 = hard cut). */
  fadeInSec?: number;
  /** How the image fills the frame (default "cover"). */
  fitMode?: SlideFit;
}

export interface AddSlideResult {
  ok: boolean;
  error?: string;
  clipId?: string;
  trackId?: string;
  startTime?: number;
  duration?: number;
}

/** Ken-Burns scale keyframes (clip-local seconds). Scale-only never reveals an
 *  edge — the image already covers the frame at scale ≥ 1. */
export function kenBurnsKeyframes(duration: number, zoom: SlideZoom): Keyframe[] {
  if (zoom === "none" || duration <= 0) return [];
  const from = zoom === "out" ? 1.18 : 1.06;
  const to = zoom === "out" ? 1.06 : 1.18;
  const mk = (axis: "scale.x" | "scale.y", t: number, v: number, i: number): Keyframe => ({
    id: `kb-${axis}-${i}`,
    time: t,
    property: axis,
    value: v,
    easing: KB_EASE,
  });
  return [
    mk("scale.x", 0, from, 0),
    mk("scale.y", 0, from, 1),
    mk("scale.x", duration, to, 2),
    mk("scale.y", duration, to, 3),
  ];
}

/** Opacity fade-in over the head [0, fade] (clip-local seconds). */
export function fadeInKeyframes(fade: number): Keyframe[] {
  if (fade <= 0) return [];
  return [
    { id: "fadein-0", time: 0, property: "opacity", value: 0, easing: KB_EASE },
    { id: "fadein-1", time: fade, property: "opacity", value: 1, easing: KB_EASE },
  ];
}

/** Import an image URL into the library, returning its new mediaId. */
async function importUrl(url: string, name?: string): Promise<string | null> {
  const existing = (useProjectStore.getState().project.mediaLibrary?.items ?? []).find(
    (m: any) => m.originalUrl === url,
  );
  if (existing) return existing.id;
  const blob = await fetchMediaBlob(url);
  if (!blob || blob.size === 0) return null;
  const fname = name || url.split("/").pop() || "image.jpg";
  const file = new File([blob], fname, { type: blob.type || "image/jpeg" });
  const before = new Set(
    useProjectStore.getState().project.mediaLibrary.items.map((m: any) => m.id),
  );
  const res = await useProjectStore.getState().importMedia(file);
  if (!res.success) return null;
  const created = useProjectStore
    .getState()
    .project.mediaLibrary.items.find((m: any) => !before.has(m.id));
  if (!created) return null;
  useProjectStore.setState((s: any) => ({
    project: {
      ...s.project,
      mediaLibrary: {
        ...s.project.mediaLibrary,
        items: s.project.mediaLibrary.items.map((m: any) =>
          m.id === created.id ? { ...m, originalUrl: m.originalUrl ?? url, name: name || m.name } : m,
        ),
      },
      modifiedAt: Date.now(),
    },
  }));
  return created.id;
}

/** A same-type image track has a free slot at [start, end)? */
function trackIsFree(track: any, start: number, end: number): boolean {
  return !(track.clips ?? []).some(
    (c: any) => c.startTime < end && c.startTime + c.duration > start,
  );
}

/** Reuse a compatible image track that is free at [start,end); else create one.
 *  Normal image tracks — no special naming. */
async function ensureImageTrack(start: number, end: number): Promise<string | null> {
  const store = useProjectStore.getState();
  const tracks = store.project.timeline?.tracks ?? [];
  const free = tracks.find((t: any) => t.type === "image" && trackIsFree(t, start, end));
  if (free) return free.id;
  const before = new Set(tracks.map((t: any) => t.id));
  const res = await store.addTrack("image");
  if (!res.success) return null;
  const fresh = useProjectStore
    .getState()
    .project.timeline?.tracks?.find((t: any) => t.type === "image" && !before.has(t.id));
  return fresh?.id ?? null;
}

/**
 * Place ONE image clip via normal image-track placement, atomically, with an
 * optional gentle Ken-Burns zoom and soft fade-in.
 */
export async function addSlide(opts: AddSlideOptions): Promise<AddSlideResult> {
  const store = useProjectStore.getState();

  let mediaId = opts.mediaId;
  if (!mediaId && opts.url) mediaId = (await importUrl(opts.url, opts.name)) ?? undefined;
  if (!mediaId) return { ok: false, error: "Provide an image mediaId or url." };
  const media = store.getMediaItem(mediaId) as any;
  if (!media) return { ok: false, error: `No media found for id ${mediaId}.` };

  const duration = Math.max(1, opts.durationSec ?? 4);
  const zoom: SlideZoom = opts.zoom ?? "in";
  const fitMode: SlideFit = opts.fitMode ?? "cover";
  const fade = Math.max(0, Math.min(duration / 2, opts.fadeInSec ?? 0));

  // Exact time, or append after the last image-track clip.
  let start = opts.startTime;
  if (typeof start !== "number" || !Number.isFinite(start)) {
    const imgClips = (store.project.timeline?.tracks ?? [])
      .filter((t: any) => t.type === "image")
      .flatMap((t: any) => t.clips ?? []);
    start = imgClips.length ? Math.max(...imgClips.map((c: any) => c.startTime + c.duration)) : 0;
  }
  start = Math.max(0, start);
  const end = start + duration;

  const trackId = await ensureImageTrack(start, end);
  if (!trackId) return { ok: false, error: "Could not create an image track." };

  const baseScale = zoom === "out" ? 1.18 : zoom === "in" ? 1.06 : 1;
  const transform: Partial<Transform> = {
    fitMode,
    opacity: 1,
    scale: { x: baseScale, y: baseScale },
  };
  const keyframes: Keyframe[] = [...kenBurnsKeyframes(duration, zoom), ...fadeInKeyframes(fade)];

  const before = new Set(
    (useProjectStore.getState().project.timeline?.tracks?.find((t: any) => t.id === trackId)
      ?.clips ?? []).map((c: any) => c.id),
  );
  // ATOMIC: clip + transform + keyframes in a single undoable action.
  const res = await store.addClip(trackId, mediaId, start, duration, {
    transform,
    ...(keyframes.length ? { keyframes } : {}),
  });
  if (!res.success) {
    return { ok: false, error: `Failed to place image clip: ${(res as any).error?.message ?? "unknown"}` };
  }
  const made = (useProjectStore.getState().project.timeline?.tracks?.find((t: any) => t.id === trackId)
    ?.clips ?? []).find((c: any) => !before.has(c.id));

  return { ok: true, clipId: made?.id, trackId, startTime: start, duration };
}
