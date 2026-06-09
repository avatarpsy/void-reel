/**
 * media-relink — resolve "lost" media items back to real files by
 * pointing at a folder, the way Premiere/Resolve relink works.
 *
 * The hard part is MATCHING. A placeholder media item can carry very
 * different identifying info depending on where it came from:
 *
 *   • User-imported files  → `sourceFile { name, size }` (reliable).
 *   • Voidspace scene media → `originalUrl`, `category`, `sceneNumber`,
 *     `role`, and a structured `id` (`media-video-<doc>-<assetId>`).
 *     These NEVER set `sourceFile`, and after a temp-URL expiry their
 *     `fileSize` is 0 — so name/size matching alone finds nothing.
 *
 * Voidspace mirrors generated assets to disk with a self-describing
 * layout (see server `mirror-asset.post.ts`):
 *
 *   <root>/voidspace-projects/<projectId>/
 *     ├── videos/scene-<n>-<assetId>.mp4
 *     ├── frames/scene-<n>-<role>-<assetId>.jpg
 *     ├── narrations/scene-<n>-<assetId>.mp3
 *     ├── music/bgm-<assetId>.mp3
 *     └── manifest.json   ← authoritative index of every mirror call
 *
 * So we walk the picked folder RECURSIVELY, read any `manifest.json`,
 * and match each item with a layered strategy (best signal first):
 *
 *   1. manifest by source/permanent URL          (exact)
 *   2. manifest by assetId embedded in item.id   (exact)
 *   3. manifest by sceneNumber + role + kind      (strong)
 *   4. sourceFile name + size                      (exact, user imports)
 *   5. originalUrl basename                        (strong)
 *   6. structural filename `scene-<n>` + kind      (strong)
 *   7. sourceFile name only                        (medium)
 *   8. exact unique file size                       (medium)
 *   9. name slug ("Scene 1 · Video" → "scene-1")   (weak)
 *
 * All scoring is pure and unit-tested; the folder walk is the only
 * impure part. Each file is assigned to at most one item (greedy by
 * descending confidence) so two scenes never grab the same clip.
 */

/** The subset of a MediaItem this matcher needs. Kept structural so it
 *  doesn't couple to @openreel/core's full MediaItem (and is trivial to
 *  build in tests). */
export interface RelinkableItem {
  id: string;
  name: string;
  type: "video" | "audio" | "image";
  originalUrl?: string;
  category?: string;
  sceneNumber?: number;
  role?: string;
  /** metadata.fileSize — often 0 for expired Voidspace media. */
  fileSize?: number;
  sourceFile?: { name: string; size: number; folder?: string };
}

/** A file discovered while walking the picked folder. */
export interface IndexedFile {
  /** Lowercased basename, e.g. "scene-1-abc.mp4". */
  name: string;
  /** POSIX-style path relative to the picked root, e.g. "videos/scene-1-abc.mp4". */
  relPath: string;
  /** Lowercased immediate parent folder name, e.g. "videos" (""=root). */
  parentDir: string;
  size: number;
  handle: FileSystemFileHandle;
  /** The resolved File (read once during the walk so apply needn't re-getFile). */
  file: File;
}

/** One entry from a mirror manifest.json. */
export interface ManifestEntry {
  kind?: string;
  sceneNumber?: number;
  assetId?: string;
  role?: string;
  sourceUrl?: string;
  permanentUrl?: string;
  localPath?: string;
  bytes?: number;
}

export interface ParsedManifest {
  project?: string;
  entries: ManifestEntry[];
}

export interface MediaMatch {
  itemId: string;
  file: IndexedFile;
  strategy: string;
  /** 0–100; higher wins when two items contend for the same file. */
  confidence: number;
}

export interface RelinkPlan {
  matches: MediaMatch[];
  /** item ids with no confident match. */
  unmatchedItemIds: string[];
}

// ── kind helpers ───────────────────────────────────────────────────

export type MediaKind = "video" | "image" | "narration" | "music" | "audio";

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "mkv"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"]);

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Classify a media item into a mirror "kind". Audio splits into
 *  narration vs music by role/category; everything else is by type. */
export function kindForItem(item: RelinkableItem): MediaKind {
  if (item.type === "video") return "video";
  if (item.type === "image") return "image";
  // audio
  const role = (item.role || "").toLowerCase();
  const cat = (item.category || "").toLowerCase();
  if (role === "music" || cat === "music") return "music";
  if (role === "narration" || cat.includes("narration")) return "narration";
  return "audio";
}

/** Classify a discovered file by its parent folder (preferred — matches
 *  the mirror layout) then by extension. */
export function kindForFile(file: { name: string; parentDir: string }): MediaKind {
  switch (file.parentDir) {
    case "videos":
    case "renders":
      return "video";
    case "frames":
      return "image";
    case "narrations":
      return "narration";
    case "music":
      return "music";
  }
  const e = ext(file.name);
  if (VIDEO_EXTS.has(e)) return "video";
  if (IMAGE_EXTS.has(e)) return "image";
  if (AUDIO_EXTS.has(e)) return "audio";
  return "audio";
}

/** Family-level compatibility: a narration item matches an `audio`
 *  file (we couldn't tell narration from music by extension alone), and
 *  a `video`/`image` file must match its own family exactly. */
export function kindsCompatible(a: MediaKind, b: MediaKind): boolean {
  if (a === b) return true;
  const audio = (k: MediaKind) => k === "narration" || k === "music" || k === "audio";
  if (audio(a) && audio(b)) {
    // narration vs music: only "audio" (unknown) bridges the two;
    // narration↔music are NOT interchangeable.
    return a === "audio" || b === "audio";
  }
  return false;
}

// ── url / filename helpers ─────────────────────────────────────────

/** Pull useful hints out of an asset URL. Handles the Voidspace
 *  `/api/studio/local-asset?...&filename=...&original=<gcsUrl>` proxy
 *  shape as well as plain CDN URLs. */
export function parseUrlHints(url?: string): { basename?: string; original?: string } {
  if (!url) return {};
  try {
    const u = new URL(url, "http://_local_");
    const fnParam = u.searchParams.get("filename") || undefined;
    const origParam = u.searchParams.get("original") || undefined;
    const base = decodeURIComponent(u.pathname.split("/").pop() || "") || undefined;
    return { basename: (fnParam || base)?.toLowerCase(), original: origParam };
  } catch {
    const base = url.split("?")[0].split("/").pop();
    return { basename: base ? base.toLowerCase() : undefined };
  }
}

/** Basename of a (possibly Windows) path, lowercased. */
export function baseNameOf(p?: string): string | undefined {
  if (!p) return undefined;
  const cleaned = p.replace(/\\/g, "/").split("?")[0];
  const b = cleaned.split("/").pop();
  return b ? b.toLowerCase() : undefined;
}

/** Extract a 1-indexed scene number from a mirror filename like
 *  "scene-3-abc.mp4" or "scene_3-...". Returns null when absent. */
export function sceneFromFilename(name: string): number | null {
  const m = name.toLowerCase().match(/scene[-_ ]?(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** A role token appears in mirrored frame filenames
 *  ("scene-1-first_frame-abc.jpg"). Loose contains check. */
function filenameHasRole(name: string, role?: string): boolean {
  if (!role) return false;
  const r = role.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return r.length > 2 && n.includes(r);
}

function rolesMatch(itemRole?: string, entryRole?: string): "match" | "mismatch" | "unknown" {
  if (!itemRole || !entryRole) return "unknown";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return norm(itemRole) === norm(entryRole) ? "match" : "mismatch";
}

/** Compare two URLs for "same asset": exact string, or same basename. */
function urlsRefSameAsset(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ba = baseNameOf(a);
  const bb = baseNameOf(b);
  return !!ba && ba === bb;
}

// ── scoring ────────────────────────────────────────────────────────

interface Candidate {
  file: IndexedFile;
  strategy: string;
  confidence: number;
}

/** Find the manifest file (by basename) inside the indexed files. */
function fileForManifestEntry(
  entry: ManifestEntry,
  filesByName: Map<string, IndexedFile[]>,
): IndexedFile | null {
  const base = baseNameOf(entry.localPath);
  if (!base) return null;
  const hits = filesByName.get(base);
  if (!hits || hits.length === 0) return null;
  // Prefer a hit whose parent folder matches the entry kind.
  if (hits.length > 1 && entry.kind) {
    const wantDir = entry.kind === "image" ? "frames"
      : entry.kind === "narration" ? "narrations"
      : entry.kind === "video" ? "videos"
      : entry.kind === "music" ? "music" : "";
    const byDir = hits.find((h) => h.parentDir === wantDir);
    if (byDir) return byDir;
  }
  return hits[0];
}

/** Score every plausible file for one item; caller picks the best and
 *  resolves contention across items. */
function candidatesForItem(
  item: RelinkableItem,
  files: IndexedFile[],
  filesByName: Map<string, IndexedFile[]>,
  manifests: ParsedManifest[],
  currentProjectId?: string,
): Candidate[] {
  const out: Candidate[] = [];
  const itemKind = kindForItem(item);
  const hints = parseUrlHints(item.originalUrl);

  // ── manifest-driven strategies (1–3) ──
  // Prefer entries from a manifest whose project matches; fall back to all.
  const orderedManifests = [...manifests].sort((a, b) => {
    const am = currentProjectId && a.project === currentProjectId ? 0 : 1;
    const bm = currentProjectId && b.project === currentProjectId ? 0 : 1;
    return am - bm;
  });
  for (const man of orderedManifests) {
    for (const entry of man.entries) {
      const file = fileForManifestEntry(entry, filesByName);
      if (!file) continue;
      const entryKind = (entry.kind as MediaKind) || kindForFile(file);
      if (!kindsCompatible(itemKind, entryKind)) continue;

      // 1. URL identity (sourceUrl / permanentUrl vs item url + its `original` hint)
      const itemUrls = [item.originalUrl, hints.original].filter(Boolean) as string[];
      const entryUrls = [entry.sourceUrl, entry.permanentUrl].filter(Boolean) as string[];
      const urlHit = itemUrls.some((iu) => entryUrls.some((eu) => urlsRefSameAsset(iu, eu)));
      if (urlHit) {
        out.push({ file, strategy: "manifest:url", confidence: 100 });
        continue;
      }

      // 2. assetId embedded in the item id (e.g. media-video-<doc>-<assetId>)
      if (entry.assetId && entry.assetId.length >= 6 && item.id.includes(entry.assetId)) {
        out.push({ file, strategy: "manifest:assetId", confidence: 96 });
        continue;
      }

      // 3. sceneNumber + role + kind
      if (
        entry.sceneNumber != null &&
        item.sceneNumber != null &&
        entry.sceneNumber === item.sceneNumber
      ) {
        const r = rolesMatch(item.role, entry.role);
        if (r !== "mismatch") {
          out.push({
            file,
            strategy: "manifest:scene",
            confidence: r === "match" ? 90 : 84,
          });
        }
      }
    }
  }

  // ── file-driven strategies (4–9) ──
  for (const file of files) {
    const fileKind = kindForFile(file);

    // 4. sourceFile name + size (exact) — user imports
    if (item.sourceFile) {
      const sn = item.sourceFile.name.toLowerCase();
      if (file.name === sn && file.size === item.sourceFile.size) {
        out.push({ file, strategy: "sourceFile:nameSize", confidence: 98 });
        continue;
      }
    }

    // Only consider remaining file strategies when kinds are compatible —
    // stops a narration mp3 from matching a music mp3 by size alone.
    if (!kindsCompatible(itemKind, fileKind)) continue;

    // 5. originalUrl basename
    if (hints.basename && file.name === hints.basename) {
      out.push({ file, strategy: "url:basename", confidence: 82 });
      continue;
    }

    // 6. structural filename: scene-<n> + (role token when known)
    if (item.sceneNumber != null) {
      const fileScene = sceneFromFilename(file.name);
      if (fileScene === item.sceneNumber) {
        // For frames the role disambiguates first_frame vs context_frame.
        const roleOk = item.role ? (filenameHasRole(file.name, item.role) || itemKind !== "image") : true;
        if (roleOk) {
          out.push({ file, strategy: "structural:scene", confidence: filenameHasRole(file.name, item.role) ? 80 : 74 });
          continue;
        }
      }
    }

    // 7. sourceFile name only (size changed)
    if (item.sourceFile && file.name === item.sourceFile.name.toLowerCase()) {
      out.push({ file, strategy: "sourceFile:name", confidence: 68 });
      continue;
    }

    // 8. exact unique size
    if (item.fileSize && item.fileSize > 0 && file.size === item.fileSize) {
      out.push({ file, strategy: "size", confidence: 58 });
      continue;
    }

    // 9. name slug ("Scene 1 · Video" → contains "scene" + number)
    const itemScene = item.sceneNumber ?? sceneFromFilename(item.name);
    if (itemScene != null && sceneFromFilename(file.name) === itemScene) {
      out.push({ file, strategy: "nameSlug:scene", confidence: 50 });
    }
  }

  return out;
}

/**
 * Build a relink plan: for each item, the single best file, with no
 * file assigned twice. Greedy by descending confidence — the strongest
 * (item,file) bindings win first.
 */
export function buildRelinkPlan(
  items: RelinkableItem[],
  files: IndexedFile[],
  manifests: ParsedManifest[] = [],
  opts: { currentProjectId?: string; minConfidence?: number } = {},
): RelinkPlan {
  const minConfidence = opts.minConfidence ?? 50;
  const filesByName = new Map<string, IndexedFile[]>();
  for (const f of files) {
    const arr = filesByName.get(f.name);
    if (arr) arr.push(f);
    else filesByName.set(f.name, [f]);
  }

  // All (item,file,score) candidates above threshold.
  type Edge = { itemId: string; file: IndexedFile; strategy: string; confidence: number };
  const edges: Edge[] = [];
  for (const item of items) {
    const cands = candidatesForItem(item, files, filesByName, manifests, opts.currentProjectId);
    // keep only the best candidate per (item,file) pair
    const bestPerFile = new Map<IndexedFile, Candidate>();
    for (const c of cands) {
      if (c.confidence < minConfidence) continue;
      const prev = bestPerFile.get(c.file);
      if (!prev || c.confidence > prev.confidence) bestPerFile.set(c.file, c);
    }
    for (const c of bestPerFile.values()) {
      edges.push({ itemId: item.id, file: c.file, strategy: c.strategy, confidence: c.confidence });
    }
  }

  // Greedy assignment: highest confidence first; each item + each file once.
  edges.sort((a, b) => b.confidence - a.confidence || a.itemId.localeCompare(b.itemId));
  const usedFiles = new Set<IndexedFile>();
  const matchedItems = new Set<string>();
  const matches: MediaMatch[] = [];
  for (const e of edges) {
    if (matchedItems.has(e.itemId) || usedFiles.has(e.file)) continue;
    matchedItems.add(e.itemId);
    usedFiles.add(e.file);
    matches.push({ itemId: e.itemId, file: e.file, strategy: e.strategy, confidence: e.confidence });
  }

  const unmatchedItemIds = items.filter((i) => !matchedItems.has(i.id)).map((i) => i.id);
  return { matches, unmatchedItemIds };
}

// ── folder walk (impure) ───────────────────────────────────────────

interface DirHandleLike {
  name: string;
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", "$recycle.bin", "system volume information",
]);

/**
 * Recursively collect every file under a directory handle, plus any
 * `manifest.json` it finds (parsed). Best-effort and bounded so a user
 * who points at a huge tree doesn't hang the tab.
 */
export async function collectFolder(
  dirHandle: FileSystemDirectoryHandle,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): Promise<{ files: IndexedFile[]; manifests: ParsedManifest[] }> {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxDepth = opts.maxDepth ?? 8;
  const files: IndexedFile[] = [];
  const manifests: ParsedManifest[] = [];

  const walk = async (
    dir: FileSystemDirectoryHandle,
    relPrefix: string,
    depth: number,
  ): Promise<void> => {
    if (depth > maxDepth || files.length >= maxFiles) return;
    const parentDir = (relPrefix.split("/").filter(Boolean).pop() || "").toLowerCase();
    let entries: AsyncIterableIterator<[string, FileSystemHandle]>;
    try {
      entries = (dir as unknown as DirHandleLike).entries();
    } catch {
      return;
    }
    for await (const [name, handle] of entries) {
      if (files.length >= maxFiles) return;
      if (handle.kind === "directory") {
        if (SKIP_DIRS.has(name.toLowerCase()) || name.startsWith(".")) continue;
        await walk(handle as FileSystemDirectoryHandle, `${relPrefix}${name}/`, depth + 1);
        continue;
      }
      // file
      const fh = handle as FileSystemFileHandle;
      let file: File;
      try {
        file = await fh.getFile();
      } catch {
        continue;
      }
      if (name.toLowerCase() === "manifest.json") {
        try {
          const parsed = JSON.parse(await file.text());
          if (parsed && Array.isArray(parsed.entries)) {
            manifests.push({ project: parsed.project, entries: parsed.entries });
          }
        } catch {
          /* corrupt manifest — ignore */
        }
        continue;
      }
      files.push({
        name: name.toLowerCase(),
        relPath: `${relPrefix}${name}`,
        parentDir,
        size: file.size,
        handle: fh,
        file,
      });
    }
  };

  await walk(dirHandle, "", 0);
  return { files, manifests };
}
