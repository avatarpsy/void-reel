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
} from "firebase/firestore";
import { v4 as uuidv4 } from "uuid";
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
  content_type?: string;
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
  music_start_ms?: number;
  music_end_ms?: number;
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

  // First attempt with raw URL
  let blob = await tryFetch(url);
  if (blob) return blob;

  // Retry with encoded URL for paths containing spaces/special chars
  if (url.includes(" ")) {
    blob = await tryFetch(encodeURI(url));
    if (blob) return blob;
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
const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;

const REMOTION_NARRATION_SUBTITLE_STYLE = {
  fontFamily: "Anton",
  fontSize: 80,
  color: "#FFFFFF",
  backgroundColor: "transparent",
  position: "center" as const,
  highlightColor: "#FF0000",
};

const REMOTION_LYRICS_SUBTITLE_STYLE = {
  fontFamily: "Anton",
  fontSize: 72,
  color: "#FFFFFF",
  backgroundColor: "transparent",
  position: "center" as const,
  highlightColor: "#FF0000",
};

function subtitleStyleToTextStyle(style?: Subtitle["style"]) {
  return {
    fontFamily: style?.fontFamily ?? "Anton",
    fontSize: style?.fontSize ?? 72,
    fontWeight: "bold" as const,
    fontStyle: "normal" as const,
    color: style?.color ?? "#FFFFFF",
    backgroundColor: style?.backgroundColor ?? undefined,
    textAlign: "center" as const,
    verticalAlign: "middle" as const,
    lineHeight: 1.2,
    letterSpacing: 0,
  };
}

function buildEvenWordTimings(
  text: string,
  startTime: number,
  endTime: number,
): Array<{ text: string; startTime: number; endTime: number }> {
  const words = text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .map((w) => w.toUpperCase());

  if (words.length === 0 || endTime <= startTime) {
    return [];
  }

  const totalDuration = endTime - startTime;
  const step = totalDuration / words.length;

  return words.map((word, index) => {
    const wordStart = startTime + step * index;
    const wordEnd = index === words.length - 1 ? endTime : startTime + step * (index + 1);
    return {
      text: word,
      startTime: wordStart,
      endTime: wordEnd,
    };
  });
}

function makeMediaMeta(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    duration: 0,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
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

  // Populate scene list context in Voidspace store
  setSceneListContext(sceneListId, slData as Record<string, unknown>);

  // 2) Fetch all scenes
  const scenes = await fetchScenes(userId, sceneListId);
  console.log(`[voidspace-loader] Fetched ${scenes.length} scenes (doc IDs: ${scenes.map(s => s._docId).join(', ')})`);

  // 3) For each scene, fetch media in parallel
  const sceneMedia = await Promise.all(
    scenes.map(async (scene) => {
      const docId = scene._docId;
      const [videos, images, narrations] = await Promise.all([
        fetchSceneVideos(userId, sceneListId, docId),
        fetchSceneImages(userId, sceneListId, docId),
        fetchSceneNarrations(userId, sceneListId, docId),
      ]);
      return { scene, videos, images, narrations };
    }),
  );

  // 4) Build media library + timeline
  const mediaItems: MediaItem[] = [];
  const videoTrackClips: Clip[] = [];
  const narrationTrackClips: Clip[] = [];
  const musicTrackClips: Clip[] = [];
  const subtitles: Subtitle[] = [];
  const textClips: TextClip[] = [];

  let currentTime = 0; // running timeline position in seconds
  let musicMediaId: string | null = null;
  let totalMusicDuration = 0;

  // Track the global music URL so we create one media item for it
  const globalMusicUrl =
    (await resolveMediaUrl(
      slData.music_url ?? scenes.find((s) => s.music_url)?.music_url ?? null,
    )) ?? null;

  if (globalMusicUrl) {
    musicMediaId = uuidv4();
    mediaItems.push({
      id: musicMediaId,
      name: slData.music_title || "Background Music",
      type: "audio",
      fileHandle: null,
      blob: null,
      metadata: makeMediaMeta({ duration: 300 }), // placeholder, will span timeline
      thumbnailUrl: null,
      waveformData: null,
      originalUrl: globalMusicUrl,
    });
  }

  for (const { scene, videos, images, narrations } of sceneMedia) {
    const sceneFallbackVideoUrl = await resolveMediaUrl(
      scene.video_url ?? scene.url ?? null,
    );
    const sceneFallbackImageUrl = await resolveMediaUrl(
      scene.image_url ?? scene.first_frame_url ?? scene.preview_image_url ?? null,
    );

    // Pick the primary video (or first available)
    const videosWithUrls = videos.filter((v) => v.url || v.video_url);
    const primaryVideo =
      videosWithUrls.find((v) => v.tag === "primary") ?? videosWithUrls[0] ?? null;
    const videoUrl = await resolveMediaUrl(
      primaryVideo?.url ?? primaryVideo?.video_url ?? sceneFallbackVideoUrl ?? null,
    );

    // Pick the primary image (first_frame or first available)
    const primaryImage =
      images.find((i) => i.tag === "first_frame") ??
      images.find((i) => i.tag === "generated_first_frame") ??
      images[0] ??
      null;
    const imageUrl = await resolveMediaUrl(
      primaryImage?.url ?? primaryImage?.image_url ?? sceneFallbackImageUrl ?? null,
    );

    // Pick narration
    const narration = narrations[0] ?? null;
    const narrationUrl =
      (await resolveMediaUrl(
        narration?.narration_url ??
          narration?.url ??
          scene.narration_url ??
          null,
      )) ?? null;

    // Compute scene duration from available timing data
    let sceneDuration = DEFAULT_SCENE_DURATION;
    if (primaryVideo?.duration_ms) {
      sceneDuration = primaryVideo.duration_ms / 1000;
    } else if (scene.music_start_ms != null && scene.music_end_ms != null) {
      sceneDuration = (scene.music_end_ms - scene.music_start_ms) / 1000;
    } else if (
      scene.narration_start_ms != null &&
      scene.narration_end_ms != null
    ) {
      sceneDuration = (scene.narration_end_ms - scene.narration_start_ms) / 1000;
    } else if (narration?.duration_ms) {
      sceneDuration = narration.duration_ms / 1000;
    }
    if (sceneDuration <= 0) sceneDuration = DEFAULT_SCENE_DURATION;

    // ── Video clip ──
    if (videoUrl) {
      const videoBlob = await fetchMediaBlob(videoUrl);
      const mediaId = uuidv4();
      mediaItems.push({
        id: mediaId,
        name: `Scene ${scene.scene_number} Video`,
        type: "video",
        fileHandle: null,
        blob: videoBlob,
        metadata: makeMediaMeta({
          duration: sceneDuration,
          fileSize: videoBlob?.size || 0,
        }),
        thumbnailUrl: imageUrl,
        waveformData: null,
        originalUrl: videoUrl,
      });

      videoTrackClips.push({
        id: uuidv4(),
        mediaId,
        trackId: "track-video",
        startTime: currentTime,
        duration: sceneDuration,
        inPoint: 0,
        outPoint: sceneDuration,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: primaryVideo?.has_embedded_audio ? 1 : 0,
        keyframes: [],
      });
    } else if (imageUrl) {
      // Fall back to image if no video
      const mediaId = uuidv4();
      mediaItems.push({
        id: mediaId,
        name: `Scene ${scene.scene_number} Image`,
        type: "image",
        fileHandle: null,
        blob: null,
        metadata: makeMediaMeta({ duration: sceneDuration }),
        thumbnailUrl: imageUrl,
        waveformData: null,
        originalUrl: imageUrl,
      });

      videoTrackClips.push({
        id: uuidv4(),
        mediaId,
        trackId: "track-video",
        startTime: currentTime,
        duration: sceneDuration,
        inPoint: 0,
        outPoint: sceneDuration,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: 0,
        keyframes: [],
      });
    }

    // Always add the primary scene image to media library for editing use.
    if (imageUrl) {
      mediaItems.push({
        id: uuidv4(),
        name: `Scene ${scene.scene_number} Image`,
        type: "image",
        fileHandle: null,
        blob: null,
        metadata: makeMediaMeta({ duration: sceneDuration }),
        thumbnailUrl: imageUrl,
        waveformData: null,
        originalUrl: imageUrl,
      });
    }

    // ── Additional images as media library items ──
    for (const img of images) {
      const imgUrl = await resolveMediaUrl(img.url ?? img.image_url ?? null);
      if (!imgUrl || imgUrl === imageUrl) continue; // skip primary, already added
      mediaItems.push({
        id: uuidv4(),
        name: `Scene ${scene.scene_number} – ${img.tag || "image"}`,
        type: "image",
        fileHandle: null,
        blob: null,
        metadata: makeMediaMeta(),
        thumbnailUrl: imgUrl,
        waveformData: null,
        originalUrl: imgUrl,
      });
    }

    // ── Additional videos as media library items ──
    for (const vid of videos) {
      if (vid === primaryVideo) continue;
      const vUrl = await resolveMediaUrl(vid.url ?? vid.video_url ?? null);
      if (!vUrl) continue;
      mediaItems.push({
        id: uuidv4(),
        name: `Scene ${scene.scene_number} – ${vid.tag || "alt"} video`,
        type: "video",
        fileHandle: null,
        blob: null,
        metadata: makeMediaMeta({ duration: (vid.duration_ms ?? 0) / 1000 }),
        thumbnailUrl: imageUrl,
        waveformData: null,
        originalUrl: vUrl,
      });
    }

    // ── Narration clip ──
    if (narrationUrl) {
      const narMediaId = uuidv4();
      const narDuration =
        narration?.duration_ms != null
          ? narration.duration_ms / 1000
          : sceneDuration;

      mediaItems.push({
        id: narMediaId,
        name: `Scene ${scene.scene_number} Narration`,
        type: "audio",
        fileHandle: null,
        blob: null,
        metadata: makeMediaMeta({ duration: narDuration }),
        thumbnailUrl: null,
        waveformData: null,
        originalUrl: narrationUrl,
      });

      const inPoint =
        narration?.start_ms != null ? narration.start_ms / 1000 : 0;
      const outPoint =
        narration?.end_ms != null
          ? narration.end_ms / 1000
          : inPoint + sceneDuration;

      narrationTrackClips.push({
        id: uuidv4(),
        mediaId: narMediaId,
        trackId: "track-narration",
        startTime: currentTime,
        duration: outPoint - inPoint,
        inPoint,
        outPoint,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: 1,
        keyframes: [],
      });
    }

    // ── Subtitles from word timestamps ──
    const wordTs =
      narration?.word_timestamps ??
      primaryVideo?.word_timestamps ??
      null;

    if (wordTs && wordTs.length > 0) {
      // Group words into subtitle segments to match Remotion-style phrase pacing.
      const WORDS_PER_CHUNK = 4;
      for (let i = 0; i < wordTs.length; i += WORDS_PER_CHUNK) {
        const chunk = wordTs
          .slice(i, i + WORDS_PER_CHUNK)
          .filter((w) => typeof w.word === "string" && w.word.trim().length > 0)
          .map((w) => ({
            text: w.word.trim().toUpperCase(),
            startTime: w.start + currentTime,
            endTime: w.end + currentTime,
          }));
        if (chunk.length === 0) continue;

        const text = chunk.map((w) => w.text).join(" ");
        const startSec = chunk[0].startTime;
        const endSec = chunk[chunk.length - 1].endTime;
        subtitles.push({
          id: uuidv4(),
          text,
          startTime: startSec,
          endTime: endSec,
          style: REMOTION_NARRATION_SUBTITLE_STYLE,
          animationStyle: "word-highlight",
          words: chunk,
        });
      }
    } else {
      const jsonSegments = scene.lyrics_json
        ? parseLyricsJsonSegments(scene.lyrics_json)
        : [];

      if (jsonSegments.length > 0) {
        for (let i = 0; i < jsonSegments.length; i += 1) {
          const segment = jsonSegments[i];
          const next = jsonSegments[i + 1];
          const fallbackEnd = next?.start ?? Math.min(sceneDuration, segment.start + 2.5);
          const end = segment.end ?? fallbackEnd;
          if (end <= segment.start) continue;

          subtitles.push({
            id: uuidv4(),
            text: segment.text.toUpperCase(),
            startTime: currentTime + segment.start,
            endTime: currentTime + end,
            style: REMOTION_LYRICS_SUBTITLE_STYLE,
            animationStyle: "word-highlight",
            words: buildEvenWordTimings(
              segment.text,
              currentTime + segment.start,
              currentTime + end,
            ),
          });
        }
      } else if (scene.lyrics_lrc) {
        const lrcSegments = parseLrcSegments(scene.lyrics_lrc);
        for (let i = 0; i < lrcSegments.length; i += 1) {
          const segment = lrcSegments[i];
          const next = lrcSegments[i + 1];
          const fallbackEnd = next?.start ?? Math.min(sceneDuration, segment.start + 2.5);
          if (fallbackEnd <= segment.start) continue;

          subtitles.push({
            id: uuidv4(),
            text: segment.text.toUpperCase(),
            startTime: currentTime + segment.start,
            endTime: currentTime + fallbackEnd,
            style: REMOTION_LYRICS_SUBTITLE_STYLE,
            animationStyle: "word-highlight",
            words: buildEvenWordTimings(
              segment.text,
              currentTime + segment.start,
              currentTime + fallbackEnd,
            ),
          });
        }
      }
    }

    currentTime += sceneDuration;
    totalMusicDuration = currentTime;
  }

  // ── Global music clip spanning entire timeline ──
  if (musicMediaId && totalMusicDuration > 0) {
    // Update music media duration
    const musicItem = mediaItems.find((m) => m.id === musicMediaId);
    if (musicItem) {
      (musicItem as { metadata: MediaMetadata }).metadata = makeMediaMeta({
        duration: totalMusicDuration,
      });
    }

    musicTrackClips.push({
      id: uuidv4(),
      mediaId: musicMediaId,
      trackId: "track-music",
      startTime: 0,
      duration: totalMusicDuration,
      inPoint: 0,
      outPoint: totalMusicDuration,
      effects: [],
      audioEffects: [],
      transform: makeDefaultTransform(),
      volume: 0.3, // Background music at 30%
      keyframes: [],
    });
  }

  // Build text clips from subtitle segments so captions are visible on the timeline.
  if (subtitles.length > 0) {
    for (const subtitle of subtitles) {
      const duration = Math.max(0.1, subtitle.endTime - subtitle.startTime);
      textClips.push({
        id: subtitle.id,
        trackId: "track-captions",
        startTime: subtitle.startTime,
        duration,
        text: subtitle.text,
        style: subtitleStyleToTextStyle(subtitle.style),
        transform: makeDefaultTransform(),
        keyframes: [],
      });
    }
  }

  // 5) Assemble tracks
  const tracks: Track[] = [
    {
      id: "track-video",
      type: "video",
      name: "Video",
      clips: videoTrackClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    },
    {
      id: "track-narration",
      type: "audio",
      name: "Narration",
      clips: narrationTrackClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    },
  ];

  if (textClips.length > 0) {
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
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
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
    textClips,
  };

  return project;
}
