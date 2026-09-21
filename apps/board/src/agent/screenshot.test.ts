/**
 * Deciding WHERE to look.
 *
 * The geometry is the part that can be wrong, and it can be wrong without a
 * canvas — so these drive `planRegions` with plain boxes. What they protect
 * against is the specific failure that made `scope: 'all'` useless: a picture
 * of a big board that looks like a picture and whose text nobody can read.
 */
import { describe, it, expect } from 'vitest';

import { planRegions } from './screenshot';

/** The shape `planRegions` actually reads: an id, an xywh, maybe a flavour. */
const el = (id: string, x: number, y: number, w = 400, h = 300, flavour = 'affine:note') =>
  ({ id, xywh: JSON.stringify([x, y, w, h]), flavour }) as never;

const frame = (id: string, x: number, y: number, w: number, h: number, title: string) =>
  ({ id, xywh: JSON.stringify([x, y, w, h]), flavour: 'affine:frame', title: { toString: () => title } }) as never;

const idsOf = (r: { models: any[] }) => r.models.map((m) => m.id).sort();

describe('planRegions', () => {
  it('leaves a small board alone — one picture, no tiling decision', () => {
    const out = planRegions([el('a', 0, 0), el('b', 500, 0)], 6);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('the whole board');
    expect(idsOf(out[0]!)).toEqual(['a', 'b']);
  });

  it('cuts a wide board into columns, in reading order', () => {
    // 8000 wide; the legible span is 1600/0.6 ≈ 2666, so this needs 3.
    const els = [0, 2600, 5200, 7600].map((x, i) => el(`e${i}`, x, 0, 400, 300));
    const out = planRegions(els, 6);

    expect(out.length).toBeGreaterThan(1);
    // Every element lands in exactly one region — assigned by centre, never
    // duplicated into two pictures.
    const all = out.flatMap(idsOf);
    expect(all.sort()).toEqual(['e0', 'e1', 'e2', 'e3']);
    // Left to right: the first region holds the leftmost element.
    expect(idsOf(out[0]!)).toContain('e0');
    expect(idsOf(out[out.length - 1]!)).toContain('e3');
  });

  it('cuts a tall board into rows, not columns', () => {
    const els = [0, 2600, 5200].map((y, i) => el(`e${i}`, 0, y, 400, 300));
    const out = planRegions(els, 6);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((r) => /region \d+ of \d+/.test(r.label))).toBe(true);
  });

  it('prefers the author\'s frames over a grid', () => {
    const els = [
      frame('f1', 0, 0, 3000, 1000, 'Act One'),
      el('a', 100, 100), el('b', 900, 100),
      frame('f2', 4000, 0, 3000, 1000, 'Act Two'),
      el('c', 4100, 100),
    ];
    const out = planRegions(els, 6);

    expect(out.map((r) => r.label)).toEqual(['Act One', 'Act Two']);
    expect(idsOf(out[0]!)).toEqual(['a', 'b', 'f1']);
    expect(idsOf(out[1]!)).toEqual(['c', 'f2']);
  });

  it('gathers what sits outside every frame — the stranded card matters most', () => {
    const els = [
      frame('f1', 0, 0, 3000, 1000, 'Act One'),
      el('a', 100, 100),
      el('stray', 6000, 4000),
    ];
    const out = planRegions(els, 6);
    const loose = out.find((r) => r.label === 'outside every frame');
    expect(loose).toBeDefined();
    expect(idsOf(loose!)).toEqual(['stray']);
  });

  it('never exceeds the tile cap, however big the board', () => {
    const els: any[] = [];
    for (let i = 0; i < 40; i++) els.push(el(`e${i}`, (i % 8) * 3000, Math.floor(i / 8) * 3000));
    const out = planRegions(els, 6);

    expect(out.length).toBeLessThanOrEqual(6);
    // And nothing is lost when the cap forces bigger tiles.
    expect(out.flatMap(idsOf).sort()).toEqual(els.map((e) => e.id).sort());
  });

  it('is empty for nothing, rather than throwing', () => {
    expect(planRegions([], 6)).toEqual([]);
  });
});
