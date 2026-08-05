/**
 * View-model tests.
 *
 * These pin the rules that must be IDENTICAL across the video, image and board
 * editors. If one of these changes, all three change together — that is the
 * point of the shared core, and these tests are what make it true rather than
 * aspirational.
 */
import { describe, expect, it } from 'vitest';
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, TILE_GAP_PX, TILE_MIN_PX, VIEW_MODES, bucketOf, clampPanelWidth, gridColumns, isAuthError, groupByRecency, hasMore, loadPanelWidth, loadViewMode, mergePage, nextOffset, searchPlaceholder } from './view-model';
import { KIND_LABEL, KIND_ORDER } from './types';
import type { AssetItem } from './types';

/** Fixed "now": 2026-08-01T12:00 local. */
const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime();
const at = (d: Date) => d.toISOString();

const item = (id: string, createdAt?: string, key = id): AssetItem => ({
  id, key, url: `https://x/${id}`, kind: 'image', label: id, scope: 'mine', createdAt,
});

describe('recency bucketing', () => {
  it('buckets against LOCAL MIDNIGHT, not a rolling 24 hours', () => {
    // 23:00 yesterday is "Yesterday" to a human even though it is only 13h old.
    expect(bucketOf(at(new Date(2026, 6, 31, 23, 0)), NOW)).toBe('Yesterday');
    // 01:00 today is "Today" even though it is 11h old.
    expect(bucketOf(at(new Date(2026, 7, 1, 1, 0)), NOW)).toBe('Today');
  });

  it('covers the remaining ranges', () => {
    expect(bucketOf(at(new Date(2026, 6, 28, 9, 0)), NOW)).toBe('This week');
    expect(bucketOf(at(new Date(2026, 6, 10, 9, 0)), NOW)).toBe('This month');
    expect(bucketOf(at(new Date(2026, 3, 10, 9, 0)), NOW)).toBe('Older');
  });

  it('treats missing or unparseable dates as Older rather than throwing', () => {
    expect(bucketOf(undefined, NOW)).toBe('Older');
    expect(bucketOf('not-a-date', NOW)).toBe('Older');
  });
});

describe('grouping', () => {
  it('orders sections newest-first and preserves server order inside each', () => {
    const sections = groupByRecency([
      item('a', at(new Date(2026, 3, 1))),
      item('b', at(new Date(2026, 7, 1, 9, 0))),
      item('c', at(new Date(2026, 7, 1, 8, 0))),
      item('d', at(new Date(2026, 6, 31, 10, 0))),
    ], NOW);

    expect(sections.map(s => s.bucket)).toEqual(['Today', 'Yesterday', 'Older']);
    // Within a bucket the server's order stands — we do not re-sort.
    expect(sections[0].items.map(i => i.id)).toEqual(['b', 'c']);
  });

  it('drops empty buckets — a header with nothing under it is noise', () => {
    const sections = groupByRecency([item('a', at(new Date(2026, 7, 1, 9, 0)))], NOW);
    expect(sections).toHaveLength(1);
    expect(sections[0].bucket).toBe('Today');
  });
});

describe('pagination', () => {
  it('knows when another page exists', () => {
    expect(hasMore(60, 200)).toBe(true);
    expect(hasMore(200, 200)).toBe(false);
    expect(nextOffset(60)).toBe(60);
  });

  it('dedupes by key when merging pages', () => {
    // The same file legitimately appears through two sources; showing it twice
    // looks like a bug.
    const merged = mergePage(
      [item('a', undefined, 'k1'), item('b', undefined, 'k2')],
      [item('b2', undefined, 'k2'), item('c', undefined, 'k3')],
    );
    expect(merged.map(i => i.key)).toEqual(['k1', 'k2', 'k3']);
  });

  it('appends rather than replacing, so scroll position survives', () => {
    const merged = mergePage([item('a', undefined, 'k1')], [item('b', undefined, 'k2')]);
    expect(merged[0].key).toBe('k1');
    expect(merged).toHaveLength(2);
  });
});

describe('view mode + panel width', () => {
  it('falls back cleanly when storage is unavailable or holds junk', () => {
    // Private mode, a cleared profile, or a stale value from an older build must
    // never leave the panel in an unrenderable state.
    expect(loadViewMode()).toBe('grid');
    localStorage.setItem('voidspace.assets.viewMode', 'nonsense');
    expect(loadViewMode()).toBe('grid');
    localStorage.setItem('voidspace.assets.viewMode', 'list');
    expect(loadViewMode()).toBe('list');
  });

  it('clamps a dragged width into the usable range', () => {
    // A panel dragged to 20px is unusable and a panel at 900px eats the canvas;
    // clamping is what keeps the drag from producing a broken layout.
    expect(clampPanelWidth(10)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(9999)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(300)).toBe(300);
  });

  it('rejects an out-of-range stored width rather than trusting it', () => {
    localStorage.setItem('voidspace.assets.panelWidth', '5000');
    // Falls back to the DEFAULT, which is the video editor's column width — the
    // board opening narrower than the editor was itself a parity gap.
    expect(loadPanelWidth()).toBe(320);
    localStorage.setItem('voidspace.assets.panelWidth', '280');
    expect(loadPanelWidth()).toBe(280);
  });
});

/**
 * Tile geometry.
 *
 * This is what "the board's panel is visibly different from the video editor's"
 * came down to: the two agreed on sources, buckets, labels and modes, then laid
 * the tiles out at different sizes. One definition, asserted here, is what stops
 * them drifting apart again.
 */
describe('tile geometry', () => {
  it('defines a size for every mode the panels offer', () => {
    for (const m of VIEW_MODES) {
      expect(TILE_MIN_PX[m]).toBeTypeOf('number');
      expect(TILE_GAP_PX[m]).toBeTypeOf('number');
    }
  });

  it('lays grid tiles out wider than compact ones', () => {
    expect(TILE_MIN_PX.grid).toBeGreaterThan(TILE_MIN_PX.compact);
  });

  it('gives list a single column and the grids auto-fill tracks', () => {
    expect(gridColumns('list')).toBe('1fr');
    expect(gridColumns('grid')).toBe(`repeat(auto-fill, minmax(${TILE_MIN_PX.grid}px, 1fr))`);
    expect(gridColumns('compact')).toBe(`repeat(auto-fill, minmax(${TILE_MIN_PX.compact}px, 1fr))`);
  });
});

/**
 * The auth-error test.
 *
 * This exists because the board's inline `/\b40[13]\b/` silently became
 * `/<U+0008>40[13]<U+0008>/` — a regex that compiles, looks right, and cannot
 * match. The panel's whole auth-race recovery was dead and a signed-in user saw
 * a permanent "Couldn't load — 401" on every cold load. Nothing failed loudly.
 */
describe('auth errors', () => {
  it('recognises the statuses a not-yet-authenticated request returns', () => {
    expect(isAuthError('Request failed: 401')).toBe(true);
    expect(isAuthError('library 403')).toBe(true);
  });

  it('does not claim unrelated failures are auth problems', () => {
    expect(isAuthError('500 internal error')).toBe(false);
    expect(isAuthError('timeout')).toBe(false);
    expect(isAuthError('')).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });

  it('does not match a number that merely CONTAINS 401', () => {
    // Word boundaries are the point; without them an asset id like 14012 or a
    // "1401 items" count would be read as a sign-in failure.
    expect(isAuthError('found 14012 items')).toBe(false);
  });

  it('is written with real escapes, not control characters', () => {
    // The exact corruption that caused this: a raw backspace where \b belonged.
    expect(isAuthError('40\u00081')).toBe(false);
    expect(isAuthError('401')).toBe(true);
  });
});

/**
 * The words on the controls.
 *
 * "Video" on the board versus "Videos" in the video editor is one character on
 * the control users hit most, across two panels that are meant to be the same
 * panel. Both hosts now render from these, so the drift cannot come back by
 * someone editing one file.
 */
describe('shared vocabulary', () => {
  it('names every kind once, for every host', () => {
    for (const id of KIND_ORDER) expect(KIND_LABEL[id]).toBeTruthy();
    expect(KIND_LABEL.video).toBe('Videos');
  });

  it('puts blocks last — they are designs, not the user own footage', () => {
    expect(KIND_ORDER[KIND_ORDER.length - 1]).toBe('block');
    expect(KIND_ORDER[0]).toBe('all');
  });

  it('promises description-search only where that lane is live', () => {
    expect(searchPlaceholder('mine', { semantic: true })).toContain('Describe it');
    expect(searchPlaceholder('mine', { semantic: false })).not.toContain('Describe it');
  });

  it('says something specific for every scope', () => {
    for (const s of ['project', 'generated', 'mine', 'shared', 'device'] as const) {
      expect(searchPlaceholder(s).length).toBeGreaterThan(8);
    }
  });

  it('switches wording for blocks regardless of scope', () => {
    expect(searchPlaceholder('mine', { kind: 'block' })).toContain('block');
    expect(searchPlaceholder('shared', { kind: 'block' })).toContain('block');
  });
});
