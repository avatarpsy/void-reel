import React, { useCallback, useMemo, useState } from "react";
import {
  Search,
  Maximize2,
  X,
  Image as ImageIcon,
  Film,
  Music,
  Plus,
  Upload,
  Trash2,
  Square,
  Circle,
  Triangle,
  Star,
  ArrowRight,
  Hexagon,
  FileCode,
  AlertTriangle,
  RefreshCw,
  Palette,
  LayoutGrid,
  Grid2x2,
  List,
  Link2,
} from "lucide-react";
import {
  BACKGROUND_PRESETS,
  generateBackgroundBlob,
  type BackgroundPreset,
} from "../../services/background-generator";
import type { ShapeType } from "@openreel/core";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import type { MediaItem } from "@openreel/core";
import { AspectRatioMatchDialog } from "./dialogs/AspectRatioMatchDialog";
import { LibraryPanel } from "./LibraryPanel";
// Voidspace fork: keep Voidspace media panel + add upstream's AI generation tab + Kie.ai dialog.
import { VoidspaceMediaPanel } from "./VoidspaceMediaPanel";
import { MediaPreviewOverlay, type PreviewKind } from "./MediaPreviewOverlay";
import { AIGenTab } from "./AIGenTab";
import { AIMusicSection } from "./AIMusicSection";
import { toast } from "../../stores/notification-store";
import { saveFileHandle, saveDirectoryHandle } from "../../services/media-storage";
import { collectFolder, buildRelinkPlan, type RelinkableItem } from "../../services/media-relink";
import {
  IconButton,
  Input,
  ScrollArea,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@openreel/ui";
import { useKieAIStore } from "../../stores/kieai-store";

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}`;
};

/**
 * Capture a poster frame from a video Blob — the SAME source the timeline
 * plays. Scene-video thumbnails point at the model's first-frame URL
 * (Seedance `tempfile.aiquickdraw.com` / GCS `storage.googleapis.com`), which
 * a plain <img> can't load once the temp link expires or when the host omits
 * CORS — so the tile fell back to a placeholder even though the video itself
 * decodes fine. Drawing a frame straight off the blob gives a reliable
 * thumbnail from the correct source. Returns a JPEG data URL, or null if the
 * video can't be decoded in time. Best-effort: all failure paths resolve null
 * so the caller just keeps the placeholder.
 */
function posterFromVideoBlob(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    let url: string | null = null;
    let settled = false;
    const video = document.createElement("video");
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute("src");
      try { video.load(); } catch { /* noop */ }
      if (url) URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 6000);
    try {
      url = URL.createObjectURL(blob);
    } catch {
      finish(null);
      return;
    }
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.onloadeddata = () => {
      const dur = video.duration && isFinite(video.duration) ? video.duration : 1;
      // Seek a touch past 0 so we don't grab a black leading frame.
      try { video.currentTime = Math.min(0.1, dur / 2); } catch { finish(null); }
    };
    video.onseeked = () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) { finish(null); return; }
      const scale = Math.min(1, 320 / w);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) { finish(null); return; }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        finish(null); // tainted canvas / draw failure
      }
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

/**
 * Media Item Thumbnail Component
 * Shows thumbnail with metadata below (not overlaid)
 */
type MediaViewMode = "large" | "small" | "list";

const MediaThumbnail: React.FC<{
  item: MediaItem;
  isSelected: boolean;
  viewMode: MediaViewMode;
  onSelect: () => void;
  onPreview: () => void;
  onDelete: () => void;
  onReplace: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onAddToTimeline: () => void;
  onRetryKieAI?: () => void;
  onRelinkItem: () => void;
  onRelinkAll?: () => void;
}> = ({
  item,
  isSelected,
  viewMode,
  onSelect,
  onPreview,
  onDelete,
  onReplace,
  onDragStart,
  onAddToTimeline,
  onRetryKieAI,
  onRelinkItem,
  onRelinkAll,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  // Thumbnail load failure → fall back to the placeholder icon instead of the
  // browser's broken-image glyph. Scene-video thumbnails point at the scene's
  // first-frame URL, which can be an expired temp URL or a CORS-blocked host
  // for a plain <img> (the blob path is proxied, the <img> is not). Reset when
  // the URL changes so a later-healed/mirrored URL gets another chance.
  const [thumbFailed, setThumbFailed] = useState(false);
  React.useEffect(() => { setThumbFailed(false); }, [item.thumbnailUrl]);

  // Poster frame drawn from the video blob — the SAME source that plays in the
  // timeline. We prefer a reliable LOCAL thumbnail (blob:/data: URL, already
  // drawn from real media) when present; otherwise, for a video that carries a
  // blob, we draw the poster off that blob rather than trust the remote
  // first-frame URL (Seedance temp links expire and GCS blocks <img> CORS, so
  // those tiles showed a placeholder even though the clip decodes fine — the
  // "thumbnail missing" bug). Non-videos / blob-less items keep the old
  // remote-URL-then-placeholder behaviour.
  const localThumb =
    item.thumbnailUrl && /^(blob:|data:)/.test(item.thumbnailUrl)
      ? item.thumbnailUrl
      : null;
  const canBlobPoster = item.type === "video" && !!item.blob;
  const [blobPoster, setBlobPoster] = useState<string | null>(null);
  // Reset the generated poster when the item or its blob identity changes.
  React.useEffect(() => { setBlobPoster(null); }, [item.id, item.blob]);
  // We need a blob poster when we CAN make one and have nothing reliable to
  // show — either no local thumbnail, or the one we tried errored.
  const needBlobPoster = canBlobPoster && (!localThumb || thumbFailed);
  React.useEffect(() => {
    if (!needBlobPoster || blobPoster) return;
    let cancelled = false;
    void posterFromVideoBlob(item.blob as Blob).then((u) => {
      if (!cancelled && u) setBlobPoster(u);
    });
    return () => { cancelled = true; };
  }, [needBlobPoster, blobPoster, item.blob]);

  // Final source priority: unfailed local thumbnail → blob poster → unfailed
  // remote thumbnail (only when we can't poster from a blob) → placeholder. A
  // video with a blob never shows the flaky remote URL; it uses the poster
  // drawn from the clip itself.
  const remoteThumb = item.thumbnailUrl && !localThumb ? item.thumbnailUrl : null;
  let effectiveThumb: string | null = null;
  if (localThumb && !thumbFailed) effectiveThumb = localThumb;
  else if (blobPoster) effectiveThumb = blobPoster;
  else if (!canBlobPoster && remoteThumb && !thumbFailed) effectiveThumb = remoteThumb;
  const showThumb = !!effectiveThumb;

  // Stable waveform heights derived from item.id. Math.random() in JSX
  // re-rolled every render, producing visible jitter during playback.
  const waveformHeights = useMemo(() => {
    let seed = 0;
    for (let i = 0; i < item.id.length; i++) {
      seed = (seed * 31 + item.id.charCodeAt(i)) >>> 0;
    }
    return Array.from({ length: 10 }, () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return 20 + ((seed >>> 16) % 80);
    });
  }, [item.id]);

  const getIcon = () => {
    switch (item.type) {
      case "video":
        return Film;
      case "audio":
        return Music;
      case "image":
        return ImageIcon;
      default:
        return Film;
    }
  };

  const Icon = getIcon();

  const formatResolution = () => {
    if (item.metadata?.width && item.metadata?.height) {
      return `${item.metadata.width}×${item.metadata.height}`;
    }
    return null;
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const iconColor = item.type === "audio"
    ? "text-primary/50"
    : item.type === "image"
      ? "text-primary/50"
      : "text-status-info/50";

  const borderClass = item.kieaiError
    ? "border-red-500 ring-1 ring-red-500/50 shadow-[0_0_10px_rgba(239,68,68,0.3)]"
    : item.isPending
    ? "border-purple-500 ring-1 ring-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.3)]"
    : item.isPlaceholder
      ? "border-yellow-500 ring-1 ring-yellow-500/50 shadow-[0_0_10px_rgba(234,179,8,0.3)]"
      : isSelected
        ? "border-primary ring-1 ring-primary/50 shadow-[0_0_10px_rgba(34,197,94,0.2)]"
        : "border-border hover:border-text-secondary";

  const hoverOverlay = (
    <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px] flex items-center justify-center gap-2 animate-in fade-in duration-200">
      {item.kieaiError ? (
        <button
          onClick={(e) => { e.stopPropagation(); onRetryKieAI?.(); }}
          title="Generation failed — click to retry"
          className="p-2 bg-red-500/20 rounded-full hover:bg-red-500/40 backdrop-blur-sm transition-colors"
        >
          <RefreshCw size={14} className="text-red-400" />
        </button>
      ) : item.isPending ? (
        <div title="KieAI generation in progress…" className="p-2">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-purple-400 border-t-transparent" />
        </div>
      ) : item.isPlaceholder ? (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); onReplace(); }}
            title="Replace asset"
            className="p-2 bg-yellow-500/20 rounded-full hover:bg-yellow-500/40 backdrop-blur-sm transition-colors"
          >
            <RefreshCw size={14} className="text-yellow-500" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete"
            className="p-2 bg-red-500/20 rounded-full hover:bg-red-500/40 backdrop-blur-sm transition-colors"
          >
            <Trash2 size={14} className="text-red-400" />
          </button>
        </>
      ) : (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); onAddToTimeline(); }}
            title="Add to timeline"
            className="p-2 bg-primary/20 rounded-full hover:bg-primary/40 backdrop-blur-sm transition-colors"
          >
            <Plus size={14} className="text-primary" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete"
            className="p-2 bg-red-500/20 rounded-full hover:bg-red-500/40 backdrop-blur-sm transition-colors"
          >
            <Trash2 size={14} className="text-red-400" />
          </button>
        </>
      )}
    </div>
  );

  // --- List view ---
  if (viewMode === "list") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
      <div
        draggable
        onDragStart={onDragStart}
        onClick={() => { onSelect(); onPreview(); }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={`flex items-center gap-3 px-2 py-1.5 rounded-lg border-2 cursor-pointer transition-all group ${borderClass}`}
      >
        {/* Small thumbnail */}
        <div className="w-12 h-8 rounded bg-background-tertiary relative overflow-hidden flex-shrink-0">
          {showThumb ? (
            <img src={effectiveThumb as string} alt={item.name} className="w-full h-full object-cover" onError={() => setThumbFailed(true)} />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Icon size={14} className={iconColor} />
            </div>
          )}
          {item.kieaiError && (
            <div className="absolute inset-0 flex items-center justify-center bg-red-500/10">
              <AlertTriangle size={12} className="text-red-400" />
            </div>
          )}
          {!item.kieaiError && item.isPending && (
            <div className="absolute inset-0 flex items-center justify-center bg-purple-500/10">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-400 border-t-transparent" />
            </div>
          )}
          {!item.kieaiError && !item.isPending && item.isPlaceholder && (
            <div className="absolute inset-0 flex items-center justify-center bg-yellow-500/10">
              <AlertTriangle size={12} className="text-yellow-500/70" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div
            className={`text-[11px] truncate font-medium ${isSelected ? "text-primary" : "text-text-primary"}`}
            title={item.name}
          >
            {item.name}
          </div>
          <div className="flex items-center gap-1.5 text-[9px] text-text-muted">
            {item.metadata?.duration && <span>{formatDuration(item.metadata.duration)}</span>}
            {item.metadata?.duration && formatResolution() && <span>•</span>}
            {formatResolution() && <span>{formatResolution()}</span>}
            {(item.metadata?.duration || formatResolution()) && formatFileSize(item.metadata?.fileSize) && <span>•</span>}
            {formatFileSize(item.metadata?.fileSize) && <span>{formatFileSize(item.metadata?.fileSize)}</span>}
          </div>
        </div>

        {/* Hover actions */}
        {isHovered && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {item.kieaiError ? (
              <button
                onClick={(e) => { e.stopPropagation(); onRetryKieAI?.(); }}
                title="Retry generation"
                className="p-1 bg-red-500/20 rounded hover:bg-red-500/40 transition-colors"
              >
                <RefreshCw size={12} className="text-red-400" />
              </button>
            ) : item.isPending ? (
              <div className="p-1" title="Generating…">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-purple-400 border-t-transparent" />
              </div>
            ) : item.isPlaceholder ? (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); onReplace(); }}
                  title="Replace asset"
                  className="p-1 bg-yellow-500/20 rounded hover:bg-yellow-500/40 transition-colors"
                >
                  <RefreshCw size={12} className="text-yellow-500" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  title="Delete"
                  className="p-1 bg-red-500/20 rounded hover:bg-red-500/40 transition-colors"
                >
                  <Trash2 size={12} className="text-red-400" />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); onAddToTimeline(); }}
                  title="Add to timeline"
                  className="p-1 bg-primary/20 rounded hover:bg-primary/40 transition-colors"
                >
                  <Plus size={12} className="text-primary" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  title="Delete"
                  className="p-1 bg-red-500/20 rounded hover:bg-red-500/40 transition-colors"
                >
                  <Trash2 size={12} className="text-red-400" />
                </button>
              </>
            )}
          </div>
        )}

        {isSelected && (
          <div className="w-2 h-2 bg-primary rounded-full shadow-[0_0_8px_#22c55e] flex-shrink-0" />
        )}
      </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={(e) => { (e as React.MouseEvent).stopPropagation?.(); onAddToTimeline(); }}>
            <Plus size={13} className="mr-2" />
            Add to Timeline
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={(e) => { (e as React.MouseEvent).stopPropagation?.(); onRelinkItem(); }}>
            <Link2 size={13} className="mr-2" />
            Relink this item…
          </ContextMenuItem>
          {onRelinkAll && (
            <ContextMenuItem onClick={(e) => { (e as React.MouseEvent).stopPropagation?.(); onRelinkAll(); }}>
              <RefreshCw size={13} className="mr-2" />
              Relink all missing…
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={(e) => { (e as React.MouseEvent).stopPropagation?.(); onDelete(); }} className="text-red-400 focus:text-red-400">
            <Trash2 size={13} className="mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  // --- Grid view (large & small) ---
  const thumbnailIconSize = viewMode === "small" ? 16 : 24;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div className="flex flex-col">
      {/* Thumbnail container */}
      <div
        draggable
        onDragStart={onDragStart}
        onClick={() => { onSelect(); onPreview(); }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onAddToTimeline();
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={`aspect-video bg-background-tertiary rounded-lg border-2 relative group cursor-pointer transition-all overflow-hidden shadow-sm ${borderClass}`}
      >
        {/* Thumbnail or placeholder */}
        {showThumb ? (
          <img
            src={effectiveThumb as string}
            alt={item.name}
            className="w-full h-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-background-tertiary">
            <Icon size={thumbnailIconSize} className={iconColor} />
          </div>
        )}

        {/* Audio waveform placeholder */}
        {item.type === "audio" && (
          <div className="absolute top-1/2 left-0 right-0 h-4 flex items-center gap-px px-2 -translate-y-1/2">
            {waveformHeights.map((height, i) => (
              <div
                key={i}
                className="flex-1 bg-primary/30 rounded-full"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
        )}

        {/* KieAI Error Badge */}
        {item.kieaiError && (
          <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-red-500 rounded text-[8px] text-white font-bold flex items-center gap-1">
            <AlertTriangle size={8} />
            Failed
          </div>
        )}

        {/* Pending KieAI Badge */}
        {!item.kieaiError && item.isPending && (
          <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-purple-500 rounded text-[8px] text-white font-bold flex items-center gap-1">
            <div className="h-2 w-2 animate-spin rounded-full border border-white border-t-transparent" />
            AI
          </div>
        )}

        {/* Missing Asset Badge */}
        {!item.kieaiError && !item.isPending && item.isPlaceholder && (
          <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-yellow-500 rounded text-[8px] text-black font-bold flex items-center gap-1">
            <AlertTriangle size={10} />
            Missing
          </div>
        )}

        {/* Duration badge on thumbnail */}
        {item.metadata?.duration && (
          <div className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/70 rounded text-[9px] text-white font-mono">
            {formatDuration(item.metadata.duration)}
          </div>
        )}

        {/* Error overlay */}
        {item.kieaiError && !isHovered && (
          <div className="absolute inset-0 flex items-center justify-center bg-red-500/10">
            <AlertTriangle size={viewMode === "small" ? 20 : 32} className="text-red-400/60" />
          </div>
        )}

        {/* Pending overlay */}
        {!item.kieaiError && item.isPending && !isHovered && (
          <div className="absolute inset-0 flex items-center justify-center bg-purple-500/10">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-purple-400 border-t-transparent" />
          </div>
        )}

        {/* Warning icon overlay for placeholders */}
        {!item.kieaiError && !item.isPending && item.isPlaceholder && !isHovered && (
          <div className="absolute inset-0 flex items-center justify-center bg-yellow-500/10">
            <AlertTriangle size={viewMode === "small" ? 20 : 32} className="text-yellow-500/50" />
          </div>
        )}

        {/* Hover overlay with actions */}
        {isHovered && hoverOverlay}

        {/* Selection indicator */}
        {isSelected && (
          <div className="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full shadow-[0_0_8px_#22c55e]" />
        )}
      </div>

      {/* Metadata below thumbnail */}
      <div className="mt-1.5 px-0.5">
        <div
          className={`text-[10px] truncate font-medium ${
            isSelected ? "text-primary" : "text-text-primary"
          }`}
          title={item.name}
        >
          {item.name}
        </div>
        {viewMode === "large" && (
          <div className="flex items-center gap-1.5 text-[9px] text-text-muted mt-0.5">
            {formatResolution() && <span>{formatResolution()}</span>}
            {formatResolution() && formatFileSize(item.metadata?.fileSize) && (
              <span>•</span>
            )}
            {formatFileSize(item.metadata?.fileSize) && (
              <span>{formatFileSize(item.metadata?.fileSize)}</span>
            )}
          </div>
        )}
      </div>
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onAddToTimeline()}>
          <Plus size={13} className="mr-2" />
          Add to Timeline
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onRelinkItem()}>
          <Link2 size={13} className="mr-2" />
          Relink this item…
        </ContextMenuItem>
        {onRelinkAll && (
          <ContextMenuItem onClick={() => onRelinkAll()}>
            <RefreshCw size={13} className="mr-2" />
            Relink all missing…
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onDelete()} className="text-red-400 focus:text-red-400">
          <Trash2 size={13} className="mr-2" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

// Hidden file input id — every clickable "import" affordance in this
// panel points its `htmlFor` here so the picker opens via native
// label-activation. We deliberately do NOT use `input.click()` —
// that path silently no-ops in Chromium embedded-iframe contexts when
// the user-activation token has been consumed (e.g. a microtask hop
// between the click event and the .click() call). Native label
// activation is dispatched at the browser layer in a real user
// gesture, so it works regardless of iframe permissions or framework
// event timing.
const ASSETS_FILE_INPUT_ID = "assets-file-input";

const EmptyState: React.FC<{ embedded: boolean; onPick: () => void }> = ({
  embedded,
  onPick,
}) => (
  <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
    <div className="w-16 h-16 rounded-2xl bg-background-tertiary border border-border flex items-center justify-center mb-4 shadow-inner">
      <Upload size={24} className="text-text-muted" />
    </div>
    <p className="text-sm text-text-secondary mb-2 font-medium">
      No media imported
    </p>
    <p className="text-xs text-text-muted mb-6">
      {embedded ? "Drag files here, or add media" : "Drag files here or click to import"}
    </p>
    {embedded ? (
      <button
        onClick={onPick}
        className="px-4 py-2 bg-background-elevated hover:bg-background-tertiary border border-border text-text-primary text-xs font-medium rounded-lg transition-all hover:border-primary/50 cursor-pointer inline-block"
      >
        Add Media
      </button>
    ) : (
      <label
        htmlFor={ASSETS_FILE_INPUT_ID}
        role="button"
        tabIndex={0}
        className="px-4 py-2 bg-background-elevated hover:bg-background-tertiary border border-border text-text-primary text-xs font-medium rounded-lg transition-all hover:border-primary/50 cursor-pointer inline-block [&_*]:pointer-events-none"
      >
        Import Media
      </label>
    )}
  </div>
);

const LoadingIndicator: React.FC<{ message: string }> = ({ message }) => (
  <div className="absolute inset-0 bg-background-secondary/90 backdrop-blur-sm flex flex-col items-center justify-center z-50">
    <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
    <p className="text-sm text-text-secondary">{message}</p>
  </div>
);

export const AssetsPanel: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTabRaw] = useState<
    "media" | "library" | "text" | "graphics" | "ai-music" | "voidspace" | "ai-gen"
  >(useUIStore.getState().appMode === "music" ? "ai-music" : "media");
  const setActiveTab = useCallback((tab: "media" | "library" | "text" | "graphics" | "ai-music" | "voidspace" | "ai-gen") => {
    setActiveTabRaw(tab);
  }, []);

  const [isDragOver, setIsDragOver] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [showOnlyMissing, setShowOnlyMissing] = useState(false);
  const [showAspectRatioDialog, setShowAspectRatioDialog] = useState(false);
  const [aspectRatioDialogData, setAspectRatioDialogData] = useState<{
    videoWidth: number;
    videoHeight: number;
    itemToAdd: MediaItem;
  } | null>(null);
  const [mediaViewMode, setMediaViewMode] = useState<MediaViewMode>("large");
  // Clicking a Media tile opens a fullscreen preview (consistent with the
  // Library/Voidspace tabs); it never auto-adds — drag onto the timeline to use.
  const [previewMediaItem, setPreviewMediaItem] = useState<MediaItem | null>(null);
  // Prefer the project blob (always playable) over a possibly-expired remote URL.
  const previewMediaSrc = useMemo(() => {
    if (!previewMediaItem) return "";
    if (previewMediaItem.blob instanceof Blob) return URL.createObjectURL(previewMediaItem.blob);
    return previewMediaItem.originalUrl || previewMediaItem.thumbnailUrl || "";
  }, [previewMediaItem]);
  React.useEffect(() => {
    return () => { if (previewMediaSrc.startsWith("blob:")) URL.revokeObjectURL(previewMediaSrc); };
  }, [previewMediaSrc]);
  const [generatingBackground, setGeneratingBackground] = useState<
    string | null
  >(null);
  const [backgroundCategory, setBackgroundCategory] = useState<
    "all" | "solid" | "gradient" | "pattern" | "mesh"
  >("all");

  // KieAI image generation dialog

  // Project store
  const {
    project,
    importMedia,
    deleteMedia,
    replaceMediaAsset,
    updateSettings,
    setKieAIItemState,
  } = useProjectStore();
  const mediaItems = project.mediaLibrary.items;

  // KieAI store
  const { retryTask } = useKieAIStore();

  // UI store
  const { select, isSelected, startDrag } = useUIStore();
  // User-resizable panel width (persisted via panels.mediaLibrary.width;
  // the drag handle lives in EditorInterface as a flex sibling).
  const assetsWidth = useUIStore((s) => s.panels.mediaLibrary.width ?? 320);
  const setPanelWidth = useUIStore((s) => s.setPanelWidth);
  // Header expand button: toggle the Assets panel between its normal width
  // and a wide preset so the user can see more columns of media at once
  // (complements the drag handle). 320 is the default; 560 is "expanded".
  const EXPANDED_W = 560;
  const DEFAULT_W = 320;
  const toggleExpandAssets = useCallback(() => {
    const cur = useUIStore.getState().panels.mediaLibrary.width ?? DEFAULT_W;
    setPanelWidth("mediaLibrary", cur >= EXPANDED_W ? DEFAULT_W : EXPANDED_W);
  }, [setPanelWidth]);

  // When embedded in the Voidspace chat (the studio shell), the "+" / "Add
  // media" affordances open the parent's rich Add-Media popup
  // (StudioMediaPickerModal: Library / Search web / Generate with AI) via
  // postMessage instead of the bare native file picker. Standalone (no
  // parent) falls back to the native picker. The parent posts the chosen
  // media back as `voidspace:add-media-from-url`, which App.tsx imports
  // into this library. One modal, one set of gen/search/credit plumbing —
  // no React reimplementation of the website feature.
  const isEmbedded = useMemo(
    () =>
      typeof window !== "undefined" &&
      (window.self !== window.top ||
        new URLSearchParams(window.location.search).get("embed") === "1"),
    [],
  );
  const openMediaPicker = useCallback(
    (initialKind?: "image" | "video" | "audio") => {
      try {
        window.parent?.postMessage(
          { type: "voidspace:open-media-picker", initialKind },
          "*",
        );
      } catch {
        /* no parent / cross-origin — ignore */
      }
    },
    [],
  );

  // Count missing assets
  const missingAssetsCount = mediaItems.filter(
    (item) => item.isPlaceholder,
  ).length;

  // Filter media items by search query and missing assets toggle
  const filteredItems = mediaItems.filter((item) => {
    const matchesSearch = item.name
      .toLowerCase()
      .includes(searchQuery.toLowerCase());
    const matchesFilter = showOnlyMissing ? item.isPlaceholder : true;
    return matchesSearch && matchesFilter;
  });

  // Handle file import with loading state
  const handleFileImport = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;

      setIsImporting(true);
      const fileArray = Array.from(files);
      let failures = 0;

      try {
        for (let i = 0; i < fileArray.length; i++) {
          const file = fileArray[i];
          setImportProgress(
            `Importing ${file.name} (${i + 1}/${fileArray.length})...`,
          );

          const result = await importMedia(file);

          if (!result.success) {
            failures++;
            const message = result.error?.message || "Import failed";
            console.error(`[AssetsPanel] Import rejected for ${file.name}:`, result.error);
            toast.error(`Couldn't import ${file.name}`, message);
            continue;
          }

          // If it's a video with audio, extract audio to separate track
          if (file.type.startsWith("video/")) {
            setImportProgress(`Extracting audio from ${file.name}...`);
            // Audio extraction is handled by the importMedia function
            // The audio track is created automatically when adding to timeline
          }
        }
        if (failures === 0 && fileArray.length > 0) {
          toast.success(
            fileArray.length === 1
              ? `Imported ${fileArray[0].name}`
              : `Imported ${fileArray.length} files`,
          );
        }
      } catch (error) {
        console.error("Import failed:", error);
        toast.error(
          "Import failed",
          error instanceof Error ? error.message : "Unknown error",
        );
      } finally {
        setIsImporting(false);
        setImportProgress("");
      }
    },
    [importMedia],
  );

  // Handle drag and drop import — capture FileSystemFileHandle for each dropped file
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      // Try to capture handles before files are consumed
      if ("getAsFileSystemHandle" in DataTransferItem.prototype) {
        const handlePromises = Array.from(e.dataTransfer.items)
          .filter((item) => item.kind === "file")
          .map(async (item) => {
            try {
              const handle = await (item as DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemHandle> }).getAsFileSystemHandle();
              if (handle.kind === "file") {
                const fileHandle = handle as FileSystemFileHandle;
                const file = await fileHandle.getFile();
                await saveFileHandle(file.name, file.size, fileHandle);
              }
            } catch {
              // Ignore — handle capture is best-effort
            }
          });
        await Promise.all(handlePromises);
      }

      handleFileImport(e.dataTransfer.files);
    },
    [handleFileImport],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  // Handle media item selection
  const handleSelectItem = useCallback(
    (itemId: string) => {
      select({ type: "clip", id: itemId });
    },
    [select],
  );

  // Handle media item deletion
  const handleDeleteItem = useCallback(
    async (itemId: string) => {
      await deleteMedia(itemId);
    },
    [deleteMedia],
  );

  // Handle asset replacement
  const handleReplaceAsset = useCallback(
    async (itemId: string) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "video/*,audio/*,image/*";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          setIsImporting(true);
          setImportProgress(`Replacing asset...`);
          try {
            await replaceMediaAsset(itemId, file);
          } catch (error) {
            console.error("Asset replacement failed:", error);
          } finally {
            setIsImporting(false);
            setImportProgress("");
          }
        }
      };
      input.click();
    },
    [replaceMediaAsset],
  );

  // Shared relink core: point at a folder, recursively scan it, match
  // each requested item to a real file (manifest-aware — understands the
  // Voidspace `voidspace-projects/<id>/{videos,frames,narrations,music}`
  // save layout), then re-import + persist handles so the link survives
  // future reloads via the project-store auto-restore tiers.
  const runRelink = useCallback(
    async (itemsToRelink: MediaItem[], contextLabel: string) => {
      if (!("showDirectoryPicker" in window)) {
        toast.error(
          "Folder picker not supported",
          "Your browser doesn't support folder selection. Use the Replace (↻) button on a single asset instead.",
        );
        return;
      }
      if (itemsToRelink.length === 0) return;

      let dirHandle: FileSystemDirectoryHandle;
      try {
        dirHandle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
      } catch {
        return; // user cancelled
      }

      setIsImporting(true);
      setImportProgress(`Scanning ${dirHandle.name}…`);
      try {
        const { files, manifests } = await collectFolder(dirHandle);
        if (files.length === 0) {
          toast.error("Folder is empty", "No media files were found in the selected folder (searched subfolders too).");
          return;
        }

        const { project: currentProject } = useProjectStore.getState();
        const relinkable: RelinkableItem[] = itemsToRelink.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          originalUrl: item.originalUrl,
          category: item.category,
          sceneNumber: item.sceneNumber,
          role: item.role,
          fileSize: item.metadata?.fileSize,
          sourceFile: item.sourceFile,
        }));

        const plan = buildRelinkPlan(relinkable, files, manifests, {
          currentProjectId: currentProject.id,
        });

        if (plan.matches.length === 0) {
          toast.error(
            "No matches found",
            `None of the files in ${dirHandle.name} matched ${contextLabel}. Pick the folder Voidspace saved this project to (it usually contains a "voidspace-projects" folder).`,
          );
          return;
        }

        // Persist the directory handle once — auto-restore re-scans it
        // (recursively, via the same matcher) on every future load.
        try { await saveDirectoryHandle(currentProject.id, dirHandle); } catch { /* best-effort */ }

        let linked = 0;
        const nameById = new Map(itemsToRelink.map((i) => [i.id, i.name]));
        for (const match of plan.matches) {
          const label = nameById.get(match.itemId) ?? match.file.name;
          setImportProgress(`Relinking ${label}…`);
          try {
            // Save the individual file handle so Tier-1 auto-restore can
            // follow this exact file even if it later moves folders.
            try { await saveFileHandle(match.file.file.name, match.file.size, match.file.handle); } catch { /* best-effort */ }
            await replaceMediaAsset(match.itemId, match.file.file, dirHandle.name);
            linked++;
          } catch (err) {
            console.error(`[AssetsPanel] Failed to relink ${label}:`, err);
          }
        }

        const skipped = itemsToRelink.length - linked;
        if (linked > 0 && skipped === 0) {
          toast.success(`Relinked ${linked} asset${linked !== 1 ? "s" : ""}`);
        } else if (linked > 0) {
          toast.success(
            `Relinked ${linked} of ${itemsToRelink.length}`,
            `${skipped} item${skipped !== 1 ? "s" : ""} had no match in that folder.`,
          );
        } else {
          toast.error("Nothing relinked", "Matches were found but couldn't be imported. Check the files aren't corrupt.");
        }
      } catch (err) {
        console.error("[AssetsPanel] Relink failed:", err);
        toast.error("Relink failed", err instanceof Error ? err.message : "Unknown error");
      } finally {
        setIsImporting(false);
        setImportProgress("");
      }
    },
    [replaceMediaAsset],
  );

  const handleRelinkFromFolder = useCallback(async () => {
    const { project: currentProject } = useProjectStore.getState();
    const placeholders = currentProject.mediaLibrary.items.filter((item) => item.isPlaceholder);
    await runRelink(placeholders, "the missing assets");
  }, [runRelink]);

  const handleRelinkSingleItem = useCallback(
    async (item: MediaItem) => {
      await runRelink([item], `"${item.name}"`);
    },
    [runRelink],
  );

  // Handle drag start for timeline placement
  const handleItemDragStart = useCallback(
    (e: React.DragEvent, item: MediaItem) => {
      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({ mediaId: item.id }),
      );
      e.dataTransfer.effectAllowed = "copy";
      startDrag("media", { mediaId: item.id, mediaType: item.type });

      // Cross-iframe drag bridge: announce the asset to the host (Voidspace
      // chat) so it can be dropped onto a scene's "Add reference" strip.
      // dataTransfer doesn't cross the iframe boundary reliably, so the payload
      // travels via postMessage; the drop itself lands in the parent document
      // (where the strip lives), which IS deliverable. Durable cloud URL only —
      // a local blob: URL is useless to the remote video model.
      try {
        const anyItem = item as any;
        const url: string = anyItem.originalUrl || anyItem.url || anyItem.src || "";
        const kind: string = String(item.type || "image").toLowerCase();
        if (url && window.parent && window.parent !== window) {
          window.parent.postMessage(
            { type: "voidspace:ref-drag-start", media: { url, kind, name: item.name || "" } },
            "*",
          );
          // One-shot dragend → tell the host the drag is over (clears its
          // drop-target highlight). Fires after any drop has been processed.
          const onEnd = () => {
            try { window.parent?.postMessage({ type: "voidspace:ref-drag-end" }, "*"); } catch { /* ignore */ }
            document.removeEventListener("dragend", onEnd);
          };
          document.addEventListener("dragend", onEnd);
        }
      } catch { /* best-effort — timeline drag still works */ }
    },
    [startDrag],
  );

  const addMediaToTimeline = useCallback(async (item: MediaItem) => {
    const { addClipToNewTrack } = useProjectStore.getState();
    await addClipToNewTrack(item.id);
  }, []);

  const handleConfirmAspectRatioMatch = useCallback(async () => {
    if (!aspectRatioDialogData) return;

    await updateSettings({
      width: aspectRatioDialogData.videoWidth,
      height: aspectRatioDialogData.videoHeight,
    });

    const itemToAdd = aspectRatioDialogData.itemToAdd;
    setShowAspectRatioDialog(false);
    setAspectRatioDialogData(null);

    await addMediaToTimeline(itemToAdd);
  }, [aspectRatioDialogData, updateSettings, addMediaToTimeline]);

  const handleCancelAspectRatioMatch = useCallback(async () => {
    if (!aspectRatioDialogData) return;

    const itemToAdd = aspectRatioDialogData.itemToAdd;
    setShowAspectRatioDialog(false);
    setAspectRatioDialogData(null);

    await addMediaToTimeline(itemToAdd);
  }, [aspectRatioDialogData, addMediaToTimeline]);

  const handleAddToTimeline = useCallback(
    async (item: MediaItem) => {
      const { project: currentProject } = useProjectStore.getState();
      const tracks = currentProject.timeline.tracks;
      const hasClips = tracks.some((track) => track.clips.length > 0);

      if (
        !hasClips &&
        item.type === "video" &&
        item.metadata?.width &&
        item.metadata?.height
      ) {
        const videoWidth = item.metadata.width;
        const videoHeight = item.metadata.height;
        const projectWidth = currentProject.settings.width;
        const projectHeight = currentProject.settings.height;

        // Only prompt to change project dimensions when the ASPECT RATIO
        // actually differs (that's when cropping/letterboxing happens). A clip
        // that matches the aspect at a different pixel size (e.g. a 810×1440
        // webcam take in a 1080×1920 project — both 9:16) scales cleanly to
        // fill the frame, so we add it silently and NEVER nudge the user to
        // change their project's aspect ratio.
        const videoAspect = videoWidth / videoHeight;
        const projectAspect = projectWidth / projectHeight;
        if (Math.abs(videoAspect - projectAspect) > 0.01) {
          setAspectRatioDialogData({ videoWidth, videoHeight, itemToAdd: item });
          setShowAspectRatioDialog(true);
          return;
        }
      }

      await addMediaToTimeline(item);
    },
    [addMediaToTimeline],
  );

  const handleImportBackground = useCallback(
    async (preset: BackgroundPreset) => {
      setGeneratingBackground(preset.id);
      try {
        const { width, height } = project.settings;
        const blob = await generateBackgroundBlob(preset, width, height);
        const file = new File([blob], `${preset.name}_${width}x${height}.png`, {
          type: "image/png",
        });
        const result = await importMedia(file);
        if (result.success && result.actionId) {
          const { addClipToNewTrack } = useProjectStore.getState();
          await addClipToNewTrack(result.actionId);
        }
      } catch (error) {
        console.error("Failed to generate background:", error);
      } finally {
        setGeneratingBackground(null);
      }
    },
    [importMedia, project.settings],
  );

  const filteredBackgrounds = BACKGROUND_PRESETS.filter(
    (preset) =>
      backgroundCategory === "all" || preset.category === backgroundCategory,
  );

  // Open KieAI dialog for an image asset

  const handleRetryKieAI = useCallback((item: MediaItem) => {
    if (!item.kieaiTaskId) return;
    // Reset error state and re-activate polling
    setKieAIItemState(item.id, true, false);
    retryTask(item.kieaiTaskId);
  }, [retryTask, setKieAIItemState]);

  return (
    <div
      data-tour="assets"
      style={{ width: assetsWidth }}
      className="bg-background-secondary border-r border-border flex flex-col h-full relative shrink-0"
    >
      {/* Loading overlay */}
      {isImporting && (
        <LoadingIndicator message={importProgress || "Importing media..."} />
      )}
      {/* Panel Header */}
      <div className="px-5 py-4 flex items-center justify-between">
        <span className="font-bold text-lg text-text-primary tracking-tight">
          Assets
        </span>
        <div className="flex gap-1">
          {/* `[&_*]:pointer-events-none` is load-bearing on every label
              in this panel — without it a real mouse click lands on
              the inner SVG `<path>` (Lucide icons render as
              <svg><path/>…), which absorbs the hit. Chromium's
              label-activation logic doesn't fire the associated input
              from a descendant-originated click on SVG children, so
              the picker never opens. Disabling pointer-events on every
              descendant forces the click target to be the label itself
              → label-activation dispatches the synthetic click on the
              input → file picker opens. */}
          {isEmbedded ? (
            <button
              onClick={() => openMediaPicker()}
              title="Add media — upload, search the web, or generate with AI"
              className="inline-flex items-center justify-center h-6 w-6 rounded-md text-text-secondary hover:text-text-primary hover:bg-background-elevated cursor-pointer transition-colors"
            >
              <Plus size={14} />
            </button>
          ) : (
            <label
              htmlFor={ASSETS_FILE_INPUT_ID}
              title="Import media"
              role="button"
              tabIndex={0}
              className="inline-flex items-center justify-center h-6 w-6 rounded-md text-text-secondary hover:text-text-primary hover:bg-background-elevated cursor-pointer transition-colors [&_*]:pointer-events-none"
            >
              <Plus size={14} />
            </label>
          )}
          <IconButton
            icon={Maximize2}
            title={assetsWidth >= EXPANDED_W ? "Shrink panel" : "Expand panel — more columns"}
            onClick={toggleExpandAssets}
          />
          <IconButton icon={X} title="Close panel" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex px-5 gap-6 border-b border-border text-xs font-medium text-text-muted mb-5">
        <button
          onClick={() => setActiveTab("media")}
          className={`pb-3 transition-all relative ${
            activeTab === "media"
              ? "text-text-primary"
              : "hover:text-text-secondary"
          }`}
        >
          Media
          {activeTab === "media" && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full shadow-[0_-2px_8px_rgba(99,102,241,0.5)]" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("library")}
          className={`pb-3 transition-all relative ${
            activeTab === "library"
              ? "text-text-primary"
              : "hover:text-text-secondary"
          }`}
        >
          Library
          {activeTab === "library" && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full shadow-[0_-2px_8px_rgba(99,102,241,0.5)]" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("text")}
          className={`pb-3 transition-all relative ${
            activeTab === "text"
              ? "text-text-primary"
              : "hover:text-text-secondary"
          }`}
        >
          Text
          {activeTab === "text" && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full shadow-[0_-2px_8px_rgba(99,102,241,0.5)]" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("graphics")}
          className={`pb-3 transition-all relative ${
            activeTab === "graphics"
              ? "text-text-primary"
              : "hover:text-text-secondary"
          }`}
        >
          Graphics
          {activeTab === "graphics" && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full shadow-[0_-2px_8px_rgba(99,102,241,0.5)]" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("ai-music")}
          className={`pb-3 transition-all relative ${
            activeTab === "ai-music"
              ? "text-text-primary"
              : "hover:text-text-secondary"
          }`}
        >
          AI Music
          {activeTab === "ai-music" && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full shadow-[0_-2px_8px_rgba(99,102,241,0.5)]" />
          )}
        </button>
        {/* Cloud + AI tabs hidden in the studio shell — the chat
            sidebar is the authoritative AI surface, and Voidspace
            cloud media flows in automatically via the scene_list
            subscription, so a separate "Cloud" tab was redundant. */}
      </div>

      {/* Search & view toggle - only show for media tab */}
      {activeTab === "media" && (
        <div className="px-5 mb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted z-10" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search media"
              className="pl-9 text-xs bg-background-tertiary border-border text-text-primary h-9"
            />
          </div>
          <div className="flex items-center bg-background-tertiary border border-border rounded-lg p-0.5">
            {([
              { mode: "large" as const, icon: LayoutGrid, title: "Large icons" },
              { mode: "small" as const, icon: Grid2x2, title: "Small icons" },
              { mode: "list" as const, icon: List, title: "List view" },
            ]).map(({ mode, icon: ViewIcon, title }) => (
              <button
                key={mode}
                onClick={() => setMediaViewMode(mode)}
                title={title}
                className={`p-1.5 rounded transition-colors ${
                  mediaViewMode === mode
                    ? "bg-background-elevated text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                <ViewIcon size={13} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Missing Assets Filter and Badge */}
      {activeTab === "media" && missingAssetsCount > 0 && (
        <div className="px-5 mb-5 space-y-2">
          <button
            onClick={() => setShowOnlyMissing(!showOnlyMissing)}
            className={`w-full px-3 py-2 rounded-lg border text-xs font-medium transition-all flex items-center justify-between ${
              showOnlyMissing
                ? "bg-yellow-500/10 border-yellow-500 text-yellow-500"
                : "bg-background-tertiary border-border text-text-secondary hover:border-yellow-500/50"
            }`}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} />
              <span>Show Only Missing Assets</span>
            </div>
            <div className="px-2 py-0.5 rounded-full bg-yellow-500 text-black text-[10px] font-bold">
              {missingAssetsCount}
            </div>
          </button>
          <button
            onClick={handleRelinkFromFolder}
            className="w-full px-3 py-2 rounded-lg border border-yellow-500/40 bg-yellow-500/5 text-yellow-500 text-xs font-medium transition-all hover:bg-yellow-500/15 flex items-center gap-2"
          >
            <RefreshCw size={14} />
            <span>Relink from Folder…</span>
          </button>
        </div>
      )}

      {/* Hidden file input — target of every `<label htmlFor>` in this
          panel.

          CRITICAL: do NOT use `className="hidden"` (display: none).
          Chromium's embedded-iframe picker policy suppresses the OS
          file chooser for inputs whose computed display is `none` —
          a trusted click reaches the input but the browser refuses
          to show the picker because the element has no layout box.
          Use the screen-reader-only recipe (1×1px, clipped, opacity:0):
          element stays laid-out so the picker is eligible to open,
          but invisible to the user. */}
      <input
        id={ASSETS_FILE_INPUT_ID}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
          opacity: 0,
          pointerEvents: "none",
        }}
        onChange={(e) => {
          // Hand the FileList to the importer BEFORE clearing value.
          // input.files is a live view — setting value = "" empties it
          // in place, so a reference grabbed beforehand becomes length 0
          // and handleFileImport's empty-guard returns silently. The
          // importer's synchronous Array.from(files) snapshots the list,
          // so clearing value right after is safe and still resets the
          // input for the next pick.
          void handleFileImport(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Content based on active tab */}
      {activeTab === "media" && (
        <ScrollArea
          className={`flex-1 ${isDragOver ? "bg-primary/5" : ""}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <div className="px-5 pb-5">
            {filteredItems.length === 0 ? (
              <EmptyState embedded={isEmbedded} onPick={() => openMediaPicker()} />
            ) : (() => {
              // Bucket items by `category` (Voidspace stamps these:
              // "Scene Videos", "Narrations", "Music"). Items without a
              // category fall into "Imported" so user-uploaded files
              // stay visually distinct from generated content. Within
              // a bucket, sort by sceneNumber when present so the
              // panel matches the timeline left-to-right.
              const buckets = new Map<string, typeof filteredItems>();
              for (const item of filteredItems) {
                const key = item.category || "Imported";
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key)!.push(item);
              }
              for (const [, arr] of buckets) {
                arr.sort((a, b) => {
                  const an = a.sceneNumber ?? Number.POSITIVE_INFINITY;
                  const bn = b.sceneNumber ?? Number.POSITIVE_INFINITY;
                  if (an !== bn) return an - bn;
                  return a.name.localeCompare(b.name);
                });
              }
              // Stable section order: Voidspace categories first, then
              // any other category alphabetically, then user imports.
              const ORDER = ["Scene Videos", "Narrations", "Voice", "Music", "Frames"];
              const sectionKeys = Array.from(buckets.keys()).sort((a, b) => {
                const ai = ORDER.indexOf(a);
                const bi = ORDER.indexOf(b);
                if (ai !== -1 && bi !== -1) return ai - bi;
                if (ai !== -1) return -1;
                if (bi !== -1) return 1;
                if (a === "Imported") return 1;
                if (b === "Imported") return -1;
                return a.localeCompare(b);
              });
              return (
                <div className="flex flex-col gap-4">
                  {sectionKeys.map((section) => {
                    const items = buckets.get(section)!;
                    return (
                      <div key={section} className="flex flex-col gap-2">
                        <div className="flex items-center justify-between sticky top-0 z-10 bg-background-secondary/95 backdrop-blur py-1">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                            {section}
                          </span>
                          <span className="text-[10px] text-text-muted tabular-nums">
                            {items.length}
                          </span>
                        </div>
                        {/* Fixed-size cards that REFLOW with panel width.
                            auto-fill + a fixed track width keeps each card the
                            same size and just changes how many columns fit
                            (2 → 3 → 4 as you widen the panel) — instead of a
                            fixed `grid-cols-N`, which stretches each card as
                            the panel grows. `minmax(0,Npx)` lets a card shrink
                            below N only when the panel is narrower than one
                            card, so it never overflows. Inline style (not a
                            Tailwind arbitrary class) so it can never be dropped
                            by JIT/purge in the prebuilt bundle. */}
                        <div
                          className={mediaViewMode === "list" ? "flex flex-col gap-1.5" : "grid"}
                          style={
                            mediaViewMode === "list"
                              ? undefined
                              : {
                                  gap: mediaViewMode === "small" ? 8 : 12,
                                  gridTemplateColumns: `repeat(auto-fill, minmax(0, ${mediaViewMode === "small" ? 84 : 132}px))`,
                                }
                          }
                        >
                          {items.map((item) => (
                            <MediaThumbnail
                              key={item.id}
                              item={item}
                              isSelected={isSelected(item.id)}
                              viewMode={mediaViewMode}
                              onSelect={() => handleSelectItem(item.id)}
                              onPreview={() => setPreviewMediaItem(item)}
                              onDelete={() => handleDeleteItem(item.id)}
                              onReplace={() => handleReplaceAsset(item.id)}
                              onDragStart={(e) => handleItemDragStart(e, item)}
                              onAddToTimeline={() => handleAddToTimeline(item)}
                              onRetryKieAI={item.kieaiError && item.kieaiTaskId ? () => handleRetryKieAI(item) : undefined}
                              onRelinkItem={() => handleRelinkSingleItem(item)}
                              onRelinkAll={missingAssetsCount > 0 ? handleRelinkFromFolder : undefined}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            {filteredItems.length > 0 && (
              <div className="mt-3">
                {/* Add more media tile — pinned at the bottom of the
                    grouped list so user-imported additions sit alongside
                    the always-on import affordance instead of being
                    swallowed by the section sort. */}
                {/* List/grid "Add media" tiles — labels (not buttons)
                    so the picker opens via native form-control activation.
                    Visual classes preserved verbatim from the previous
                    <button> versions; semantics swap to role="button". */}
                {mediaViewMode === "list" ? (
                  isEmbedded ? (
                    <button
                      onClick={() => openMediaPicker()}
                      className="w-full flex items-center gap-3 px-2 py-1.5 rounded-lg border-2 border-dashed border-border hover:border-text-secondary cursor-pointer transition-all group"
                    >
                      <div className="w-12 h-8 rounded bg-background-tertiary flex items-center justify-center flex-shrink-0">
                        <Plus size={14} className="text-text-muted group-hover:text-text-secondary transition-colors" />
                      </div>
                      <span className="text-[11px] text-text-muted group-hover:text-text-secondary transition-colors font-medium">Add media</span>
                    </button>
                  ) : (
                    <label
                      htmlFor={ASSETS_FILE_INPUT_ID}
                      role="button"
                      tabIndex={0}
                      className="w-full flex items-center gap-3 px-2 py-1.5 rounded-lg border-2 border-dashed border-border hover:border-text-secondary cursor-pointer transition-all group [&_*]:pointer-events-none"
                    >
                      <div className="w-12 h-8 rounded bg-background-tertiary flex items-center justify-center flex-shrink-0">
                        <Upload size={14} className="text-text-muted group-hover:text-text-secondary transition-colors" />
                      </div>
                      <span className="text-[11px] text-text-muted group-hover:text-text-secondary transition-colors font-medium">Add media</span>
                    </label>
                  )
                ) : isEmbedded ? (
                  <button
                    onClick={() => openMediaPicker()}
                    className="w-full aspect-video bg-background-tertiary rounded-lg border-2 border-dashed border-border hover:border-text-secondary relative flex items-center justify-center cursor-pointer transition-all overflow-hidden shadow-sm group"
                  >
                    <div className="flex flex-col items-center gap-1.5">
                      <Plus size={mediaViewMode === "small" ? 16 : 20} className="text-text-muted group-hover:text-text-secondary transition-colors" />
                      <span className="text-[10px] text-text-muted group-hover:text-text-secondary transition-colors">Add media</span>
                    </div>
                  </button>
                ) : (
                  <label
                    htmlFor={ASSETS_FILE_INPUT_ID}
                    role="button"
                    tabIndex={0}
                    className="w-full aspect-video bg-background-tertiary rounded-lg border-2 border-dashed border-border hover:border-text-secondary relative flex items-center justify-center cursor-pointer transition-all overflow-hidden shadow-sm group [&_*]:pointer-events-none"
                  >
                    <div className="flex flex-col items-center gap-1.5">
                      <Upload size={mediaViewMode === "small" ? 16 : 20} className="text-text-muted group-hover:text-text-secondary transition-colors" />
                      <span className="text-[10px] text-text-muted group-hover:text-text-secondary transition-colors">Add media</span>
                    </div>
                  </label>
                )}
              </div>
            )}

            {/* Drop zone indicator */}
            {isDragOver && (
              <div className="absolute inset-4 border-2 border-dashed border-primary rounded-xl flex items-center justify-center bg-primary/5 pointer-events-none z-50 backdrop-blur-sm">
                <div className="text-primary text-sm font-bold bg-background-secondary px-4 py-2 rounded-full shadow-lg">
                  Drop files to import
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      {/* Graphics Tab Content (Task 16) */}
      {activeTab === "graphics" && (
        <ScrollArea className="flex-1">
          <div className="px-5 pb-5">
          {/* Backgrounds Section */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
                <Palette size={12} />
                Backgrounds
              </h4>
            </div>
            <div className="flex gap-1.5 mb-3 flex-wrap">
              {(["all", "solid", "gradient", "mesh", "pattern"] as const).map(
                (cat) => (
                  <button
                    key={cat}
                    onClick={() => setBackgroundCategory(cat)}
                    className={`px-2.5 py-1 text-[10px] rounded-md transition-all ${
                      backgroundCategory === cat
                        ? "bg-primary text-white"
                        : "bg-background-tertiary text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    {cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </button>
                ),
              )}
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(0, 64px))" }}>
              {filteredBackgrounds.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => handleImportBackground(preset)}
                  disabled={generatingBackground !== null}
                  className="aspect-square rounded-lg border border-border hover:border-primary/50 transition-all overflow-hidden relative group disabled:opacity-50"
                  title={preset.name}
                  style={{ background: preset.thumbnail }}
                >
                  {generatingBackground === preset.id && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <Plus size={16} className="text-white" />
                  </div>
                  <span className="absolute bottom-0 left-0 right-0 text-[8px] text-white bg-black/60 py-0.5 px-1 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                    {preset.name}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Shapes Section */}
          <div className="mb-6">
            <h4 className="text-xs font-medium text-text-secondary mb-3">
              Shapes
            </h4>
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(0, 64px))" }}>
              {[
                {
                  type: "rectangle" as ShapeType,
                  icon: Square,
                  label: "Rectangle",
                },
                { type: "circle" as ShapeType, icon: Circle, label: "Circle" },
                {
                  type: "triangle" as ShapeType,
                  icon: Triangle,
                  label: "Triangle",
                },
                { type: "star" as ShapeType, icon: Star, label: "Star" },
                {
                  type: "arrow" as ShapeType,
                  icon: ArrowRight,
                  label: "Arrow",
                },
                {
                  type: "polygon" as ShapeType,
                  icon: Hexagon,
                  label: "Polygon",
                },
              ].map((shape) => (
                <button
                  key={shape.type}
                  onClick={async () => {
                    const state = useProjectStore.getState();
                    const { createShapeClip, addTrack } = state;
                    const tracksBefore = state.project.timeline.tracks;
                    await addTrack("graphics", 0);
                    const tracksAfter =
                      useProjectStore.getState().project.timeline.tracks;
                    const newGraphicsTrack = tracksAfter.find(
                      (t) =>
                        t.type === "graphics" &&
                        !tracksBefore.some((bt) => bt.id === t.id),
                    );
                    if (newGraphicsTrack) {
                      createShapeClip(newGraphicsTrack.id, 0, shape.type);
                    }
                  }}
                  className="aspect-square bg-background-tertiary rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-1 group"
                  title={shape.label}
                >
                  <shape.icon
                    size={20}
                    className="text-text-secondary group-hover:text-primary transition-colors"
                  />
                  <span className="text-[9px] text-text-muted group-hover:text-text-secondary">
                    {shape.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* SVG Import Section */}
          <div className="mb-6">
            <h4 className="text-xs font-medium text-text-secondary mb-3">
              SVG Import
            </h4>
            <button
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".svg";
                input.onchange = async (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (file) {
                    const content = await file.text();
                    const state = useProjectStore.getState();
                    const { importSVG, addTrack } = state;
                    const tracksBefore = state.project.timeline.tracks;
                    await addTrack("graphics", 0);
                    const tracksAfter =
                      useProjectStore.getState().project.timeline.tracks;
                    const newGraphicsTrack = tracksAfter.find(
                      (t) =>
                        t.type === "graphics" &&
                        !tracksBefore.some((bt) => bt.id === t.id),
                    );
                    if (newGraphicsTrack) {
                      importSVG(content, newGraphicsTrack.id, 0);
                    }
                  }
                };
                input.click();
              }}
              className="w-full py-3 bg-background-tertiary rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all flex items-center justify-center gap-2 group"
            >
              <FileCode
                size={16}
                className="text-text-secondary group-hover:text-primary transition-colors"
              />
              <span className="text-xs text-text-secondary group-hover:text-text-primary">
                Import SVG File
              </span>
            </button>
          </div>

          {/* Stickers Section (placeholder) */}
          <div className="mb-6">
            <h4 className="text-xs font-medium text-text-secondary mb-3">
              Stickers & Emojis
            </h4>
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(0, 64px))" }}>
              {["😀", "🎉", "❤️", "⭐", "🔥", "👍", "🎬", "🎵"].map(
                (emoji, i) => (
                  <button
                    key={i}
                    onClick={async () => {
                      const state = useProjectStore.getState();
                      const { createStickerClip, addTrack } = state;
                      const { stickerLibrary } = await import("@openreel/core");

                      const tracksBefore = state.project.timeline.tracks;
                      await addTrack("graphics", 0);
                      const tracksAfter =
                        useProjectStore.getState().project.timeline.tracks;
                      const newGraphicsTrack = tracksAfter.find(
                        (t) =>
                          t.type === "graphics" &&
                          !tracksBefore.some((bt) => bt.id === t.id),
                      );

                      if (newGraphicsTrack) {
                        const emojiItem = {
                          id: `emoji-${i}`,
                          emoji,
                          name: emoji,
                          category: "emojis",
                        };
                        const clip = stickerLibrary.createEmojiClip(
                          emojiItem,
                          newGraphicsTrack.id,
                          0,
                          5,
                        );
                        createStickerClip(clip);
                      }
                    }}
                    className="aspect-square bg-background-tertiary rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all flex items-center justify-center text-xl cursor-pointer"
                  >
                    {emoji}
                  </button>
                ),
              )}
            </div>
          </div>
          </div>
        </ScrollArea>
      )}

      {/* Text Tab Content */}
      {activeTab === "text" && (
        <ScrollArea className="flex-1">
          <div className="px-5 pb-5 space-y-3">
            <button
              onClick={async () => {
                const state = useProjectStore.getState();
                const { createTextClip, addTrack } = state;
                const tracksBefore = state.project.timeline.tracks;
                await addTrack("text", 0);
                const tracksAfter =
                  useProjectStore.getState().project.timeline.tracks;
                const newTextTrack = tracksAfter.find(
                  (t) =>
                    t.type === "text" &&
                    !tracksBefore.some((bt) => bt.id === t.id),
                );
                if (newTextTrack) {
                  createTextClip(newTextTrack.id, 0, "New Title");
                }
              }}
              className="w-full py-4 bg-background-tertiary rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-center"
            >
              <span className="text-lg font-bold text-text-primary">
                Add Title
              </span>
              <p className="text-xs text-text-muted mt-1">
                Click to add text to timeline
              </p>
            </button>
            <div className="grid grid-cols-2 gap-2">
              {[
                {
                  name: "Heading",
                  text: "Heading",
                  style: {
                    fontSize: 72,
                    fontWeight: 700 as const,
                    textAlign: "center" as const,
                    verticalAlign: "middle" as const,
                  },
                },
                {
                  name: "Subtitle",
                  text: "Subtitle text",
                  style: {
                    fontSize: 36,
                    fontWeight: 400 as const,
                    textAlign: "center" as const,
                    verticalAlign: "middle" as const,
                  },
                },
                {
                  name: "Lower Third",
                  text: "Name Here",
                  style: {
                    fontSize: 32,
                    fontWeight: 600 as const,
                    textAlign: "left" as const,
                    verticalAlign: "bottom" as const,
                    backgroundColor: "rgba(0, 0, 0, 0.7)",
                  },
                },
                {
                  name: "Caption",
                  text: "Caption text here",
                  style: {
                    fontSize: 24,
                    fontWeight: 400 as const,
                    textAlign: "center" as const,
                    verticalAlign: "bottom" as const,
                    shadowColor: "rgba(0, 0, 0, 0.8)",
                    shadowBlur: 4,
                    shadowOffsetX: 1,
                    shadowOffsetY: 1,
                  },
                },
              ].map((preset) => (
                <button
                  key={preset.name}
                  onClick={async () => {
                    const state = useProjectStore.getState();
                    const { createTextClip, addTrack } = state;
                    const tracksBefore = state.project.timeline.tracks;
                    await addTrack("text", 0);
                    const tracksAfter =
                      useProjectStore.getState().project.timeline.tracks;
                    const newTextTrack = tracksAfter.find(
                      (t) =>
                        t.type === "text" &&
                        !tracksBefore.some((bt) => bt.id === t.id),
                    );
                    if (newTextTrack) {
                      createTextClip(
                        newTextTrack.id,
                        0,
                        preset.text,
                        5,
                        preset.style,
                      );
                    }
                  }}
                  className="py-3 bg-background-tertiary rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-xs text-text-secondary hover:text-text-primary"
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
        </ScrollArea>
      )}

      {/* AI Music Tab — paginated user-generated tracks from users/{uid}/music */}
      {activeTab === "ai-music" && (
        <ScrollArea className="flex-1">
          <div className="px-5 pb-5">
            <AIMusicSection />
          </div>
        </ScrollArea>
      )}

      {/* Library tab — cross-project, local-first reuse of past generations */}
      {activeTab === "library" && <LibraryPanel />}

      {/* Voidspace Cloud Media Tab */}
      {activeTab === "voidspace" && <VoidspaceMediaPanel />}

      {/* AI generation tab — upstream's panel (Kie.ai brief, aspect, live timeline placeholders) */}
      {activeTab === "ai-gen" && <AIGenTab />}

      {/* Media-tile fullscreen preview (click a Media tile). Consistent with the
          Library/Voidspace preview; Edit opens the image editor for images. */}
      {previewMediaItem && previewMediaSrc && (
        <MediaPreviewOverlay
          url={previewMediaSrc}
          editUrl={previewMediaItem.originalUrl || undefined}
          kind={previewMediaItem.type as PreviewKind}
          name={previewMediaItem.name}
          onClose={() => setPreviewMediaItem(null)}
        />
      )}

      {aspectRatioDialogData && (
        <AspectRatioMatchDialog
          isOpen={showAspectRatioDialog}
          videoWidth={aspectRatioDialogData.videoWidth}
          videoHeight={aspectRatioDialogData.videoHeight}
          currentWidth={project.settings.width}
          currentHeight={project.settings.height}
          onConfirm={handleConfirmAspectRatioMatch}
          onCancel={handleCancelAspectRatioMatch}
        />
      )}

    </div>
  );
};

export default AssetsPanel;
