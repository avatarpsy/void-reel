/**
 * VoidspaceMediaPanel — Cloud media browser for Voidspace-generated content.
 * Shows all user's AI-generated videos, images, music, and narrations
 * from Firestore, ready to drag onto the timeline.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Cloud,
  Video,
  Image as ImageIcon,
  Music,
  Mic,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  GripVertical,
  RefreshCw,
} from "lucide-react";
import { ScrollArea } from "@openreel/ui";
import { v4 as uuidv4 } from "uuid";
import { MediaPreviewOverlay, type PreviewKind } from "./MediaPreviewOverlay";
import {
  waitForAuth,
  fetchSceneLists,
} from "../../services/voidspace-loader";
import { parseVoidspaceProjectId } from "../../services/voidspace-project-id";
import { db } from "../../config/firebase-config";
import {
  collection,
  getDocs,
  query,
  orderBy,
  where,
  limit,
  doc,
  getDoc,
} from "firebase/firestore";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import type { MediaItem, MediaMetadata } from "@openreel/core";
import type { Project } from "@openreel/core";

// ─── Types ───────────────────────────────────────────

interface VoidspaceAsset {
  id: string;
  name: string;
  type: "video" | "audio" | "image";
  url: string;
  thumbnailUrl?: string;
  duration?: number; // seconds
  width?: number;
  height?: number;
  sceneListName?: string;
  sceneNumber?: number;
  tag?: string; // e.g. "narration", "music", "ai-generated"
}

type AssetCategory = "videos" | "images" | "music" | "narrations";

interface AvatarContext {
  sceneListId: string | null;
  avatarId: string | null;
  avatarName: string | null;
}

interface PanelSceneList {
  id: string;
  name?: string;
  avatar_id?: string;
  avatar_name?: string;
  music_url?: string;
  music_title?: string;
  updated_at?: { seconds?: number };
  created_at?: { seconds?: number };
}

interface FetchAssetsResult {
  assets: Record<AssetCategory, VoidspaceAsset[]>;
  sceneListSignature: string;
}

interface CloudCacheEntry {
  assets: Record<AssetCategory, VoidspaceAsset[]>;
  avatarContext: AvatarContext;
  sceneListSignature: string;
  fetchedAt: number;
}

const CLOUD_PAGE_SIZE = 8;
const MAX_SCENES_PER_LIST = 25;
const QUERY_TIMEOUT_MS = 12000;

const cloudMediaCache = new Map<string, CloudCacheEntry>();

// ─── Helpers ─────────────────────────────────────────

function makeMediaMeta(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    duration: 0,
    width: 1080,
    height: 1920,
    frameRate: 30,
    codec: "",
    sampleRate: 44100,
    channels: 2,
    fileSize: 0,
    ...overrides,
  };
}

function assetToMediaItem(asset: VoidspaceAsset): MediaItem {
  return {
    id: uuidv4(),
    name: asset.name,
    type: asset.type,
    fileHandle: null,
    blob: null,
    metadata: makeMediaMeta({
      duration: asset.duration || (asset.type === "image" ? 5 : 0),
      width: asset.width || 1080,
      height: asset.height || 1920,
    }),
    thumbnailUrl: asset.thumbnailUrl || null,
    waveformData: null,
    originalUrl: asset.url,
  };
}

// ─── Fetcher: collect ALL assets across all scene lists ──

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[VoidspaceMediaPanel] Timeout: ${label}`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function getSceneListIdFromProject(project: Project | null): string | null {
  if (!project?.id) return null;
  const parsed = parseVoidspaceProjectId(project.id);
  return parsed?.sceneListId ?? null;
}

function getCacheKey(userId: string, avatarContext: AvatarContext): string {
  return `${userId}::${avatarContext.avatarId || "all"}`;
}

function getSceneListTimestamp(sl: PanelSceneList): number {
  return (
    sl.updated_at?.seconds ||
    sl.created_at?.seconds ||
    0
  );
}

function buildSceneListSignature(sceneLists: PanelSceneList[]): string {
  return sceneLists
    .map((sl) => `${sl.id}:${getSceneListTimestamp(sl)}:${sl.music_url || ""}`)
    .join("|");
}

async function resolveAvatarContext(
  userId: string,
  project: Project | null,
): Promise<AvatarContext> {
  const sceneListId = getSceneListIdFromProject(project);
  if (!sceneListId) {
    return { sceneListId: null, avatarId: null, avatarName: null };
  }

  try {
    const slRef = doc(db, "users", userId, "scene_lists", sceneListId);
    const slSnap = await withTimeout(getDoc(slRef), QUERY_TIMEOUT_MS, "sceneList metadata");
    if (!slSnap.exists()) {
      return { sceneListId, avatarId: null, avatarName: null };
    }
    const data = slSnap.data() as Record<string, unknown>;
    return {
      sceneListId,
      avatarId: (data.avatar_id as string) || null,
      avatarName: (data.avatar_name as string) || null,
    };
  } catch (err) {
    console.warn("[VoidspaceMediaPanel] Could not resolve avatar context", err);
    return { sceneListId, avatarId: null, avatarName: null };
  }
}

async function fetchAvatarSceneLists(
  userId: string,
  avatarId: string | null,
  pageSize: number,
): Promise<PanelSceneList[]> {
  const sceneListsRef = collection(db, "users", userId, "scene_lists");

  // Fast path: indexed query by avatar_id
  if (avatarId) {
    try {
      const q = query(
        sceneListsRef,
        where("avatar_id", "==", avatarId),
        orderBy("updated_at", "desc"),
        limit(pageSize),
      );
      const snap = await withTimeout(getDocs(q), QUERY_TIMEOUT_MS, "avatar scene lists query");
      return snap.docs.map((d) => {
        const data = d.data() as PanelSceneList;
        const { id: _unusedId, ...rest } = data;
        return { id: d.id, ...rest };
      });
    } catch (err) {
      console.warn("[VoidspaceMediaPanel] avatar_id query failed, using fallback", err);
    }
  }

  // Fallback path: latest scene lists, client filter
  const allSceneLists = await fetchSceneLists(userId);
  const filtered = avatarId
    ? allSceneLists.filter((sl) => sl.avatar_id === avatarId)
    : allSceneLists;
  return filtered.slice(0, pageSize).map((sl) => ({
    id: sl.id,
    name: sl.name,
    avatar_id: sl.avatar_id,
    avatar_name: sl.avatar_name,
    music_url: sl.music_url,
    music_title: sl.music_title,
    updated_at: sl.updated_at,
    created_at: sl.created_at,
  }));
}

async function fetchLightweightSceneListSignature(
  userId: string,
  avatarContext: AvatarContext,
  pageSize = CLOUD_PAGE_SIZE,
): Promise<string> {
  const sceneLists = await fetchAvatarSceneLists(
    userId,
    avatarContext.avatarId,
    pageSize,
  );
  return buildSceneListSignature(sceneLists);
}

async function fetchAllUserAssets(
  userId: string,
  avatarContext: AvatarContext,
  pageSize = CLOUD_PAGE_SIZE,
): Promise<FetchAssetsResult> {
  const result: Record<AssetCategory, VoidspaceAsset[]> = {
    videos: [],
    images: [],
    music: [],
    narrations: [],
  };
  const seenUrls = new Set<string>();
  const sceneLists = await fetchAvatarSceneLists(
    userId,
    avatarContext.avatarId,
    pageSize,
  );
  const sceneListSignature = buildSceneListSignature(sceneLists);

  for (const sl of sceneLists) {
    const slName = sl.name || sl.music_title || "Untitled";
    const slId = String(sl.id || "");
    if (!slId) continue;

    // Global music from the scene list itself
    const sceneListMusicUrl = sl.music_url || "";
    if (sceneListMusicUrl && !seenUrls.has(sceneListMusicUrl)) {
      seenUrls.add(sceneListMusicUrl);
      result.music.push({
        id: `music-${slId}`,
        name: sl.music_title || `Music - ${slName}`,
        type: "audio",
        url: sceneListMusicUrl,
        tag: "music",
        sceneListName: slName,
      });
    }

    // Fetch scenes
    const scenesRef = collection(
      db,
      "users",
      userId,
      "scene_lists",
      slId,
      "scenes",
    );
    let scenes: Array<{ id: string; data: Record<string, unknown> }>;
    try {
      const q = query(scenesRef, orderBy("scene_number"));
      const snap = await withTimeout(getDocs(q), QUERY_TIMEOUT_MS, `scenes query ${slId}`);
      scenes = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    } catch (err) {
      console.warn(`[VoidspaceMediaPanel] Failed to load scenes for ${slId}`, err);
      continue;
    }

    const scenesToScan = scenes.slice(0, MAX_SCENES_PER_LIST);
    for (const scene of scenesToScan) {
      const sceneNum = scene.id;
      const sd = scene.data;
      const sn = (sd.scene_number as number) || 0;
      let scenePrimaryImageUrl =
        (sd.first_frame_url as string) ||
        (sd.preview_image_url as string) ||
        (sd.image_url as string) ||
        "";

      // Scene-level narration URL
      const narrationUrl =
        (sd.narration_url as string) || "";
      if (narrationUrl && !seenUrls.has(narrationUrl)) {
        seenUrls.add(narrationUrl);
        result.narrations.push({
          id: `narr-${slId}-${sceneNum}`,
          name: `Narration S${sn} - ${slName}`,
          type: "audio",
          url: narrationUrl,
          duration: ((sd.narration_duration_ms as number) || 0) / 1000,
          tag: "narration",
          sceneListName: slName,
          sceneNumber: sn,
        });
      }

      // Scene-level music URL
      const sceneMusicUrl = (sd.music_url as string) || "";
      if (sceneMusicUrl && !seenUrls.has(sceneMusicUrl)) {
        seenUrls.add(sceneMusicUrl);
        result.music.push({
          id: `smusic-${slId}-${sceneNum}`,
          name:
            (sd.music_title as string) || `Scene Music S${sn} - ${slName}`,
          type: "audio",
          url: sceneMusicUrl,
          tag: "music",
          sceneListName: slName,
          sceneNumber: sn,
        });
      }

      // Sub-collections: images
      try {
        const iSnap = await withTimeout(
          getDocs(
          collection(
            db,
            "users",
            userId,
            "scene_lists",
            slId,
            "scenes",
            sceneNum,
            "images",
          ),
          ),
          QUERY_TIMEOUT_MS,
          `images query ${slId}/${sceneNum}`,
        );
        for (const iDoc of iSnap.docs) {
          const im = iDoc.data();
          const iUrl =
            (im.url as string) || (im.image_url as string) || "";
          if (iUrl && !seenUrls.has(iUrl)) {
            seenUrls.add(iUrl);
            if (!scenePrimaryImageUrl) {
              scenePrimaryImageUrl = iUrl;
            }
            result.images.push({
              id: `img-${iDoc.id}`,
              name: `Scene ${sn} Image - ${slName}`,
              type: "image",
              url: iUrl,
              thumbnailUrl: iUrl, // images are their own thumbnails
              tag: (im.tag as string) || "ai-generated",
              sceneListName: slName,
              sceneNumber: sn,
            });
          }
        }
      } catch {
        /* no images sub-collection */
      }

      // Sub-collections: videos
      try {
        const vSnap = await withTimeout(
          getDocs(
            collection(
              db,
              "users",
              userId,
              "scene_lists",
              slId,
              "scenes",
              sceneNum,
              "videos",
            ),
          ),
          QUERY_TIMEOUT_MS,
          `videos query ${slId}/${sceneNum}`,
        );
        for (const vDoc of vSnap.docs) {
          const v = vDoc.data();
          const vUrl = (v.url as string) || (v.video_url as string) || "";
          const vThumb =
            (v.thumbnail_url as string) ||
            (v.thumbnailUrl as string) ||
            (v.poster_url as string) ||
            (v.posterUrl as string) ||
            scenePrimaryImageUrl ||
            undefined;
          if (vUrl && !seenUrls.has(vUrl)) {
            seenUrls.add(vUrl);
            result.videos.push({
              id: `vid-${vDoc.id}`,
              name: `Scene ${sn} Video - ${slName}`,
              type: "video",
              url: vUrl,
              thumbnailUrl: vThumb,
              duration: ((v.duration_ms as number) || 0) / 1000,
              tag: (v.tag as string) || "ai-generated",
              sceneListName: slName,
              sceneNumber: sn,
            });
          }
        }
      } catch {
        /* no videos sub-collection */
      }

      // Sub-collections: narrations
      try {
        const nSnap = await withTimeout(
          getDocs(
          collection(
            db,
            "users",
            userId,
            "scene_lists",
            slId,
            "scenes",
            sceneNum,
            "narrations",
          ),
          ),
          QUERY_TIMEOUT_MS,
          `narrations query ${slId}/${sceneNum}`,
        );
        for (const nDoc of nSnap.docs) {
          const n = nDoc.data();
          const nUrl =
            (n.narration_url as string) || (n.url as string) || "";
          if (nUrl && !seenUrls.has(nUrl)) {
            seenUrls.add(nUrl);
            result.narrations.push({
              id: `narr-${nDoc.id}`,
              name: `Narration S${sn} - ${slName}`,
              type: "audio",
              url: nUrl,
              duration: ((n.duration_ms as number) || 0) / 1000,
              tag: "narration",
              sceneListName: slName,
              sceneNumber: sn,
            });
          }
        }
      } catch {
        /* no narrations sub-collection */
      }
    }
  }

  // Include published videos/images for this avatar (or latest if no avatar context)
  try {
    const pubRef = collection(db, "users", userId, "published_posts");
    const pubQ = query(pubRef, orderBy("created_at", "desc"), limit(30));
    const pubSnap = await withTimeout(getDocs(pubQ), QUERY_TIMEOUT_MS, "published_posts query");
    for (const p of pubSnap.docs) {
      const data = p.data() as Record<string, unknown>;
      const postAvatarId = (data.avatar_id as string) || null;
      if (avatarContext.avatarId && postAvatarId && postAvatarId !== avatarContext.avatarId) {
        continue;
      }

      const postName = (data.title as string) || (data.caption as string) || "Published post";
      const vUrl = (data.video_url as string) || "";
      const thumb = (data.thumbnail_url as string) || (data.image_url as string) || undefined;
      if (vUrl && !seenUrls.has(vUrl)) {
        seenUrls.add(vUrl);
        result.videos.push({
          id: `pubv-${p.id}`,
          name: postName,
          type: "video",
          url: vUrl,
          thumbnailUrl: thumb,
          tag: "published",
          sceneListName: avatarContext.avatarName || "Published",
        });
      }

      const imgUrl = (data.image_url as string) || "";
      if (imgUrl && !seenUrls.has(imgUrl)) {
        seenUrls.add(imgUrl);
        result.images.push({
          id: `pubi-${p.id}`,
          name: `${postName} Image`,
          type: "image",
          url: imgUrl,
          thumbnailUrl: imgUrl,
          tag: "published",
          sceneListName: avatarContext.avatarName || "Published",
        });
      }
    }
  } catch (err) {
    console.warn("[VoidspaceMediaPanel] published_posts query skipped", err);
  }

  return {
    assets: result,
    sceneListSignature,
  };
}

// ─── Component ───────────────────────────────────────

interface AssetSectionProps {
  title: string;
  icon: React.ElementType;
  assets: VoidspaceAsset[];
  onPreview: (asset: VoidspaceAsset) => void;
  onDragStart: (e: React.DragEvent, asset: VoidspaceAsset) => void;
  defaultOpen?: boolean;
}

function AssetSection({
  title,
  icon: Icon,
  assets,
  onPreview,
  onDragStart,
  defaultOpen = true,
}: AssetSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  if (assets.length === 0) return null;

  return (
    <div className="mb-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 w-full text-left text-xs font-medium text-text-secondary hover:text-text-primary transition-colors mb-2"
      >
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={13} />
        <span>
          {title} ({assets.length})
        </span>
      </button>
      {isOpen && (
        <div className="grid grid-cols-2 gap-2">
          {assets.map((asset) => (
            <div
              key={asset.id}
              draggable
              onDragStart={(e) => onDragStart(e, asset)}
              onClick={() => onPreview(asset)}
              className="group relative bg-background-tertiary rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-all overflow-hidden"
              title={`${asset.name}\n${asset.sceneListName || ""}\nClick to preview · drag onto the timeline to use`}
            >
              {/* Thumbnail / icon */}
              <div className="aspect-video flex items-center justify-center bg-background-secondary relative">
                {asset.thumbnailUrl ? (
                  <img
                    src={asset.thumbnailUrl}
                    alt={asset.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <Icon
                    size={20}
                    className="text-text-muted group-hover:text-primary transition-colors"
                  />
                )}
                {/* Duration badge */}
                {asset.duration && asset.duration > 0 ? (
                  <span className="absolute bottom-1 right-1 text-[9px] bg-black/70 text-white px-1 rounded">
                    {Math.floor(asset.duration / 60)}:
                    {String(Math.floor(asset.duration % 60)).padStart(2, "0")}
                  </span>
                ) : null}
                {/* Drag handle */}
                <div className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <GripVertical
                    size={12}
                    className="text-white drop-shadow"
                  />
                </div>
              </div>
              {/* Label */}
              <div className="px-1.5 py-1">
                <p className="text-[10px] text-text-secondary leading-tight truncate">
                  {asset.name}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────

export function VoidspaceMediaPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Clicking a tile previews it fullscreen (never auto-adds); drag adds to timeline.
  const [previewAsset, setPreviewAsset] = useState<VoidspaceAsset | null>(null);
  const [assets, setAssets] = useState<Record<AssetCategory, VoidspaceAsset[]>>(
    {
      videos: [],
      images: [],
      music: [],
      narrations: [],
    },
  );
  const [userId, setUserId] = useState<string | null>(null);
  const [avatarContext, setAvatarContext] = useState<AvatarContext>({
    sceneListId: null,
    avatarId: null,
    avatarName: null,
  });
  const hasLoaded = useRef(false);

  const project = useProjectStore((s) => s.project);
  const { startDrag } = useUIStore();

  // Auth + fetch on mount
  useEffect(() => {
    if (hasLoaded.current) return;
    hasLoaded.current = true;

    (async () => {
      try {
        const uid = await waitForAuth(10000);
        if (!uid) {
          setError("Sign in to access your Voidspace media");
          setLoading(false);
          return;
        }
        setUserId(uid);
        const context = await resolveAvatarContext(
          uid,
          useProjectStore.getState().project,
        );
        setAvatarContext(context);

        const cacheKey = getCacheKey(uid, context);
        const cached = cloudMediaCache.get(cacheKey);
        if (cached) {
          setAssets(cached.assets);
          return;
        }

        const fetched = await fetchAllUserAssets(uid, context);
        setAssets(fetched.assets);
        cloudMediaCache.set(cacheKey, {
          assets: fetched.assets,
          avatarContext: context,
          sceneListSignature: fetched.sceneListSignature,
          fetchedAt: Date.now(),
        });
      } catch (err) {
        console.error("[VoidspaceMediaPanel] Fetch error:", err);
        setError("Failed to load Voidspace media");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const context = avatarContext.avatarId
        ? avatarContext
        : await resolveAvatarContext(userId, useProjectStore.getState().project);
      if (!avatarContext.avatarId && context.avatarId) {
        setAvatarContext(context);
      }
      const cacheKey = getCacheKey(userId, context);
      const cached = cloudMediaCache.get(cacheKey);

      // Smart refresh: lightweight signature check first.
      const latestSignature = await fetchLightweightSceneListSignature(userId, context);
      if (cached && cached.sceneListSignature === latestSignature) {
        setAssets(cached.assets);
        cloudMediaCache.set(cacheKey, {
          ...cached,
          fetchedAt: Date.now(),
        });
        return;
      }

      const fetched = await fetchAllUserAssets(userId, context);
      setAssets(fetched.assets);
      cloudMediaCache.set(cacheKey, {
        assets: fetched.assets,
        avatarContext: context,
        sceneListSignature: fetched.sceneListSignature,
        fetchedAt: Date.now(),
      });
    } catch {
      setError("Failed to refresh");
    } finally {
      setLoading(false);
    }
  }, [userId, avatarContext]);

  // Add asset to the project's media library
  const addToMediaLibrary = useCallback(
    (asset: VoidspaceAsset) => {
      if (!project) return;

      // Check if already added (by URL)
      const exists = project.mediaLibrary.items.some(
        (item) => item.originalUrl === asset.url,
      );
      if (exists) return;

      const mediaItem = assetToMediaItem(asset);
      const updatedProject = {
        ...project,
        mediaLibrary: {
          ...project.mediaLibrary,
          items: [...project.mediaLibrary.items, mediaItem],
        },
        modifiedAt: Date.now(),
      };
      useProjectStore.setState({ project: updatedProject });
    },
    [project],
  );

  // Drag start — add to media library AND start the drag
  const handleDragStart = useCallback(
    (e: React.DragEvent, asset: VoidspaceAsset) => {
      // Ensure it's in the media library first
      addToMediaLibrary(asset);

      // Find the media item (either existing or just added)
      const currentProject = useProjectStore.getState().project;
      const item = currentProject.mediaLibrary.items.find(
        (m) => m.originalUrl === asset.url,
      );
      if (!item) return;

      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({ mediaId: item.id }),
      );
      startDrag("media", { mediaId: item.id, mediaType: item.type });
    },
    [addToMediaLibrary, startDrag],
  );

  const totalCount =
    assets.videos.length +
    assets.images.length +
    assets.music.length +
    assets.narrations.length;

  // ─── Loading state ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <Loader2 size={20} className="text-primary animate-spin" />
        <p className="text-xs text-text-muted">Loading Voidspace media...</p>
      </div>
    );
  }

  // ─── Error state ──
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 px-5">
        <AlertCircle size={20} className="text-destructive" />
        <p className="text-xs text-text-muted text-center">{error}</p>
        <button
          onClick={handleRefresh}
          className="text-xs text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  // ─── Empty state ──
  if (totalCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 px-5">
        <Cloud size={24} className="text-text-muted" />
        <p className="text-xs text-text-muted text-center">
          No media found. Create content in the Voidspace app to see it here.
        </p>
        <button
          onClick={handleRefresh}
          className="text-xs text-primary hover:underline flex items-center gap-1"
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
    );
  }

  // ─── Populated state ──
  return (
    <>
    <ScrollArea className="flex-1">
      <div className="px-5 pb-5">
        {/* Header with count + refresh */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] text-text-muted">
            {totalCount} assets from Voidspace
          </p>
          <button
            onClick={handleRefresh}
            className="text-text-muted hover:text-primary transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>

        <AssetSection
          title="Videos"
          icon={Video}
          assets={assets.videos}
          onPreview={setPreviewAsset}
          onDragStart={handleDragStart}
        />
        <AssetSection
          title="Images"
          icon={ImageIcon}
          assets={assets.images}
          onPreview={setPreviewAsset}
          onDragStart={handleDragStart}
        />
        <AssetSection
          title="Music"
          icon={Music}
          assets={assets.music}
          onPreview={setPreviewAsset}
          onDragStart={handleDragStart}
          defaultOpen={false}
        />
        <AssetSection
          title="Narrations"
          icon={Mic}
          assets={assets.narrations}
          onPreview={setPreviewAsset}
          onDragStart={handleDragStart}
          defaultOpen={false}
        />
      </div>
    </ScrollArea>
    {previewAsset && (
      <MediaPreviewOverlay
        url={previewAsset.url}
        kind={previewAsset.type as PreviewKind}
        name={previewAsset.name}
        onClose={() => setPreviewAsset(null)}
      />
    )}
    </>
  );
}
