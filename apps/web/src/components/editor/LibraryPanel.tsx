import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Loader2, Plus, Check, Film, Music2, Image as ImageIcon, AudioLines, Mic } from "lucide-react";
import { useVoidspaceStore } from "../../stores/voidspace-store";
import { useProjectStore } from "../../stores/project-store";
import { saveMediaBlob } from "../../services/media-storage";

/**
 * Library tab — the user's CROSS-PROJECT, local-first asset library. Aggregates
 * every generated asset they've ever made (SFX / BGM / images / videos /
 * voiceovers) from `GET /api/studio/library` (which scans the per-project disk
 * manifests — zero Firebase). Browsing + REUSING a past generation here means
 * the user never has to regenerate (= zero credits, instant).
 *
 * Reuse model (the founder's call): clicking an item COPIES it into the current
 * project — fetched bytes -> IndexedDB + a MediaItem -> appears in the Media tab
 * and is draggable to the timeline. Deduped by source URL so re-adding the same
 * library asset doesn't pile up duplicates. Self-contained = sellable.
 */

type LibType = "all" | "video" | "image" | "music" | "sfx" | "voice";

interface LibItem {
  id: string;
  type: string;
  kind: string;
  label: string;
  url: string;            // /api/studio/local-asset?... (auth-stamped by main.tsx fetch hook)
  thumbnailUrl?: string;
  bytes: number;
  createdAt: string;
  projectId: string;
}

const TYPE_PILLS: { id: LibType; label: string; Icon: typeof Film }[] = [
  { id: "all", label: "All", Icon: Plus },
  { id: "video", label: "Videos", Icon: Film },
  { id: "image", label: "Images", Icon: ImageIcon },
  { id: "music", label: "Music", Icon: Music2 },
  { id: "sfx", label: "SFX", Icon: AudioLines },
  { id: "voice", label: "Voice", Icon: Mic },
];

/** Parent origin when embedded in the website iframe; else same origin. */
function apiBase(): string {
  if (typeof window !== "undefined") {
    try {
      if (window.parent && window.parent !== window) return window.parent.location.origin;
    } catch { /* cross-origin — fall through */ }
  }
  return "";
}
/** The user's configured Storage location (shared via same-origin localStorage). */
function resolveOutputDir(): string {
  try {
    const raw = localStorage.getItem("voidspace.studio.settings");
    if (raw) {
      const s = JSON.parse(raw);
      const dir = typeof s?.outputDir === "string" ? s.outputDir.trim() : "";
      if (dir) return dir;
    }
  } catch { /* ignore */ }
  return "~/Voidspace";
}
function fmtBytes(n: number): string {
  if (!n) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const LibraryPanel: React.FC = () => {
  const [type, setType] = useState<LibType>("all");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState<LibItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  // Firebase ID token, appended as ?t= to <img>/<video> src. local-asset is
  // auth-gated and an element src can't carry an Authorization header (only
  // fetch() is stamped by the main.tsx hook), so without this every thumbnail
  // 401s and renders broken.
  const [mediaToken, setMediaToken] = useState<string>("");
  const reqSeq = useRef(0);

  const srcWithToken = useCallback((url: string) => {
    const full = `${apiBase()}${url}`;
    if (!mediaToken || /[?&]t=/.test(full)) return full;
    return `${full}${full.includes("?") ? "&" : "?"}t=${encodeURIComponent(mediaToken)}`;
  }, [mediaToken]);

  const importMedia = useProjectStore((s) => s.importMedia);
  const mediaItems = useProjectStore((s) => s.project.mediaLibrary.items);
  // URLs already imported into THIS project — drives the "Added" check state.
  const importedUrls = useMemo(
    () => new Set(mediaItems.map((m: any) => m.originalUrl).filter(Boolean)),
    [mediaItems],
  );

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const token = await useVoidspaceStore.getState().getIdToken();
      if (token) setMediaToken(token);
      const qs = new URLSearchParams({
        outputDir: resolveOutputDir(),
        type,
        q: debounced,
        limit: "120",
      });
      const res = await fetch(`${apiBase()}/api/studio/library?${qs.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`library ${res.status}`);
      const j = await res.json();
      if (seq !== reqSeq.current) return; // a newer request superseded this one
      setItems(Array.isArray(j.items) ? j.items : []);
      setTotal(typeof j.total === "number" ? j.total : 0);
    } catch (e: any) {
      if (seq === reqSeq.current) setError(e?.message ?? "Failed to load library");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [type, debounced]);

  useEffect(() => { void load(); }, [load]);

  const addToProject = useCallback(async (it: LibItem) => {
    if (importedUrls.has(it.url)) return; // already in this project
    setAddingId(it.id);
    try {
      // local-asset URLs are auth-stamped by the main.tsx fetch hook, so a
      // plain fetch resolves the bytes from disk (no CORS / no token plumbing).
      const r = await fetch(`${apiBase()}${it.url}`);
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      const blob = await r.blob();
      const extGuess = it.kind === "image" ? "jpg" : (it.type === "video" ? "mp4" : "mp3");
      const fname = `${(it.label || it.kind).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48) || it.kind}.${extGuess}`;
      const file = new File([blob], fname, { type: blob.type || "application/octet-stream" });
      const result = await importMedia(file);
      if (result.success && result.actionId) {
        // Tag originalUrl (durable library URL) so a reload rehydrates it AND
        // mark it as a Library import so the dedup check recognises it; also
        // cache the blob under the new id for instant reloads.
        useProjectStore.setState((s: any) => ({
          project: {
            ...s.project,
            mediaLibrary: {
              ...s.project.mediaLibrary,
              items: (s.project.mediaLibrary?.items ?? []).map((m: any) =>
                m.id === result.actionId
                  ? { ...m, originalUrl: m.originalUrl ?? it.url, category: m.category ?? "Library" }
                  : m,
              ),
            },
            modifiedAt: Date.now(),
          },
        }));
        const proj = useProjectStore.getState().project;
        saveMediaBlob(proj.id, result.actionId, blob, (file as any).metadata ?? {} as any).catch(() => {});
      }
    } catch (e) {
      console.warn("[library] add-to-project failed:", e);
    } finally {
      setAddingId(null);
    }
  }, [importMedia, importedUrls]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Search */}
      <div className="px-5 mb-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted z-10" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your generations…"
            className="w-full pl-9 pr-3 text-xs bg-background-tertiary border border-border rounded-md text-text-primary h-9 focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Type filter pills */}
      <div className="px-5 mb-3 flex flex-wrap gap-1.5">
        {TYPE_PILLS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setType(id)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
              type === id
                ? "bg-primary/15 border-primary text-primary"
                : "bg-background-tertiary border-border text-text-secondary hover:border-text-muted"
            }`}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-5 pb-5 min-h-0">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-text-muted gap-2 text-xs">
            <Loader2 size={16} className="animate-spin" /> Loading your library…
          </div>
        ) : error ? (
          <div className="text-xs text-error py-8 text-center">{error}</div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <AudioLines size={28} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">No generations yet</p>
            <p className="text-[11px] mt-1">Generated SFX, music, images and videos show up here — reuse them in any project without regenerating.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              {items.map((it) => {
                const added = importedUrls.has(it.url);
                const isImage = it.type === "image";
                const isVideo = it.type === "video";
                return (
                  <div
                    key={it.id}
                    role="button"
                    tabIndex={0}
                    // Native media items are draggable to the timeline; Library
                    // cards must behave identically — including ones already in
                    // the project (the blue-tick state). We ALWAYS carry a
                    // `libraryItem` descriptor with the RAW url (no ?t= — the
                    // main.tsx fetch hook stamps it on drop); the timeline drop
                    // handler dedups by originalUrl, so an already-imported asset
                    // resolves to its existing mediaId and places instantly
                    // (no re-import), while a new one is imported on drop. Click
                    // still imports it into Media (disabled once added).
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        "application/json",
                        JSON.stringify({ libraryItem: { url: it.url, kind: it.kind, type: it.type, label: it.label } }),
                      );
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => { if (!added && addingId !== it.id) void addToProject(it); }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && !added && addingId !== it.id) { e.preventDefault(); void addToProject(it); }
                    }}
                    title={added ? `${it.label} — in this project · drag to add to timeline` : `${it.label} — drag to timeline or click to add`}
                    className={`group relative text-left rounded-lg overflow-hidden border transition-all cursor-grab active:cursor-grabbing ${
                      added ? "border-primary/60" : "border-border hover:border-primary/60"
                    } bg-background-tertiary`}
                  >
                    <div className="aspect-video bg-background-elevated flex items-center justify-center overflow-hidden">
                      {isImage ? (
                        <img src={srcWithToken(it.thumbnailUrl || it.url)} alt={it.label} loading="lazy" className="w-full h-full object-cover" />
                      ) : isVideo ? (
                        <video src={srcWithToken(it.url)} muted preload="metadata" className="w-full h-full object-cover" />
                      ) : it.type === "music" ? (
                        <Music2 size={22} className="text-primary/60" />
                      ) : it.type === "voice" ? (
                        <Mic size={22} className="text-primary/60" />
                      ) : (
                        <AudioLines size={22} className="text-primary/60" />
                      )}
                      {/* add / added affordance */}
                      <div className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow ${
                        added ? "bg-primary text-white" : "bg-black/55 text-white opacity-0 group-hover:opacity-100"
                      } transition-opacity`}>
                        {addingId === it.id ? <Loader2 size={13} className="animate-spin" /> : added ? <Check size={13} /> : <Plus size={13} />}
                      </div>
                    </div>
                    <div className="px-2 py-1.5">
                      <p className="text-[11px] text-text-primary truncate">{it.label}</p>
                      <p className="text-[10px] text-text-muted">{it.type}{it.bytes ? ` · ${fmtBytes(it.bytes)}` : ""}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            {total > items.length && (
              <p className="text-[10px] text-text-muted text-center mt-3">Showing {items.length} of {total} — refine with search to find more.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
