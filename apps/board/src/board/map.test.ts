import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { drawOnCanvas, fitFramesToMembers } from './canvas';
import { composeRegion } from './compose';
import { describeLayout, readBoardMap } from './map';

/**
 * ── THE FAILURE THIS READ EXISTS FOR ────────────────────────────────────────
 * An agent had the complete geometry of a 57-element board — zero overlaps,
 * consistent widths, frames fitted — declared it good, and the user's verdict
 * was "its crap, useless, it explains nothing". Every fault was computable and
 * none of it was computed.
 *
 * So these assert the two things raw coordinates could not give: a layout said
 * in words, and a judgement about whether the board communicates.
 */
function composed(board: ReturnType<typeof makeTestBoard>, req: Parameters<typeof composeRegion>[0]) {
  const { elements } = composeRegion(req);
  const r = drawOnCanvas(board.std, elements);
  elements.forEach((e, i) => {
    if (e.kind !== 'frame' || !r.ids[i]) return;
    const ids = (e as { contains: Array<{ ref: string }> }).contains
      .map(m => r.refs[m.ref]).filter(Boolean);
    fitFramesToMembers(board.std, [{ frameId: r.ids[i]!, memberIds: ids }]);
  });
  return r;
}

describe('the layout is described, not measured', () => {
  it('names a grid by its columns and rows', () => {
    expect(describeLayout([
      { x: 0, y: 0 }, { x: 470, y: 0 }, { x: 940, y: 0 },
      { x: 0, y: 300 }, { x: 470, y: 300 }, { x: 940, y: 300 },
    ])).toBe('3 columns x 2 rows');
  });

  it('names a run as a run, because that is what a reader sees', () => {
    expect(describeLayout([{ x: 0, y: 0 }, { x: 273, y: 0 }, { x: 546, y: 0 }]))
      .toBe('a run of 3, left to right');
  });

  it('names a column', () => {
    expect(describeLayout([{ x: 0, y: 0 }, { x: 0, y: 200 }])).toBe('a column of 2');
  });

  it('folds near-equal positions together, as a reader does', () => {
    // 4px out is the same column to anyone looking at it.
    expect(describeLayout([{ x: 0, y: 0 }, { x: 4, y: 200 }])).toBe('a column of 2');
  });
});

describe('a section is one line, whatever it holds', () => {
  it('reports each frame with its shape, its kinds and what it is about', () => {
    const board = makeTestBoard();
    composed(board, {
      title: 'THE QUIET WAR',
      sections: [
        { title: 'THE CAST', cards: [{ text: '# PSY\nawake' }, { text: '# SOFIA\ncannot lie' }, { text: '# DEREK\nthe dragon' }] },
        { title: 'S1E01', layout: 'sequence', cards: [{ text: '# Friction' }, { text: '# Deflection' }, { text: '# The tap' }] },
      ],
    });

    const map = readBoardMap(board.std);
    expect(map.sections.map(s => s.title)).toEqual(['THE CAST', 'S1E01']);

    const cast = map.sections[0];
    expect(cast.items).toBe(3);
    expect(cast.kinds.note).toBe(3);
    expect(cast.layout).toBe('a run of 3, left to right');
    // The digest gives the section a SUBJECT, not just a name.
    expect(cast.digest).toContain('PSY');
    expect(cast.digest).toContain('DEREK');
    // And the ids are the handle for the next level down.
    expect(cast.ids).toHaveLength(3);
  });

  it('claims each element once, so a section cannot double-count', () => {
    const board = makeTestBoard();
    composed(board, {
      title: 'T',
      sections: [
        { title: 'A', cards: [{ text: 'a1' }, { text: 'a2' }, { text: 'a3' }] },
        { title: 'B', cards: [{ text: 'b1' }, { text: 'b2' }, { text: 'b3' }] },
      ],
    });
    const map = readBoardMap(board.std);
    const all = map.sections.flatMap(s => s.ids);
    expect(new Set(all).size).toBe(all.length);
  });

  it('costs one line per section, not per element', () => {
    const board = makeTestBoard();
    composed(board, {
      title: 'BIG',
      sections: Array.from({ length: 6 }, (_, s) => ({
        title: `S${s}`,
        cards: Array.from({ length: 6 }, (_, c) => ({ text: `# card ${s}-${c}\nbody text here` })),
      })),
    });
    const map = readBoardMap(board.std);
    expect(map.board.elements).toBeGreaterThanOrEqual(36);
    expect(map.sections).toHaveLength(6);
    // The whole map stays small even though the board is not.
    expect(JSON.stringify(map).length).toBeLessThan(9000);
  });
});

describe('the board judges itself, because a screenshot cannot be trusted to', () => {
  const wall = (board: ReturnType<typeof makeTestBoard>) => composed(board, {
    title: 'THE QUIET WAR',
    // Measured at 870 x 3835, a ratio of 4.4 — which is within a whisker of the
    // real board that prompted all this (1340 x 5800, ratio 4.3).
    sections: Array.from({ length: 12 }, (_, s) => ({
      title: `S${s}`,
      cards: Array.from({ length: 2 }, (_, c) => ({ text: `# card ${s}-${c}\nsome body` })),
    })),
  });

  it('notices there are no images at all', () => {
    const board = makeTestBoard();
    wall(board);
    expect(readBoardMap(board.std).issues.join(' ')).toMatch(/not one image/i);
  });

  it('notices a ribbon nothing can take in', () => {
    const board = makeTestBoard();
    wall(board);
    const map = readBoardMap(board.std);
    expect(map.board.aspect).toMatch(/tall|wide/);
    expect(map.issues.join(' ')).toMatch(/taken in/i);
  });

  it('notices that every card is the same and nothing is emphasised', () => {
    const board = makeTestBoard();
    wall(board);
    expect(readBoardMap(board.std).issues.join(' ')).toMatch(/nowhere to land/i);
  });

  it('notices an element stranded outside every frame', () => {
    const board = makeTestBoard();
    wall(board);
    drawOnCanvas(board.std, [{ kind: 'note', text: 'orphan', x: 4000, y: 4000, w: 400, h: 100 }]);
    const map = readBoardMap(board.std);
    expect(map.loose.count).toBeGreaterThanOrEqual(1);
    expect(map.issues.join(' ')).toMatch(/outside every frame/i);
  });

  it('notices a card that is really a paragraph', () => {
    const board = makeTestBoard();
    composed(board, {
      title: 'T',
      sections: [{
        title: 'S',
        cards: Array.from({ length: 8 }, () => ({ text: 'x'.repeat(400) })),
      }],
    });
    expect(readBoardMap(board.std).issues.join(' ')).toMatch(/read at a glance/i);
  });

  it('says nothing about an empty board rather than inventing faults', () => {
    const board = makeTestBoard();
    const map = readBoardMap(board.std);
    expect(map.board.elements).toBe(0);
    expect(map.sections).toEqual([]);
    expect(map.issues).toEqual([]);
  });
});
