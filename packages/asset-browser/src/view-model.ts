/**
 * View-model — the presentation rules every asset browser must share.
 *
 * WHY THESE LIVE IN THE CORE AND NOT IN EACH PANEL
 * Recency bucketing, pagination and favourites are not "UI"; they are decisions
 * about what the user is shown and in what order. If the video editor buckets by
 * "Today / Yesterday / This week" and the board buckets differently — or worse,
 * not at all — the two stop being the same feature even though they read the
 * same API. Putting them here means a change lands in **all three editors at
 * once**, which is the stated requirement.
 *
 * Deliberately pure and framework-free: React renders these as sections, the
 * board as DOM, and neither can drift because neither owns the rule.
 */
import type { AssetItem, AssetKind, AssetScope } from './types';

/** How many items a page requests. This is PRODUCTION's value, taken from
 *  LibraryPanel — the core adopted it rather than imposing a new one, so
 *  migrating the video editor changes no behaviour a user could notice. */
export const PAGE_SIZE = 120;

/** Recency buckets, newest first. Section headers in every host.
 *  'Older' (not 'Earlier') because that is the label already shipping in the
 *  video editor — the core matches production so the migration is invisible. */
export type Bucket = 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Older';

const DAY = 86_400_000;

/**
 * Which bucket a timestamp falls in.
 *
 * `now` is injected rather than read from the clock so this is testable and
 * deterministic — a bucketing bug that only appears near midnight is exactly the
 * kind nobody reproduces.
 */
export function bucketOf(iso: string | undefined, now: number = Date.now()): Bucket {
  if (!iso) return 'Older';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Older';

  // Compare against local midnight, not "24 hours ago": something made at 23:00
  // yesterday is "Yesterday" to a human even if it is 20 hours old.
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - DAY) return 'Yesterday';
  if (t >= startOfToday - 7 * DAY) return 'This week';
  if (t >= startOfToday - 30 * DAY) return 'This month';
  return 'Older';
}

export interface AssetSection {
  bucket: Bucket;
  items: AssetItem[];
}

export const BUCKET_ORDER: Bucket[] = ['Today', 'Yesterday', 'This week', 'This month', 'Older'];

/**
 * Group into recency sections, preserving the server's order within each.
 *
 * Empty buckets are dropped — a header with nothing under it is noise, and the
 * gaps make a short library look broken.
 */
export function groupByRecency(items: AssetItem[], now: number = Date.now()): AssetSection[] {
  const map = new Map<Bucket, AssetItem[]>();
  for (const item of items) {
    const b = bucketOf(item.createdAt, now);
    const list = map.get(b);
    if (list) list.push(item);
    else map.set(b, [item]);
  }
  return BUCKET_ORDER.filter(b => map.has(b)).map(b => ({ bucket: b, items: map.get(b)! }));
}

/**
 * How the host lays tiles out.
 *
 * Shared because it is a USER PREFERENCE, not a per-surface style: someone who
 * works in list view in the video editor expects list view on the board. The
 * modes, their order and the storage key all live here so the two cannot offer
 * different sets or forget each other's choice.
 */
export type ViewMode = 'grid' | 'compact' | 'list';

export const VIEW_MODES: ViewMode[] = ['grid', 'compact', 'list'];

/** One key, so the preference genuinely follows the user between surfaces. */
const VIEW_MODE_KEY = 'voidspace.assets.viewMode';

export function loadViewMode(fallback: ViewMode = 'grid'): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY) as ViewMode | null;
    return v && VIEW_MODES.includes(v) ? v : fallback;
  } catch {
    return fallback; // private mode / no storage — the session still works
  }
}

export function saveViewMode(mode: ViewMode): void {
  try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* non-fatal */ }
}

/**
 * TILE GEOMETRY — the last thing that made the two panels look like two panels.
 *
 * Both hosts already read the same sources, buckets and labels, and both offer
 * the same three view modes. They still LOOKED different, because each picked
 * its own tile size: the board laid grid tiles out at 96px and compact at 62px
 * while the video editor used 150px and 96px. Same data, same modes, visibly
 * different panel — and "same layout" is most of what a user means by "the same
 * panel".
 *
 * The video editor's numbers are canonical here: it is the panel the others are
 * being matched TO, so adopting it changes nothing a video editor user has
 * learned. `list` has no column width — it is one column of rows.
 *
 * These are minimums for `repeat(auto-fill, minmax(<min>, 1fr))`, not fixed
 * widths, so a wider panel still shows more columns rather than bigger gaps.
 */
export const TILE_MIN_PX: Record<ViewMode, number> = {
  grid: 150,
  compact: 96,
  list: 0,
};

/** Gap between tiles, per mode. Rows sit tighter than columns in list view. */
export const TILE_GAP_PX: Record<ViewMode, number> = {
  grid: 6,
  compact: 6,
  list: 3,
};

/** The `grid-template-columns` value for a mode — one string, both hosts. */
export function gridColumns(mode: ViewMode): string {
  return mode === 'list'
    ? '1fr'
    : `repeat(auto-fill, minmax(${TILE_MIN_PX[mode]}px, 1fr))`;
}

/** Panel width, likewise shared so the layout feels like one app. */
const PANEL_WIDTH_KEY = 'voidspace.assets.panelWidth';
export const PANEL_MIN_WIDTH = 200;
export const PANEL_MAX_WIDTH = 520;

/** 320 = the video editor's Assets column. A board that opened at 244 showed
 *  narrower tiles and fewer columns than the editor for the same library, which
 *  is the difference you notice before any typography. A width the user has
 *  actually dragged still wins — this is only the starting point. */
export function loadPanelWidth(fallback = 320): number {
  try {
    const n = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(n) && n >= PANEL_MIN_WIDTH && n <= PANEL_MAX_WIDTH ? n : fallback;
  } catch { return fallback; }
}

export function savePanelWidth(px: number): void {
  try { localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(px))); } catch { /* non-fatal */ }
}

/** Clamp a dragged width to the usable range. */
export function clampPanelWidth(px: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, px));
}

/** Whether another page is worth requesting. */
export function hasMore(loaded: number, total: number): boolean {
  return loaded < total;
}

/** The offset for the next page. */
export function nextOffset(loaded: number): number {
  return loaded;
}

/**
 * Merge a freshly-fetched page into what is already on screen.
 *
 * Deduped by `key` (the source URL), because the same asset legitimately appears
 * through more than one source — the user's own store and the shared library can
 * both surface a file they saved. Showing it twice looks like a bug, and letting
 * a later page overwrite an earlier one loses the scroll position.
 */
export function mergePage(existing: AssetItem[], page: AssetItem[]): AssetItem[] {
  const seen = new Set(existing.map(a => a.key));
  const out = existing.slice();
  for (const a of page) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    out.push(a);
  }
  return out;
}

/**
 * Is this failure "you are not authenticated (yet)" rather than a real error?
 *
 * ── WHY THIS IS A FUNCTION AND NOT AN INLINE REGEX ────────────────────────────
 * It was an inline `/\b40[13]\b/` in the board's asset panel, and at some point
 * the two `\b` escapes in that source file became literal U+0008 BACKSPACE
 * bytes. The regex still compiled, still looked correct in most editors, and
 * could never match an HTTP error message again — so the panel's entire
 * auth-race recovery became dead code and a signed-in user got a permanent
 * "Couldn't load — 401" on every cold board.
 *
 * A silently-unmatchable regex is not something review catches. A tested
 * function is. Both panels now ask the same question the same way.
 */
export function isAuthError(message: unknown): boolean {
  return /\b(401|403)\b/.test(String(message ?? ''));
}

/**
 * What the search box should say it searches.
 *
 * Written twice before — once in each panel — and they had drifted into
 * different promises about the same box: the board offered "Describe it — rain
 * on a window" for every scope, while the video editor only said that for the
 * on-disk library and said "Search your generations…" elsewhere. Since the
 * placeholder is where a user learns that this box takes a DESCRIPTION rather
 * than a filename, two answers is two products.
 *
 * `semantic` is whether the meaning-based lane is actually available: promising
 * description-search where only substring matching is running is worse than
 * saying nothing, because the user writes a sentence and gets no results.
 */
export function searchPlaceholder(
  scope: AssetScope,
  opts: { semantic?: boolean; kind?: AssetKind | 'all' } = {},
): string {
  if (opts.kind === 'block') return 'Find a block — "lower third", "stat"…';
  switch (scope) {
    case 'project':
      return 'Search what this project uses…';
    case 'device':
      return 'Search media in this browser…';
    case 'mine':
      return opts.semantic
        ? 'Describe it — "rain on a window", "deep whoosh"…'
        : 'Search sfx, music, footage, stills…';
    case 'shared':
      return 'Search what other creators shared…';
    case 'generated':
    default:
      return 'Search your generations…';
  }
}
