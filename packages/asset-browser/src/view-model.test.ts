/**
 * View-model tests.
 *
 * These pin the rules that must be IDENTICAL across the video, image and board
 * editors. If one of these changes, all three change together — that is the
 * point of the shared core, and these tests are what make it true rather than
 * aspirational.
 */
import { describe, expect, it } from 'vitest';
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, bucketOf, clampPanelWidth, groupByRecency, hasMore, loadPanelWidth, loadViewMode, mergePage, nextOffset } from './view-model';
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
    expect(loadPanelWidth()).toBe(244);
    localStorage.setItem('voidspace.assets.panelWidth', '320');
    expect(loadPanelWidth()).toBe(320);
  });
});
