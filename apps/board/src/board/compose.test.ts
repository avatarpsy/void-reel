import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { drawOnCanvas, fitFramesToMembers, readCanvas } from './canvas';
import {
  ACCENT_MAX_RATIO, CARD_W, GUTTER, type ComposeBox, cardHeight, columnsFor, composeRegion,
  numberCard, reflowComposed, sequenceWidth,
} from './compose';

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

/**
 * ── CALIBRATED AGAINST CARDS A BROWSER REALLY DREW ──────────────────────────
 * The first estimate under-read by up to 31%, which put one card 19px on top of
 * the one above it on a live board. Under is the only dangerous direction:
 * over-estimating costs whitespace the frame absorbs, under-estimating collides.
 *
 * These are the real heights, read back off the board after AFFiNE had grown
 * every card. Each must be met or exceeded — never under.
 */
describe('cardHeight never under-reads a real card', () => {
  /**
   * Re-measured 2026-10-05 on the current note theme (the earlier table was
   * taken on an older, tighter one and no longer matches what renders).
   * Read back with board_canvas_read after every note had finished growing.
   */
  const beat = '# 1 · Beat 1\nHe takes the stairs down past the floors he swore he would never visit, and every landing is quieter than the last one.';
  const real: Array<[string, string, number, number?]> = [
    [
      'a long line, no heading',
      'One tower block. Seven floors, one per drive — Survival at the ground, Purpose at the top. Riders nest by floor and travel in the walls.',
      294,
    ],
    [
      'heading plus two short lines',
      '# The one rule\nSee it completely and it dies.\nFight it and it grows.',
      296,
    ],
    ['one word', 'short', 201],
    ['one medium line', 'Funny for fifty seconds. Then it turns, and the last ten seconds hurt.', 248],
    ['a narrow sequence beat (w=248)', beat, 637, 248],
    ['a narrower sequence beat (w=203)', beat, 928, 203],
  ];

  for (const [label, text, actual, width] of real) {
    it(`${label}: covers the real ${actual}px`, () => {
      const h = cardHeight(text, width);
      expect(h, 'must never be under the real height').toBeGreaterThanOrEqual(actual);
      // …and not so far over that the page turns into whitespace.
      expect(h, 'must not be absurdly over').toBeLessThan(actual * 1.6);
    });
  }

  it('gives an empty card a floor rather than nothing', () => {
    expect(cardHeight('')).toBeGreaterThanOrEqual(96);
  });
});

/**
 * THE COLLISION ITSELF, at the row that produced it: a tall card in column one
 * and a second row beneath it.
 */
describe('a tall card does not get sat on', () => {
  it('clears the tallest card in the row above', () => {
    const { elements } = composeRegion({
      title: 'T',
      columns: 3,
      sections: [{
        title: 'S',
        cards: [
          { text: '# SEVEN\nOne tower block. Seven floors, one per drive — Survival at the ground, Purpose at the top. Riders nest by floor and travel in the walls.' },
          { text: '# Short' },
          { text: '# Also short' },
          { text: 'The card that used to land on top of SEVEN.' },
        ],
      }],
    });
    const notes = elements.filter(e => e.kind === 'note');
    const tall = notes[0];
    const below = notes[3];
    expect(below.y!).toBeGreaterThanOrEqual(tall.y! + 194);
  });
});

/**
 * Four cards in three columns leaves a row of one and two empty slots — half a
 * screen of nothing, which is exactly how the first composed board looked.
 */
describe('a section picks the column count that fills', () => {
  const cases: Array<[number, number, number]> = [
    [4, 3, 2],  // 3+1 orphan  ->  2+2 filled
    [3, 3, 3],  // already exact
    [6, 3, 3],  // already exact
    [5, 3, 3],  // 3+2 beats 2+2+1
    [2, 3, 2],
    [7, 4, 4],  // 4+3 beats 3+3+1
  ];
  for (const [count, requested, expected] of cases) {
    it(`${count} cards asked for ${requested} columns -> ${expected}`, () => {
      expect(columnsFor(count, requested)).toBe(expected);
    });
  }

  it('lays four cards out as a filled 2x2, not 3 and an orphan', () => {
    const { elements } = composeRegion({
      title: 'T',
      columns: 3,
      sections: [{ title: 'S', cards: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] }],
    });
    const xs = elements.filter(e => e.kind === 'note').map(e => e.x!);
    expect(new Set(xs).size, 'two columns').toBe(2);
    // …and two distinct rows.
    expect(new Set(elements.filter(e => e.kind === 'note').map(e => e.y!)).size).toBe(2);
  });

  it('decides per section, so one orphan does not narrow the whole page', () => {
    const { elements } = composeRegion({
      title: 'T',
      columns: 3,
      sections: [
        { title: 'FOUR', cards: Array.from({ length: 4 }, (_, i) => ({ text: `a${i}` })) },
        { title: 'SIX', cards: Array.from({ length: 6 }, (_, i) => ({ text: `b${i}` })) },
      ],
    });
    const notes = elements.filter(e => e.kind === 'note') as Array<{ text: string; x: number }>;
    const four = new Set(notes.filter(n => n.text.startsWith('a')).map(n => n.x));
    const six = new Set(notes.filter(n => n.text.startsWith('b')).map(n => n.x));
    expect(four.size).toBe(2);
    expect(six.size).toBe(3);
  });
});

/**
 * ── ORDERED CONTENT READS DIFFERENTLY FROM UNORDERED ────────────────────────
 * A season is sections stacked down the page; an episode is one run across it.
 * The same shape is a funnel, a process or a checklist — nothing here knows the
 * word "episode", which is the point.
 */
describe('a sequence is a run, not a grid', () => {
  const beats = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `# Beat ${i + 1}\nwhat happens` }));

  it('keeps every card on ONE row, however many there are', () => {
    const { elements } = composeRegion({
      title: 'S1',
      columns: 3,
      sections: [{ title: 'S1E01', layout: 'sequence', cards: beats(5) }],
    });
    const notes = elements.filter(e => e.kind === 'note');
    expect(new Set(notes.map(n => n.y)).size, 'one row').toBe(1);
    expect(new Set(notes.map(n => n.x)).size, 'five distinct columns').toBe(5);
  });

  it('spans the same width as the page grid, so sections line up', () => {
    const page = 3 * CARD_W + 2 * GUTTER;
    const { elements } = composeRegion({
      title: 'S1',
      columns: 3,
      sections: [{ title: 'E1', layout: 'sequence', cards: beats(5) }],
    });
    const notes = elements.filter(e => e.kind === 'note');
    const right = Math.max(...notes.map(n => n.x! + n.w!));
    expect(Math.abs(right - page), 'run ends on the page edge').toBeLessThanOrEqual(6);
    expect(Math.min(...notes.map(n => n.x!))).toBe(0);
  });

  it('numbers a run, because there the order is information', () => {
    const { elements } = composeRegion({
      title: 'S1',
      sections: [{ title: 'E1', layout: 'sequence', cards: beats(3) }],
    });
    const texts = elements.filter(e => e.kind === 'note').map(e => (e as { text: string }).text);
    expect(texts[0]).toMatch(/^# 1 · Beat 1/);
    expect(texts[2]).toMatch(/^# 3 · Beat 3/);
  });

  it('does NOT number a grid, where order is an accident of typing', () => {
    const { elements } = composeRegion({
      title: 'T',
      sections: [{ title: 'S', cards: [{ text: '# One' }, { text: '# Two' }, { text: '# Three' }] }],
    });
    const texts = elements.filter(e => e.kind === 'note').map(e => (e as { text: string }).text);
    expect(texts.every(t => !/^#\s*\d+\s*·/.test(t))).toBe(true);
  });

  it('numbers a card that has no heading, without eating its text', () => {
    expect(numberCard('just a line', 2)).toBe('**2** just a line');
    expect(numberCard('# Head\nbody', 4)).toBe('# 4 · Head\nbody');
  });

  it('lets a long run overflow rather than shrink into slivers', () => {
    // Ten beats cannot fit the page width and stay readable.
    expect(sequenceWidth(10, 3)).toBeGreaterThanOrEqual(220);
    expect(sequenceWidth(5, 3)).toBeLessThan(CARD_W);
  });

  it('stacks runs down the page in order, so a season reads top to bottom', () => {
    const { elements } = composeRegion({
      title: 'SEASON ONE',
      columns: 3,
      sections: [
        { title: 'S1E01', layout: 'sequence', cards: beats(4) },
        { title: 'S1E02', layout: 'sequence', cards: beats(4) },
        { title: 'S1E03', layout: 'sequence', cards: beats(4) },
      ],
    });
    const frames = elements.filter(e => e.kind === 'frame');
    expect(frames.map(f => (f as { title: string }).title)).toEqual(['S1E01', 'S1E02', 'S1E03']);
    // Each episode's cards start further down than the last one's.
    const notes = elements.filter(e => e.kind === 'note') as Array<{ y: number }>;
    const rows = [...new Set(notes.map(n => n.y))].sort((a, b) => a - b);
    expect(rows.length).toBe(3);
  });

  it('mixes a run and a grid on one page without either breaking', () => {
    const { elements } = composeRegion({
      title: 'T',
      columns: 3,
      sections: [
        { title: 'THE WORLD', cards: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
        { title: 'S1E01', layout: 'sequence', cards: beats(5) },
      ],
    });
    const notes = elements.filter(e => e.kind === 'note') as Array<{ x: number; w: number; text: string }>;
    const grid = notes.filter(n => !/·/.test(n.text));
    const runCards = notes.filter(n => /·/.test(n.text));
    expect(new Set(grid.map(n => n.w))).toEqual(new Set([CARD_W]));
    expect(new Set(runCards.map(n => n.w)).size).toBe(1);
    // Both start on the same left edge — one document, not two.
    expect(Math.min(...grid.map(n => n.x))).toBe(Math.min(...runCards.map(n => n.x)));
  });
});

/**
 * ── THE PAGE IS RE-STACKED FROM WHAT THE RENDERER REALLY DREW ──────────────
 * Measured on a live board: a 248-wide sequence card estimated ~390 rendered
 * 629, and the composed page had 35 overlapping pairs. These boxes play that
 * back — every card far taller than planned — and the reflow must still leave
 * no card on a card and no frame on the next section or the title.
 */
describe('reflow from measured heights', () => {
  it('leaves nothing overlapping when every card grew past its estimate', () => {
    const plan = composeRegion({
      title: 'SEASON ONE',
      subtitle: 'Seven floors, one per drive.',
      columns: 3,
      sections: [
        { title: 'S1E01', layout: 'sequence', cards: Array.from({ length: 5 }, (_, i) => ({ text: `# Beat ${i}\nHe takes the stairs down past the floors he swore he would never visit.` })) },
        { title: 'THE WORLD', cards: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }, { text: 'f' }] },
        { title: 'S1E02', layout: 'sequence', cards: [{ text: 'x' }, { text: 'y' }] },
      ],
    });

    // The planned boxes, with every note grown to 629 — and the subtitle too.
    const boxes: Record<string, ComposeBox> = {};
    for (const e of plan.elements) {
      if (!e.ref || e.kind === 'frame') continue;
      boxes[e.ref] = { x: e.x!, y: e.y!, w: e.w ?? 900, h: e.kind === 'note' ? 629 : 76 };
    }
    for (const m of reflowComposed(plan.layout, boxes)) boxes[m.ref] = { ...boxes[m.ref], y: m.y };

    // Frames as `fitFramesToMembers` draws them: 56 pad, 48 title bar above.
    const frames = plan.layout.sections.map(s => {
      const m = s.rows.flat().map(r => boxes[r]);
      const x = Math.min(...m.map(b => b.x)) - 56;
      const y = Math.min(...m.map(b => b.y)) - 104;
      const r = Math.max(...m.map(b => b.x + b.w)) + 56;
      const btm = Math.max(...m.map(b => b.y + b.h)) + 56;
      return { x, y, w: r - x, h: btm - y };
    });
    const hit = (p: ComposeBox, q: ComposeBox) =>
      p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;

    const cards = Object.entries(boxes);
    for (let a = 0; a < cards.length; a++) {
      for (let b = a + 1; b < cards.length; b++) {
        expect(hit(cards[a][1], cards[b][1]), `${cards[a][0]} on ${cards[b][0]}`).toBe(false);
      }
    }
    for (let a = 0; a < frames.length; a++) {
      for (let b = a + 1; b < frames.length; b++) {
        expect(hit(frames[a], frames[b]), `frame ${a} on frame ${b}`).toBe(false);
      }
      expect(hit(frames[a], boxes['compose-title']), `frame ${a} on the title`).toBe(false);
      expect(hit(frames[a], boxes['compose-sub']), `frame ${a} on the subtitle`).toBe(false);
    }
    // A sequence stays one row after the reflow.
    expect(new Set(plan.layout.sections[0].rows.flat().map(r => boxes[r].y)).size).toBe(1);
  });

  it('moves nothing when the estimate was already right', () => {
    const plan = composeRegion({ title: 'T', sections: [{ title: 'S', cards: [{ text: 'a' }, { text: 'b' }] }] });
    const boxes: Record<string, ComposeBox> = {};
    for (const e of plan.elements) {
      if (!e.ref || e.kind === 'frame') continue;
      boxes[e.ref] = { x: e.x!, y: e.y!, w: e.w ?? 400, h: e.kind === 'note' ? cardHeight((e as { text: string }).text) : 76 };
    }
    // The title's real height differs from the estimate, so anchor the check on it.
    boxes['compose-title'].h = boxes['c0-0'].y - 104 - 40 - boxes['compose-title'].y;
    expect(reflowComposed(plan.layout, boxes)).toEqual([]);
  });
});
