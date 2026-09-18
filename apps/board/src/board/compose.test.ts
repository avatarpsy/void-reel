import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { drawOnCanvas, fitFramesToMembers, readCanvas } from './canvas';
import { ACCENT_MAX_RATIO, CARD_W, GUTTER, composeRegion } from './compose';

/**
 * ── WHAT THIS FILE IS DEFENDING ─────────────────────────────────────────────
 * A real board came out with seventeen cards at four widths, fourteen of them
 * coloured, seven frames wrapping nothing, and a title in a box a third the
 * size of its own text. Every one of those is a decision with exactly one right
 * answer and no reason to be made per call.
 *
 * `composeRegion` takes content and owns the geometry, so the failures below
 * are not "unlikely" — they are unreachable through this door.
 */
const req = (over: Partial<Parameters<typeof composeRegion>[0]> = {}) => composeRegion({
  title: 'THE QUIET WAR',
  sections: [
    { title: 'THE WORLD', cards: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] },
    { title: 'THE CAST', cards: [{ text: 'four' }, { text: 'five' }] },
  ],
  ...over,
});

describe('the grid is not negotiable', () => {
  it('gives every card the same width', () => {
    const notes = req().elements.filter(e => e.kind === 'note');
    expect(new Set(notes.map(n => n.w))).toEqual(new Set([CARD_W]));
  });

  it('puts cards on one pitch, and wraps at the column count', () => {
    const { elements } = req({ columns: 3 });
    const xs = elements.filter(e => e.kind === 'note').map(e => e.x!);
    // Three columns, so only three distinct x values however many cards there are.
    expect([...new Set(xs)].sort((a, b) => a - b))
      .toEqual([0, CARD_W + GUTTER, (CARD_W + GUTTER) * 2]);
  });

  it('clamps a silly column count instead of drawing it', () => {
    expect(new Set(req({ columns: 99 }).elements.filter(e => e.kind === 'note').map(e => e.x)).size)
      .toBeLessThanOrEqual(4);
    expect(new Set(req({ columns: 0 }).elements.filter(e => e.kind === 'note').map(e => e.x)).size)
      .toBeGreaterThanOrEqual(1);
  });

  /** A section is a frame with members and NO box — see fitFramesToMembers. */
  it('never gives a frame coordinates, so it can fit its own contents', () => {
    for (const f of req().elements.filter(e => e.kind === 'frame')) {
      expect(f.x).toBeUndefined();
      expect(f.y).toBeUndefined();
      expect(f.w).toBeUndefined();
      expect(f.h).toBeUndefined();
      expect((f as { contains?: unknown[] }).contains!.length).toBeGreaterThan(0);
    }
  });

  it('draws exactly one title, and no heading per section', () => {
    // The frame carries the section name. Two titles for one region is the pile look.
    expect(req().elements.filter(e => e.kind === 'text')).toHaveLength(1);
    expect(req().elements.filter(e => e.kind === 'frame').map(f => (f as { title: string }).title))
      .toEqual(['THE WORLD', 'THE CAST']);
  });
});

describe('the accent budget is enforced, not advised', () => {
  /**
   * THE EXACT FAILURE. The guidance already said "uncoloured is fine and
   * usually better"; the board that prompted this had 14 of 17 coloured.
   */
  it('refuses to colour more than a third of the cards', () => {
    const { elements, notes } = composeRegion({
      title: 'T',
      sections: [{
        title: 'S',
        cards: Array.from({ length: 9 }, (_, i) => ({ text: `card ${i}`, accent: true })),
      }],
    });
    const coloured = elements.filter(e => e.kind === 'note' && !!(e as { color?: string }).color);
    expect(coloured.length).toBe(Math.floor(9 * ACCENT_MAX_RATIO));
    expect(notes.join(' ')).toMatch(/stops meaning anything/i);
  });

  it('spends the budget on the cards that asked first', () => {
    const { elements } = composeRegion({
      title: 'T',
      sections: [{
        title: 'S',
        cards: [
          { text: 'first', accent: true }, { text: 'second', accent: true },
          { text: 'third', accent: true }, { text: 'fourth' }, { text: 'fifth' },
          { text: 'sixth' },
        ],
      }],
    });
    const coloured = elements
      .filter(e => e.kind === 'note' && !!(e as { color?: string }).color)
      .map(e => (e as { text: string }).text);
    expect(coloured).toEqual(['first', 'second']);
  });

  it('uses one accent colour for the whole board', () => {
    const { elements } = composeRegion({
      title: 'T',
      accent: 'teal',
      sections: [
        { title: 'A', cards: [{ text: 'a', accent: true }, { text: 'b' }, { text: 'c' }] },
        { title: 'B', cards: [{ text: 'd', accent: true }, { text: 'e' }, { text: 'f' }] },
      ],
    });
    const colours = elements
      .filter(e => e.kind === 'note')
      .map(e => (e as { color?: string }).color)
      .filter(Boolean);
    expect(new Set(colours)).toEqual(new Set(['teal']));
  });
});

describe('nothing lands on top of anything', () => {
  /**
   * The composed plan is drawn for real and then read back, so this asserts
   * against the boxes BlockSuite actually kept — not the ones we asked for.
   */
  it('draws a whole page with no overlapping cards', () => {
    const board = makeTestBoard();
    const { elements } = composeRegion({
      title: 'THE QUIET WAR',
      subtitle: 'A war is being fought in every room, and it makes no sound.',
      sections: [
        {
          title: 'THE WORLD',
          cards: [
            { text: 'One tower block. Seven floors, one per drive.', accent: true },
            { text: 'See it completely and it dies. Fight it and it grows.' },
            { text: 'Funny for fifty seconds, then it turns.' },
            { text: 'A much longer card, written to be several lines tall so that the row below it has to clear a taller neighbour than the ones beside it.' },
          ],
        },
        {
          title: 'THE CAST',
          cards: [
            { text: 'Psy — awake, and tired.' },
            { text: 'Engineer45 — the fixer.' },
            { text: 'Derek — and the dragon.' },
          ],
        },
      ],
    });

    const r = drawOnCanvas(board.std, elements);
    expect(r.problems).toEqual([]);

    // Fit the frames the way the deferred pass does in the browser.
    const frames = elements
      .map((e, i) => ({ e, id: r.ids[i] }))
      .filter(z => z.e.kind === 'frame' && z.id);
    for (const f of frames) {
      const members = ((f.e as { contains: Array<{ ref: string }> }).contains)
        .map(m => r.refs[m.ref])
        .filter(Boolean);
      fitFramesToMembers(board.std, [{ frameId: f.id!, memberIds: members }]);
    }

    // Cards only — a frame is SUPPOSED to sit under its contents.
    const cards = readCanvas(board.std).filter(i => i.kind === 'note');
    expect(cards.length).toBe(8);
    for (let a = 0; a < cards.length; a++) {
      for (let b = a + 1; b < cards.length; b++) {
        const p = cards[a];
        const q = cards[b];
        const hit = p.x! < q.x! + q.w! && p.x! + p.w! > q.x!
          && p.y! < q.y! + q.h! && p.y! + p.h! > q.y!;
        expect(hit, `"${p.text?.slice(0, 20)}" overlaps "${q.text?.slice(0, 20)}"`).toBe(false);
      }
    }
  });

  it('keeps the title clear of the first row of cards', () => {
    const board = makeTestBoard();
    const { elements } = composeRegion({
      title: 'A VERY LONG TITLE THAT WOULD HAVE OVERFLOWED THE OLD 260px BOX',
      sections: [{ title: 'S', cards: [{ text: 'a card' }] }],
    });
    drawOnCanvas(board.std, elements);
    const items = readCanvas(board.std);
    const title = items.find(i => i.kind === 'text')!;
    const card = items.find(i => i.kind === 'note')!;
    expect(card.y!).toBeGreaterThanOrEqual(title.y! + title.h!);
  });
});
