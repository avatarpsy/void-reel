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
import type { AssetItem } from './types';

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

/** Panel width, likewise shared so the layout feels like one app. */
const PANEL_WIDTH_KEY = 'voidspace.assets.panelWidth';
export const PANEL_MIN_WIDTH = 200;
export const PANEL_MAX_WIDTH = 520;

export function loadPanelWidth(fallback = 244): number {
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
