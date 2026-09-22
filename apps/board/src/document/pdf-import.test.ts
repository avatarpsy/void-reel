/**
 * Turning coordinates back into a document.
 *
 * ── WHY THE LAYOUTS ARE BUILT BY HAND ───────────────────────────────────────
 * Because each one is a STATEMENT about what the geometry means, and a fixture
 * file cannot make a statement. "A line 1.6x the body size is a heading" is
 * testable in three lines here and needs a hand-made PDF and a paragraph of
 * explanation anywhere else. The numbers below are taken from what real PDFs
 * look like: A4 at 595x842, an inch of margin, 11pt body, headings at 22/16/13.
 *
 * What this does NOT cover is pdfjs itself — whether `transform[3]` really is
 * the size, whether the y needs flipping. That is the app's `pdfLayout`, and it
 * is verified against a real file in the browser rather than guessed at here.
 */
import { describe, it, expect } from 'vitest';

import { importPdfLayout, type PdfPageLayout, type PdfTextItem } from './pdf-import';

const MARGIN = 72;
const PAGE = { width: 595, height: 842 };

/** One run, at a position, with the width a real extractor would report. */
function run(text: string, x: number, y: number, size = 11, font = 'Georgia'): PdfTextItem {
  // ~0.5em per character is close enough for a serif face, and the tests that
  // care about width say so explicitly rather than relying on it.
  return { text, x, y, width: text.length * size * 0.5, size, font };
}

function page(items: PdfTextItem[]): PdfPageLayout {
  return { ...PAGE, items };
}

const textOf = (blocks: any[]) =>
  blocks.flatMap((b) => b.runs ?? []).map((r: any) => r.text).join('');

describe('lines', () => {
  it('joins runs that share a baseline, in reading order', () => {
    const { blocks } = importPdfLayout([page([
      run('world', MARGIN + 40, 100),
      run('Hello ', MARGIN, 100),
    ])]);
    expect(textOf(blocks)).toBe('Hello world');
  });

  /**
   * A PDF frequently does not store the space between two words. Without this
   * an imported document reads "thepositioningisthat".
   */
  it('puts back a space the PDF did not store', () => {
    const { blocks } = importPdfLayout([page([
      run('The', MARGIN, 100),
      run('positioning', MARGIN + 22, 100),
    ])]);
    expect(textOf(blocks)).toBe('The positioning');
  });

  it('does not invent a space between runs that are touching', () => {
    const items = [run('Void', MARGIN, 100), run('space', MARGIN + 4 * 11 * 0.5, 100)];
    expect(textOf(importPdfLayout([page(items)]).blocks)).toBe('Voidspace');
  });

  /** Tolerance scales with the type size, or big text splits into two lines. */
  it('keeps a 24pt line together despite a 3pt drift', () => {
    const { blocks } = importPdfLayout([page([
      run('Certificate', MARGIN, 100, 24),
      run(' of Completion', MARGIN + 80, 102.5, 24),
    ])]);
    expect(blocks).toHaveLength(1);
    expect(textOf(blocks)).toContain('Certificate of Completion');
  });
});

describe('paragraphs', () => {
  it('joins consecutive lines into one paragraph', () => {
    const { blocks } = importPdfLayout([page([
      run('The first line of the paragraph,', MARGIN, 100),
      run('and the second line of it.', MARGIN, 115),
    ])]);
    expect(blocks).toHaveLength(1);
    expect(textOf(blocks)).toBe('The first line of the paragraph, and the second line of it.');
  });

  it('starts a new paragraph on a wide vertical gap', () => {
    const { blocks } = importPdfLayout([page([
      run('First paragraph.', MARGIN, 100),
      run('Second paragraph.', MARGIN, 145),
    ])]);
    expect(blocks).toHaveLength(2);
  });

  /** A word split across a line break must not keep its hyphen. */
  it('rejoins a hyphenated word across a line break', () => {
    const { blocks } = importPdfLayout([page([
      run('a compre-', MARGIN, 100),
      run('hensive review', MARGIN, 115),
    ])]);
    expect(textOf(blocks)).toBe('a comprehensive review');
  });
});

describe('what the geometry means', () => {
  it('reads a much larger line as a heading, at a level set by how much larger', () => {
    const { blocks } = importPdfLayout([page([
      run('Certificate', MARGIN, 90, 22),
      run('Annexure', MARGIN, 140, 16),
      run('Notes', MARGIN, 180, 13),
      ...Array.from({ length: 8 }, (_, i) =>
        run('Ordinary body text that carries the document.', MARGIN, 220 + i * 15)),
    ])]);
    const headings = blocks.filter((b: any) => b.kind === 'heading') as any[];
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(headings[0].runs[0].text).toBe('Certificate');
  });

  /**
   * The body size is the size MOST OF THE TEXT is set in, measured by
   * characters. Counting lines instead makes a document of many short headings
   * and few long paragraphs decide that its headings are the body.
   */
  it('finds the body size by weight of text, not by number of lines', () => {
    const { blocks } = importPdfLayout([page([
      ...Array.from({ length: 6 }, (_, i) => run(`Heading ${i}`, MARGIN, 60 + i * 20, 18)),
      ...Array.from({ length: 2 }, (_, i) =>
        run('A very long paragraph of ordinary body text which carries most of the '
          + 'characters on this page and therefore sets the body size.', MARGIN, 200 + i * 15, 11)),
    ])]);
    expect(blocks.filter((b: any) => b.kind === 'heading')).toHaveLength(6);
  });

  it('reads a line centred in the column as centred', () => {
    const centred = 'A centred line';
    const width = centred.length * 11 * 0.5;
    const { blocks } = importPdfLayout([page([
      run('Ordinary text at the column edge.', MARGIN, 100),
      { ...run(centred, (595 - width) / 2, 140), width },
    ])]);
    expect(blocks[1]).toMatchObject({ align: 'center' });
  });

  it('leaves an ordinary line alone rather than guessing', () => {
    const { blocks } = importPdfLayout([page([
      run('Ordinary text at the column edge.', MARGIN, 100),
    ])]);
    expect((blocks[0] as any).align).toBeUndefined();
  });

  it('reads bold and italic off the font name', () => {
    const { blocks } = importPdfLayout([page([
      run('Plain ', MARGIN, 100),
      run('bold', MARGIN + 40, 100, 11, 'ABCDEF+Georgia-Bold'),
      run(' and ', MARGIN + 70, 100),
      run('italic', MARGIN + 100, 100, 11, 'ABCDEF+Georgia-Italic'),
    ])]);
    const runs = (blocks[0] as any).runs;
    expect(runs.find((r: any) => r.bold)?.text.trim()).toBe('bold');
    expect(runs.find((r: any) => r.italic)?.text.trim()).toBe('italic');
  });

  it('reads bullets and numbers as lists, without their markers', () => {
    const { blocks } = importPdfLayout([page([
      run('• first point', MARGIN, 100),
      run('• second point', MARGIN, 118),
      run('1. step one', MARGIN, 150),
      run('2. step two', MARGIN, 168),
    ])]);
    const lists = blocks.filter((b: any) => b.kind === 'list') as any[];
    expect(lists).toHaveLength(4);
    expect(lists[0].runs[0].text).toBe('first point');
    expect(lists[0].ordered).toBe(false);
    expect(lists[2].ordered).toBe(true);
    expect(lists[2].index).toBe(1);
    expect(lists[3].index).toBe(2);
  });
});

describe('pages', () => {
  it('puts a page break between pages, and not after the last one', () => {
    const { blocks } = importPdfLayout([
      page([run('Page one.', MARGIN, 100)]),
      page([run('Page two.', MARGIN, 100)]),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'pagebreak', 'para']);
  });

  it('says a file with no text at all is probably a scan', () => {
    const { blocks, inferred } = importPdfLayout([page([])]);
    expect(blocks).toEqual([]);
    expect(inferred.join(' ')).toMatch(/scan/i);
  });

  it('names what it guessed rather than presenting it as read', () => {
    const { inferred } = importPdfLayout([page([
      run('Heading', MARGIN, 90, 22),
      run('Body text goes here and is long enough to set the body size.', MARGIN, 140),
    ])]);
    expect(inferred).toContain('headings from type size');
    expect(inferred).toContain('paragraphs from line spacing');
  });
});
