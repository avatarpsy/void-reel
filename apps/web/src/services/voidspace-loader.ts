/**
 * Voidspace Loader — Fetches scene lists from Firestore and transforms them
 * into OpenReel Project objects for the video editor timeline.
 */

import { auth, db, storage } from "../config/firebase-config";
import { onAuthStateChanged } from "firebase/auth";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import { useVoidspaceStore } from "../stores/voidspace-store";
import { buildVoidspaceProjectId } from "./voidspace-project-id";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  query,
  orderBy,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import type {
  Project,
  ProjectSettings,
  MediaItem,
  MediaMetadata,
  Timeline,
  Track,
  Clip,
  Subtitle,
  TextClip,
} from "@openreel/core";

// ────────────────────────────────────────────
// Types matching Firestore document shapes
// ────────────────────────────────────────────

export interface VoidspaceSceneList {
  id: string;
  name?: string;
  avatar_id?: string;
  avatar_name?: string;
  status?: string;
  created_at?: { seconds: number };
  updated_at?: { seconds: number };
  scene_count?: number;
  music_url?: string;
  music_title?: string;
  music_volume?: number;
  content_type?: string;
  aspect_ratio?: string;
  video_url?: string;
  loop_description?: string;
  description?: string;
  content?: string;
  caption?: string;
  post_description?: string;
  thumbnail_url?: string;
  review_id?: string;
}

interface SceneData {
  scene_number: number;
  scene_text?: string;
  narration_text?: string;
  visual_description?: string;
  video_url?: string;
  url?: string;
  image_url?: string;
  first_frame_url?: string;
  preview_image_url?: string;
  music_start_ms?: number | string;
  music_end_ms?: number | string;
  audio_start_ms?: number | string;
  audio_end_ms?: number | string;
  music_url?: string;
  music_file_name?: string;
  music_title?: string;
  music_artist?: string;
  narration_url?: string;
  narration_start_ms?: number;
  narration_end_ms?: number;
  narration_duration_ms?: number;
  lyrics_lrc?: string;
  lyrics_json?: string;
  is_branding?: boolean;
  status?: string;
  edit_state?: {
    music_start_ms?: number | string;
    music_end_ms?: number | string;
    audio_start_ms?: number | string;
    audio_end_ms?: number | string;
  };
}

interface SceneVideoData {
  id: string;
  url?: string;
  video_url?: string;
  duration_ms?: number;
  tag?: string;
  source_type?: string;
  start_ms?: number;
  end_ms?: number;
  voice_mode?: string;
  has_embedded_audio?: boolean;
  word_timestamps?: Array<{ word: string; start: number; end: number }>;
}

const resolvedUrlCache = new Map<string, string>();
const mediaBlobCache = new Map<string, Blob>();

// Tiny deterministic hash for building stable media IDs from URLs.
// FNV-1a 32-bit, base36-encoded — short, dependency-free, and stable
// across reloads (which is what we want for the live-rebuild path).
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function resolveMediaUrl(rawUrl?: string | null): Promise<string | null> {
  if (!rawUrl) return null;
  const url = String(rawUrl).trim();
  if (!url) return null;

  if (resolvedUrlCache.has(url)) {
    return resolvedUrlCache.get(url)!;
  }

  // Already a browser-usable URL
  if (/^https?:\/\//i.test(url) || /^blob:/i.test(url) || /^data:/i.test(url)) {
    resolvedUrlCache.set(url, url);
    return url;
  }

  try {
    const downloadUrl = await getDownloadURL(storageRef(storage, url));
    resolvedUrlCache.set(url, downloadUrl);
    return downloadUrl;
  } catch (e) {
    console.warn("[voidspace-loader] Could not resolve storage URL, using raw value:", url, e);
    resolvedUrlCache.set(url, url);
    return url;
  }
}

// CORS-bypass proxy helper lives in @openreel/core/utils so every
// renderer surface (preview, export, video-engine, playback) routes
// through the same same-origin endpoint. See utils/cors-proxy.ts.
import { rewriteToProxy } from "@openreel/core";

async function fetchMediaBlob(
  url: string | null,
  timeoutMs = 15000,
): Promise<Blob | null> {
  if (!url) return null;
  if (mediaBlobCache.has(url)) return mediaBlobCache.get(url)!;

  const tryFetch = async (targetUrl: string): Promise<Blob | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(targetUrl, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(
          `[voidspace-loader] Blob fetch failed (${res.status}) for ${targetUrl}`,
        );
        return null;
      }
      const blob = await res.blob();
      if (blob.size > 0) {
        mediaBlobCache.set(url, blob);
        return blob;
      }
      return null;
    } catch (e) {
      console.warn(`[voidspace-loader] Blob fetch error for ${targetUrl}:`, e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // For cross-origin URLs, route through the same-origin proxy from
  // the FIRST attempt. Hosts like tempfile.redpandaai.co serve no
  // `Access-Control-Allow-Origin` header so a direct fetch always
  // fails CORS — and even though we used to recover via the proxy on
  // the second attempt, the failed first attempt floods the console
  // with red `net::ERR_FAILED` lines on every project load. Cleaner
  // and faster to skip the wasted round-trip entirely.
  const proxied = rewriteToProxy(url);
  const isCrossOrigin = proxied !== url;

  let blob: Blob | null;
  if (isCrossOrigin) {
    blob = await tryFetch(proxied);
    if (blob) {
      // Cache against the ORIGINAL URL so future lookups keyed on
      // `originalUrl` hit immediately without re-routing.
      mediaBlobCache.set(url, blob);
      return blob;
    }
    // Proxy didn't have it — try the raw URL as a last resort. This
    // covers the rare case where the host actually does serve CORS
    // (some R2 buckets) but the proxy is misconfigured / down.
    blob = await tryFetch(url);
    if (blob) return blob;
  } else {
    // Same-origin URL — fetch direct.
    blob = await tryFetch(url);
    if (blob) return blob;
    // Retry with encoded URL for paths containing spaces/special chars
    if (url.includes(" ")) {
      blob = await tryFetch(encodeURI(url));
      if (blob) return blob;
    }
  }

  return null;
}

interface SceneImageData {
  id: string;
  url?: string;
  image_url?: string;
  tag?: string;
  source_type?: string;
}

interface SceneNarrationData {
  id: string;
  narration_url?: string;
  url?: string;
  script?: string;
  start_ms?: number;
  end_ms?: number;
  duration_ms?: number;
  word_timestamps?: Array<{ word: string; start: number; end: number }>;
  voice_mode?: string;
  has_embedded_audio?: boolean;
}

interface SceneSfxData {
  id: string;
  sfx_url?: string;
  url?: string;
  prompt?: string;
  start_ms?: number;
  end_ms?: number;
  duration_ms?: number;
  volume?: number;
  source_type?: string;
}

// ────────────────────────────────────────────
// Auth helpers
// ────────────────────────────────────────────

export function waitForAuth(timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      resolve(user?.uid ?? null);
    });
    // Timeout: resolve null if auth state never fires
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      console.warn("[waitForAuth] Timed out waiting for auth state");
      resolve(null);
    }, timeoutMs);
  });
}

export function getCurrentUserId(): string | null {
  return auth.currentUser?.uid ?? null;
}

// ────────────────────────────────────────────
// Firestore fetchers
// ────────────────────────────────────────────

export async function fetchSceneLists(
  userId: string,
): Promise<VoidspaceSceneList[]> {
  const ref = collection(db, "users", userId, "scene_lists");
  const snapshot = await getDocs(ref);
  return snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() } as VoidspaceSceneList))
    .sort((a, b) => {
      const aTime = a.updated_at?.seconds ?? a.created_at?.seconds ?? 0;
      const bTime = b.updated_at?.seconds ?? b.created_at?.seconds ?? 0;
      return bTime - aTime; // newest first
    });
}

async function fetchScenes(
  userId: string,
  sceneListId: string,
): Promise<Array<SceneData & { _docId: string }>> {
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
  );
  const q = query(ref, orderBy("scene_number"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ _docId: d.id, ...(d.data() as SceneData) }));
}

async function fetchSceneVideos(
  userId: string,
  sceneListId: string,
  sceneNum: string,
): Promise<SceneVideoData[]> {
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
    sceneNum,
    "videos",
  );
  const snapshot = await getDocs(ref);
  return snapshot.docs.map(
    (d) => ({ id: d.id, ...d.data() } as SceneVideoData),
  );
}

async function fetchSceneImages(
  userId: string,
  sceneListId: string,
  sceneNum: string,
): Promise<SceneImageData[]> {
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
    sceneNum,
    "images",
  );
  const snapshot = await getDocs(ref);
  return snapshot.docs.map(
    (d) => ({ id: d.id, ...d.data() } as SceneImageData),
  );
}

async function fetchSceneNarrations(
  userId: string,
  sceneListId: string,
  sceneNum: string,
): Promise<SceneNarrationData[]> {
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
    sceneNum,
    "narrations",
  );
  const snapshot = await getDocs(ref);
  return snapshot.docs.map(
    (d) => ({ id: d.id, ...d.data() } as SceneNarrationData),
  );
}

async function fetchSceneSfx(
  userId: string,
  sceneListId: string,
  sceneNum: string,
  inlineSfxList?: SceneSfxData[],
): Promise<SceneSfxData[]> {
  // Prefer the inline `sfx_list` array on the scene doc (cheap — already
  // fetched as part of fetchScenes). The array is AUTHORITATIVE when
  // present at all (including when explicitly empty) — that means
  // `sfx_list: []` is "no SFX, on purpose" not "fall through to subcoll".
  //
  // We only fall back to the legacy `sfxs/` subcollection when the
  // field is genuinely absent (`undefined`). Conflating "absent" with
  // "empty array" was a real bug — clearing SFX via `{ sfx_list: [] }`
  // would silently re-hydrate from the stale subcollection.
  if (Array.isArray(inlineSfxList)) {
    return inlineSfxList.map((s, i) => ({ ...s, id: s.id ?? `sfx_${i}` } as SceneSfxData));
  }
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
    sceneNum,
    "sfxs",
  );
  const snapshot = await getDocs(ref);
  return snapshot.docs.map(
    (d) => ({ id: d.id, ...d.data() } as SceneSfxData),
  );
}

/** Fetch all user music from the global music collection owned by this user */
export async function fetchUserMusic(userId: string): Promise<
  Array<{
    id: string;
    title?: string;
    artist?: string;
    url?: string;
    duration_ms?: number;
    avatar_id?: string;
  }>
> {
  // Music is stored in users/{userId}/scene_lists but also might be in a global music collection
  // For now fetch music referenced in scene lists
  const sceneLists = await fetchSceneLists(userId);
  const musicMap = new Map<string, { id: string; title?: string; artist?: string; url?: string; duration_ms?: number }>();

  for (const sl of sceneLists) {
    if (sl.music_url && !musicMap.has(sl.music_url)) {
      musicMap.set(sl.music_url, {
        id: sl.id,
        title: sl.music_title || sl.name,
        url: sl.music_url,
      });
    }
  }

  return Array.from(musicMap.values());
}

// ────────────────────────────────────────────
// Project builder
// ────────────────────────────────────────────

const DEFAULT_SCENE_DURATION = 6; // seconds
const DEFAULT_FPS = 30;

// Aspect-ratio → canvas dimensions, kept in lockstep with the studio's
// Remotion render (`studio/src/render.ts` → ASPECT_DIMENSIONS). The chat
// writes `aspect_ratio` onto the scene_list doc; we resolve it here so
// the editor canvas, timeline thumbnails, and final encode all agree.
const ASPECT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1':  { width: 1080, height: 1080 },
  '4:3':  { width: 1440, height: 1080 },
  '3:4':  { width: 1080, height: 1440 },
  '21:9': { width: 2560, height: 1080 },
};
const FALLBACK_DIM = ASPECT_DIMENSIONS['16:9'];

function resolveAspectDimensions(aspect: unknown): { width: number; height: number } {
  if (typeof aspect === 'string') {
    const key = aspect.trim();
    if (ASPECT_DIMENSIONS[key]) return ASPECT_DIMENSIONS[key];
    // Tolerate "16x9" / "16/9" variants.
    const norm = key.replace(/[x/]/g, ':');
    if (ASPECT_DIMENSIONS[norm]) return ASPECT_DIMENSIONS[norm];
  }
  return FALLBACK_DIM;
}

// TextClip style for caption phrases. The title-engine uses these
// fields for rendering; standard openreel Inspector edits (font size,
// color, alignment, transform) bind directly into this style and the
// clip's transform.
const CAPTION_TEXT_STYLE = {
  fontFamily: "Anton",
  fontSize: 72,
  fontWeight: "bold" as const,
  fontStyle: "normal" as const,
  color: "#FFFFFF",
  backgroundColor: "transparent",
  textAlign: "center" as const,
  verticalAlign: "middle" as const,
  lineHeight: 1.2,
  letterSpacing: 0,
  // Drop shadow + outline for legibility over busy backgrounds —
  // mirrors the look the subtitle-canvas-renderer produced for
  // Anton-family captions.
  strokeColor: "#000000",
  strokeWidth: 5,
};

// Bottom-center transform expressed in NORMALIZED canvas coords (0..1)
// so it scales correctly across 16:9 / 9:16 / 1:1 / etc. The Inspector
// Transform section edits these directly, so users can drag captions
// anywhere on the canvas after the initial placement.
const CAPTION_DEFAULT_TRANSFORM = {
  position: { x: 0.5, y: 0.85 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
};

function makeMediaMeta(
  overrides: Partial<MediaMetadata> = {},
  dim: { width: number; height: number } = FALLBACK_DIM,
): MediaMetadata {
  return {
    duration: 0,
    width: dim.width,
    height: dim.height,
    frameRate: DEFAULT_FPS,
    codec: "",
    sampleRate: 44100,
    channels: 2,
    fileSize: 0,
    ...overrides,
  };
}

function makeDefaultTransform() {
  return {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  };
}

function parseTimestampToSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const simple = Number(trimmed);
  if (Number.isFinite(simple)) {
    if (simple > 1000) return simple / 1000;
    return simple;
  }

  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return null;
}

function parseNumericTime(value: unknown, assumeMs = false): number | null {
  if (value == null) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (assumeMs) return value / 1000;
    if (value > 1000) return value / 1000;
    return value;
  }

  if (typeof value === "string") {
    const parsed = parseTimestampToSeconds(value);
    if (parsed != null) return parsed;
  }

  return null;
}

function parseNumericMs(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function resolveSceneMusicTimingMs(scene: SceneData): {
  startMs: number | null;
  endMs: number | null;
} {
  const row = scene as unknown as Record<string, unknown>;
  const editState =
    (row.edit_state as Record<string, unknown> | undefined) ??
    undefined;

  const startMs =
    parseNumericMs(row.music_start_ms) ??
    parseNumericMs(row.audio_start_ms) ??
    parseNumericMs(editState?.music_start_ms) ??
    parseNumericMs(editState?.audio_start_ms);

  const endMs =
    parseNumericMs(row.music_end_ms) ??
    parseNumericMs(row.audio_end_ms) ??
    parseNumericMs(editState?.music_end_ms) ??
    parseNumericMs(editState?.audio_end_ms);

  return {
    startMs,
    endMs,
  };
}

function parseLyricsJsonSegments(raw: string): Array<{ text: string; start: number; end?: number }> {
  try {
    const parsed = JSON.parse(raw);

    const candidates: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.lyrics)
        ? parsed.lyrics
        : Array.isArray(parsed?.lines)
          ? parsed.lines
          : Array.isArray(parsed?.segments)
            ? parsed.segments
            : Array.isArray(parsed?.words)
              ? parsed.words
              : [];

    const segments: Array<{ text: string; start: number; end?: number }> = [];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const row = candidate as Record<string, unknown>;

      const text = [row.text, row.lyric, row.line, row.caption]
        .find((v) => typeof v === "string" && v.trim().length > 0) as string | undefined;

      if (!text) continue;

      const start =
        parseNumericTime(row.start_ms, true) ??
        parseNumericTime(row.startTime) ??
        parseNumericTime(row.start_time) ??
        parseNumericTime(row.start) ??
        parseNumericTime(row.time) ??
        parseNumericTime(row.timestamp);

      const end =
        parseNumericTime(row.end_ms, true) ??
        parseNumericTime(row.endTime) ??
        parseNumericTime(row.end_time) ??
        parseNumericTime(row.end);

      if (start == null) continue;

      segments.push({ text: text.trim(), start, end: end ?? undefined });
    }

    return segments.sort((a, b) => a.start - b.start);
  } catch {
    return [];
  }
}

function parseLrcSegments(raw: string): Array<{ text: string; start: number }> {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const segments: Array<{ text: string; start: number }> = [];

  for (const line of lines) {
    const matches = [...line.matchAll(/\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]/g)];
    if (!matches.length) continue;

    const text = line.replace(/\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]/g, "").trim();
    if (!text) continue;

    for (const match of matches) {
      const ts = parseTimestampToSeconds(match[1]);
      if (ts == null) continue;
      segments.push({ text, start: ts });
    }
  }

  return segments.sort((a, b) => a.start - b.start);
}

function setSceneListContext(
  sceneListId: string,
  slData: Record<string, unknown>,
) {
  const caption =
    (slData.loop_description as string | undefined) ||
    (slData.description as string | undefined) ||
    (slData.content as string | undefined) ||
    (slData.caption as string | undefined) ||
    (slData.post_description as string | undefined) ||
    undefined;

  useVoidspaceStore.getState().setSceneList({
    sceneListId,
    name: slData.name as string | undefined,
    videoUrl: slData.video_url as string | undefined,
    thumbnailUrl:
      (slData.thumbnail_url as string | undefined) ||
      (slData.preview_image_url as string | undefined) ||
      (slData.first_frame_url as string | undefined) ||
      (slData.image_url as string | undefined) ||
      undefined,
    avatarId: slData.avatar_id as string | undefined,
    avatarName: slData.avatar_name as string | undefined,
    reviewId: slData.review_id as string | undefined,
    caption,
  });
}

export async function fetchSceneListContext(
  userId: string,
  sceneListId: string,
): Promise<void> {
  const slDoc = await getDoc(doc(db, "users", userId, "scene_lists", sceneListId));
  if (!slDoc.exists()) return;
  const slData = slDoc.data() as Record<string, unknown>;

  // If the scene list has a review_id and no caption fields, fetch the review
  // document's description to use as the caption.
  const hasCaption =
    slData.loop_description || slData.description || slData.content ||
    slData.caption || slData.post_description;

  if (!hasCaption && slData.review_id) {
    try {
      const reviewDoc = await getDoc(
        doc(db, "users", userId, "reviews", slData.review_id as string),
      );
      if (reviewDoc.exists()) {
        const reviewData = reviewDoc.data() as Record<string, unknown>;
        if (reviewData.description) {
          slData.description = reviewData.description;
        }
      }
    } catch (err) {
      console.warn("[voidspace-loader] Failed to fetch review caption:", err);
    }
  }

  setSceneListContext(sceneListId, slData);
}

/**
 * Load a Voidspace scene list and build a complete OpenReel Project.
 */
export async function loadSceneListAsProject(
  userId: string,
  sceneListId: string,
): Promise<Project> {
  console.log(`[voidspace-loader] Loading scene list: ${sceneListId} for user: ${userId}`);

  // 1) Fetch scene list metadata
  const slDoc = await getDoc(
    doc(db, "users", userId, "scene_lists", sceneListId),
  );
  if (!slDoc.exists()) {
    throw new Error(`Scene list "${sceneListId}" not found`);
  }
  const slData = slDoc.data();
  console.log(`[voidspace-loader] Scene list found: ${slData.name || sceneListId}`);

  // ── Project-state blob: the source of truth ────────────────────────
  // The editor's autoSaveManager serialises the full openreel Project
  // (timeline tracks, clips, mediaLibrary, textClips/captions, settings,
  // ActionHistory) to `scene_lists/{id}.project_state.json` on every
  // save. When present, this blob IS the project — no per-scene rebuild
  // needed, no field translation. openreel's own serializer + loadProject
  // handle deserialisation; everything round-trips natively.
  //
  // The per-scene Firestore fields (`scene.video_url`, `scene.narration_url`,
  // `videos/`, `narrations/` subcollections) are now used ONLY to bootstrap
  // a fresh project (no blob yet — first load after generation pipeline
  // produces media). Once the editor's first autosave fires, the blob
  // takes over forever.
  //
  // Agent edits go through editorBridge RPCs (patchClip, addClip,
  // addSfxClip, etc.), which dispatch through the editor's ActionExecutor
  // → ActionHistory → autoSaveManager. The blob captures them. There's
  // no parallel "agent writes per-scene + we reconcile" path — that's
  // the freshness/staleness machinery we just deleted.
  const projectStateRaw = (slData as Record<string, unknown>).project_state as
    | { json?: string }
    | undefined;
  if (projectStateRaw && typeof projectStateRaw.json === "string" && projectStateRaw.json) {
    try {
      const parsed = JSON.parse(projectStateRaw.json) as Project;
      if (parsed && typeof parsed === "object" && parsed.timeline) {
        console.log(`[voidspace-loader] Using project_state blob (${projectStateRaw.json.length} bytes)`);
        return parsed;
      }
      console.warn("[voidspace-loader] project_state blob malformed, falling back to per-scene bootstrap");
    } catch (e) {
      console.warn("[voidspace-loader] project_state JSON.parse failed, falling back:", e);
    }
  }

  // Resolve canvas dimensions. Priority order:
  //   1. `?aspect=…` query param on the iframe URL — wins over Firestore
  //      because the studio chat sets it from the welcome picker LIVE,
  //      so even if the doc was minted with a stale value (rehydrated
  //      session, race), the canvas matches what the user chose.
  //   2. `aspect_ratio` on the scene_list doc (canonical).
  //   3. `aspect` (legacy alias) on the scene_list doc.
  //   4. Default 16:9.
  // Every media item built below carries matching width/height — keeping
  // the openreel canvas, timeline thumbnails, and the final Remotion
  // encode all in lockstep.
  let urlAspect: string | undefined;
  if (typeof window !== 'undefined') {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('aspect');
      if (v) urlAspect = v;
    } catch {
      // ignore — fall through to Firestore.
    }
  }
  const dim = resolveAspectDimensions(
    urlAspect
      ?? (slData as Record<string, unknown>).aspect_ratio
      ?? (slData as Record<string, unknown>).aspect,
  );
  const mediaMeta = (overrides: Partial<MediaMetadata> = {}) =>
    makeMediaMeta(overrides, dim);

  // Populate scene list context in Voidspace store
  setSceneListContext(sceneListId, slData as Record<string, unknown>);

  // 2) Fetch all scenes
  const scenes = await fetchScenes(userId, sceneListId);
  console.log(`[voidspace-loader] Fetched ${scenes.length} scenes (doc IDs: ${scenes.map(s => s._docId).join(', ')})`);

  // 3) For each scene, fetch media in parallel
  const sceneMedia = await Promise.all(
    scenes.map(async (scene) => {
      const docId = scene._docId;
      // sfx_list array on the scene doc is the canonical source.
      // fetchSceneSfx falls back to subcollection only if absent.
      const inlineSfx = (scene as any).sfx_list as any[] | undefined;
      const [videos, images, narrations, sfxs] = await Promise.all([
        fetchSceneVideos(userId, sceneListId, docId),
        fetchSceneImages(userId, sceneListId, docId),
        fetchSceneNarrations(userId, sceneListId, docId),
        fetchSceneSfx(userId, sceneListId, docId, inlineSfx),
      ]);
      return { scene, videos, images, narrations, sfxs };
    }),
  );

  // 4) Build media library + timeline
  const mediaItems: MediaItem[] = [];
  const videoTrackClips: Clip[] = [];
  const narrationTrackClips: Clip[] = [];
  const sfxTrackClips: Clip[] = [];
  const musicTrackClips: Clip[] = [];
  const musicTrackSpecs: Array<{
    mediaId: string;
    sceneDocId: string;
    startTime: number;
    duration: number;
    inPoint: number;
    outPoint: number;
  }> = [];
  // Captions are emitted as TextClips on `track-captions` so the
  // standard openreel Inspector (Transform, Alignment, Effects, Text
  // Properties, Animation) operates on them like any other text. The
  // legacy `timeline.subtitles` array is kept empty to avoid double-
  // rendering on top of the TextClips.
  const subtitles: Subtitle[] = [];
  const captionTextClips: TextClip[] = [];
  const pushCaption = (
    text: string,
    startTime: number,
    endTime: number,
    sceneDocId: string,
    chunkIdx: number,
  ) => {
    const duration = Math.max(0.1, endTime - startTime);
    captionTextClips.push({
      id: `caption-${sceneDocId}-${chunkIdx}`,
      trackId: "track-captions",
      startTime,
      duration,
      text,
      style: { ...CAPTION_TEXT_STYLE },
      transform: { ...CAPTION_DEFAULT_TRANSFORM },
      keyframes: [],
    });
  };

  let currentTime = 0; // running timeline position in seconds
  let fallbackMusicMediaId: string | null = null;
  let totalMusicDuration = 0;
  const musicMediaIdsByUrl = new Map<string, string>();
  let lastMusicMediaId: string | null = null;
  let lastMusicOutPointSec: number | null = null;

  const ensureMusicMediaItem = async (
    rawUrl: string | null | undefined,
    preferredTitle?: string,
  ): Promise<string | null> => {
    const resolvedUrl = await resolveMediaUrl(rawUrl ?? null);
    if (!resolvedUrl) return null;

    const existingMediaId = musicMediaIdsByUrl.get(resolvedUrl);
    if (existingMediaId) return existingMediaId;

    // Stable mediaId derived from the resolved URL — same hashing
    // rationale as scene video / narration above (id stability across
    // live-rebuilds → preserves selection + dedupes additive merges).
    const mediaId = `media-music-${stableHash(resolvedUrl)}`;
    musicMediaIdsByUrl.set(resolvedUrl, mediaId);
    // Fetch the music blob so the export-time audio engine can decode it.
    // Without a blob, getAudioBuffer() in audio-engine.ts returns null and
    // the track is silently dropped from the rendered MP4.
    const musicBlob = await fetchMediaBlob(resolvedUrl);
    mediaItems.push({
      id: mediaId,
      name: preferredTitle || "Background Music",
      type: "audio",
      fileHandle: null,
      blob: musicBlob,
      metadata: mediaMeta({ duration: 300, fileSize: musicBlob?.size || 0 }), // placeholder duration, updated from clips below
      thumbnailUrl: null,
      waveformData: null,
      originalUrl: resolvedUrl,
      category: "Music",
      role: "music",
    });

    if (!fallbackMusicMediaId) {
      fallbackMusicMediaId = mediaId;
    }

    return mediaId;
  };

  // Track the global music URL so we create one media item for it
  await ensureMusicMediaItem(
    slData.music_url ?? scenes.find((s) => s.music_url)?.music_url ?? null,
    slData.music_title || "Background Music",
  );

  for (const { scene, videos, images, narrations, sfxs } of sceneMedia) {
    const sceneFallbackVideoUrl = await resolveMediaUrl(
      scene.video_url ?? scene.url ?? null,
    );
    const sceneFallbackImageUrl = await resolveMediaUrl(
      scene.image_url ?? scene.first_frame_url ?? scene.preview_image_url ?? null,
    );

    // Pick the primary video. Prefer the asset whose URL matches the
    // scene-level `video_url` — that field is the chat side's
    // authoritative pointer to the latest approved clip, so honoring
    // it makes regen-approve actually swap the clip on the timeline
    // instead of replaying the oldest doc that happens to be tagged
    // `primary` from a prior generation.
    const videosWithUrls = videos.filter((v) => v.url || v.video_url);
    const primaryVideo =
      (scene.video_url
        ? videosWithUrls.find((v) => (v.url ?? v.video_url) === scene.video_url)
        : null) ??
      videosWithUrls.find((v) => v.tag === "primary") ??
      videosWithUrls[videosWithUrls.length - 1] ??
      null;
    const videoUrl = await resolveMediaUrl(
      primaryVideo?.url ?? primaryVideo?.video_url ?? sceneFallbackVideoUrl ?? null,
    );

    // Pick the primary image. Same idea as video — prefer whichever
    // asset matches the scene-level pointer so a regen-approved frame
    // wins over the first-tagged doc.
    const sceneImagePointer =
      scene.image_url ?? scene.first_frame_url ?? scene.preview_image_url ?? null;
    const primaryImage =
      (sceneImagePointer
        ? images.find((i) => (i.url ?? i.image_url) === sceneImagePointer)
        : null) ??
      images.find((i) => i.tag === "first_frame") ??
      images.find((i) => i.tag === "generated_first_frame") ??
      images[images.length - 1] ??
      null;
    const imageUrl = await resolveMediaUrl(
      primaryImage?.url ?? primaryImage?.image_url ?? sceneFallbackImageUrl ?? null,
    );

    // Pick narration. Same pointer-first rule so the editor swaps to
    // the regenerated TTS instead of the first-inserted doc — which
    // never matched the chat side's slider selection after regen.
    const narration =
      (scene.narration_url
        ? narrations.find(
            (n) => (n.narration_url ?? n.url) === scene.narration_url,
          )
        : null) ??
      narrations[narrations.length - 1] ??
      null;
    const narrationUrl =
      (await resolveMediaUrl(
        narration?.narration_url ??
          narration?.url ??
          scene.narration_url ??
          null,
      )) ?? null;

    // Per-scene-bootstrap path only — once the blob exists, this code
    // is bypassed entirely. music_disabled / narration_disabled flags
    // are no longer written (deleted via the bigger refactor); the
    // blob captures music presence/absence directly.
    const sceneMusicMediaId =
      (await ensureMusicMediaItem(
        scene.music_url ?? slData.music_url ?? null,
        scene.music_title || slData.music_title || "Background Music",
      )) ?? fallbackMusicMediaId;

    const { startMs: musicStartMs, endMs: musicEndMs } =
      resolveSceneMusicTimingMs(scene);
    const musicStartSec =
      musicStartMs != null ? Math.max(0, musicStartMs / 1000) : null;
    const musicEndSec =
      musicEndMs != null ? Math.max(0, musicEndMs / 1000) : null;

    // ── Resolve persisted video trim (Flutter parity) ──
    // Either side can store a trim window for the scene's primary video:
    //   - scene-level: `video_start_ms` / `video_end_ms` / `video_duration_ms`
    //     (web-side patchClip mirror writes here so the agent's edit_clip
    //      survives reload)
    //   - video-doc level: `start_ms` / `end_ms` (Flutter automation pipeline
    //     writes here)
    // Scene-level wins when both are present so a per-scene tweak survives
    // a video regen that mints a fresh primaryVideo doc.
    const videoStartMsRaw =
      typeof (scene as any).video_start_ms === "number"
        ? (scene as any).video_start_ms
        : typeof primaryVideo?.start_ms === "number"
          ? primaryVideo.start_ms
          : null;
    const videoEndMsRaw =
      typeof (scene as any).video_end_ms === "number"
        ? (scene as any).video_end_ms
        : typeof primaryVideo?.end_ms === "number"
          ? primaryVideo.end_ms
          : null;
    const hasVideoTrim =
      videoStartMsRaw != null &&
      videoEndMsRaw != null &&
      videoEndMsRaw > videoStartMsRaw;

    // Compute scene duration from available timing data
    let sceneDuration = DEFAULT_SCENE_DURATION;
    if (hasVideoTrim) {
      // A trim shrinks the scene's slot on the timeline. Narration /
      // captions / SFX placed inside this scene rebase against the
      // shorter window automatically because they all use `currentTime`
      // (cumulative) + their own offsets.
      sceneDuration = (videoEndMsRaw! - videoStartMsRaw!) / 1000;
    } else if (primaryVideo?.duration_ms) {
      sceneDuration = primaryVideo.duration_ms / 1000;
    } else if (musicStartSec != null && musicEndSec != null) {
      sceneDuration = musicEndSec - musicStartSec;
    } else if (
      scene.narration_start_ms != null &&
      scene.narration_end_ms != null
    ) {
      sceneDuration = (scene.narration_end_ms - scene.narration_start_ms) / 1000;
    } else if (narration?.duration_ms) {
      sceneDuration = narration.duration_ms / 1000;
    }
    if (sceneDuration <= 0) sceneDuration = DEFAULT_SCENE_DURATION;

    // Build music track segments from scene trim timing (Flutter parity).
    // When music_start_ms/music_end_ms are present, use them as source in/out points.
    if (sceneMusicMediaId) {
      let inPoint: number | null = null;
      let outPoint: number | null = null;

      if (musicStartSec != null || musicEndSec != null) {
        inPoint =
          musicStartSec ??
          (musicEndSec != null ? Math.max(0, musicEndSec - sceneDuration) : 0);
        outPoint =
          musicEndSec ??
          (inPoint + sceneDuration);
      } else if (
        lastMusicOutPointSec != null &&
        lastMusicMediaId === sceneMusicMediaId
      ) {
        // Continue seamlessly if a previous scene established the source cursor.
        inPoint = lastMusicOutPointSec;
        outPoint = inPoint + sceneDuration;
      } else {
        // Backward compatibility for scenes without explicit trim timing.
        inPoint = 0;
        outPoint = sceneDuration;
      }

      if (inPoint != null && outPoint != null) {
        if (outPoint <= inPoint) {
          outPoint = inPoint + sceneDuration;
        }
        const duration = Math.max(0.001, Math.min(sceneDuration, outPoint - inPoint));
        const clippedOutPoint: number = inPoint + duration;

        musicTrackSpecs.push({
          mediaId: sceneMusicMediaId,
          sceneDocId: scene._docId,
          startTime: currentTime,
          duration,
          inPoint,
          outPoint: clippedOutPoint,
        });
        lastMusicMediaId = sceneMusicMediaId;
        lastMusicOutPointSec = clippedOutPoint;
      }
    }

    // ── Video clip ──
    // Only place the actual rendered video on the timeline. Scenes
    // without a generated video URL are skipped entirely — no image
    // fallback, no orphan image tracks. The user's chat flow guarantees
    // a video per scene before render is offered, so a missing video
    // means generation failed and we'd rather see a gap than a still.
    if (videoUrl) {
      const videoBlob = await fetchMediaBlob(videoUrl);
      // Stable IDs derived from Firestore doc keys so the editor's
      // selection / Inspector edits / undo history survive across the
      // periodic rebuilds the live subscription performs. Random
      // uuidv4()s would mint a fresh id on every Firestore tick which
      // (a) breaks selection mid-edit and (b) makes additive media-
      // library merges duplicate the same scene's video / narration.
      const mediaId = `media-video-${scene._docId}-${primaryVideo?.id ?? "fallback"}`;
      mediaItems.push({
        id: mediaId,
        name: `Scene ${scene.scene_number} · Video`,
        type: "video",
        fileHandle: null,
        blob: videoBlob,
        metadata: mediaMeta({
          duration: sceneDuration,
          fileSize: videoBlob?.size || 0,
        }),
        thumbnailUrl: imageUrl,
        waveformData: null,
        originalUrl: videoUrl,
        category: "Scene Videos",
        sceneNumber: scene.scene_number,
        role: "primary",
      });

      // inPoint / outPoint are SOURCE-FILE coordinates (which slice of the
      // underlying video to play); duration is timeline-slot length. When
      // a trim window was persisted, both move together — see
      // `hasVideoTrim` above. Without one, we play the whole source.
      const clipInPoint = hasVideoTrim ? videoStartMsRaw! / 1000 : 0;
      const clipOutPoint = hasVideoTrim
        ? videoEndMsRaw! / 1000
        : sceneDuration;
      videoTrackClips.push({
        id: `clip-video-${scene._docId}`,
        mediaId,
        trackId: "track-video",
        startTime: currentTime,
        duration: sceneDuration,
        inPoint: clipInPoint,
        outPoint: clipOutPoint,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: primaryVideo?.has_embedded_audio ? 1 : 0,
        keyframes: [],
      });
    }

    // ── Narration clip ──
    if (narrationUrl) {
      const narMediaId = `media-narration-${scene._docId}-${narration?.id ?? "fallback"}`;
      const narDurMs = typeof narration?.duration_ms === "number" ? narration.duration_ms : null;
      const narDuration = narDurMs != null ? narDurMs / 1000 : sceneDuration;

      // Fetch the narration blob so the export-time audio engine can decode
      // it. The audio engine's getAudioBuffer() returns null when blob is
      // missing, which silently drops the narration from the rendered MP4
      // (caused the "missing narration" bug at export time).
      const narrationBlob = await fetchMediaBlob(narrationUrl);

      mediaItems.push({
        id: narMediaId,
        name: `Scene ${scene.scene_number} · Narration`,
        type: "audio",
        fileHandle: null,
        blob: narrationBlob,
        metadata: mediaMeta({ duration: narDuration, fileSize: narrationBlob?.size || 0 }),
        thumbnailUrl: null,
        waveformData: null,
        originalUrl: narrationUrl,
        category: "Narrations",
        sceneNumber: scene.scene_number,
        role: "narration",
      });

      // Bullet-proof source-clip in/out resolution.
      //
      // Older studio chats wrote `start_ms`/`end_ms` as GLOBAL timeline
      // offsets (e.g. scene 2 narration had start_ms: 6000 even though
      // its audio file is only 6s long). The loader used to feed those
      // straight in as inPoint/outPoint, which made the audio element
      // play frames 6–12 of a 6s file — silence — and filtered every
      // word out of the captions because their timestamps fell below
      // trimStartSec.
      //
      // Heuristic: treat start_ms as the source-clip in-point ONLY if
      // it falls inside the audio file (i.e. < duration_ms). Anything
      // at or beyond duration_ms is a stale global offset; collapse to
      // 0..duration. This keeps both old and new docs working without
      // a Firestore migration.
      const rawStartMs = typeof narration?.start_ms === "number" ? narration.start_ms : 0;
      const rawEndMs = typeof narration?.end_ms === "number" ? narration.end_ms : null;
      const looksLikeGlobalOffset =
        narDurMs != null && rawStartMs > 0 && rawStartMs >= narDurMs;
      const inPoint = looksLikeGlobalOffset ? 0 : Math.max(0, rawStartMs / 1000);
      const outPoint = looksLikeGlobalOffset
        ? narDuration
        : (rawEndMs != null ? Math.max(inPoint, rawEndMs / 1000) : inPoint + narDuration);

      narrationTrackClips.push({
        id: `clip-narration-${scene._docId}`,
        mediaId: narMediaId,
        trackId: "track-narration",
        startTime: currentTime,
        duration: Math.max(0.1, outPoint - inPoint),
        inPoint,
        outPoint,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: 1,
        keyframes: [],
      });
    }

    // ── SFX clips ──
    // Each SFX doc carries `sfx_url`, `start_ms` (offset into the scene),
    // `duration_ms`, and `volume`. We mount them as audio clips on
    // `track-sfx`, rebased onto the scene's cumulative start so they
    // ride the same timeline coordinate space as narration/music.
    for (const sfx of sfxs ?? []) {
      const sfxRawUrl = sfx.sfx_url ?? sfx.url ?? null;
      if (!sfxRawUrl) continue;
      const sfxUrl = await resolveMediaUrl(sfxRawUrl);
      if (!sfxUrl) continue;
      const sfxBlob = await fetchMediaBlob(sfxUrl);
      const sfxMediaId = `media-sfx-${stableHash(sfxRawUrl)}`;
      if (!mediaItems.find((m) => m.id === sfxMediaId)) {
        const sfxDur = typeof sfx.duration_ms === "number" ? sfx.duration_ms / 1000 : 2;
        mediaItems.push({
          id: sfxMediaId,
          name: sfx.prompt || "SFX",
          type: "audio",
          fileHandle: null,
          blob: sfxBlob ?? null,
          metadata: mediaMeta({ duration: sfxDur, fileSize: sfxBlob?.size || 0 }),
          thumbnailUrl: null,
          waveformData: null,
          originalUrl: sfxUrl,
          category: "SFX",
          role: "sfx",
        });
      }
      const offsetSec = (typeof sfx.start_ms === "number" ? sfx.start_ms : 0) / 1000;
      const durSec = typeof sfx.duration_ms === "number" ? sfx.duration_ms / 1000 : 2;
      const startTime = currentTime + Math.max(0, offsetSec);
      // Scene-prefix the clip id. `sfx.id` is just an index within ONE
      // scene's `sfx_list` (`sfx_0`, `sfx_1`, …) and collides across
      // scenes the moment two scenes both have an SFX. Without the
      // prefix, identical ids merged through `applyAdditiveMerge` show
      // up as multiple stacked entries with the same id — exactly the
      // "10 × clip-sfx-sfx_0 at startTime=92" pathology we hit in
      // production. Prefixing with the scene doc id makes every clip
      // distinct without changing the underlying media reuse.
      sfxTrackClips.push({
        id: `clip-sfx-${scene._docId}-${sfx.id}`,
        mediaId: sfxMediaId,
        trackId: "track-sfx",
        startTime,
        duration: Math.max(0.05, durSec),
        inPoint: 0,
        outPoint: Math.max(0.05, durSec),
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: typeof sfx.volume === "number" ? Math.max(0, Math.min(2, sfx.volume)) : 1,
        keyframes: [],
      });
    }

    // ── Subtitles from word timestamps ──
    // Studio writes word_timestamps onto the narration doc post-TTS AND
    // onto the chosen video doc post-clip-STT. Earlier versions stamped
    // them only on the first scene's narration; check every available
    // source before giving up so every scene shows captions.
    //
    // Captions track narration. If narration was deliberately disabled
    // for this scene, suppress the caption build too — otherwise we'd
    // re-emit captions whose audio source is muted, which doesn't match
    // what the editor showed at save time.
    const videoWithWords = videos.find(
      (v) => Array.isArray(v.word_timestamps) && v.word_timestamps.length > 0,
    );
    const narrationWithWords = narrations.find(
      (n) => Array.isArray(n.word_timestamps) && n.word_timestamps!.length > 0,
    );
    const rawWordTs =
      narration?.word_timestamps ??
      narrationWithWords?.word_timestamps ??
      primaryVideo?.word_timestamps ??
      videoWithWords?.word_timestamps ??
      null;

    if (rawWordTs && rawWordTs.length > 0) {
      // Filter and rebase word timestamps to match trim handles (Flutter parity).
      // Same global-offset guard as the narration clip above: when
      // start_ms looks like a stale global offset (>= file duration),
      // collapse to 0..duration so all words pass through unfiltered.
      const narDurMsForWords = typeof narration?.duration_ms === "number" ? narration.duration_ms : null;
      const rawStartMsForWords = typeof narration?.start_ms === "number" ? narration.start_ms : 0;
      const rawEndMsForWords = typeof narration?.end_ms === "number" ? narration.end_ms : null;
      const wordsLookLikeGlobalOffset =
        narDurMsForWords != null && rawStartMsForWords > 0 && rawStartMsForWords >= narDurMsForWords;
      const trimStartSec = wordsLookLikeGlobalOffset ? 0 : rawStartMsForWords / 1000;
      const trimEndSec = wordsLookLikeGlobalOffset
        ? (narDurMsForWords != null ? narDurMsForWords / 1000 : sceneDuration)
        : (rawEndMsForWords != null ? rawEndMsForWords / 1000 : trimStartSec + sceneDuration);

      const wordTs = rawWordTs
        .filter(
          (w) =>
            typeof w.word === "string" &&
            w.word.trim().length > 0 &&
            w.start >= trimStartSec &&
            w.start < trimEndSec,
        )
        .map((w) => ({
          word: w.word,
          start: w.start - trimStartSec,
          end: Math.min(w.end - trimStartSec, sceneDuration),
        }));

      // Group words into phrase segments synced to narration timing.
      const WORDS_PER_CHUNK = 4;
      let chunkIdx = 0;
      for (let i = 0; i < wordTs.length; i += WORDS_PER_CHUNK) {
        const chunk = wordTs
          .slice(i, i + WORDS_PER_CHUNK)
          .map((w) => ({
            text: w.word.trim().toUpperCase(),
            startTime: w.start + currentTime,
            endTime: w.end + currentTime,
          }));
        if (chunk.length === 0) continue;

        const text = chunk.map((w) => w.text).join(" ");
        const startSec = chunk[0].startTime;
        const endSec = chunk[chunk.length - 1].endTime;
        pushCaption(text, startSec, endSec, scene._docId, chunkIdx++);
      }
    } else {
      // Lyrics segments need rebasing relative to music_start_ms (Flutter parity).
      // lyrics_json / lyrics_lrc timestamps are absolute within the full song;
      // subtract the scene's music_start_ms to get scene-relative offsets.
      const lyricsBaseSec = musicStartSec;

      const jsonSegments = scene.lyrics_json
        ? parseLyricsJsonSegments(scene.lyrics_json)
        : [];

      if (jsonSegments.length > 0) {
        // Determine offset: prefer music_start_ms, fallback to first segment start
        const offsetSec = lyricsBaseSec ?? jsonSegments[0].start;

        let chunkIdx = 0;
        for (let i = 0; i < jsonSegments.length; i += 1) {
          const segment = jsonSegments[i];
          const rebasedStart = segment.start - offsetSec;
          const next = jsonSegments[i + 1];
          const rebasedNextStart = next != null ? next.start - offsetSec : null;
          const fallbackEnd =
            rebasedNextStart ?? Math.min(sceneDuration, rebasedStart + 2.5);
          const rebasedEnd = segment.end != null
            ? segment.end - offsetSec
            : fallbackEnd;

          // Skip segments outside scene bounds
          if (rebasedStart < 0 || rebasedStart >= sceneDuration) continue;
          if (rebasedEnd <= rebasedStart) continue;
          const clampedEnd = Math.min(rebasedEnd, sceneDuration);

          pushCaption(
            segment.text.toUpperCase(),
            currentTime + rebasedStart,
            currentTime + clampedEnd,
            scene._docId,
            chunkIdx++,
          );
        }
      } else if (scene.lyrics_lrc) {
        const lrcSegments = parseLrcSegments(scene.lyrics_lrc);
        // Determine offset: prefer music_start_ms, fallback to first segment start
        const offsetSec =
          lyricsBaseSec ??
          (lrcSegments.length > 0 ? lrcSegments[0].start : 0);

        let chunkIdx = 0;
        for (let i = 0; i < lrcSegments.length; i += 1) {
          const segment = lrcSegments[i];
          const rebasedStart = segment.start - offsetSec;
          const next = lrcSegments[i + 1];
          const rebasedNextStart = next != null ? next.start - offsetSec : null;
          const fallbackEnd =
            rebasedNextStart ?? Math.min(sceneDuration, rebasedStart + 2.5);

          // Skip segments outside scene bounds
          if (rebasedStart < 0 || rebasedStart >= sceneDuration) continue;
          if (fallbackEnd <= rebasedStart) continue;
          const clampedEnd = Math.min(fallbackEnd, sceneDuration);

          pushCaption(
            segment.text.toUpperCase(),
            currentTime + rebasedStart,
            currentTime + clampedEnd,
            scene._docId,
            chunkIdx++,
          );
        }
      }
    }

    currentTime += sceneDuration;
    totalMusicDuration = currentTime;
  }

  // ── Build music track clips ──
  if (musicTrackSpecs.length > 0 && totalMusicDuration > 0) {
    for (const spec of musicTrackSpecs) {
      musicTrackClips.push({
        id: `clip-music-${spec.sceneDocId}`,
        mediaId: spec.mediaId,
        trackId: "track-music",
        startTime: spec.startTime,
        duration: spec.duration,
        inPoint: spec.inPoint,
        outPoint: spec.outPoint,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: typeof slData.music_volume === "number"
          ? Math.max(0, Math.min(2, slData.music_volume as number))
          : 0.3,
        keyframes: [],
      });
    }
  } else if (fallbackMusicMediaId && totalMusicDuration > 0) {
    // Fallback for older scene lists that don't have per-scene music timing.
    musicTrackClips.push({
      id: `clip-music-fallback-${fallbackMusicMediaId}`,
      mediaId: fallbackMusicMediaId,
      trackId: "track-music",
      startTime: 0,
      duration: totalMusicDuration,
      inPoint: 0,
      outPoint: totalMusicDuration,
      effects: [],
      audioEffects: [],
      transform: makeDefaultTransform(),
      volume: typeof slData.music_volume === "number"
        ? Math.max(0, Math.min(2, slData.music_volume as number))
        : 0.3,
      keyframes: [],
    });
  }

  // Ensure each music media metadata duration covers the furthest out-point used by its clips.
  if (musicTrackClips.length > 0) {
    const maxMusicOutPointByMedia = new Map<string, number>();
    for (const clip of musicTrackClips) {
      const currentMax = maxMusicOutPointByMedia.get(clip.mediaId) ?? 0;
      maxMusicOutPointByMedia.set(clip.mediaId, Math.max(currentMax, clip.outPoint));
    }

    for (const [mediaId, maxOutPoint] of maxMusicOutPointByMedia.entries()) {
      const musicItem = mediaItems.find((m) => m.id === mediaId);
      if (musicItem) {
        (musicItem as { metadata: MediaMetadata }).metadata = mediaMeta({
          duration: Math.max(maxOutPoint, musicItem.metadata.duration || 0),
        });
      }
    }
  }

  // Captions are emitted as TextClips on `track-captions` (built via
  // `pushCaption` above). They render through the title-engine, so the
  // standard openreel Inspector — Transform, Alignment, Effects, Text
  // Properties, Animations, Keyframes — operates on them like any other
  // text clip. `timeline.subtitles` is intentionally left empty so the
  // subtitle-canvas-renderer doesn't draw a second copy on top.

  // 5) Assemble tracks
  //
  // ⚠ Track ORDER matters for both the editor preview AND the export
  // renderer. Both sort tracks by descending `originalIndex` (last
  // track first → drawn FIRST → bottom of the stack), so a track at
  // index 0 ends up on TOP of the visual stack. We deliberately put
  // the captions track at index 0 (top) so subtitles render OVER the
  // video, not underneath it. The previous order had captions at the
  // tail of the array which made the video clip cover them in the
  // export — captions appeared in the preview only because the
  // preview-side renderer's "above-video" pass was structured around
  // the originalIndex < lowestVideoIndex predicate; the export
  // renderer has no such split, so the descending-sort z-order
  // dropped them straight into the bottom layer.
  const tracks: Track[] = [];

  if (captionTextClips.length > 0) {
    // Type "text" — see video-engine `getActiveTextClips` which filters
    // textClips by their track type. We register an empty `clips` array
    // here because TextClips live in `project.textClips` (managed by the
    // title-engine), not on the track itself.
    tracks.push({
      id: "track-captions",
      type: "text",
      name: "Captions",
      clips: [],
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  tracks.push({
    id: "track-video",
    type: "video",
    name: "Video",
    clips: videoTrackClips,
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  });

  // Only add narration track if it has clips (matches Flutter — no empty tracks)
  if (narrationTrackClips.length > 0) {
    tracks.push({
      id: "track-narration",
      type: "audio",
      name: "Narration",
      clips: narrationTrackClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  if (sfxTrackClips.length > 0) {
    tracks.push({
      id: "track-sfx",
      type: "audio",
      name: "SFX",
      clips: sfxTrackClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  if (musicTrackClips.length > 0) {
    tracks.push({
      id: "track-music",
      type: "audio",
      name: "Background Music",
      clips: musicTrackClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  const timeline: Timeline = {
    tracks,
    subtitles,
    duration: totalMusicDuration || currentTime,
    markers: [],
  };

  const settings: ProjectSettings = {
    width: dim.width,
    height: dim.height,
    frameRate: DEFAULT_FPS,
    sampleRate: 44100,
    channels: 2,
  };

  const now = Date.now();

  const project: Project = {
    id: buildVoidspaceProjectId(userId, sceneListId, slData.avatar_id as string | undefined),
    name: slData.name || slData.avatar_name || "Voidspace Project",
    createdAt: slData.created_at?.seconds
      ? slData.created_at.seconds * 1000
      : now,
    modifiedAt: slData.updated_at?.seconds
      ? slData.updated_at.seconds * 1000
      : now,
    settings,
    mediaLibrary: { items: mediaItems },
    timeline,
    textClips: captionTextClips,
  };

  return project;
}

/**
 * Live subscription wrapper — registers Firestore onSnapshot() listeners on
 * the scene_list doc and the scenes / images / videos / narrations
 * subcollections, debounces them, and re-runs `loadSceneListAsProject` on
 * every change.
 *
 * The studio chat upserts assets (frame, voiceover, clip) one by one as the
 * user approves each step. Without live subscription the editor sees only
 * the snapshot at iframe-mount time and the timeline never refreshes —
 * users had to reload the page to see the next clip land. This wires the
 * editor to receive a fresh `Project` on every Firestore write so the
 * timeline tracks fill in real time.
 *
 * Returns an unsubscribe function that tears down all listeners.
 */
export function subscribeSceneListAsProject(
  userId: string,
  sceneListId: string,
  onProject: (project: Project) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const slRef = doc(db, "users", userId, "scene_lists", sceneListId);
  const scenesCol = collection(db, "users", userId, "scene_lists", sceneListId, "scenes");

  // Coalesce bursts of writes into a single rebuild so we don't reload
  // the whole project on each per-asset upsert (which itself fires 4–6
  // writes back-to-back: scene_text, narration_url, narration_*_ms, etc.).
  let pending: any = null;
  let inFlight = false;
  let needsRerun = false;
  const rebuild = async () => {
    if (inFlight) { needsRerun = true; return; }
    inFlight = true;
    try {
      const project = await loadSceneListAsProject(userId, sceneListId);
      onProject(project);
    } catch (err) {
      console.warn("[voidspace-loader] live rebuild failed:", err);
      onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight = false;
      if (needsRerun) {
        needsRerun = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(rebuild, 250);
  };

  const unsubscribers: Unsubscribe[] = [];

  // 1. Top-level scene_list doc — captures aspect_ratio / music_url /
  //    title / video_url / status changes.
  unsubscribers.push(
    onSnapshot(slRef, () => schedule(), (err) => onError?.(err))
  );

  // 2. Scenes collection — every per-scene field write (first_frame_url,
  //    narration_url, video_url, status, duration_ms…). Subcollection
  //    snapshots fire when an `addAsset` call lands the new image / video
  //    / narration doc; the per-scene listener registered below on
  //    demand catches those.
  let sceneAssetUnsubs: Unsubscribe[] = [];
  unsubscribers.push(
    onSnapshot(
      query(scenesCol, orderBy("scene_number")),
      (snap) => {
        // Tear down existing per-scene asset listeners.
        for (const u of sceneAssetUnsubs) try { u(); } catch { /* ignore */ }
        sceneAssetUnsubs = [];
        // Register fresh listeners on each scene's images/videos/
        // narrations subcollections so live asset upserts trigger a
        // rebuild without polling.
        for (const sceneDoc of snap.docs) {
          const sceneId = sceneDoc.id;
          for (const kind of ["images", "videos", "narrations", "sfxs"] as const) {
            const sub = collection(
              db, "users", userId, "scene_lists", sceneListId,
              "scenes", sceneId, kind,
            );
            sceneAssetUnsubs.push(
              onSnapshot(sub, () => schedule(), (err) => onError?.(err))
            );
          }
        }
        schedule();
      },
      (err) => onError?.(err),
    )
  );

  // Immediate first load — don't wait for the first snapshot tick.
  schedule();

  return () => {
    if (pending) clearTimeout(pending);
    for (const u of unsubscribers) try { u(); } catch { /* ignore */ }
    for (const u of sceneAssetUnsubs) try { u(); } catch { /* ignore */ }
  };
}
