/**
 * The open canvas, as the agent drives it.
 *
 * These run against a REAL `BlockStdScope` (see `test-board.ts`), so a green run
 * is evidence that BlockSuite accepted the props — which is the only thing worth
 * testing here. Every bug this file exists to catch was a prop shape BlockSuite
 * quietly ignored: an element that is created, is in the document, and paints
 * nothing.
 */
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';
import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { createShots } from '../shot/shots';
import { canvasDigest, drawOnCanvas, editCanvas, readCanvas, relaxOverlaps } from './canvas';

describe('drawing on the open canvas', () => {
  it('creates a sticky note carrying its text', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'note', text: 'The opening has to earn the next ten seconds.', color: 'yellow' },
    ]);

    expect(r.problems).toEqual([]);
    expect(r.ids[0]).toBeTruthy();

    const note = readCanvas(board.std).find(i => i.id === r.ids[0]);
    expect(note?.kind).toBe('note');
    expect(note?.text).toContain('earn the next ten seconds');
  });

  it('turns bullets and headings in a note into real blocks', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'note', text: '# Risks\n- cost\n- timing\n1. first' },
    ]);

    const children = board.store.getBlock(r.ids[0]!)!.model.children;
    expect(children.map(c => c.flavour)).toEqual([
      'affine:paragraph', 'affine:list', 'affine:list', 'affine:list',
    ]);
    expect((children[0].props as { type: string }).type).toBe('h1');
    expect((children[3].props as { type: string }).type).toBe('numbered');
  });

  it('creates shapes and text with the size it was given', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'shape', shape: 'ellipse', text: 'Awareness', x: 0, y: 0, w: 240, h: 120 },
      { kind: 'text', text: 'Funnel', x: 0, y: 200 },
    ]);

    expect(r.problems).toEqual([]);
    const items = readCanvas(board.std);
    const shape = items.find(i => i.id === r.ids[0]);
    expect(shape?.kind).toBe('shape');
    expect(shape?.w).toBe(240);
    expect(shape?.text).toBe('Awareness');
    expect(items.find(i => i.id === r.ids[1])?.kind).toBe('text');
  });

  /**
   * THE POINT OF A BATCH. A diagram is boxes AND the arrows between them, and an
   * agent cannot know the ids of things it has not created yet — so a connector
   * has to be able to name a sibling spec. Without this a flowchart is n round
   * trips and n undo steps.
   */
  it('lets a connector point at elements created in the same call', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { ref: 'a', kind: 'shape', text: 'Problem', x: 0, y: 0 },
      { ref: 'b', kind: 'shape', text: 'Solution', x: 400, y: 0 },
      { kind: 'connector', from: { ref: 'a' }, to: { ref: 'b' }, label: 'because' },
    ]);

    expect(r.problems).toEqual([]);
    expect(r.ids.every(Boolean)).toBe(true);
    expect(r.refs.a).toBe(r.ids[0]);

    const surface = board.std.get(GfxControllerIdentifier).surface!;
    const connector = surface.getElementById(r.ids[2]!) as unknown as
      | { source: { id?: string }; target: { id?: string } }
      | null;
    expect(connector?.source.id).toBe(r.ids[0]);
    expect(connector?.target.id).toBe(r.ids[1]);
  });

  /** A partly-wrong batch must leave the right parts standing and say what failed. */
  it('skips a bad spec rather than losing the whole batch', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'shape', text: 'kept', x: 0, y: 0 },
      { kind: 'connector', from: { id: 'nope' }, to: { x: 10, y: 10 } },
      { kind: 'shape', text: 'also kept', x: 300, y: 0 },
    ]);

    expect(r.ids[0]).toBeTruthy();
    expect(r.ids[1]).toBeNull();
    expect(r.ids[2]).toBeTruthy();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('the start');
  });

  it('builds a whole mind map from one nested tree', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      {
        kind: 'mindmap',
        x: 0,
        y: 0,
        tree: {
          text: 'Launch',
          children: [
            { text: 'Story', children: [{ text: 'Cold open' }] },
            { text: 'Proof' },
          ],
        },
      },
    ]);

    expect(r.problems).toEqual([]);
    expect(r.ids[0]).toBeTruthy();
    // The element lays itself out into shapes — four nodes means four of them.
    const shapes = readCanvas(board.std).filter(i => i.kind === 'shape');
    expect(shapes.map(s => s.text).sort()).toEqual(['Cold open', 'Launch', 'Proof', 'Story']);
  });

  /**
   * A web page as a card. This also proves the bookmark block is registered,
   * which is what the toolbar's own Link button silently depended on — see
   * `contract.test.ts`.
   */
  it('puts a web link on the board as a card', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'link', url: 'https://example.test/the-ad', title: 'The ad that works', x: 0, y: 0 },
    ]);

    expect(r.problems).toEqual([]);
    expect(board.store.getBlock(r.ids[0]!)?.model.flavour).toBe('affine:bookmark');
  });

  it('refuses a link that is not an http url rather than making a dead card', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [{ kind: 'link', url: 'not a url' }]);
    expect(r.ids[0]).toBeNull();
    expect(r.problems[0]).toContain('not an http(s) url');
  });

  it('places a batch clear of the filmstrip when it is given no coordinates', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['A', 'B']);
    const r = drawOnCanvas(board.std, [{ kind: 'note', text: 'thinking' }]);

    const note = readCanvas(board.std).find(i => i.id === r.ids[0])!;
    const shots = readCanvas(board.std).filter(i => i.kind === 'shot');
    // Below every shot, so it cannot land on top of the strip.
    expect(note.y).toBeGreaterThan(Math.max(...shots.map(s => s.y + s.h)));
  });

  /** One gesture in, one gesture out — a diagram must not take nine undos. */
  it('is a single undo step however many elements it draws', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [
      { ref: 'a', kind: 'shape', text: 'one', x: 0, y: 0 },
      { ref: 'b', kind: 'shape', text: 'two', x: 300, y: 0 },
      { kind: 'connector', from: { ref: 'a' }, to: { ref: 'b' } },
    ]);
    expect(readCanvas(board.std)).toHaveLength(3);

    board.store.undo();
    expect(readCanvas(board.std)).toHaveLength(0);
  });
});

describe('reading the canvas', () => {
  /**
   * The board's own blocks are IN the picture, marked. Leaving them out meant the
   * agent thought the filmstrip's space was empty and drew on top of it.
   */
  it('reports shots as anchors, marked as owned', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Cold open']);

    const shot = readCanvas(board.std).find(i => i.kind === 'shot');
    expect(shot).toBeTruthy();
    expect(shot?.owned).toBe(true);
    expect(shot?.text).toBe('Cold open');
  });

  it('lets a connector attach an idea to a shot', () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Cold open']);
    const r = drawOnCanvas(board.std, [
      { ref: 'idea', kind: 'note', text: 'open on the hands', x: 0, y: 1200 },
      { kind: 'connector', from: { ref: 'idea' }, to: { id: shotId } },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.ids[1]).toBeTruthy();
  });

  /**
   * The 400-character preview is right for "what is on this board" and wrong for
   * "turn what I wrote into a document" — the note somebody spent ten minutes on
   * is exactly the one that runs past it. Both halves are asserted because
   * dropping either loses something: without the cap a big board is a context
   * bomb, without `full` the user's own words are unreachable.
   */
  it('previews text by default and returns it whole on request', () => {
    const board = makeTestBoard();
    const long = 'x'.repeat(1200);
    drawOnCanvas(board.std, [{ kind: 'note', text: long }]);

    const preview = readCanvas(board.std).find(i => i.kind === 'note');
    expect(preview!.text.length).toBe(400);

    const full = readCanvas(board.std, { full: true }).find(i => i.kind === 'note');
    expect(full!.text.length).toBe(1200);
  });

  it('reads only the elements it is given ids for', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'note', text: 'keep me', x: 0, y: 0 },
      { kind: 'note', text: 'not me', x: 400, y: 0 },
    ]);

    const only = readCanvas(board.std, { ids: [r.ids[0]!] });
    expect(only).toHaveLength(1);
    expect(only[0]!.text).toContain('keep me');
  });
});

describe('the canvas digest', () => {
  /**
   * This is what rides in the agent's context on EVERY turn, so the two things
   * that matter are that it describes the thinking work and that it stays small.
   */
  it('counts loose items by kind and lists frame titles and note openings', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [
      { kind: 'frame', title: 'Options', x: 0, y: 0, w: 800, h: 600 },
      { kind: 'note', text: 'Hire someone\nand the rest of the body', x: 40, y: 900 },
      { kind: 'note', text: 'Do it myself', x: 400, y: 900 },
      { kind: 'shape', text: 'cost', x: 40, y: 1400 },
    ]);

    const d = canvasDigest(board.std);
    expect(d.total).toBe(4);
    expect(d.kinds.note).toBe(2);
    expect(d.kinds.shape).toBe(1);
    expect(d.frames).toEqual(['Options']);
    // First LINE only — the body belongs in a read, not in a per-turn summary.
    expect(d.notes).toContain('Hire someone');
    expect(d.notes.some(n => n.includes('rest of the body'))).toBe(false);
  });

  /**
   * Shots and the screenplay are reported in full alongside this. Counting them
   * here too makes a board look like it holds more than it does — a small lie
   * that surfaces as the agent describing work that is not there.
   */
  it('leaves the board\'s own blocks out of the count', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Cold open', 'The turn']);
    drawOnCanvas(board.std, [{ kind: 'note', text: 'a thought', x: 0, y: 2000 }]);

    const d = canvasDigest(board.std);
    expect(d.total).toBe(1);
    expect(d.kinds.shot).toBeUndefined();
  });

  it('stays bounded as the board grows', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, Array.from({ length: 60 }, (_, i) => ({
      kind: 'note' as const, text: `thought ${i}`, x: (i % 10) * 300, y: Math.floor(i / 10) * 300,
    })));

    const d = canvasDigest(board.std);
    expect(d.total).toBe(60);
    expect(d.notes.length).toBeLessThanOrEqual(24);
  });
});

describe('editing the canvas', () => {
  it('moves, resizes, recolours and deletes', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [{ kind: 'shape', text: 'x', x: 0, y: 0, w: 100, h: 100 }]);
    const id = r.ids[0]!;

    expect(editCanvas(board.std, [{ id, op: 'move', x: 50, y: 60 }]).changed).toBe(1);
    let item = readCanvas(board.std).find(i => i.id === id)!;
    expect([item.x, item.y]).toEqual([50, 60]);

    expect(editCanvas(board.std, [{ id, op: 'resize', w: 300, h: 200 }]).changed).toBe(1);
    item = readCanvas(board.std).find(i => i.id === id)!;
    expect([item.w, item.h]).toEqual([300, 200]);

    expect(editCanvas(board.std, [{ id, op: 'color', fill: 'blue' }]).changed).toBe(1);
    expect(editCanvas(board.std, [{ id, op: 'delete' }]).changed).toBe(1);
    expect(readCanvas(board.std).find(i => i.id === id)).toBeUndefined();
  });

  it('replaces a note’s text rather than appending to it', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [{ kind: 'note', text: 'first' }]);
    editCanvas(board.std, [{ id: r.ids[0]!, op: 'text', text: 'second' }]);

    const note = readCanvas(board.std).find(i => i.id === r.ids[0])!;
    expect(note.text).toBe('second');
  });

  /**
   * A shot has its own tools, its own validation and its own layout rule — the
   * filmstrip IS the compile order. A generic move would silently renumber the
   * film, so this refuses and names the tool to use instead.
   */
  it('refuses to move or delete a shot', () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Cold open']);

    const moved = editCanvas(board.std, [{ id: shotId, op: 'move', x: 9999, y: 9999 }]);
    expect(moved.changed).toBe(0);
    expect(moved.problems[0]).toContain('board_update_shot');

    const deleted = editCanvas(board.std, [{ id: shotId, op: 'delete' }]);
    expect(deleted.changed).toBe(0);
    expect(readCanvas(board.std).some(i => i.id === shotId)).toBe(true);
  });

  it('names an id it cannot find instead of failing silently', () => {
    const board = makeTestBoard();
    const r = editCanvas(board.std, [{ id: 'ghost', op: 'delete' }]);
    expect(r.changed).toBe(0);
    expect(r.problems[0]).toContain('ghost');
  });
});

/**
 * LAYOUT — nothing may land on top of anything else.
 *
 * The failure this pins came off a real board: a year of journal entries laid
 * out as a timeline, where the month notes auto-grew from the ~100px the agent
 * assumed to 284px, and the mind map and summary note placed below them were
 * drawn straight through. Neither size is knowable when the call is written, so
 * no amount of better prompting fixes it — the board has to resolve it.
 */
describe('overlap resolution', () => {
  // NOTES are what moves — a shape is placed at a size the agent chose, and
  // an explicit position is a decision the pass must not overrule.
  it('pushes a colliding element DOWN, never sideways', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'note', text: 'first', x: 0, y: 0, w: 400, h: 300 },
      { kind: 'note', text: 'second', x: 0, y: 100, w: 400, h: 300 },
    ]);
    relaxOverlaps(board.std, r.ids.filter(Boolean) as string[]);

    const items = readCanvas(board.std);
    const a = items.find(i => i.text.includes('first'))!;
    const b = items.find(i => i.text.includes('second'))!;

    // Horizontal position carries the meaning on a canvas — a timeline, a
    // comparison — so it must survive untouched.
    expect(b.x).toBe(a.x);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h);
  });

  it('leaves an already-clear layout exactly where it was', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'shape', text: 'a', x: 0, y: 0, w: 100, h: 100 },
      { kind: 'shape', text: 'b', x: 600, y: 0, w: 100, h: 100 },
    ]);
    const before = readCanvas(board.std).map(i => `${i.x},${i.y}`).sort();
    const moved = relaxOverlaps(board.std, r.ids.filter(Boolean) as string[]);

    expect(moved).toBe(0);
    expect(readCanvas(board.std).map(i => `${i.x},${i.y}`).sort()).toEqual(before);
  });

  /** A frame is a CONTAINER — it is supposed to sit under its contents. */
  it('never treats a frame as a collision', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'frame', title: 'Section', x: 0, y: 0, w: 1000, h: 800 },
      { kind: 'shape', text: 'inside', x: 100, y: 100, w: 200, h: 100 },
    ]);
    relaxOverlaps(board.std, r.ids.filter(Boolean) as string[]);

    // The shape stays inside the frame it was placed in.
    const inside = readCanvas(board.std).find(i => i.text === 'inside')!;
    expect(inside.y).toBe(100);
  });

  it('does not disturb what was already on the board', () => {
    const board = makeTestBoard();
    const first = drawOnCanvas(board.std, [{ kind: 'note', text: 'existing', x: 0, y: 0, w: 300, h: 200 }]);
    relaxOverlaps(board.std, first.ids.filter(Boolean) as string[]);

    const second = drawOnCanvas(board.std, [{ kind: 'note', text: 'newcomer', x: 0, y: 50, w: 300, h: 200 }]);
    relaxOverlaps(board.std, second.ids.filter(Boolean) as string[]);

    const items = readCanvas(board.std);
    // The incumbent holds its ground; the newcomer moves.
    expect(items.find(i => i.text.includes('existing'))!.y).toBe(0);
    const incumbent = items.find(i => i.text.includes('existing'))!;
    expect(items.find(i => i.text.includes('newcomer'))!.y)
      .toBeGreaterThanOrEqual(incumbent.y + incumbent.h);
  });

  it('resolves a chain rather than stopping at the first collision', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'note', text: 'x1', x: 0, y: 0, w: 300, h: 200 },
      { kind: 'note', text: 'x2', x: 0, y: 10, w: 300, h: 200 },
      { kind: 'note', text: 'x3', x: 0, y: 20, w: 300, h: 200 },
    ]);
    relaxOverlaps(board.std, r.ids.filter(Boolean) as string[]);

    const ys = readCanvas(board.std)
      .filter(i => /^x[123]/.test(i.text))
      .map(i => ({ t: i.text, y: i.y, h: i.h }))
      .sort((a, b) => a.t.localeCompare(b.t));
    expect(ys[1].y).toBeGreaterThanOrEqual(ys[0].y + ys[0].h);
    expect(ys[2].y).toBeGreaterThanOrEqual(ys[1].y + ys[1].h);
  });
});

/**
 * INLINE MARKDOWN. A model writes `**bold**` whether or not you ask it to, and
 * passed through as a plain string it renders as literal asterisks — the
 * cheapest possible way to make a generated board look unfinished.
 */
describe('note formatting', () => {
  it('turns **bold**, *italic* and `code` into real marks', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'note', text: '- **The pitch** outpaces the *life* and `code` too' },
    ]);

    const list = board.store.getBlock(r.ids[0]!)!.model.children[0];
    const deltas = (list.props as { text: { toDelta(): Array<{ insert: string; attributes?: Record<string, boolean> }> } })
      .text.toDelta();

    const bold = deltas.find(d => d.attributes?.bold);
    const italic = deltas.find(d => d.attributes?.italic);
    const code = deltas.find(d => d.attributes?.code);

    expect(bold?.insert).toBe('The pitch');
    expect(italic?.insert).toBe('life');
    expect(code?.insert).toBe('code');
    // And no asterisks survive into the rendered text.
    expect(deltas.map(d => d.insert).join('')).not.toContain('*');
  });

  it('leaves ordinary prose alone', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [{ kind: 'note', text: 'just a sentence' }]);
    const p = board.store.getBlock(r.ids[0]!)!.model.children[0];
    const deltas = (p.props as { text: { toDelta(): Array<{ insert: string }> } }).text.toDelta();
    expect(deltas.map(d => d.insert).join('')).toBe('just a sentence');
  });
});

/**
 * THE LIMIT OF THE LAYOUT PASS — and it is the important half.
 *
 * The first version moved anything that collided, and replayed against a real
 * agent spec (a title, a subtitle and nine month cards at one y, evenly spaced,
 * with NO overlaps anywhere) it moved the title down 72px, the subtitle 161px,
 * and split the row into two heights. It destroyed a correct layout, which is
 * strictly worse than the overlap it was written to fix.
 */
describe('the layout pass leaves deliberate work alone', () => {
  /** The exact shape the agent sent for the journal arc. */
  function arc() {
    const els: Array<Record<string, unknown>> = [
      { kind: 'text', x: 60, y: 60, fontSize: 40, text: 'Eight months, one arc' },
      { kind: 'text', x: 62, y: 115, fontSize: 14, text: 'Nov 24 to Jul 30' },
    ];
    for (let i = 0; i < 9; i++) {
      els.push({ kind: 'shape', x: 90 + i * 130, y: 250, w: 105, h: 135, text: `M${i}` });
    }
    return els;
  }

  it('does not touch a hand-placed row of shapes', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, arc() as never);
    const moved = relaxOverlaps(board.std, r.ids.filter(Boolean) as string[]);

    expect(moved).toBe(0);
    const shapes = readCanvas(board.std).filter(i => i.kind === 'shape');
    expect(shapes).toHaveLength(9);
    // One row, one y — the thing the agent actually asked for.
    expect(new Set(shapes.map(s => s.y)).size).toBe(1);
    expect(shapes[0].y).toBe(250);
  });

  it('never moves text the agent positioned', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'text', text: 'Title', x: 60, y: 60 },
      { kind: 'text', text: 'Subtitle', x: 62, y: 70 },
    ]);
    relaxOverlaps(board.std, r.ids.filter(Boolean) as string[]);

    const texts = readCanvas(board.std).filter(i => i.kind === 'text');
    // Even overlapping, they stay: an explicit position is a decision.
    expect(texts.map(t => t.y).sort((a, b) => a - b)).toEqual([60, 70]);
  });

  /** A NOTE is the case the pass exists for — its height is not knowable. */
  it('still moves a note that grew into something', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'shape', text: 'fixed', x: 0, y: 0, w: 400, h: 300 },
      { kind: 'note', text: 'a note that landed on top of it', x: 0, y: 100, w: 400 },
    ]);
    relaxOverlaps(board.std, r.ids.filter(Boolean) as string[]);

    const items = readCanvas(board.std);
    const shape = items.find(i => i.kind === 'shape')!;
    const note = items.find(i => i.kind === 'note')!;
    expect(shape.y).toBe(0);                          // the fixed thing holds
    expect(note.y).toBeGreaterThanOrEqual(shape.y + shape.h);
  });
});
