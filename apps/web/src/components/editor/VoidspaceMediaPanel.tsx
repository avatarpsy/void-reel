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
import {
  waitForAuth,
  fetchSceneLists,
} from "../../services/voidspace-loader";
import { db } from "../../config/firebase-config";
import { collection, getDocs, query, orderBy } from "firebase/firestore";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import type { MediaItem, MediaMetadata } from "@openreel/core";

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

async function fetchAllUserAssets(
  userId: string,
): Promise<Record<AssetCategory, VoidspaceAsset[]>> {
  const result: Record<AssetCategory, VoidspaceAsset[]> = {
    videos: [],
    images: [],
    music: [],
    narrations: [],
  };
  const seenUrls = new Set<string>();

  const sceneLists = await fetchSceneLists(userId);

  for (const sl of sceneLists) {
    const slName = sl.name || sl.music_title || "Untitled";

    // Global music from the scene list itself
    if (sl.music_url && !seenUrls.has(sl.music_url)) {
      seenUrls.add(sl.music_url);
      result.music.push({
        id: `music-${sl.id}`,
        name: sl.music_title || `Music - ${slName}`,
        type: "audio",
        url: sl.music_url,
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
      sl.id,
      "scenes",
    );
    let scenes: Array<{ id: string; data: Record<string, unknown> }>;
    try {
      const q = query(scenesRef, orderBy("scene_number"));
      const snap = await getDocs(q);
      scenes = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    } catch {
      continue;
    }

    for (const scene of scenes) {
      const sceneNum = scene.id;
      const sd = scene.data;
      const sn = (sd.scene_number as number) || 0;

      // Scene-level narration URL
      const narrationUrl =
        (sd.narration_url as string) || "";
      if (narrationUrl && !seenUrls.has(narrationUrl)) {
        seenUrls.add(narrationUrl);
        result.narrations.push({
          id: `narr-${sl.id}-${sceneNum}`,
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
          id: `smusic-${sl.id}-${sceneNum}`,
          name:
            (sd.music_title as string) || `Scene Music S${sn} - ${slName}`,
          type: "audio",
          url: sceneMusicUrl,
          tag: "music",
          sceneListName: slName,
          sceneNumber: sn,
        });
      }

      // Sub-collections: videos
      try {
        const vSnap = await getDocs(
          collection(
            db,
            "users",
            userId,
            "scene_lists",
            sl.id,
            "scenes",
            sceneNum,
            "videos",
          ),
        );
        for (const vDoc of vSnap.docs) {
          const v = vDoc.data();
          const vUrl = (v.url as string) || (v.video_url as string) || "";
          if (vUrl && !seenUrls.has(vUrl)) {
            seenUrls.add(vUrl);
            result.videos.push({
              id: `vid-${vDoc.id}`,
              name: `Scene ${sn} Video - ${slName}`,
              type: "video",
              url: vUrl,
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

      // Sub-collections: images
      try {
        const iSnap = await getDocs(
          collection(
            db,
            "users",
            userId,
            "scene_lists",
            sl.id,
            "scenes",
            sceneNum,
            "images",
          ),
        );
        for (const iDoc of iSnap.docs) {
          const im = iDoc.data();
          const iUrl =
            (im.url as string) || (im.image_url as string) || "";
          if (iUrl && !seenUrls.has(iUrl)) {
            seenUrls.add(iUrl);
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

      // Sub-collections: narrations
      try {
        const nSnap = await getDocs(
          collection(
            db,
            "users",
            userId,
            "scene_lists",
            sl.id,
            "scenes",
            sceneNum,
            "narrations",
          ),
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

  return result;
}

// ─── Component ───────────────────────────────────────

interface AssetSectionProps {
  title: string;
  icon: React.ElementType;
  assets: VoidspaceAsset[];
  onAddToMedia: (asset: VoidspaceAsset) => void;
  onDragStart: (e: React.DragEvent, asset: VoidspaceAsset) => void;
  defaultOpen?: boolean;
}

function AssetSection({
  title,
  icon: Icon,
  assets,
  onAddToMedia,
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
              onClick={() => onAddToMedia(asset)}
              className="group relative bg-background-tertiary rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-all overflow-hidden"
              title={`${asset.name}\n${asset.sceneListName || ""}\nClick to add to media library`}
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
  const [assets, setAssets] = useState<Record<AssetCategory, VoidspaceAsset[]>>(
    {
      videos: [],
      images: [],
      music: [],
      narrations: [],
    },
  );
  const [userId, setUserId] = useState<string | null>(null);
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
        const data = await fetchAllUserAssets(uid);
        setAssets(data);
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
      const data = await fetchAllUserAssets(userId);
      setAssets(data);
    } catch {
      setError("Failed to refresh");
    } finally {
      setLoading(false);
    }
  }, [userId]);

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
          onAddToMedia={addToMediaLibrary}
          onDragStart={handleDragStart}
        />
        <AssetSection
          title="Images"
          icon={ImageIcon}
          assets={assets.images}
          onAddToMedia={addToMediaLibrary}
          onDragStart={handleDragStart}
        />
        <AssetSection
          title="Music"
          icon={Music}
          assets={assets.music}
          onAddToMedia={addToMediaLibrary}
          onDragStart={handleDragStart}
          defaultOpen={false}
        />
        <AssetSection
          title="Narrations"
          icon={Mic}
          assets={assets.narrations}
          onAddToMedia={addToMediaLibrary}
          onDragStart={handleDragStart}
          defaultOpen={false}
        />
      </div>
    </ScrollArea>
  );
}
