import { describe, expect, it } from 'vitest';
import { MARK, SPACE_UNIT, commentsFromMarks, marksFromComments, readMark } from './align-marks';
import { parseMarkdown } from './blocks';

describe('deliberate space survives the canvas', () => {
  it('carries a gap as one empty paragraph per unit', () => {
    const md = marksFromComments('A\n\n<!-- space: 36 -->\n\nB\n');
    // The comment is gone — the adapter would have dropped it — and three
    // paragraphs stand in its place.
    expect(md).not.toContain('<!--');
    expect(md.split('\n').filter((l) => l === MARK.space)).toHaveLength(36 / SPACE_UNIT);
  });

  it('rounds an odd gap to whole units rather than dropping it', () => {
    const md = marksFromComments('<!-- space: 30 -->\n');
    expect(md.split('\n').filter((l) => l === MARK.space)).toHaveLength(3);
    expect(marksFromComments('<!-- space: 4 -->\n')).toContain(MARK.space);
  });

  it('reads a page break as a break, never as a gap', () => {
    // Four word joiners START WITH three, so order of checks is the whole test.
    expect(readMark(MARK.pagebreak)).toMatchObject({ pagebreak: true });
    expect(readMark(MARK.space)).toMatchObject({ space: true });
    expect(readMark(MARK.space).pagebreak).toBeUndefined();
    expect(readMark(MARK.pagebreak).space).toBeUndefined();
  });

  it('puts the comment back when the document leaves for a file', () => {
    const marks = marksFromComments('A\n\n<!-- space: 36 -->\n\nB\n');
    expect(commentsFromMarks(marks)).toContain('<!-- space: 36 -->');
    // ONE comment, not three.
    expect(commentsFromMarks(marks).match(/<!-- space:/g)).toHaveLength(1);
  });

  it('parses to the same blocks from the file and from the board', () => {
    const fromFile = parseMarkdown('A\n\n<!-- space: 36 -->\n\nB\n');
    const fromBoard = parseMarkdown(marksFromComments('A\n\n<!-- space: 36 -->\n\nB\n'));
    expect(fromFile.map((b) => b.kind)).toEqual(['para', 'space', 'para']);
    expect(fromBoard).toEqual(fromFile);
    expect(fromBoard[1]).toMatchObject({ kind: 'space', points: 36 });
  });

  it('drops a gap at the very top and merges neighbours', () => {
    const out = parseMarkdown('<!-- space: 12 -->\n\n<!-- space: 24 -->\n\nA\n');
    expect(out.filter((b) => b.kind === 'space')).toHaveLength(1);
    expect(out.find((b) => b.kind === 'space')).toMatchObject({ points: 36 });
  });
});
