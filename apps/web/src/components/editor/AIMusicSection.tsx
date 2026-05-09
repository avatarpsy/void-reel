/**
 * AIMusicSection — content for the AssetsPanel "AI Music" tab. Lists the
 * user's AI-generated tracks from `users/{uid}/music/{date}/songs[]` with
 * cover art, paginated by date-bucket docs (newest day first).
 *
 * Each tile is click-to-add and drag-to-timeline; the underlying MediaItem
 * mirrors VoidspaceMediaPanel's pattern — `originalUrl` carries the remote
 * audio URL so the renderer hydrates lazily.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Music, Plus, RefreshCw } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { QueryDocumentSnapshot } from "firebase/firestore";
import type { MediaItem, MediaMetadata } from "@openreel/core";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { waitForAuth } from "../../services/voidspace-loader";
import {
  fetchUserMusicPage,
  USER_MUSIC_DATE_PAGE_SIZE,
  type UserMusicTrack,
} from "../../services/user-music-loader";

function makeMediaMeta(durationMs: number): MediaMetadata {
  return {
    duration: durationMs > 0 ? durationMs / 1000 : 0,
    width: 0,
    height: 0,
    frameRate: 0,
    codec: "",
    sampleRate: 44100,
    channels: 2,
    fileSize: 0,
  };
}

function trackToMediaItem(track: UserMusicTrack): MediaItem {
  return {
    id: uuidv4(),
    name: track.title,
    type: "audio",
    fileHandle: null,
    blob: null,
    metadata: makeMediaMeta(track.durationMs),
    thumbnailUrl: track.imageUrl,
    waveformData: null,
    originalUrl: track.musicUrl,
    category: "AI Music",
  };
}

/**
 * Add the track to the project's media library if it isn't already
 * there (matched by remote URL), and return the MediaItem either way.
 */
function ensureInLibrary(track: UserMusicTrack): MediaItem | null {
  const { project } = useProjectStore.getState();
  if (!project) return null;
  const existing = project.mediaLibrary.items.find(
    (m) => m.originalUrl === track.musicUrl,
  );
  if (existing) return existing;

  const item = trackToMediaItem(track);
  useProjectStore.setState({
    project: {
      ...project,
      mediaLibrary: {
        ...project.mediaLibrary,
        items: [...project.mediaLibrary.items, item],
      },
      modifiedAt: Date.now(),
    },
  });
  return item;
}

interface AIMusicTileProps {
  track: UserMusicTrack;
  onAdd: (track: UserMusicTrack) => void;
  onDragStart: (e: React.DragEvent, track: UserMusicTrack) => void;
}

function AIMusicTile({ track, onAdd, onDragStart }: AIMusicTileProps) {
  const isGenerating = track.status === "generating";
  const disabled = isGenerating || !track.musicUrl;

  return (
    <div
      draggable={!disabled}
      onDragStart={(e) => !disabled && onDragStart(e, track)}
      onClick={() => !disabled && onAdd(track)}
      onDoubleClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        onAdd(track);
      }}
      title={disabled ? `${track.title} (generating…)` : `${track.title}\nClick to add`}
      className={`group flex flex-col rounded-lg border-2 border-border hover:border-text-secondary transition-all overflow-hidden bg-background-tertiary shadow-sm ${
        disabled ? "opacity-60 cursor-wait" : "cursor-pointer"
      }`}
    >
      <div className="aspect-square relative bg-background-elevated">
        {track.imageUrl ? (
          <img
            src={track.imageUrl}
            alt={track.title}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Music size={20} className="text-primary/50" />
          </div>
        )}
        {isGenerating && (
          <div className="absolute inset-0 flex items-center justify-center bg-purple-500/20">
            <Loader2 size={20} className="text-purple-300 animate-spin" />
          </div>
        )}
        {!disabled && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="p-1.5 bg-primary/30 rounded-full backdrop-blur-sm">
              <Plus size={14} className="text-primary" />
            </div>
          </div>
        )}
        {track.durationMs > 0 && (
          <div className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/70 rounded text-[9px] text-white font-mono">
            {`${Math.floor(track.durationMs / 60000)}:${String(
              Math.floor((track.durationMs % 60000) / 1000),
            ).padStart(2, "0")}`}
          </div>
        )}
      </div>
      <div className="px-1.5 py-1">
        <div className="text-[10px] font-medium text-text-primary truncate" title={track.title}>
          {track.title}
        </div>
        {track.artist && (
          <div className="text-[9px] text-text-muted truncate" title={track.artist}>
            {track.artist}
          </div>
        )}
      </div>
    </div>
  );
}

export function AIMusicSection() {
  const [tracks, setTracks] = useState<UserMusicTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const userIdRef = useRef<string | null>(null);
  const cursorRef = useRef<QueryDocumentSnapshot | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const hasInitialized = useRef(false);

  const { startDrag } = useUIStore();

  const loadPage = useCallback(async () => {
    if (loading || done) return;
    setLoading(true);
    setError(null);
    try {
      let uid = userIdRef.current;
      if (!uid) {
        uid = await waitForAuth(8000);
        if (!uid) {
          setError("Sign in to access your music");
          setLoading(false);
          return;
        }
        userIdRef.current = uid;
      }

      const page = await fetchUserMusicPage(uid, {
        pageSize: USER_MUSIC_DATE_PAGE_SIZE,
        startAfterDoc: cursorRef.current,
      });

      cursorRef.current = page.lastDoc;
      if (page.done || !page.lastDoc) setDone(true);

      const fresh: UserMusicTrack[] = [];
      for (const t of page.tracks) {
        if (seenIdsRef.current.has(t.id)) continue;
        seenIdsRef.current.add(t.id);
        fresh.push(t);
      }
      if (fresh.length > 0) {
        setTracks((prev) => [...prev, ...fresh]);
      }
    } catch (err) {
      console.error("[AIMusicSection] Failed to load music:", err);
      setError("Failed to load music");
    } finally {
      setLoading(false);
    }
  }, [loading, done]);

  // Auto-load first page when the tab mounts
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    void loadPage();
  }, [loadPage]);

  const handleRefresh = useCallback(() => {
    cursorRef.current = null;
    seenIdsRef.current.clear();
    setTracks([]);
    setDone(false);
    setError(null);
    hasInitialized.current = true; // already mounted
    void loadPage();
  }, [loadPage]);

  const handleAdd = useCallback(async (track: UserMusicTrack) => {
    const item = ensureInLibrary(track);
    if (!item) return;
    const { addClipToNewTrack } = useProjectStore.getState();
    await addClipToNewTrack(item.id);
  }, []);

  const handleDragStart = useCallback(
    (e: React.DragEvent, track: UserMusicTrack) => {
      const item = ensureInLibrary(track);
      if (!item) return;
      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({ mediaId: item.id }),
      );
      e.dataTransfer.effectAllowed = "copy";
      startDrag("media", { mediaId: item.id, mediaType: item.type });
    },
    [startDrag],
  );

  const isInitialLoad = loading && tracks.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Header: count + refresh */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-text-muted">
          {tracks.length === 0
            ? "Your AI music"
            : `${tracks.length}${!done ? "+" : ""} track${tracks.length === 1 ? "" : "s"}`}
        </span>
        <button
          onClick={handleRefresh}
          disabled={loading}
          title="Refresh"
          className="text-text-muted hover:text-text-primary transition-colors p-1 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-400">
          {error}
          <button
            onClick={handleRefresh}
            className="ml-2 underline hover:text-red-300"
          >
            Retry
          </button>
        </div>
      )}

      {isInitialLoad && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 size={20} className="text-primary animate-spin" />
          <p className="text-xs text-text-muted">Loading your music…</p>
        </div>
      )}

      {!isInitialLoad && tracks.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-12 gap-2 px-4 text-center">
          <Music size={24} className="text-text-muted" />
          <p className="text-xs text-text-muted">
            No music found. Generate tracks in the Voidspace app to see them here.
          </p>
        </div>
      )}

      {tracks.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {tracks.map((track) => (
            <AIMusicTile
              key={track.id}
              track={track}
              onAdd={handleAdd}
              onDragStart={handleDragStart}
            />
          ))}
        </div>
      )}

      {!done && tracks.length > 0 && (
        <button
          onClick={() => void loadPage()}
          disabled={loading}
          className="w-full py-2 rounded-lg border border-dashed border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-[11px] text-text-muted hover:text-text-primary disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Loading…
            </>
          ) : (
            "Load more"
          )}
        </button>
      )}
    </div>
  );
}

export default AIMusicSection;
