import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Loader2, Plus, Check, Film, Music2, Image as ImageIcon, AudioLines, Mic, Pencil, HardDrive, Cloud, Star, Filter, Upload, RefreshCw, LayoutGrid, Grid2x2, List, ChevronDown, ChevronRight, Download, Settings2, X } from "lucide-react";
import { useVoidspaceStore } from "../../stores/voidspace-store";
import { useProjectStore } from "../../stores/project-store";
import { saveMediaBlob, loadMediaBlob } from "../../services/media-storage";
import { checkForRecovery, recoverProject } from "../../services/auto-save";
import { MediaPreviewOverlay, type PreviewKind } from "./MediaPreviewOverlay";
import { usePlayableVideo } from "../../services/video-playback";

/**
 * Library tab — the user's CROSS-PROJECT asset library. Two tabs (below),
 * five underlying sources:
 *   1. GET /api/studio/library — the user's own server-side store (disk
 *      partition manifests + Firestore generated media: agent chat, app,
 *      automation, finalized songs). Tab: My files.
 *   2. GET /api/media-library/search — the media library on disk (sfx, music,
 *      footage, stills, HDRI, LUTs, fonts, templates), shown whole and unsplit
 *      as "My files". Scope: myfiles.
 *   3. "On this device" — media saved inside THIS browser's other projects
 *      (IndexedDB), surfaced so locally-imported assets are never invisible.
 *      Tab: My files.
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

/**
 * WHERE the assets come from. A SCOPE, deliberately not a tab.
 *
 * A "Cloud" tab used to exist here and was removed as redundant once
 * /api/studio/library began unioning the automation scene tree. Re-adding a tab
 * per source would repeat that mistake: the user does not think "which library?",
 * they think "my stuff". Same activity, different source — a filter, not a tab.
 *
 *   generated — the user's own generated media, renders, uploads.
 *               /api/studio/library (unions cloud + local-disk manifests).
 *   myfiles   — the on-disk media library: sfx, music, footage, stills, HDRI,
 *               LUTs, fonts, templates. EVERYTHING in it, unsplit.
 *   device    — media inside other projects saved in THIS browser (IndexedDB).
 *
 * WHY THERE IS NO "LICENSED" SCOPE (removed 2026-07-30)
 * A `Licensed` pill briefly split the library by `license.type === 'licensed-stock'`.
 * It was removed because that field was WRONG for most of the catalogue — VFX-Triune,
 * much of the sfx and bgm, and others were marked licensed-stock without a licence
 * actually having been verified. A UI that labels an asset "Licensed to you" on bad
 * data is worse than no label: it invites the user to rely on rights they may not
 * hold. The honest state is one undivided "My files", with provenance recorded in
 * the catalogue (`license.type: 'unknown'` + a confirm-before-selling note) rather
 * than asserted in the interface.
 *
 * WHY THERE IS NO "SHARED ASSETS" TAB (removed 2026-07-30)
 * It would only ever list OTHER accounts' public uploads, and nothing is public
 * while the library is local-only — so it shipped permanently empty. Removed until
 * cloud sync exists and there is something real to show. The server-side
 * `scope=shared` filter is retained (correct and tested) for when it returns.
 */
type LibScope = "generated" | "myfiles" | "device";

const SCOPE_PILLS: { id: LibScope; label: string; hint: string }[] = [
  { id: "generated", label: "Generated", hint: "AI generations and renders from your projects" },
  { id: "myfiles",   label: "My files",  hint: "Your media library on this machine — sfx, music, footage, stills, HDRI, fonts" },
  { id: "device",    label: "This browser", hint: "Media in other projects saved in this browser" },
];

/** Which scopes read the shared media library (vs the generations store / IndexedDB). */
const LIBRARY_SCOPES: LibScope[] = ["myfiles"];

interface LibItem {
  id: string;
  type: string;
  kind: string;
  label: string;
  url: string;            // /api/studio/local-asset?... OR absolute cloud URL
  thumbnailUrl?: string;  // compressed (`w=`) variant for grids
  /** Transcoded H.264 fallback for videos whose master codec (ProRes/DNxHD
   *  .mov, common in stock packs) no browser can decode natively. Only set
   *  for shared-library items — /api/studio/library has no such field. */
  proxyUrl?: string | null;
  bytes: number;
  createdAt: string;
  projectId: string;
  // Download-metadata (embedded into the saved file by /api/studio/download):
  title?: string;
  artist?: string;
  prompt?: string;
  coverUrl?: string;
  mood?: string;
  sceneNumber?: number;
  // ── Personal signals (media-library items only). Private to this user. ──
  favorite?: boolean;
  personalRating?: number;
  myTags?: string[];
  useCount?: number;
  // ── Derived facets, computed server-side. ──
  orientation?: string | null;
  durationBand?: string | null;
  resolutionTier?: string | null;
  /** Best available date, and whether it is a real capture time. An approximate
   *  date must never be rendered as though it were exact. */
  dateForSort?: string | null;
  dateIsApprox?: boolean;
}

/** Quick filters — the answer to "never open on everything". */
type QuickFilter = "none" | "favourites" | "used" | "recent";

const QUICK_FILTERS: { id: QuickFilter; label: string; hint: string }[] = [
  { id: "favourites", label: "★ Favourites", hint: "Assets you starred" },
  { id: "used",       label: "Most used",    hint: "What you keep coming back to — counted automatically" },
  { id: "recent",     label: "Newest",       hint: "Most recent first, by capture date where known" },
];

/**
 * Facet groups the server reports counts for.
 *
 * `types` is which type filters the group is MEANINGFUL for. Without it, "All"
 * showed audio duration bands next to image resolutions — 16 chips over three
 * rows, most irrelevant to whatever the user was actually looking for, pushing
 * the grid off screen. A resolution band means nothing for a sound effect.
 */
const DERIVED_FACET_GROUPS: {
  key: string;
  title: string;
  labels: Record<string, string>;
  /** Order to render values in — NOT count order, which reshuffles as you filter
   *  and makes the control feel unstable. Duration and resolution are ordinal. */
  order?: string[];
  types: LibType[];
}[] = [
  {
    key: "orientation", title: "Shape",
    labels: { landscape: "Landscape", portrait: "Portrait", square: "Square" },
    order: ["landscape", "portrait", "square"],
    types: ["all", "video", "image"],
  },
  {
    key: "durationBand", title: "Length",
    labels: { stinger: "Under 1s", oneshot: "1-5s", short: "5-30s", medium: "30s-2m", long: "Over 2m" },
    order: ["stinger", "oneshot", "short", "medium", "long"],
    types: ["all", "video", "music", "sfx", "voice"],
  },
  {
    key: "resolutionTier", title: "Resolution",
    labels: { "8K": "8K", "4K": "4K", "1440p": "1440p", "1080p": "1080p", "720p": "720p", SD: "SD" },
    order: ["8K", "4K", "1440p", "1080p", "720p", "SD"],
    types: ["all", "video", "image"],
  },
];

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

/** Type pill → media-library `kind` group. The stock library uses richer kinds
 *  (`audio-sfx`, `visual-vfx`, …) and accepts a group prefix, so this keeps ONE
 *  type filter driving both scopes instead of showing the user two vocabularies. */
const LIB_KIND_FOR_TYPE: Record<LibType, string> = {
  all: "all",
  video: "visual",
  image: "visual-image",
  music: "audio-music",
  sfx: "audio-sfx",
  voice: "audio-voice",
};

/** Stock `kind` → the coarse type the rest of this panel (icons, drag payloads,
 *  preview routing) already understands. */
function libTypeOf(kind: string): string {
  if (kind === "visual-image" || kind === "visual-hdri" || kind === "visual-vector") return "image";
  if (kind === "visual-video" || kind === "visual-vfx") return "video";
  if (kind === "audio-music") return "music";
  if (kind === "audio-voice") return "voice";
  if (kind.startsWith("audio-")) return "sfx";
  return "video";
}

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

/** Which items can have their metadata edited (rename / prompt / mood), routed
 *  by /api/studio/library-item to the item's own source:
 *    gm|song|umusic  → user generations (Firestore)
 *    scene-vid|img|narr|sfx → scene subcollection docs
 *    local:          → the local-disk manifest entry
 *  Only scene-list-level field items (scene-ff / scene-*url / scene-music) and
 *  device-tab items aren't individually writable, so they get no gear. */
function isEditableItem(it: LibItem): boolean {
  return /^(gm|song|umusic|local|scene-vid|scene-img|scene-narr|scene-sfx):/.test(it.id);
}

/** Human tag for where an item came from — makes the grid scannable. */
function sourceTag(projectId: string): string {
  if (projectId === "chat-images") return "Chat";
  if (projectId === "generated-media") return "Agent";
  if (projectId === "user-music") return "Music";
  // Stock items carry a sentinel projectId because they belong to no project.
  // Returning "" (rather than letting the sentinel through) keeps `__stock__`
  // out of the tile subtitle — the scope pill already says where you are, so a
  // per-tile source tag would be redundant even if it were pretty.
  if (projectId === "__stock__") return "";
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
 * The tile's muted background-preview <video> (used only when no server
 * poster could be produced). A proper component, not inline JSX in a `.map`
 * callback, because it needs its own hook — `usePlayableVideo` falls back to
 * a transcoded proxy when the original master (ProRes/DNxHD .mov, common in
 * stock packs) plays fine for the server's thumbnailer but not for any
 * browser <video> element.
 */
function TileVideo({ src, proxySrc, onGiveUp }: { src: string; proxySrc?: string | null; onGiveUp: () => void }) {
  const { src: playable, onError, failed } = usePlayableVideo(src, proxySrc ?? null);
  useEffect(() => { if (failed) onGiveUp(); }, [failed, onGiveUp]);
  if (failed) return null;
  return (
    <video src={playable} muted preload="metadata" className="w-full h-full object-cover" onError={onError} />
  );
}

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
  // Persisted: the scope a user works in is a preference, and losing it on every
  // reload is the kind of small friction that makes a tool feel unfinished.
  const [scope, setScopeRaw] = useState<LibScope>(() => {
    try {
      const s = localStorage.getItem("voidspace.library.scope");
      // Migrate retired names so a returning user is not dropped on a scope that
      // no longer exists (which would render a permanently empty panel).
      //   mine/stock — the original two-scope naming
      //   licensed   — the removed provenance split, now folded into myfiles
      //   shared     — the removed Shared-assets tab
      const migrated = s === "mine" ? "generated"
        : (s === "stock" || s === "licensed" || s === "shared") ? "myfiles"
        : s;
      if (migrated === "generated" || migrated === "myfiles" || migrated === "device") return migrated;
    } catch { /* fresh default */ }
    return "generated";
  });
  const setScope = useCallback((s: LibScope) => {
    setScopeRaw(s);
    try { localStorage.setItem("voidspace.library.scope", s); } catch { /* ignore */ }
  }, []);
  // Upload state. `uploading` is a count so several files at once show one
  // honest "3 uploading" rather than flickering between names.
  const [uploading, setUploading] = useState(0);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** Whether a media library exists on the server at all (available:false). */
  const [libraryAvailable, setLibraryAvailable] = useState<boolean | null>(null);
  /** Where the library resolved to on the serving machine — /search always
   *  reports it, so we can show it and offer to open it. */
  // Kept for the empty state ("Looked in: …"). There is deliberately no
  // folder button here: the Assets header already has one, and two controls
  // doing the same thing in one panel is just clutter.
  const [libraryRoot, setLibraryRoot] = useState<string>("");

  /** Same three modes as the Media tab, so the two panels behave identically.
   *  Persisted separately: Explorer-style, a shelf remembers its own view. */
  const [viewMode, setViewModeRaw] = useState<"large" | "small" | "list">(() => {
    try {
      const v = localStorage.getItem("voidspace.library.viewMode");
      if (v === "large" || v === "small" || v === "list") return v;
    } catch { /* default */ }
    return "large";
  });
  const setViewMode = useCallback((v: "large" | "small" | "list") => {
    setViewModeRaw(v);
    try { localStorage.setItem("voidspace.library.viewMode", v); } catch { /* ignore */ }
  }, []);

  const [type, setType] = useState<LibType>("all");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  /** Quick filter — favourites / most-used / newest. Not persisted: it is a
   *  momentary "show me my good ones", not a standing preference. */
  const [quick, setQuick] = useState<QuickFilter>("none");
  /** Active derived-facet selections, e.g. { orientation: 'portrait' }. */
  const [facetSel, setFacetSel] = useState<Record<string, string>>({});
  /** Counts the server reports for the CURRENT result set. A group arrives empty
   *  when it cannot narrow, and we then render nothing for it. */
  const [derivedFacets, setDerivedFacets] = useState<Record<string, Record<string, number>>>({});
  const [personalCounts, setPersonalCounts] = useState<{ favorite: number; rated: number; used: number }>(
    { favorite: 0, rated: 0, used: 0 },
  );
  /** Optimistic favourite overrides, so a star fills the instant it is clicked
   *  rather than after a refetch. Keyed by asset id. */
  const [favOverride, setFavOverride] = useState<Record<string, boolean>>({});
  /** Is the grouped filter panel expanded? Collapsed by default — the point of
   *  the panel is that the toolbar stays short until the user asks for more. */
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Secondary mood filter (music) — the server returns the distinct moods
  // available for the current type/search so we can render them as chips.
  const [mood, setMood] = useState("");
  const [moods, setMoods] = useState<Array<{ label: string; count: number }>>([]);
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
  const [previewItem, setPreviewItem] = useState<{ url: string; editUrl?: string; kind: PreviewKind; name: string; coverUrl?: string; proxyUrl?: string | null } | null>(null);
  // Item whose metadata is being edited (rename / prompt / mood).
  const [editItem, setEditItem] = useState<LibItem | null>(null);
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
  // The FIRST load after the editor opens force-refreshes the server union
  // cache (?refresh=1) so a render the user just made — a fresh local-disk
  // write the 90s union cache hasn't picked up yet — shows immediately instead
  // of after the TTL. Subsequent filter/search changes reuse the cache.
  const forcedInitialLoad = useRef(false);

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
    // Scope is part of the cache key. Without it, switching Mine↔Stock would
    // show the other scope's tiles from cache — the exact "wrong stuff flashes
    // up" glitch the stale-while-revalidate cache exists to avoid.
    // Quick filter and facet selections are part of the key: without them,
    // switching to Favourites would show the unfiltered set from cache.
    const facetKey = Object.entries(facetSel).sort().map(([k, v]) => `${k}=${v}`).join(",");
    const cacheKey = `${scope}::${type}::${debounced}::${mood}::${quick}::${facetKey}`;
    if (offset === 0) {
      setError(null);
      // Show the last result for this filter INSTANTLY, then revalidate. Only
      // block with the spinner when we have nothing cached to show.
      const cached = libClientCache.get(cacheKey);
      if (cached) { setItems(cached.items); setTotal(cached.total); setLoading(false); }
      // No cache for this filter → CLEAR the previous filter's items now so the
      // grid doesn't keep showing (e.g.) video tiles after switching to Music
      // while the fetch is in flight. Shows the spinner instead — instant, clean.
      else { setItems([]); setTotal(0); setLoading(true); }
    } else { setLoadingMore(true); }
    try {
      const token = await useVoidspaceStore.getState().getIdToken();
      if (token) setMediaToken(token);

      // ── MY FILES: the on-disk media library, a different API with a different
      // item shape. Mapped onto LibItem here so every downstream renderer,
      // drag handler and importer keeps working untouched.
      //
      // Deliberately sends NO `provenance` filter: the library is shown whole.
      // It used to be split licensed-vs-own, which was dropped once the
      // `licensed-stock` flag turned out to be wrong across most of the
      // catalogue (see the LibScope comment).
      if (LIBRARY_SCOPES.includes(scope)) {
        const sq = new URLSearchParams({
          kind: LIB_KIND_FOR_TYPE[type] ?? "all",
          q: debounced,
          limit: String(PAGE_SIZE),
          offset: String(offset),
          facets: "0",              // tag-facet UI not built yet; skip that work
        });
        // Quick filters map onto server-side filters/sorts, never client-side —
        // filtering a page after the fact silently drops results and yields
        // short pages.
        if (quick === "favourites") sq.set("favourites", "1");
        else if (quick === "used") { sq.set("used", "1"); sq.set("sort", "used"); }
        else if (quick === "recent") sq.set("sort", "newest");
        for (const [k, v] of Object.entries(facetSel)) if (v) sq.set(k, v);

        const sres = await fetch(`${apiBase()}/api/media-library/search?${sq.toString()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!sres.ok) throw new Error(`stock ${sres.status}`);
        const sj = await sres.json();
        if (seq !== reqSeq.current) return;
        setLibraryAvailable(sj.available !== false);
        setLibraryRoot(typeof sj?.location?.root === "string" ? sj.location.root : "");
        setDerivedFacets(sj.derivedFacets && typeof sj.derivedFacets === "object" ? sj.derivedFacets : {});
        setPersonalCounts(sj.personalCounts || { favorite: 0, rated: 0, used: 0 });
        const page: LibItem[] = (Array.isArray(sj.items) ? sj.items : []).map((a: any) => ({
          id: a.id,
          type: libTypeOf(a.kind),
          kind: a.kind,
          // Prefer the REAL filename. The slug is a sanitised derivative, so a
          // photo called "IMG_2043.jpg" became "img-2043" and a file called "3.png"
          // became the tile label "3" — meaningless in a grid. originalName is what
          // the user recognises.
          label: a.originalName || a.slug || a.id,
          url: a.url,
          // hasRasterPreview=false (audio, 3D, fonts) means thumbUrl would return
          // a placeholder SVG. Leaving it undefined lets the existing kind-icon
          // fallback render instead, which reads as intentional rather than broken.
          thumbnailUrl: a.hasRasterPreview ? a.thumbUrl : undefined,
          proxyUrl: a.proxyUrl ?? null,
          bytes: a.bytes ?? 0,
          createdAt: a.addedAt || "",
          projectId: "__stock__",
          // Show the user's OWN tags first — they are the ones that mean
          // something to them — then fill with machine tags.
          prompt: [...(a.myTags || []), ...(Array.isArray(a.tags) ? a.tags : [])].slice(0, 6).join(", ") || undefined,
          favorite: a.favorite === true,
          personalRating: a.personalRating ?? 0,
          myTags: a.myTags ?? [],
          useCount: a.useCount ?? 0,
          orientation: a.orientation ?? null,
          durationBand: a.durationBand ?? null,
          resolutionTier: a.resolutionTier ?? null,
          dateForSort: a.dateForSort ?? null,
          dateIsApprox: a.dateIsApprox !== false,
        }));
        const nextTotal = typeof sj.total === "number" ? sj.total : page.length;
        setItems((prev) => (offset === 0 ? page : [...prev, ...page]));
        setTotal(nextTotal);
        if (offset === 0) {
          setMoods([]);
          libClientCache.set(cacheKey, { items: page, total: nextTotal, at: Date.now() });
        }
        return;
      }

      const qs = new URLSearchParams({
        outputDir: resolveOutputDir(),
        type,
        q: debounced,
        ...(mood ? { mood } : {}),
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
      if (offset === 0 && Array.isArray(j.moods)) setMoods(j.moods);
      if (offset === 0) libClientCache.set(cacheKey, { items: page, total: nextTotal, at: Date.now() });
    } catch (e: any) {
      // Keep any stale-but-shown results; only surface an error with nothing to show.
      if (seq === reqSeq.current && offset === 0 && !libClientCache.get(cacheKey)) {
        setError(e?.message ?? "Failed to load library");
      }
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [scope, type, debounced, mood, quick, facetSel]);

  /**
   * Star / un-star an asset.
   *
   * Optimistic: the star fills immediately and reverts only if the write fails.
   * Waiting on a round trip for a one-click action is exactly the friction that
   * stops people using favourites at all — and favourites only pay off if they
   * are cheap enough to use without thinking.
   *
   * Writes to /personal, NOT /rate: the latter is a public review, gated on
   * verified use and refusing self-rating. This is private organisation.
   */
  const toggleFavourite = useCallback(async (it: LibItem) => {
    const next = !(favOverride[it.id] ?? it.favorite ?? false);
    setFavOverride((p) => ({ ...p, [it.id]: next }));
    try {
      const token = await useVoidspaceStore.getState().getIdToken();
      const res = await fetch(`${apiBase()}/api/media-library/personal`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ id: it.id, favorite: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Keep the count in step so the Favourites chip doesn't lie until refetch.
      setPersonalCounts((c) => ({ ...c, favorite: Math.max(0, c.favorite + (next ? 1 : -1)) }));
    } catch {
      setFavOverride((p) => ({ ...p, [it.id]: !next }));   // revert; the write failed
    }
  }, [favOverride]);

  /**
   * Upload files into the library.
   *
   * Uploads land PRIVATE to the uploader (the server enforces this) and appear in
   * the "My files" scope. Deliberately switches scope on success: a file that
   * uploads while you are looking at "Generated" would otherwise vanish into a
   * scope you are not on, which reads as a failed upload.
   *
   * Files are sent one at a time rather than in one request — a single failure in
   * a batch of ten should not lose the other nine, and per-file progress is the
   * only honest thing to show.
   */
  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploadMsg(null);
    setUploading(files.length);
    let ok = 0, deduped = 0;
    const failures: string[] = [];
    try {
      const token = await useVoidspaceStore.getState().getIdToken();
      for (const f of files) {
        try {
          const fd = new FormData();
          fd.append("file", f, f.name);
          const res = await fetch(`${apiBase()}/api/media-library/upload`, {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: fd,
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) {
            // Surface the server's reason (unsupported type, no library, too big)
            // rather than a generic failure the user cannot act on.
            failures.push(`${f.name}: ${j?.statusMessage || j?.message || `HTTP ${res.status}`}`);
          } else if (j?.deduped) { deduped++; ok++; }
          else ok++;
        } catch (e: any) {
          failures.push(`${f.name}: ${e?.message ?? "upload failed"}`);
        } finally {
          setUploading((n) => Math.max(0, n - 1));
        }
      }
    } finally {
      setUploading(0);
    }

    const parts: string[] = [];
    if (ok) parts.push(`${ok} added${deduped ? ` (${deduped} already in library)` : ""}`);
    if (failures.length) parts.push(`${failures.length} failed`);
    setUploadMsg(parts.join(" · ") + (failures.length ? ` — ${failures[0]}` : ""));

    if (ok) {
      setScope("myfiles");       // where the upload actually lands
      libClientCache.clear();    // the SWR cache would otherwise hide it
      await load(0, true);
    }
  }, [load, setScope]);


  useEffect(() => {
    // Force ONCE on the initial mount (freshly opened editor) so just-rendered
    // clips are visible; after that, reactive reloads (filter/search) reuse the
    // union cache to avoid re-running the heavy scene scan every keystroke.
    const force = !forcedInitialLoad.current;
    forcedInitialLoad.current = true;
    void load(0, force);
  }, [load]);

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
        void load(0, true);
      };
    } catch { /* BroadcastChannel unsupported — manual refresh still works */ }
    return () => { try { bc?.close(); } catch { /* noop */ } };
  }, [load]);

  // ── New studio media (a HyperFrames render the agent/pipeline just made on
  //    the desktop) → force-refresh so it appears in the Library live, without
  //    waiting on the 90s server union cache or a manual refresh. The chat /
  //    pipeline broadcasts on this channel the moment a render lands on disk.
  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("voidspace-library");
      bc.onmessage = (ev: MessageEvent) => {
        const t = ev?.data?.type;
        if (t !== "library-updated" && t !== "render-complete") return;
        void load(0, true);   // refresh=1 busts the server union cache
        void loadDevice();
      };
    } catch { /* BroadcastChannel unsupported — mount-force + manual still work */ }
    return () => { try { bc?.close(); } catch { /* noop */ } };
  }, [load, loadDevice]);

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
  // Device items belong to the "This device" scope ONLY. They used to append to
  // every view; showing browser-local copies underneath server results made it
  // impossible to tell what was actually stored where.
  const visibleDeviceItems = useMemo(() => {
    if (scope !== "device") return [];
    const q = debounced.toLowerCase();
    return deviceItems.filter((d) =>
      (type === "all" || d.type === type)
      && (!d.originalUrl || !serverUrls.has(d.originalUrl))
      && (!q || d.label.toLowerCase().includes(q) || d.projectName.toLowerCase().includes(q)),
    );
  }, [scope, deviceItems, type, debounced, serverUrls]);

  /** Server-sourced items for the current scope. Empty on "This device", whose
   *  content comes entirely from IndexedDB. */
  const visibleItems = useMemo(() => (scope === "device" ? [] : items), [scope, items]);

  const sections = useMemo(() => {
    // Stock has no meaningful per-item timestamp (it is an ingested catalogue,
    // not a timeline of the user's work), so recency buckets would put 12,000
    // assets under a single "Older" header. One flat grid is the honest layout.
    if (LIBRARY_SCOPES.includes(scope)) {
      // An ingested catalogue has no meaningful per-item recency, so date buckets
      // would file everything under "Older". One flat grid is the honest layout.
      const title = "My files";
      return visibleItems.length ? [{ title, items: visibleItems }] : [];
    }
    const by = new Map<string, LibItem[]>();
    for (const it of visibleItems) {
      const b = bucketOf(it.createdAt);
      const arr = by.get(b) ?? [];
      arr.push(it);
      by.set(b, arr);
    }
    return BUCKET_ORDER.filter((b) => (by.get(b) ?? []).length > 0).map((b) => ({ title: b, items: by.get(b)! }));
  }, [scope, visibleItems]);

  /**
   * Facet groups worth offering right now. A group survives only if:
   *   1. it is MEANINGFUL for the active type (a resolution band says nothing
   *      about a sound effect), and
   *   2. the server reported more than one distinct value for it — one value
   *      cannot narrow, so the control would be decoration.
   */
  const availableFacetGroups = useMemo(() => {
    return DERIVED_FACET_GROUPS
      .filter((g) => g.types.includes(type))
      .map((g) => ({ ...g, values: (derivedFacets[g.key] || {}) as Record<string, number> }))
      .filter((g) => Object.keys(g.values).length > 1);
  }, [type, derivedFacets]);

  const facetCount = Object.keys(facetSel).length;

  // A facet selection that is no longer offered (the user switched type) would
  // otherwise keep filtering invisibly — the result set shrinks with no visible
  // cause. Drop any selection whose group is gone.
  useEffect(() => {
    const allowed = new Set(availableFacetGroups.map((g) => g.key));
    setFacetSel((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([k]) => allowed.has(k)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [availableFacetGroups]);

  /** Layout for the current view mode. `list` becomes a single column of rows;
   *  the two grid modes only differ by tile size, so the same tile is reused. */
  const gridStyle = viewMode === "list"
    ? { gridTemplateColumns: "1fr" }
    : { gridTemplateColumns: `repeat(auto-fill, minmax(0, ${viewMode === "small" ? 96 : 150}px))` };

  const renderServerTile = (it: LibItem) => {
    const added = importedUrls.has(it.url);
    const isImage = it.type === "image";
    const isVideo = it.type === "video";
    const videoFailed = failedVideos.has(it.id);
    const thumbSrc = it.thumbnailUrl || it.url;
    const fullThumbSrc = /^https?:/i.test(thumbSrc) ? thumbSrc : `${apiBase()}${thumbSrc}`;
    // WHERE this asset physically lives, derived from the URL shape rather than a
    // new API field: an absolute http(s) URL is in cloud storage, a relative
    // /api/studio/local-asset path is served off this machine's disk.
    //
    // Shown because it changes what the user can rely on: a local-only asset is
    // not available in another browser or on another device, and that is worth
    // knowing BEFORE building a project around it. Stock is always local, so the
    // badge would be noise on every tile there — hence `mine` only.
    const isCloud = /^https?:/i.test(it.url);
    const showStorageBadge = scope === "generated";
    // Favourites only exist for media-library items (the /personal endpoint is
    // keyed on a library asset id); generated + device items have no such id.
    const canFavourite = LIBRARY_SCOPES.includes(scope);
    const isFav = favOverride[it.id] ?? it.favorite ?? false;
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
          coverUrl: it.coverUrl ? srcWithToken(it.coverUrl) : undefined,
          proxyUrl: it.proxyUrl ? srcWithToken(it.proxyUrl) : null,
        })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPreviewItem({
              url: srcWithToken(it.url),
              editUrl: it.url,
              kind: (isImage ? "image" : isVideo ? "video" : "audio") as PreviewKind,
              name: it.label,
              coverUrl: it.coverUrl ? srcWithToken(it.coverUrl) : undefined,
              proxyUrl: it.proxyUrl ? srcWithToken(it.proxyUrl) : null,
            });
          }
        }}
        title={`${it.label} — click to preview · drag onto the timeline to use${added ? " · already in this project" : ""}`}
        className={`group relative text-left rounded-lg overflow-hidden border transition-all cursor-grab active:cursor-grabbing ${
          viewMode === "list" ? "flex items-center gap-2 p-1.5" : ""
        } ${
          added ? "border-primary/60" : "border-border hover:border-primary/60"
        } bg-background-tertiary`}
      >
        {showStorageBadge && (
          <div
            className="absolute top-1 left-1 z-10 flex items-center gap-0.5 px-1.5 py-0.5 rounded
                       bg-black/65 backdrop-blur-sm text-[9px] font-medium text-white/90 pointer-events-none"
            title={isCloud
              ? "In cloud storage — available on any device"
              : "On this machine only — not available on your other devices"}
          >
            {isCloud ? <Cloud size={9} /> : <HardDrive size={9} />}
            {isCloud ? "Cloud" : "Local"}
          </div>
        )}
        {/* Star. Always visible once set (it is information), fades in on hover
            when unset (it is an offer). Stops propagation so starring never
            opens the preview. */}
        {canFavourite && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void toggleFavourite(it); }}
            title={isFav ? "Starred — click to remove" : "Star this so it's easy to find again"}
            aria-label={isFav ? "Remove star" : "Add star"}
            aria-pressed={isFav}
            className={`absolute top-1 right-1 z-20 w-6 h-6 rounded-full flex items-center justify-center
                        transition-all ${
              isFav
                ? "bg-black/60 text-amber-400 opacity-100"
                : "bg-black/50 text-white/70 opacity-0 group-hover:opacity-100 hover:text-amber-300"
            }`}
          >
            <Star size={12} fill={isFav ? "currentColor" : "none"} />
          </button>
        )}
        <div className={`bg-background-elevated flex items-center justify-center overflow-hidden ${
          viewMode === "list" ? "w-14 h-9 shrink-0 rounded" : "aspect-video"
        }`}>
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
                  <TileVideo
                    src={srcWithToken(it.url)}
                    proxySrc={it.proxyUrl ? srcWithToken(it.proxyUrl) : null}
                    onGiveUp={() => setFailedVideos((prev) => new Set(prev).add(it.id))}
                  />
                )}
              />
            ) : videoFailed ? (
              <Film size={22} className="text-primary/60" />
            ) : (
              <TileVideo
                src={srcWithToken(it.url)}
                proxySrc={it.proxyUrl ? srcWithToken(it.proxyUrl) : null}
                onGiveUp={() => setFailedVideos((prev) => new Set(prev).add(it.id))}
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
          {/* Edit metadata (rename / prompt / mood) — replaces the old
              "add to Media" +; items are still added by dragging onto the
              timeline. Only user-owned generations are editable. */}
          {isEditableItem(it) && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setEditItem(it); }}
              title="Edit name & metadata"
              className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow bg-black/55 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80 transition-opacity"
            >
              <Settings2 size={12} />
            </button>
          )}
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
        <div className={viewMode === "list" ? "flex-1 min-w-0" : "px-2 py-1.5"}>
          <p className="text-[11px] text-text-primary truncate">{it.label}</p>
          <p className="text-[10px] text-text-muted truncate">
            {/* Separator is conditional: stock items have no source tag, and a
                hardcoded " · " left a dangling dot on every stock tile. */}
            {it.type}{it.bytes ? ` · ${fmtBytes(it.bytes)}` : ""}
            {sourceTag(it.projectId) ? ` · ${sourceTag(it.projectId)}` : ""}
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
          viewMode === "list" ? "flex items-center gap-2 p-1.5" : ""
        } ${
          added ? "border-primary/60" : "border-border hover:border-primary/60"
        } bg-background-tertiary`}
      >
        <div className={`bg-background-elevated flex items-center justify-center overflow-hidden ${
          viewMode === "list" ? "w-14 h-9 shrink-0 rounded" : "aspect-video"
        }`}>
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
        <div className={viewMode === "list" ? "flex-1 min-w-0" : "px-2 py-1.5"}>
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
      {/* Scope — WHERE the assets come from. A single segmented control: one
          coarse choice, then narrow by kind below. Everything here is the user's
          own; there is no public/shared destination while the library is
          local-only, so there is no second level to pick. */}
      <div className="px-5 mb-2">
        <div
          role="tablist"
          aria-label="Library scope"
          className="flex p-0.5 gap-0.5 bg-background-tertiary border border-border rounded-lg"
        >
          {SCOPE_PILLS.map(({ id, label, hint }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={scope === id}
              onClick={() => setScope(id)}
              title={hint}
              className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                scope === id
                  ? "bg-primary/15 text-primary"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Search + refresh */}
      <div className="px-5 mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted z-10" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              scope === "myfiles" ? "Search sfx, music, footage, stills…"
                : scope === "device" ? "Search media in this browser…"
                  : "Search your generations…"
            }
            className="w-full pl-9 pr-3 text-xs bg-background-tertiary border border-border rounded-md text-text-primary h-9 focus:outline-none focus:border-primary"
          />
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading > 0}
          title="Add files to your library — they stay private to you"
          className="h-9 px-2.5 flex items-center gap-1.5 rounded-md border border-border text-[11px] font-medium
                     text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors disabled:opacity-50"
        >
          {uploading > 0
            ? <><Loader2 size={13} className="animate-spin" />{uploading}</>
            : <><Upload size={13} />Add</>}
        </button>
        {/* Identical markup/classes to the Media tab's control — one visual
            language for "how do I want this laid out". */}
        <div className="flex items-center bg-background-tertiary border border-border rounded-lg p-0.5">
          {([
            { mode: "large" as const, icon: LayoutGrid, title: "Large icons" },
            { mode: "small" as const, icon: Grid2x2, title: "Small icons" },
            { mode: "list" as const, icon: List, title: "List view" },
          ]).map(({ mode, icon: ViewIcon, title }) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              title={title}
              className={`p-1.5 rounded transition-colors ${
                viewMode === mode
                  ? "bg-background-elevated text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              <ViewIcon size={13} />
            </button>
          ))}
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
      <div className="px-5 mb-2 flex flex-wrap gap-1.5">
        {TYPE_PILLS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => { setType(id); setMood(""); }}
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

      {/* QUICK FILTERS + DERIVED FACETS — the narrowing row.
          Only rendered for the media library (the generations store and
          IndexedDB have neither personal signals nor server-computed facets).

          Each control is shown ONLY when it can actually change the result:
          Favourites appears once something is starred, Most-used once something
          has been used, and a facet group only when the server reports more than
          one distinct value for it. A filter that cannot narrow is worse than no
          filter — the user still has to read it. */}
      {LIBRARY_SCOPES.includes(scope) && (
        <div className="px-5 mb-2 flex flex-wrap items-center gap-1.5">
          {QUICK_FILTERS.map(({ id, label, hint }) => {
            // Hide a quick filter with nothing behind it.
            if (id === "favourites" && !personalCounts.favorite && quick !== "favourites") return null;
            if (id === "used" && !personalCounts.used && quick !== "used") return null;
            const on = quick === id;
            const count = id === "favourites" ? personalCounts.favorite : id === "used" ? personalCounts.used : 0;
            return (
              <button
                key={id}
                type="button"
                title={hint}
                onClick={() => setQuick(on ? "none" : id)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                  on
                    ? "bg-amber-400/15 border-amber-400/70 text-amber-300"
                    : "bg-background-tertiary border-border text-text-secondary hover:border-text-muted"
                }`}
              >
                {label}{count ? ` (${count})` : ""}
              </button>
            );
          })}

          {/* Everything else lives behind ONE button. Rendering every facet
              inline cost three rows of 16 chips and pushed the grid off screen —
              the opposite of helping. The badge carries how many are active so a
              collapsed panel never hides state. */}
          {availableFacetGroups.length > 0 && (
            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              title="More ways to narrow this list"
              aria-expanded={filtersOpen}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                filtersOpen || facetCount > 0
                  ? "bg-primary/15 border-primary text-primary"
                  : "bg-background-tertiary border-border text-text-secondary hover:border-text-muted"
              }`}
            >
              <Filter size={11} />
              Filters{facetCount > 0 ? ` (${facetCount})` : ""}
              {filtersOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          )}

          {(quick !== "none" || facetCount > 0) && (
            <button
              type="button"
              onClick={() => { setQuick("none"); setFacetSel({}); }}
              title="Clear filters"
              className="px-2 py-1 rounded-full text-[11px] font-medium text-text-muted hover:text-text-primary transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* The filter panel. Grouped under headings, because a bare chip reading
          "Under 1s" next to one reading "4K" is not self-explanatory. Values keep
          their natural ORDINAL order rather than count order — a control whose
          buttons reshuffle every time you touch it feels broken. */}
      {LIBRARY_SCOPES.includes(scope) && filtersOpen && availableFacetGroups.length > 0 && (
        <div className="px-5 mb-2 pb-2 space-y-2 border-b border-border/60">
          {availableFacetGroups.map(({ key, title, labels, order, values }) => {
            const active = facetSel[key];
            const keys = order
              ? order.filter((k) => values[k] != null)
              : Object.keys(values);
            return (
              <div key={key}>
                <p className="text-[10px] uppercase tracking-wide text-text-muted mb-1">{title}</p>
                <div className="flex flex-wrap gap-1.5">
                  {keys.map((val) => {
                    const n = values[val];
                    const on = active === val;
                    return (
                      <button
                        key={val}
                        type="button"
                        title={`${n} match${n === 1 ? "" : "es"}`}
                        onClick={() => setFacetSel((p) => {
                          const next = { ...p };
                          if (on) delete next[key]; else next[key] = val;
                          return next;
                        })}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                          on
                            ? "bg-primary/15 border-primary text-primary"
                            : "bg-background-tertiary border-border text-text-secondary hover:border-text-muted"
                        }`}
                      >
                        {labels[val] || val} <span className="opacity-60">{n}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Mood chips — a secondary filter for music so a big catalogue is easy
          to browse by feel. Only shown when Music is active and the server
          surfaced moods. Horizontally scrollable so it never wraps huge. */}
      {type === "music" && moods.length > 0 && (
        <div className="px-5 mb-3 flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
          <button
            onClick={() => setMood("")}
            className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
              !mood
                ? "bg-accent/15 border-accent text-accent"
                : "bg-background-tertiary border-border text-text-secondary hover:border-text-muted"
            }`}
          >
            All moods
          </button>
          {moods.map((m) => {
            const active = mood.toLowerCase() === m.label.toLowerCase();
            return (
              <button
                key={m.label}
                onClick={() => setMood(active ? "" : m.label)}
                title={`${m.count} track${m.count === 1 ? "" : "s"}`}
                className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium border capitalize transition-colors ${
                  active
                    ? "bg-accent/15 border-accent text-accent"
                    : "bg-background-tertiary border-border text-text-secondary hover:border-text-muted"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Hidden picker driven by the Add button. `multiple` because people add a
          folder's worth of sfx at once, not one file. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";          // allow re-picking the same file
          void uploadFiles(files);
        }}
      />

      {/* Result line. Stays until the next upload so a failure reason can be read
          — a toast that vanishes is useless for "why did that fail?". */}
      {uploadMsg && (
        <div className="px-5 pb-2 flex items-start gap-2">
          <p className="text-[10px] text-text-muted leading-relaxed flex-1">{uploadMsg}</p>
          <button type="button" onClick={() => setUploadMsg(null)}
            className="text-text-muted hover:text-text-primary" title="Dismiss">
            <X size={11} />
          </button>
        </div>
      )}

      {/* Grid — also the DROP TARGET. Dropping onto the panel you are already
          looking at is the shortest path from "file on my desktop" to "in my
          library"; the Add button is the discoverable equivalent. */}
      <div
        className={`flex-1 overflow-y-auto px-5 pb-5 min-h-0 relative ${
          dragOver ? "outline outline-2 outline-primary/60 outline-offset-[-8px] rounded-lg" : ""
        }`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;   // ignore tile drags
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          // Only clear when the pointer actually leaves the panel, not on every
          // child boundary crossing (which makes the outline strobe).
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(false);
          void uploadFiles(Array.from(e.dataTransfer.files ?? []));
        }}
      >
        {dragOver && (
          <div className="absolute inset-2 z-20 flex items-center justify-center pointer-events-none
                          rounded-lg bg-background-elevated/80 backdrop-blur-sm border border-primary/40">
            <p className="text-xs text-primary font-medium">Drop to add to your library</p>
          </div>
        )}
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-text-muted gap-2 text-xs">
            <Loader2 size={16} className="animate-spin" /> Loading your library…
          </div>
        ) : error ? (
          <div className="text-xs text-error py-8 text-center">{error}</div>
        ) : LIBRARY_SCOPES.includes(scope) && libraryAvailable === false ? (
          /* No library on this machine at all. A specific, actionable message —
             an empty grid here would read as "the library is broken". */
          <div className="text-center py-12 text-text-muted">
            <HardDrive size={28} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">No media library on this machine</p>
            <p className="text-[11px] mt-1 leading-relaxed">
              The library is a folder of media on this machine — sfx, music, footage,
              stills, 3D, LUTs, fonts — read from the machine running Voidspace.
              <br />
              Set its location in the desktop app under Settings → Media Library Folder.
            </p>
            {libraryRoot && (
              <p className="text-[10px] mt-3 font-mono opacity-70 break-all px-6">
                Looked in: {libraryRoot}
              </p>
            )}
          </div>
        ) : visibleItems.length === 0 && visibleDeviceItems.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <AudioLines size={28} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">
              {scope === "myfiles" ? "No files of this type yet"
                : scope === "device" ? "No media saved in this browser"
                  : "No generations yet"}
            </p>
            <p className="text-[11px] mt-1">
              {scope === "myfiles"
                ? "Try a different search or type filter."
                : scope === "device"
                  ? "Media you import into projects in this browser shows up here."
                  : "Generated SFX, music, images and videos show up here — reuse them in any project without regenerating."}
            </p>
          </div>
        ) : (
          <>
            {sections.map((s) => (
              <div key={s.title} className="mb-3">
                {sectionHeader(s.title, s.items.length)}
                {!collapsed.has(s.title) && (
                  <div
                    className="grid gap-2 mt-1"
                    style={gridStyle}
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
                    style={gridStyle}
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
          coverUrl={previewItem.coverUrl}
          proxyUrl={previewItem.proxyUrl}
          onClose={() => setPreviewItem(null)}
        />
      )}
      {editItem && (
        <LibraryItemEditor
          item={editItem}
          onClose={() => setEditItem(null)}
          onSaved={() => { setEditItem(null); void load(0, true); }}
        />
      )}
    </div>
  );
};

/**
 * Small modal to rename a Library item + refine its prompt/mood — the metadata
 * that drives search + agent findability. Persists to the item's own source
 * via /api/studio/library-item, then triggers a forced Library refresh.
 */
const LibraryItemEditor: React.FC<{
  item: LibItem;
  onClose: () => void;
  onSaved: () => void;
}> = ({ item, onClose, onSaved }) => {
  const [title, setTitle] = useState(item.title || item.label || "");
  const [prompt, setPrompt] = useState(item.prompt || "");
  const [mood, setMood] = useState(item.mood || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const token = await useVoidspaceStore.getState().getIdToken();
      const res = await fetch(`${apiBase()}/api/studio/library-item`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ id: item.id, title, prompt, mood }),
      });
      if (!res.ok) throw new Error(`save ${res.status}`);
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to save");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-background-secondary border border-border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">Edit media details</h3>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-medium text-text-secondary">Name</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Give this a clear name"
              className="mt-1 w-full px-3 py-2 rounded-lg bg-background-tertiary border border-border text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium text-text-secondary">Prompt / description</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="What is this? (helps you + the agent find it)"
              className="mt-1 w-full px-3 py-2 rounded-lg bg-background-tertiary border border-border text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none resize-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium text-text-secondary">Mood / style</span>
            <input
              value={mood}
              onChange={(e) => setMood(e.target.value)}
              placeholder="e.g. calm, energetic, cinematic"
              className="mt-1 w-full px-3 py-2 rounded-lg bg-background-tertiary border border-border text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none"
            />
          </label>
          {err ? <p className="text-[11px] text-error">{err}</p> : null}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-60 transition-colors inline-flex items-center gap-1.5"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
