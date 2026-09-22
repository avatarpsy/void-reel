/**
 * A table's column widths, both ways.
 *
 * The bug this pins: `<!-- columns: 3,1,1 -->` is dropped by the markdown
 * adapter, so a document that lived on a note exported with equal columns
 * while the canvas drew BlockSuite's own 2:1:1 — three answers for one
 * document, and nothing said so.
 */
import { describe, expect, it } from 'vitest';
import {
  applyTableWidths, columnsComment, tableWeights, weightsOfNote, withColumnComments,
} from './doc-tables';

const TABLE = [
  '<!-- columns: 3,1,1 -->',
  '',
  '| Description | Qty | Amount |',
  '| :--- | :-: | ---: |',
  '| A line item | 2 | 1,200.00 |',
  '',
].join('\n');

/** A note holding one table, shaped the way BlockSuite shapes one. */
function fakeBoard(columns: Record<string, { width?: number }>, width = 752) {
  const table = {
    flavour: 'affine:table',
    id: 't1',
    props: { columns: JSON.parse(JSON.stringify(columns)) },
  };
  const note = { props: { xywh: `[0,0,${width},400]` }, children: [table] };
  return {
    table,
    store: {
      getBlock: (id: string) => (id === 'n1' ? { model: note } : null),
      updateBlock: (_m: any, fn: () => void) => fn(),
    },
  };
}

const THREE = { a: {}, b: {}, c: {} };

describe('reading the widths a document asks for', () => {
  it('finds them in document order', () => {
    expect(tableWeights(`${TABLE}\n${TABLE.replace('3,1,1', '1,2')}`))
      .toEqual([[3, 1, 1], [1, 2]]);
  });

  it('leaves a table with no hint alone rather than forcing equal columns', () => {
    // BlockSuite's own default is reasonable; overruling it would make every
    // table the agent ever wrote look edited.
    expect(tableWeights(TABLE.replace('<!-- columns: 3,1,1 -->\n', ''))).toEqual([null]);
  });
});

describe('writing them onto the note', () => {
  it('spends the content width in the ratio asked for', () => {
    const board = fakeBoard(THREE);
    expect(applyTableWidths(board, 'n1', [[3, 1, 1]])).toBe(1);
    // 752 less the 64px page margin on both sides.
    const widths = Object.values(board.table.props.columns).map((c: any) => c.width);
    expect(widths).toEqual([374, 125, 125]);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(624);
  });

  it('pads a short hint with ones, like the PDF writer does', () => {
    // `columns: 3` on a three-column table means "first one wide".
    const board = fakeBoard(THREE);
    applyTableWidths(board, 'n1', [[3]]);
    const [a, b, c] = Object.values(board.table.props.columns).map((x: any) => x.width);
    expect(a).toBe(374);
    expect(b).toBe(c);
  });

  it('does nothing at all when no table asked', () => {
    const board = fakeBoard(THREE);
    expect(applyTableWidths(board, 'n1', [null])).toBe(0);
    expect(Object.values(board.table.props.columns).every((c: any) => c.width === undefined))
      .toBe(true);
  });
});

describe('reading them back off the note', () => {
  it('normalises to the narrowest column so the file is editable by hand', () => {
    const board = fakeBoard({ a: { width: 374 }, b: { width: 125 }, c: { width: 125 } });
    expect(weightsOfNote(board, 'n1')).toEqual([[2.99, 1, 1]]);
  });

  it('says nothing about equal columns, which are the default', () => {
    const board = fakeBoard({ a: { width: 200 }, b: { width: 200 }, c: { width: 200 } });
    expect(weightsOfNote(board, 'n1')).toEqual([null]);
  });

  it('says nothing when only some columns have been sized', () => {
    // Half a ratio is a guess, and a guess written into the file is worse
    // than the default it replaced.
    const board = fakeBoard({ a: { width: 300 }, b: {}, c: {} });
    expect(weightsOfNote(board, 'n1')).toEqual([null]);
  });
});

describe('putting the comment back into the markdown', () => {
  it('writes it above the table it belongs to', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    expect(withColumnComments(md, [[3, 1]])).toBe(`${columnsComment([3, 1])}\n${md}`);
  });

  it('matches the Nth table to the Nth set of weights', () => {
    const md = '| A |\n| --- |\n\ntext\n\n| B |\n| --- |\n';
    const out = withColumnComments(md, [null, [2, 1]]);
    expect(out.indexOf('<!-- columns:')).toBeGreaterThan(out.indexOf('text'));
    expect(out.match(/<!-- columns:/g)).toHaveLength(1);
  });

  it('leaves a pipe inside a fence alone', () => {
    // `| a | b |` in a code sample is not a table, and a comment shoved into
    // somebody's code is a worse bug than the one this fixes.
    const md = '```\n| a | b |\n```\n\n| A |\n| --- |\n';
    const out = withColumnComments(md, [[3, 1]]);
    expect(out.split('\n')[0]).toBe('```');
    expect(out.indexOf('<!-- columns:')).toBeGreaterThan(out.indexOf('```\n\n'));
  });

  it('is exactly what the parser reads back', () => {
    const board = fakeBoard({ a: { width: 374 }, b: { width: 125 }, c: { width: 125 } });
    const md = withColumnComments(
      '| Description | Qty | Amount |\n| --- | --- | --- |\n| x | 1 | 2 |\n',
      weightsOfNote(board, 'n1'),
    );
    // Round trip: off the note, into a file, and back to the same ratio.
    const [weights] = tableWeights(md);
    expect(weights![0]! / weights![1]!).toBeCloseTo(3, 1);
  });
});
