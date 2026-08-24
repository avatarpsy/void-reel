/**
 * Asset sources — the data layer, lifted out of LibraryPanel.tsx.
 *
 * A FAITHFUL PORT, not a reimplementation. Every behaviour below exists because
 * the video editor already needed it, and the comments record WHY so a future
 * reader does not "simplify" one back out:
 *
 *   • `apiBase()` resolves through `window.parent` — these SPAs run in an iframe
 *     inside Voidspace, and a bare relative URL would hit the iframe's own origin.
 *   • `resolveOutputDir()` reads the user's Storage location from same-origin
 *     localStorage; `/api/studio/library` unions disk manifests from it.
 *   • The semantic lane is a POST (the endpoint embeds the text server-side, so
 *     the vector never rides in a URL) and is used ONLY for a non-empty query —
 *     an empty query has nothing to embed, and "just browse my library" must not
 *     pay for a model round trip.
 *   • Whether ranking WAS semantic is read back from the server (`vector.active`),
 *     never assumed from what we asked for: the lane can decline (cold model,
 *     upgrade mid-flight) and still return good keyword results. A badge that
 *     lies about this is worse than no badge.
 */
import { quickFilterParams } from './types';
import type { AssetBrowserHost, AssetItem, AssetKind, AssetPage, AssetQuery, AssetScope, PersonalCounts } from './types';

/** Voidspace origin. These apps are iframed, so relative URLs are wrong. */
export function defaultApiBase(): string {
  if (typeof window !== 'undefined') {
    try {
      if (window.parent && window.parent !== window) return window.parent.location.origin;
    } catch { /* cross-origin — fall through to same-origin */ }
  }
  return '';
}

/** The user's configured Storage location, shared via same-origin localStorage. */
function resolveOutputDir(): string {
  try {
    const raw = localStorage.getItem('voidspace.studio.settings');
    if (raw) {
      const dir = JSON.parse(raw)?.outputDir;
      if (typeof dir === 'string' && dir.trim()) return dir.trim();
    }
  } catch { /* unreadable settings are not worth failing a search over */ }
  return '~/Voidspace';
}

/** The Library reports many flavours; the browser deals in five. */
export function normaliseKind(raw: unknown): AssetKind {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('video') || s.includes('clip') || s.includes('footage')) return 'video';
  if (s.includes('voice') || s.includes('narration') || s.includes('tts')) return 'voice';
  if (s.includes('sfx') || s.includes('sound')) return 'sfx';
  if (s.includes('music') || s.includes('song') || s.includes('audio')) return 'music';
  /**
   * Documents, BEFORE the image fallback.
   *
   * The server calls this kind `document`; the pill is `doc`. Without this line
   * every uploaded PDF fell through to the default and was catalogued as an
   * IMAGE — it appeared in the Images filter, with a broken thumbnail, and the
   * Docs filter was permanently empty.
   *
   * The extensions are here as well as the word because a row whose type was
   * never set still has a filename, and calling a `.pdf` an image is worse than
   * calling it unknown.
   */
  if (s.includes('doc') || s.includes('pdf') || /\.(pdf|docx|txt|md|csv|json)$/.test(s)) return 'doc';
  return 'image';
}

async function authHeaders(host: AssetBrowserHost): Promise<Record<string, string>> {
  const token = await host.getIdToken().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const base = (host: AssetBrowserHost) => host.apiBase?.() ?? defaultApiBase();

/** Identity for "do I already have this?" — the SOURCE URL, never the id, which
 *  differs between the same asset seen through two sources. */
const keyOf = (url: string) => url.split('?')[0];

/**
 * A human-usable name from a URL, for assets the API returns unlabelled.
 *
 * Prefers a `filename=` query param (how `/api/studio/local-asset` addresses
 * disk files) and otherwise takes the last path segment. Decoded, because a
 * card reading `my%20render.mp4` looks broken.
 */
export function filenameFromUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url, 'https://x');
    const explicit = u.searchParams.get('filename');
    if (explicit) return decodeURIComponent(explicit);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : '';
  } catch {
    return '';
  }
}

/** The user's own generated + saved media. */
async function fetchGenerated(host: AssetBrowserHost, q: AssetQuery): Promise<AssetPage> {
  const qs = new URLSearchParams({
    outputDir: resolveOutputDir(),
    type: q.kind && q.kind !== 'all' ? q.kind : 'all',
    q: q.q ?? '',
    limit: String(q.limit ?? 60),
    offset: String(q.offset ?? 0),
  });
  const res = await fetch(`${base(host)}/api/studio/library?${qs}`, {
    headers: await authHeaders(host),
  });
  if (!res.ok) throw new Error(`library ${res.status}`);
  const j = await res.json();
  const items: AssetItem[] = (Array.isArray(j.items) ? j.items : []).map((it: any) => ({
    id: String(it.id),
    url: String(it.url ?? ''),
    key: keyOf(String(it.url ?? '')),
    kind: normaliseKind(it.type ?? it.kind),
    // Fall back to the FILENAME from the url, never to ''. An empty label
    // propagates: it becomes the File name on placement, so the card on the
    // board renders as "media" and the asset loses its identity. Generated
    // media frequently arrives with no label at all.
    label: (typeof it.label === 'string' && it.label.trim())
      ? it.label
      : filenameFromUrl(String(it.url ?? '')),
    scope: 'generated' as const,
    thumbnailUrl: it.thumbnailUrl,
    durationSec: Number(it.durationSec) > 0 ? Number(it.durationSec) : undefined,
    bytes: Number(it.bytes) || undefined,
    createdAt: it.createdAt,
  })).filter((a: AssetItem) => a.url);
  return { items, total: Number(j.total) || items.length, semantic: false };
}

/**
 * The user's OWN media library on disk — sfx, music, footage, stills, fonts.
 *
 * This is the lane that makes "rain on a window" find a clip nobody tagged.
 *
 * Named `fetchMyFiles` because it reads the user's own files. It used to be
 * called `fetchShared` and sat behind a scope named `shared`, which the video
 * editor already used for OTHER PEOPLE's published assets — so one word meant
 * two sources depending on which editor you had open.
 */
async function fetchMyFiles(host: AssetBrowserHost, q: AssetQuery): Promise<AssetPage> {
  const query = (q.q ?? '').trim();
  const sq = new URLSearchParams({
    ...(q.kind && q.kind !== 'all' ? { kind: q.kind } : {}),
    ...(query ? { q: query } : {}),
    limit: String(q.limit ?? 60),
    offset: String(q.offset ?? 0),
    // Quick filters map onto server-side filters/sorts, never client-side —
    // narrowing a page after it arrives silently drops results and yields short
    // pages. Same mapping the video editor sends.
    ...quickFilterParams(q.quick ?? 'none'),
  });
  const headers = await authHeaders(host);

  // Semantic ONLY for a real query — see the header note.
  const res = query
    ? await fetch(`${base(host)}/api/media-library/search-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(Object.fromEntries(sq.entries())),
      })
    : await fetch(`${base(host)}/api/media-library/search?${sq}`, { headers });

  if (!res.ok) throw new Error(`media-library ${res.status}`);
  const j = await res.json();
  const items: AssetItem[] = (Array.isArray(j.items) ? j.items : []).map((a: any) => ({
    id: String(a.id),
    url: String(a.url ?? ''),
    key: keyOf(String(a.url ?? '')),
    kind: normaliseKind(a.kind),
    // The REAL filename first. `slug` is a sanitised derivative, so a photo
    // called "IMG_2043.jpg" becomes "img-2043" and "3.png" becomes the tile
    // label "3" — meaningless in a grid. Same order as the video editor.
    label: String(a.originalName || a.slug || a.id || ''),
    scope: 'mine' as const,
    // `thumbUrl` is the field the server actually sends (media-library.ts:796).
    // This previously read `thumbnailUrl ?? previewUrl` — NEITHER EXISTS — so it
    // was always undefined and every tile fell back to proxying the full master.
    // Suppressed when the thumb would only be a placeholder SVG.
    thumbnailUrl: a.hasRasterPreview ? a.thumbUrl : undefined,
    // The 720p scrubbing proxy. Carried through rather than dropped: this is
    // what makes video preview cheap, and the fallback for undecodable masters.
    proxyUrl: a.proxyUrl ?? null,
    hasRasterPreview: a.hasRasterPreview !== false,
    durationSec: Number(a.durationSec) > 0 ? Number(a.durationSec) : undefined,
    bytes: Number(a.bytes) || undefined,
    createdAt: a.addedAt || undefined,
  })).filter((a: AssetItem) => a.url);

  return {
    items,
    total: Number(j.total) || items.length,
    // Read back from the SERVER, not from what we asked for.
    semantic: j?.vector?.active === true,
  };
}

/**
 * One entry point for every scope.
 *
 * Errors surface to the caller rather than being swallowed: a host showing "no
 * results" when the request actually failed is the worst outcome, because it is
 * indistinguishable from an empty library.
 */
/** Substring match over what a host-provided list already holds. The project and
 *  device scopes are in-memory, so there is nothing to ask a server for. */
function filterLocal(items: AssetItem[], q: AssetQuery): AssetPage {
  const needle = (q.q ?? '').trim().toLowerCase();
  const words = needle ? needle.split(/\s+/) : [];
  const matched = items.filter(it => {
    if (q.kind && q.kind !== 'all' && it.kind !== q.kind) return false;
    if (!words.length) return true;
    // `detail` carries a block's category, tags and slot count, which is how
    // people look for one — "lower third", "transition" — far more often than
    // by the name its author happened to give it.
    const hay = `${it.label} ${it.detail ?? ''} ${it.id}`.toLowerCase();
    // AND across words, same rule the server search uses, so "kitchen wide"
    // narrows here exactly as it would there.
    return words.every(w => hay.includes(w));
  });
  return { items: matched, total: matched.length, semantic: false };
}

export async function fetchAssets(host: AssetBrowserHost, q: AssetQuery): Promise<AssetPage> {
  /**
   * BLOCKS ARE A KIND, AND THEY ANSWER FIRST.
   *
   * They live in the user's Voidspace folder rather than the Library, so no
   * scope can serve them and every scope must be able to show them — which is
   * why the kind is checked before the scope rather than inside one of them.
   *
   * They are also deliberately ABSENT from "All". A stock install ships 128
   * starter blocks; letting them into the mixed list would bury a user's actual
   * footage under templates on every search. You get blocks when you ask for
   * blocks.
   */
  if (q.kind === 'block') {
    return filterLocal(host.blockSource?.list(q) ?? [], q);
  }
  if (q.scope === 'project') {
    return filterLocal(host.projectSource?.list() ?? [], q);
  }
  if (q.scope === 'device') {
    return filterLocal((await host.browserSource?.list()) ?? [], q);
  }
  if (q.scope === 'shared') return fetchSharedLibrary(host, q);
  if (q.scope === 'generated') return fetchGenerated(host, q);
  return fetchMyFiles(host, q);
}

/**
 * Assets OTHER creators have published.
 *
 * The board had no way to reach these at all — the video editor had a "Shared"
 * tab and the board simply did not, so the same account saw a different library
 * depending on which editor was open.
 *
 * ONE ENDPOINT FOR BROWSE AND SEARCH: an empty query browses by popularity, a
 * real query fuses meaning and keyword lanes SERVER-SIDE. The client does not
 * pick a ranking strategy — doing that here would put ranking policy in two
 * places, which is how the local search's fusion drifted once already.
 */
async function fetchSharedLibrary(host: AssetBrowserHost, q: AssetQuery): Promise<AssetPage> {
  const res = await fetch(`${base(host)}/api/media-library/shared/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders(host)) },
    body: JSON.stringify({
      q: (q.q ?? '').trim(),
      ...(q.kind && q.kind !== 'all' ? { kinds: [q.kind] } : {}),
      limit: q.limit ?? 60,
      offset: q.offset ?? 0,
    }),
  });
  if (!res.ok) throw new Error(`shared ${res.status}`);
  const j = await res.json();

  const items: AssetItem[] = (Array.isArray(j.items) ? j.items : []).map((a: any) => ({
    id: String(a.sha256 ?? a.id ?? ''),
    url: `${base(host)}${a.url ?? ''}`,
    key: keyOf(String(a.url ?? '')),
    kind: normaliseKind(a.kind),
    label: String(a.name || a.originalName || a.id || ''),
    scope: 'shared' as const,
    thumbnailUrl: a.thumbUrl ? `${base(host)}${a.thumbUrl}` : undefined,
    proxyUrl: a.proxyUrl ?? null,
    hasRasterPreview: a.hasRasterPreview !== false,
    durationSec: Number(a.durationSec) > 0 ? Number(a.durationSec) : undefined,
    bytes: Number(a.bytes) || undefined,
    createdAt: a.publishedAt || a.createdAt,
    /**
     * ATTRIBUTION TRAVELS WITH THE ASSET.
     *
     * A handle, never a uid. It rides on the item so every tile, drag payload
     * and placement keeps it — credit that lives only in the browsing UI is
     * credit that disappears the moment somebody uses the thing.
     */
    credit: a.credit?.handle ? `@${a.credit.handle}` : (a.credit?.name || undefined),
  })).filter((a: AssetItem) => a.url);

  return {
    items,
    total: Number(j.total) || items.length,
    // The server says whether the semantic lane actually ran; it can decline
    // (cold tower, empty index) and still return good keyword results, and the
    // badge must not claim otherwise.
    semantic: j?.vector?.active === true,
  };
}

/**
 * Which scopes this host can actually offer.
 *
 * `project` FIRST when present: what you already used is the likeliest thing you
 * want next, and putting it behind "My files" makes reusing one backing track
 * across six shots a search each time.
 */
export function availableScopes(host: AssetBrowserHost): AssetScope[] {
  return [
    ...(host.projectSource ? (['project'] as const) : []),
    'generated' as const,
    'mine' as const,
    'shared' as const,
    ...(host.browserSource ? (['device'] as const) : []),
  ];
}

/**
 * The user's personal signals (starred / used counts).
 *
 * Drives whether a quick-filter chip is worth showing at all: a "Favourites"
 * chip with nothing starred behind it is a control that cannot narrow, and the
 * user still has to read it. Returns zeros on any failure — the chips simply
 * stay hidden rather than the panel failing over a secondary signal.
 */
export async function fetchPersonalCounts(host: AssetBrowserHost): Promise<PersonalCounts> {
  const empty: PersonalCounts = { favorite: 0, rated: 0, used: 0 };
  try {
    const res = await fetch(`${base(host)}/api/media-library/personal`, {
      headers: await authHeaders(host),
    });
    if (!res.ok) return empty;
    const j = await res.json();
    const c = j?.personalCounts ?? j?.counts ?? {};
    return {
      favorite: Number(c.favorite) || 0,
      rated: Number(c.rated) || 0,
      used: Number(c.used) || 0,
    };
  } catch {
    return empty;
  }
}

/**
 * Star / unstar a media-library asset.
 *
 * ONE WRITE PATH for every panel. The video editor had this and the board and
 * image editor did not, so a library you starred in one editor looked unstarred
 * in the others — the signal existed but only one surface could set it, which
 * makes the Favourites filter feel broken rather than empty.
 *
 * Only media-library items have personal signals: the endpoint is keyed on a
 * library asset id, and generations / in-browser projects have none. Callers
 * should hide the control outside the `mine` scope rather than let it fail.
 *
 * Returns whether the write landed, so a host can revert its optimistic tick.
 */
export async function setAssetFavourite(
  host: AssetBrowserHost,
  id: string,
  favorite: boolean,
): Promise<boolean> {
  try {
    const res = await fetch(`${base(host)}/api/media-library/personal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders(host)) },
      body: JSON.stringify({ id, favorite }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Upload files into the user's media library.
 *
 * The same ingest the video editor's Add uses — one dedupe, one ownership rule,
 * one catalogue. Sent ONE AT A TIME on purpose: a single failure in a batch of
 * ten must not lose the other nine, and per-file progress is the only honest
 * thing to report. Resolves with how many landed.
 */
export async function uploadToLibrary(
  host: AssetBrowserHost,
  files: File[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ ok: number; failed: string[] }> {
  let ok = 0;
  const failed: string[] = [];
  const headers = await authHeaders(host);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.(i, files.length, f.name);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch(`${base(host)}/api/media-library/upload`, {
        method: 'POST', headers, body: fd,
      });
      if (res.ok) ok++; else failed.push(f.name);
    } catch {
      failed.push(f.name);
    }
  }
  onProgress?.(files.length, files.length, '');
  return { ok, failed };
}
