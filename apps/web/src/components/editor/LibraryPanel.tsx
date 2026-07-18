import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Loader2, Plus, Check, Film, Music2, Image as ImageIcon, AudioLines, Mic, Pencil, HardDrive, RefreshCw, ChevronDown, ChevronRight, Download } from "lucide-react";
import { useVoidspaceStore } from "../../stores/voidspace-store";
import { useProjectStore } from "../../stores/project-store";
import { saveMediaBlob, loadMediaBlob } from "../../services/media-storage";
import { fetchLibraryBlob } from "../../services/library-drop";
import { checkForRecovery, recoverProject } from "../../services/auto-save";
import { MediaPreviewOverlay, type PreviewKind } from "./MediaPreviewOverlay";

/**
 * Library tab — the user's CROSS-PROJECT asset library. Three sources:
 *   1. GET /api/studio/library — the user's own server-side store (disk
 *      partition manifests + Firestore generated media: agent chat, app,
 *      automation, finalized songs).
 *   2. "On this device" — media saved inside THIS browser's other projects
 *      (IndexedDB), surfaced so locally-imported assets are never invisible.
 *
 * Display rules:
 *   • Image tiles load a COMPRESSED thumbnail (server `w=` resize) through
 *     CachedThumb — authenticated fetch with a FRESH token (an <img src>
 *     token goes stale after ~1 h and every tile 401s) + a Cache API copy so
 *     a tile that loaded once keeps rendering even if the upstream expires.
 *   • Items are grouped into recency sections (Today / Yesterday / …) with
 *     sticky headers, searchable by prompt, filterable by type, paginated
 *     with Load more.
 *   • Images carry an Edit button → opens the Voidspace Image editor in a
 *     NEW TAB. In-place saves there broadcast `voidspace-image-edit`, which
 *     busts the thumb caches and refreshes this panel (back-and-forth
 *     editing without a reload).
 *
 * Reuse model (the founder's call): clicking an item previews it; the +
 * affordance COPIES it into the current project (bytes → IndexedDB + a
 * MediaItem), deduped by source URL; dragging places it on the timeline.
 */

type LibType = "all" | "video" | "image" | "music" | "sfx" | "voice";

interface LibItem {
  id: string;
  type: string;
  kind: string;
  label: string;
  url: string;            // /api/studio/local-asset?... OR absolute cloud URL
  thumbnailUrl?: string;  // compressed (`w=`) variant for grids
  bytes: number;
  createdAt: string;
  projectId: string;
  // Download-metadata (embedded into the saved file by /api/studio/download):
  title?: string;
  artist?: string;
  prompt?: string;
  coverUrl?: string;
}

/** A media item found in another project saved on THIS device (IndexedDB). */
interface DeviceItem {
  id: string;
  mediaId: string;
  type: string;            // coarse: image | video | music | sfx | voice
  kind: string;            // libraryItem kind for drag/drop
  label: string;
  projectName: string;
  addedAt: number;
  originalUrl?: string;
  dataThumb?: string;      // persisted data: thumbnail when available
  objectUrl?: string;      // lazily-created blob URL (preview/drag)
}

const TYPE_PILLS: { id: LibType; label: string; Icon: typeof Film }[] = [
  { id: "all", label: "All", Icon: Plus },
  { id: "video", label: "Videos", Icon: Film },
  { id: "image", label: "Images", Icon: ImageIcon },
  { id: "music", label: "Music", Icon: Music2 },
  { id: "sfx", label: "SFX", Icon: AudioLines },
  { id: "voice", label: "Voice", Icon: Mic },
];

const PAGE_SIZE = 120;
const THUMB_CACHE = "voidspace-library-thumbs-v1";

// Stale-while-revalidate cache: switching to the Library tab (or between type
// pills / searches) shows the last result INSTANTLY while a fresh fetch runs in
// the background. Keyed by type+query; module-level so it survives unmount.
const libClientCache = new Map<string, { items: LibItem[]; total: number; at: number }>();

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

/** Human tag for where an item came from — makes the grid scannable. */
function sourceTag(projectId: string): string {
  if (projectId === "chat-images") return "Chat";
  if (projectId === "generated-media") return "Agent";
  if (projectId === "user-music") return "Music";
  return projectId.length > 14 ? `${projectId.slice(0, 12)}…` : projectId;
}

/** Recency bucket for section grouping. */
function bucketOf(iso: string): string {
  const t = new Date(iso || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return "Older";
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (t >= startOfToday.getTime()) return "Today";
  if (t >= startOfToday.getTime() - day) return "Yesterday";
  if (t >= Date.now() - 7 * day) return "This week";
  if (t >= Date.now() - 30 * day) return "This month";
  return "Older";
}
const BUCKET_ORDER = ["Today", "Yesterday", "This week", "This month", "Older"];

/**
 * Fetch a (thumbnail) URL with a FRESH auth token and keep a Cache API copy.
 * Order: network (updates cache) → cache (offline / expired upstream) → null.
 * The cache is what stops images "getting lost": once a thumb has rendered
 * on this device it keeps rendering even if the source URL later dies.
 */
async function fetchThumbWithCache(url: string): Promise<Blob | null> {
  let token: string | null = null;
  try { token = await useVoidspaceStore.getState().getIdToken(); } catch { /* signed out */ }
  try {
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (res.ok) {
      try {
        const copy = res.clone();
        void caches.open(THUMB_CACHE).then((c) => c.put(url, copy)).catch(() => {});
      } catch { /* Cache API unavailable (insecure context) */ }
      return await res.blob();
    }
  } catch { /* network failure — try the cache */ }
  try {
    const c = await caches.open(THUMB_CACHE);
    const hit = await c.match(url);
    if (hit) return await hit.blob();
  } catch { /* no cache */ }
  return null;
}

/** Image/poster tile that survives token expiry + dead upstreams (see above).
 *  `fallback` renders when the thumb can't be fetched (default: image icon —
 *  video tiles pass their `<video>` element so playback-capable previews
 *  remain available when a poster is missing). */
const CachedThumb: React.FC<{ src: string; alt: string; rev: number; className?: string; fallback?: React.ReactNode }> = ({ src, alt, rev, className, fallback }) => {
  const [objUrl, setObjUrl] = useState<string>("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let created = "";
    setFailed(false);
    // rev busts both the browser HTTP cache and our Cache API key after an
    // in-place edit (the URL itself is otherwise stable).
    const full = rev ? `${src}${src.includes("?") ? "&" : "?"}r=${rev}` : src;
    void fetchThumbWithCache(full).then((blob) => {
      if (!alive) return;
      if (!blob) { setFailed(true); return; }
      created = URL.createObjectURL(blob);
      setObjUrl(created);
    });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src, rev]);
  if (failed) return <>{fallback ?? <ImageIcon size={22} className="text-primary/40" />}</>;
  if (!objUrl) return <div className={`animate-pulse bg-background-elevated ${className ?? "w-full h-full"}`} />;
  return <img src={objUrl} alt={alt} loading="lazy" className={className ?? "w-full h-full object-cover"} onError={() => setFailed(true)} />;
};

export const LibraryPanel: React.FC = () => {
  const [type, setType] = useState<LibType>("all");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState<LibItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [failedVideos, setFailedVideos] = useState<Set<string>>(new Set());
  // Bumped when the image editor broadcasts an in-place save — re-fetches
  // thumbs past every cache layer.
  const [rev, setRev] = useState(0);
  // Clicking a card previews it fullscreen; drag adds to the timeline, the +
  // affordance imports it into Media. (Click no longer auto-imports.)
  const [previewItem, setPreviewItem] = useState<{ url: string; editUrl?: string; kind: PreviewKind; name: string } | null>(null);
  // "On this device" — media inside other locally-saved projects.
  const [deviceItems, setDeviceItems] = useState<DeviceItem[]>([]);
  // Collapsed section titles — persisted so the layout the user set survives
  // reloads.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("voidspace.library.collapsed");
      if (raw) return new Set(JSON.parse(raw));
    } catch { /* fresh default */ }
    return new Set();
  });
  const toggleSection = useCallback((title: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      try { localStorage.setItem("voidspace.library.collapsed", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);
  // Firebase ID token appended as ?t= to <video> src (element src can't carry
  // an Authorization header; images go through CachedThumb instead).
  const [mediaToken, setMediaToken] = useState<string>("");
  const reqSeq = useRef(0);
  const deviceObjectUrls = useRef<string[]>([]);

  const srcWithToken = useCallback((url: string) => {
    // Absolute cloud URLs (Firestore-sourced) and blob/data URLs need no
    // token and no origin prefix.
    if (/^(https?:|blob:|data:)/i.test(url)) return url;
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

  const load = useCallback(async (offset = 0, force = false) => {
    const seq = ++reqSeq.current;
    const cacheKey = `${type}::${debounced}`;
    if (offset === 0) {
      setError(null);
      // Show the last result for this filter INSTANTLY, then revalidate. Only
      // block with the spinner when we have nothing cached to show.
      const cached = libClientCache.get(cacheKey);
      if (cached) { setItems(cached.items); setTotal(cached.total); setLoading(false); }
      else { setLoading(true); }
    } else { setLoadingMore(true); }
    try {
      const token = await useVoidspaceStore.getState().getIdToken();
      if (token) setMediaToken(token);
      const qs = new URLSearchParams({
        outputDir: resolveOutputDir(),
        type,
        q: debounced,
        limit: String(PAGE_SIZE),
        offset: String(offset),
        ...(force ? { refresh: "1" } : {}),
      });
      const res = await fetch(`${apiBase()}/api/studio/library?${qs.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`library ${res.status}`);
      const j = await res.json();
      if (seq !== reqSeq.current) return; // a newer request superseded this one
      const page: LibItem[] = Array.isArray(j.items) ? j.items : [];
      const nextTotal = typeof j.total === "number" ? j.total : 0;
      setItems((prev) => (offset === 0 ? page : [...prev, ...page]));
      setTotal(nextTotal);
      if (offset === 0) libClientCache.set(cacheKey, { items: page, total: nextTotal, at: Date.now() });
    } catch (e: any) {
      // Keep any stale-but-shown results; only surface an error with nothing to show.
      if (seq === reqSeq.current && offset === 0 && !libClientCache.get(cacheKey)) {
        setError(e?.message ?? "Failed to load library");
      }
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [type, debounced]);

  useEffect(() => { void load(0); }, [load]);

  // ── "On this device": scan other locally-saved projects' media ──────────
  const loadDevice = useCallback(async () => {
    try {
      const saves = await checkForRecovery();
      const newestByProject = new Map<string, (typeof saves)[number]>();
      for (const s of saves) {
        if (!newestByProject.has(s.projectId)) newestByProject.set(s.projectId, s);
      }
      const currentProjectId = useProjectStore.getState().project.id;
      const picks = [...newestByProject.values()]
        .filter((s) => s.projectId !== currentProjectId) // current project = Media tab
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 15);
      const out: DeviceItem[] = [];
      const seen = new Set<string>();
      for (const save of picks) {
        const proj = await recoverProject(save.id).catch(() => null);
        const list: any[] = (proj as any)?.mediaLibrary?.items ?? [];
        for (const m of list) {
          const coarse = m?.type === "image" ? "image"
            : m?.type === "video" ? "video"
            : m?.type === "audio"
              ? (/sfx/i.test(String(m?.category || "")) ? "sfx"
                : /voice|narration/i.test(String(m?.category || "")) ? "voice"
                : "music")
              : "";
          if (!coarse) continue;
          const dedupeKey = String(m?.originalUrl || `${save.projectId}:${m?.id}`);
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          out.push({
            id: `dev:${save.projectId}:${m.id}`,
            mediaId: String(m.id),
            type: coarse,
            kind: coarse === "voice" ? "narration" : coarse,
            label: String(m?.name || coarse),
            projectName: String(save.projectName || "Untitled project"),
            addedAt: save.timestamp,
            originalUrl: typeof m?.originalUrl === "string" ? m.originalUrl : undefined,
            dataThumb: typeof m?.thumbnailUrl === "string" && m.thumbnailUrl.startsWith("data:") ? m.thumbnailUrl : undefined,
          });
        }
      }
      setDeviceItems(out.slice(0, 300));
    } catch (e) {
      console.warn("[library] device media scan failed:", e);
    }
  }, []);

  useEffect(() => { void loadDevice(); }, [loadDevice]);
  useEffect(() => () => {
    for (const u of deviceObjectUrls.current) URL.revokeObjectURL(u);
    deviceObjectUrls.current = [];
  }, []);

  // ── Back-and-forth editing: the image editor broadcasts in-place saves ──
  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("voidspace-image-edit");
      bc.onmessage = (ev: MessageEvent) => {
        if (ev?.data?.type !== "image-updated") return;
        // Bust every thumb layer (Cache API + HTTP via &r=) and re-list —
        // edited pixels and freshly saved copies show up immediately.
        void caches.delete(THUMB_CACHE).catch(() => {});
        setRev((r) => r + 1);
        void load(0);
      };
    } catch { /* BroadcastChannel unsupported — manual refresh still works */ }
    return () => { try { bc?.close(); } catch { /* noop */ } };
  }, [load]);

  // Download WITH embedded metadata: routes through /api/studio/download,
  // which losslessly remuxes the file with Title/Artist/Comment(prompt) tags
  // + cover art — the saved file stays identifiable in Explorer/Finder and
  // any player, not just inside Voidspace. Fresh token per click (the <a>
  // navigation can't send an Authorization header and stale ?t= 401s).
  const downloadItem = useCallback(async (it: LibItem) => {
    try {
      const token = await useVoidspaceStore.getState().getIdToken();
      const params = new URLSearchParams({ url: it.url });
      const title = it.title || it.label;
      if (title) params.set("title", title);
      if (it.artist) params.set("artist", it.artist);
      const comment = it.prompt || it.label;
      if (comment) params.set("comment", comment);
      if (it.coverUrl) params.set("cover", it.coverUrl);
      if (token) params.set("t", token);
      const a = document.createElement("a");
      a.href = `${apiBase()}/api/studio/download?${params.toString()}`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.warn("[library] download failed:", e);
    }
  }, []);

  const openInImageEditor = useCallback((rawUrl: string) => {
    // New tab, same handoff the chat lightbox uses. For a local-asset source
    // the editor's "Update original" overwrites the file in place and the
    // broadcast above refreshes this panel.
    window.open(
      `${apiBase()}/image/?src=${encodeURIComponent(rawUrl)}&from=${encodeURIComponent("Editor")}`,
      "_blank",
    );
  }, []);

  const tagImported = useCallback((actionId: string, originalUrl: string, blob: Blob) => {
    useProjectStore.setState((s: any) => ({
      project: {
        ...s.project,
        mediaLibrary: {
          ...s.project.mediaLibrary,
          items: (s.project.mediaLibrary?.items ?? []).map((m: any) =>
            m.id === actionId
              ? { ...m, originalUrl: m.originalUrl ?? originalUrl, category: m.category ?? "Library" }
              : m,
          ),
        },
        modifiedAt: Date.now(),
      },
    }));
    const proj = useProjectStore.getState().project;
    saveMediaBlob(proj.id, actionId, blob, {} as any).catch(() => {});
  }, []);

  const addToProject = useCallback(async (it: LibItem) => {
    if (importedUrls.has(it.url)) return; // already in this project
    setAddingId(it.id);
    try {
      // local-asset URLs are auth-stamped by the main.tsx fetch hook; absolute
      // cloud URLs (Firestore-sourced items) fall back to the media-proxy.
      const blob = await fetchLibraryBlob(it.url);
      if (!blob) throw new Error("fetch failed");
      const extGuess = it.kind === "image" ? "jpg" : (it.type === "video" ? "mp4" : "mp3");
      const fname = `${(it.label || it.kind).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48) || it.kind}.${extGuess}`;
      const file = new File([blob], fname, { type: blob.type || "application/octet-stream" });
      const result = await importMedia(file);
      if (result.success && result.actionId) tagImported(result.actionId, it.url, blob);
    } catch (e) {
      console.warn("[library] add-to-project failed:", e);
    } finally {
      setAddingId(null);
    }
  }, [importMedia, importedUrls, tagImported]);

  const deviceBlobUrl = useCallback(async (d: DeviceItem): Promise<string | null> => {
    if (d.objectUrl) return d.objectUrl;
    const blob = await loadMediaBlob(d.mediaId).catch(() => null);
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    deviceObjectUrls.current.push(u);
    setDeviceItems((prev) => prev.map((x) => (x.id === d.id ? { ...x, objectUrl: u } : x)));
    return u;
  }, []);

  const addDeviceToProject = useCallback(async (d: DeviceItem) => {
    const dedupeUrl = d.originalUrl || `device:${d.mediaId}`;
    if (importedUrls.has(dedupeUrl)) return;
    setAddingId(d.id);
    try {
      const blob = await loadMediaBlob(d.mediaId);
      if (!blob) throw new Error("blob missing from device storage");
      const ext = d.type === "image" ? "jpg" : d.type === "video" ? "mp4" : "mp3";
      const safe = d.label.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48) || d.type;
      const file = new File([blob], `${safe}.${ext}`, { type: blob.type || "application/octet-stream" });
      const result = await importMedia(file);
      if (result.success && result.actionId) tagImported(result.actionId, dedupeUrl, blob);
    } catch (e) {
      console.warn("[library] add-device-to-project failed:", e);
    } finally {
      setAddingId(null);
    }
  }, [importMedia, importedUrls, tagImported]);

  // Device items whose bytes already exist in the server library are noise.
  const serverUrls = useMemo(() => new Set(items.map((i) => i.url)), [items]);
  const visibleDeviceItems = useMemo(() => {
    const q = debounced.toLowerCase();
    return deviceItems.filter((d) =>
      (type === "all" || d.type === type)
      && (!d.originalUrl || !serverUrls.has(d.originalUrl))
      && (!q || d.label.toLowerCase().includes(q) || d.projectName.toLowerCase().includes(q)),
    );
  }, [deviceItems, type, debounced, serverUrls]);

  const sections = useMemo(() => {
    const by = new Map<string, LibItem[]>();
    for (const it of items) {
      const b = bucketOf(it.createdAt);
      const arr = by.get(b) ?? [];
      arr.push(it);
      by.set(b, arr);
    }
    return BUCKET_ORDER.filter((b) => (by.get(b) ?? []).length > 0).map((b) => ({ title: b, items: by.get(b)! }));
  }, [items]);

  const renderServerTile = (it: LibItem) => {
    const added = importedUrls.has(it.url);
    const isImage = it.type === "image";
    const isVideo = it.type === "video";
    const videoFailed = failedVideos.has(it.id);
    const thumbSrc = it.thumbnailUrl || it.url;
    const fullThumbSrc = /^https?:/i.test(thumbSrc) ? thumbSrc : `${apiBase()}${thumbSrc}`;
    return (
      <div
        key={it.id}
        role="button"
        tabIndex={0}
        // Cards drag to the timeline like native media. The drag carries the
        // RAW url (no ?t= — the fetch hook stamps it on drop); drops dedupe
        // by originalUrl so already-imported assets place instantly.
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/json",
            JSON.stringify({ libraryItem: { url: it.url, kind: it.kind, type: it.type, label: it.label } }),
          );
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => setPreviewItem({
          url: srcWithToken(it.url),
          editUrl: it.url,
          kind: (isImage ? "image" : isVideo ? "video" : "audio") as PreviewKind,
          name: it.label,
        })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPreviewItem({
              url: srcWithToken(it.url),
              editUrl: it.url,
              kind: (isImage ? "image" : isVideo ? "video" : "audio") as PreviewKind,
              name: it.label,
            });
          }
        }}
        title={`${it.label} — click to preview · drag onto the timeline to use${added ? " · already in this project" : ""}`}
        className={`group relative text-left rounded-lg overflow-hidden border transition-all cursor-grab active:cursor-grabbing ${
          added ? "border-primary/60" : "border-border hover:border-primary/60"
        } bg-background-tertiary`}
      >
        <div className="aspect-video bg-background-elevated flex items-center justify-center overflow-hidden">
          {isImage ? (
            <CachedThumb src={fullThumbSrc} alt={it.label} rev={rev} />
          ) : isVideo ? (
            // Poster-first: a cached server-extracted first frame (cheap,
            // robust). The <video> element is only mounted when no poster
            // could be produced — and range support on local-asset makes
            // that fallback actually render a frame now.
            it.thumbnailUrl ? (
              <CachedThumb
                src={fullThumbSrc}
                alt={it.label}
                rev={rev}
                fallback={videoFailed ? (
                  <Film size={22} className="text-primary/60" />
                ) : (
                  <video
                    src={srcWithToken(it.url)}
                    muted
                    preload="metadata"
                    className="w-full h-full object-cover"
                    onError={() => setFailedVideos((prev) => new Set(prev).add(it.id))}
                  />
                )}
              />
            ) : videoFailed ? (
              <Film size={22} className="text-primary/60" />
            ) : (
              <video
                src={srcWithToken(it.url)}
                muted
                preload="metadata"
                className="w-full h-full object-cover"
                onError={() => setFailedVideos((prev) => new Set(prev).add(it.id))}
              />
            )
          ) : it.thumbnailUrl ? (
            <CachedThumb src={/^https?:/i.test(it.thumbnailUrl) ? it.thumbnailUrl : `${apiBase()}${it.thumbnailUrl}`} alt={it.label} rev={rev} />
          ) : it.type === "music" ? (
            <Music2 size={22} className="text-primary/60" />
          ) : it.type === "voice" ? (
            <Mic size={22} className="text-primary/60" />
          ) : (
            <AudioLines size={22} className="text-primary/60" />
          )}
          {/* Edit-in-image-editor — images only, opens a new tab */}
          {isImage && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openInImageEditor(it.url); }}
              title="Edit in Image editor (new tab)"
              className="absolute top-1.5 left-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow bg-black/55 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80 transition-opacity"
            >
              <Pencil size={12} />
            </button>
          )}
          {/* add-to-Media affordance — explicit (click previews instead) */}
          <button
            type="button"
            disabled={added || addingId === it.id}
            onClick={(e) => { e.stopPropagation(); if (!added && addingId !== it.id) void addToProject(it); }}
            title={added ? "In this project's Media" : "Add to Media"}
            className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow ${
              added ? "bg-primary text-white" : "bg-black/55 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80"
            } transition-opacity`}
          >
            {addingId === it.id ? <Loader2 size={13} className="animate-spin" /> : added ? <Check size={13} /> : <Plus size={13} />}
          </button>
          {/* download with embedded metadata (title/artist/prompt/cover) */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void downloadItem(it); }}
            title="Download (with title, prompt & cover metadata)"
            className="absolute bottom-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow bg-black/55 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80 transition-opacity"
          >
            <Download size={12} />
          </button>
        </div>
        <div className="px-2 py-1.5">
          <p className="text-[11px] text-text-primary truncate">{it.label}</p>
          <p className="text-[10px] text-text-muted truncate">
            {it.type}{it.bytes ? ` · ${fmtBytes(it.bytes)}` : ""} · {sourceTag(it.projectId)}
          </p>
        </div>
      </div>
    );
  };

  const renderDeviceTile = (d: DeviceItem) => {
    const dedupeUrl = d.originalUrl || `device:${d.mediaId}`;
    const added = importedUrls.has(dedupeUrl);
    const isImage = d.type === "image";
    return (
      <div
        key={d.id}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => {
          // Drag needs a synchronously readable payload. Prefer the pre-minted
          // objectUrl (bytes guaranteed present in IndexedDB; deviceBlobUrl
          // mints it on hover) over originalUrl, which may point at a URL
          // that has since died — that's the "image got lost" failure mode.
          const url = d.objectUrl || d.originalUrl;
          if (!url) { e.preventDefault(); return; }
          e.dataTransfer.setData(
            "application/json",
            JSON.stringify({ libraryItem: { url, kind: d.kind, type: d.type, label: d.label } }),
          );
          e.dataTransfer.effectAllowed = "copy";
        }}
        onMouseEnter={() => { if (!d.objectUrl) void deviceBlobUrl(d); }}
        onClick={async () => {
          const u = (await deviceBlobUrl(d)) || d.originalUrl;
          if (!u) return;
          setPreviewItem({
            url: u.startsWith("blob:") || /^https?:/i.test(u) ? u : srcWithToken(u),
            kind: (isImage ? "image" : d.type === "video" ? "video" : "audio") as PreviewKind,
            name: d.label,
          });
        }}
        title={`${d.label} — from "${d.projectName}" on this device`}
        className={`group relative text-left rounded-lg overflow-hidden border transition-all cursor-grab active:cursor-grabbing ${
          added ? "border-primary/60" : "border-border hover:border-primary/60"
        } bg-background-tertiary`}
      >
        <div className="aspect-video bg-background-elevated flex items-center justify-center overflow-hidden">
          {d.dataThumb ? (
            <img src={d.dataThumb} alt={d.label} loading="lazy" className="w-full h-full object-cover" />
          ) : d.objectUrl && isImage ? (
            <img src={d.objectUrl} alt={d.label} loading="lazy" className="w-full h-full object-cover" />
          ) : isImage ? (
            <ImageIcon size={22} className="text-primary/60" />
          ) : d.type === "video" ? (
            <Film size={22} className="text-primary/60" />
          ) : d.type === "voice" ? (
            <Mic size={22} className="text-primary/60" />
          ) : (
            <Music2 size={22} className="text-primary/60" />
          )}
          <button
            type="button"
            disabled={added || addingId === d.id}
            onClick={(e) => { e.stopPropagation(); if (!added && addingId !== d.id) void addDeviceToProject(d); }}
            title={added ? "In this project's Media" : "Add to Media"}
            className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow ${
              added ? "bg-primary text-white" : "bg-black/55 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80"
            } transition-opacity`}
          >
            {addingId === d.id ? <Loader2 size={13} className="animate-spin" /> : added ? <Check size={13} /> : <Plus size={13} />}
          </button>
        </div>
        <div className="px-2 py-1.5">
          <p className="text-[11px] text-text-primary truncate">{d.label}</p>
          <p className="text-[10px] text-text-muted truncate">{d.type} · {d.projectName}</p>
        </div>
      </div>
    );
  };

  const sectionHeader = (title: string, count: number, Icon?: typeof Film) => {
    const isCollapsed = collapsed.has(title);
    return (
      <button
        type="button"
        onClick={() => toggleSection(title)}
        title={isCollapsed ? "Expand section" : "Collapse section"}
        className="sticky top-0 z-[1] -mx-1 px-1 py-1 w-[calc(100%+0.5rem)] text-left bg-background-secondary/95 backdrop-blur-sm"
      >
        <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted flex items-center gap-1.5">
          {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          {Icon ? <Icon size={11} /> : null}
          {title}
          <span className="font-normal opacity-70">({count})</span>
        </p>
      </button>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Search + refresh */}
      <div className="px-5 mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted z-10" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your generations…"
            className="w-full pl-9 pr-3 text-xs bg-background-tertiary border border-border rounded-md text-text-primary h-9 focus:outline-none focus:border-primary"
          />
        </div>
        <button
          type="button"
          onClick={() => { void caches.delete(THUMB_CACHE).catch(() => {}); setRev((r) => r + 1); void load(0, true); void loadDevice(); }}
          title="Refresh library"
          className="w-9 h-9 flex items-center justify-center rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
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
        ) : items.length === 0 && visibleDeviceItems.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <AudioLines size={28} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">No generations yet</p>
            <p className="text-[11px] mt-1">Generated SFX, music, images and videos show up here — reuse them in any project without regenerating.</p>
          </div>
        ) : (
          <>
            {sections.map((s) => (
              <div key={s.title} className="mb-3">
                {sectionHeader(s.title, s.items.length)}
                {!collapsed.has(s.title) && (
                  <div
                    className="grid gap-2 mt-1"
                    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(0, 150px))" }}
                  >
                    {s.items.map(renderServerTile)}
                  </div>
                )}
              </div>
            ))}
            {visibleDeviceItems.length > 0 && (
              <div className="mb-3">
                {sectionHeader("On this device", visibleDeviceItems.length, HardDrive)}
                {!collapsed.has("On this device") && (
                  <div
                    className="grid gap-2 mt-1"
                    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(0, 150px))" }}
                  >
                    {visibleDeviceItems.map(renderDeviceTile)}
                  </div>
                )}
              </div>
            )}
            {total > items.length && (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void load(items.length)}
                className="w-full mt-1 py-2 text-[11px] font-medium rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors flex items-center justify-center gap-2"
              >
                {loadingMore ? <Loader2 size={12} className="animate-spin" /> : null}
                Load more ({items.length} of {total})
              </button>
            )}
          </>
        )}
      </div>
      {previewItem && (
        <MediaPreviewOverlay
          url={previewItem.url}
          editUrl={previewItem.editUrl}
          kind={previewItem.kind}
          name={previewItem.name}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </div>
  );
};
