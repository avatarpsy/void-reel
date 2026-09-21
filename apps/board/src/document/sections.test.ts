/**
 * Reading and editing a document a section at a time.
 *
 * These run against a REAL board, because the whole value of this module is
 * that a section's address survives edits to its neighbours — and that is a
 * property of BlockSuite's block ids, not of anything a mock would show.
 */
import { describe, it, expect } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { placeMarkdownDocument, noteToMarkdown } from './note-io';
import { outline, listDocuments, readSections, editSection, searchDocument } from './sections';

const DOC = [
  'An opening paragraph before any heading at all.',
  '',
  '# The Report',
  '',
  'Intro under the title.',
  '',
  '## Findings',
  '',
  'What we found.',
  '',
  '### Detail',
  '',
  'A subsection that belongs to Findings.',
  '',
  '## Recommendations',
  '',
  'What to do.',
].join('\n');

async function docBoard(md = DOC) {
  const board = makeTestBoard();
  const { noteId } = await placeMarkdownDocument(board as any, md, { x: 0, y: 0 });
  return { board: board as any, noteId };
}

describe('outline', () => {
  it('is the cheap complete index — every section, no text', async () => {
    const { board, noteId } = await docBoard();
    const secs = outline(board, noteId);

    expect(secs.map((s) => [s.level, s.heading])).toEqual([
      [0, ''],              // the preamble is a section too
      [1, 'The Report'],
      [2, 'Findings'],
      [3, 'Detail'],
      [2, 'Recommendations'],
    ]);
    for (const s of secs) expect(s.words).toBeGreaterThan(0);
  }, 60_000);

  it('gives every section a stable block id, not an index', async () => {
    const { board, noteId } = await docBoard();
    const before = outline(board, noteId);

    /**
     * Rewrite the DEEPEST section. Replacing `# The Report` would legitimately
     * take the whole document with it — a level-1 heading owns everything until
     * the next level-1 — so it would prove nothing about stability.
     */
    const detail = before.find((s) => s.heading === 'Detail')!;
    await editSection(board, noteId, 'replace', {
      sectionId: detail.id,
      markdown: '### Detail\n\nRewritten, and rather longer than it was before.',
    });

    const after = outline(board, noteId);
    const stable = (list: any[]) => list
      .filter((s) => ['The Report', 'Findings', 'Recommendations'].includes(s.heading))
      .map((s) => s.id);
    expect(stable(after)).toEqual(stable(before));
  }, 60_000);
});

describe('listDocuments', () => {
  it('finds every document on the board, because a board holds several', async () => {
    const { board, noteId } = await docBoard();
    await placeMarkdownDocument(board, '# Second Doc\n\nIts body.', { x: 1200, y: 0 });

    const docs = listDocuments(board);
    expect(docs.map((d) => d.title).sort()).toEqual(['Second Doc', 'The Report']);
    expect(docs.find((d) => d.noteId === noteId)!.sections).toBe(5);
  }, 60_000);

  /** An empty sticky is not a document; listing it sends the caller nowhere. */
  it('leaves out notes with nothing in them', async () => {
    const { board } = await docBoard();
    board.store.addBlock('affine:note', {}, board.pageId);
    expect(listDocuments(board)).toHaveLength(1);
  }, 60_000);
});

describe('readSections', () => {
  it('returns the whole document when it fits', async () => {
    const { board, noteId } = await docBoard();
    const { markdown, omitted } = await readSections(board, noteId);
    expect(omitted).toEqual([]);
    expect(markdown).toContain('The Report');
    expect(markdown).toContain('Recommendations');
  }, 60_000);

  it('returns just the sections asked for', async () => {
    const { board, noteId } = await docBoard();
    const secs = outline(board, noteId);
    const recs = secs.find((s) => s.heading === 'Recommendations')!;

    const { markdown } = await readSections(board, noteId, { ids: [recs.id] });
    expect(markdown).toContain('What to do');
    expect(markdown).not.toContain('What we found');
  }, 60_000);

  /**
   * A heading owns everything under it until a heading of the same or higher
   * level — so asking for Findings must bring Detail with it, which is what
   * anyone reading the document would expect.
   */
  it('a section carries its subsections', async () => {
    const { board, noteId } = await docBoard();
    const findings = outline(board, noteId).find((s) => s.heading === 'Findings')!;
    const { markdown } = await readSections(board, noteId, { ids: [findings.id] });
    expect(markdown).toContain('What we found');
    expect(markdown).toContain('A subsection that belongs to Findings');
    expect(markdown).not.toContain('What to do');
  }, 60_000);

  /**
   * TRUNCATION THAT IS NOT REPORTED is a caller confidently summarising half a
   * document. It cuts at a section boundary and names what it dropped.
   */
  it('cuts at a section boundary and says what it left out', async () => {
    const long = ['# Long'];
    for (let i = 1; i <= 40; i++) {
      long.push('', `## Section ${i}`, '', 'Body text for this section. '.repeat(20));
    }
    const { board, noteId } = await docBoard(long.join('\n'));

    const { markdown, omitted } = await readSections(board, noteId, { budget: 4000 });
    expect(markdown.length).toBeLessThanOrEqual(4500);
    expect(omitted.length).toBeGreaterThan(0);
    for (const o of omitted) {
      expect(o.id, 'an omitted section must be re-askable by id').toBeTruthy();
      expect(o.heading).toMatch(/Section \d+/);
    }
  }, 120_000);
});

describe('editSection', () => {
  it('replaces one section and leaves the rest alone', async () => {
    const { board, noteId } = await docBoard();
    const findings = outline(board, noteId).find((s) => s.heading === 'Findings')!;

    await editSection(board, noteId, 'replace', {
      sectionId: findings.id,
      markdown: '## Findings\n\nRewritten entirely.',
    });

    const md = await noteToMarkdown(board, noteId);
    expect(md).toContain('Rewritten entirely');
    expect(md).not.toContain('What we found');
    // Its subsection went with it — replacing a section replaces what it owns.
    expect(md).not.toContain('A subsection that belongs');
    // And nothing else moved.
    expect(md).toContain('An opening paragraph');
    expect(md).toContain('What to do');
  }, 60_000);

  it('inserts before and after a section', async () => {
    const { board, noteId } = await docBoard();
    const recs = outline(board, noteId).find((s) => s.heading === 'Recommendations')!;

    await editSection(board, noteId, 'before', {
      sectionId: recs.id, markdown: '## Risks\n\nWhat could go wrong.',
    });
    await editSection(board, noteId, 'after', {
      sectionId: recs.id, markdown: '## Appendix\n\nThe numbers.',
    });

    expect(outline(board, noteId).map((s) => s.heading)).toEqual(
      ['', 'The Report', 'Findings', 'Detail', 'Risks', 'Recommendations', 'Appendix'],
    );
  }, 60_000);

  it('appends to the end', async () => {
    const { board, noteId } = await docBoard();
    await editSection(board, noteId, 'append', { markdown: '## Last Word\n\nThe end.' });
    expect(outline(board, noteId).at(-1)!.heading).toBe('Last Word');
  }, 60_000);

  it('deletes a section and what it owns', async () => {
    const { board, noteId } = await docBoard();
    const findings = outline(board, noteId).find((s) => s.heading === 'Findings')!;
    await editSection(board, noteId, 'delete', { sectionId: findings.id });

    const headings = outline(board, noteId).map((s) => s.heading);
    expect(headings).not.toContain('Findings');
    expect(headings, 'the subsection should have gone too').not.toContain('Detail');
    expect(headings).toContain('Recommendations');
  }, 60_000);

  /**
   * An edit moves indices and can merge or split sections, so a caller working
   * from the outline it held BEFORE would address the wrong thing next.
   */
  it('hands back the outline AFTER the edit, every time', async () => {
    const { board, noteId } = await docBoard();
    const recs = outline(board, noteId).find((s) => s.heading === 'Recommendations')!;
    const { outline: fresh } = await editSection(board, noteId, 'after', {
      sectionId: recs.id, markdown: '## Added\n\nBody.',
    });
    expect(fresh.map((s) => s.heading)).toContain('Added');
    expect(fresh).toEqual(outline(board, noteId));
  }, 60_000);

  it('refuses a stale section id with words that say what to do', async () => {
    const { board, noteId } = await docBoard();
    await expect(editSection(board, noteId, 'replace', {
      sectionId: 'no-such-block', markdown: '## X\n\nY.',
    })).rejects.toThrow(/Read the outline again/i);
  }, 60_000);

  it('refuses to write nothing', async () => {
    const { board, noteId } = await docBoard();
    const first = outline(board, noteId)[1]!;
    await expect(editSection(board, noteId, 'replace', { sectionId: first.id, markdown: '  ' }))
      .rejects.toThrow(/empty/i);
  }, 60_000);
});

/**
 * GREP FOR A DOCUMENT.
 *
 * The outline gives a document's shape and cannot say where a word is. Without
 * search, "what does it say about pricing" on a sixty-page report means reading
 * all of it to find two sentences — the exact cost this module exists to avoid,
 * reintroduced by the question people ask most often.
 */
describe('searchDocument', () => {
  it('finds matches and says which SECTION each is in', async () => {
    const { board, noteId } = await docBoard();
    const hits = await searchDocument(board, noteId, 'What we found');

    expect(hits).toHaveLength(1);
    expect(hits[0]!.heading).toBe('Findings');
    expect(hits[0]!.line).toContain('What we found');
    // The id is the point: it leads straight into a bounded read or an edit.
    const { markdown } = await readSections(board, noteId, { ids: [hits[0]!.id] });
    expect(markdown).toContain('What we found');
  }, 60_000);

  it('attributes a hit to its NEAREST heading, not to an ancestor', async () => {
    const { board, noteId } = await docBoard();
    const hits = await searchDocument(board, noteId, 'subsection that belongs');
    expect(hits[0]!.heading).toBe('Detail');
  }, 60_000);

  it('is case-insensitive, because nobody types the document back exactly', async () => {
    const { board, noteId } = await docBoard();
    expect(await searchDocument(board, noteId, 'RECOMMENDATIONS')).not.toHaveLength(0);
  }, 60_000);

  it('returns nothing for a term that is not there, rather than guessing', async () => {
    const { board, noteId } = await docBoard();
    expect(await searchDocument(board, noteId, 'kangaroo')).toEqual([]);
    expect(await searchDocument(board, noteId, '   ')).toEqual([]);
  }, 60_000);

  it('caps the hits, so a common word cannot return the document', async () => {
    const many = ['# Big'];
    for (let i = 1; i <= 30; i++) many.push('', `## S${i}`, '', 'the word appears here', 'the word again');
    const { board, noteId } = await docBoard(many.join('\n'));
    const hits = await searchDocument(board, noteId, 'the word', { max: 10 });
    expect(hits).toHaveLength(10);
  }, 120_000);
});
