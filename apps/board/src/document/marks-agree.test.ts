/**
 * THE TWO PLACES THAT READ A MARK MUST AGREE.
 *
 * `parseMarkdown` reads `++x++`, `==x==` and `[x]{…}` when a document is
 * EXPORTED. `markersToAttributes` reads the same three when a document is placed
 * on the CANVAS. They are different code — one works on marked's token stream,
 * the other on BlockSuite's deltas — and they have to reach the same answer,
 * because a disagreement means the page shows one thing and the file says
 * another, which is the single most confusing kind of bug a document tool can
 * have.
 *
 * So this runs both over the same inputs and compares. The interesting cases are
 * not the marks; they are the text that LOOKS like a mark and is not, which is
 * exactly where two hand-written parsers drift apart.
 */
import { describe, it, expect } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { parseMarkdown } from './blocks';
import { placeMarkdownDocument, noteToMarkdown } from './note-io';

/** What the words are, with no marks — the thing that must never change. */
function wordsOf(markdown: string): string {
  return parseMarkdown(markdown)
    .flatMap((b: any) => b.runs ?? [])
    .map((r: any) => r.text)
    .join('');
}

/** Which stretches carry which marks, as a comparable summary. */
function marksOf(markdown: string): string {
  return parseMarkdown(markdown)
    .flatMap((b: any) => b.runs ?? [])
    .filter((r: any) => r.underline || r.highlight || r.color)
    .map((r: any) => [
      r.text,
      r.underline ? 'u' : '',
      r.highlight ? 'h' : '',
      r.color ? `c:${r.color}` : '',
    ].filter(Boolean).join('|'))
    .join(' + ');
}

async function throughTheBoard(markdown: string): Promise<string> {
  const board = makeTestBoard();
  const { noteId } = await placeMarkdownDocument(board as any, markdown);
  return await noteToMarkdown(board as any, noteId);
}

const REAL_MARKS = [
  'a ++underlined++ b',
  'a ==highlighted== b',
  'a [red]{color=#cc0000} b',
  'a [navy]{color=navy} b',
  '++all of it underlined++',
  'both ++under++ and ==high== in one line',
  '++a **bold** inside an underline++',
];

/** Text that LOOKS like a mark. Both readers must leave all of it alone. */
const NOT_MARKS = [
  '2 + 2 == 4, and x++ is a language',
  'C++ and C++ are the same language',
  'The array [1, 2, 3] {is not a span}',
  'A range a==b was compared',
  'See [the docs](https://x.test) for more',
  'Nothing marked here at all',
];

describe('the canvas and the exporter read a mark the same way', () => {
  for (const source of REAL_MARKS) {
    it(`agrees about: ${source}`, async () => {
      const back = await throughTheBoard(source);
      expect(wordsOf(back), 'the words').toBe(wordsOf(source));
      expect(marksOf(back), 'the marks').toBe(marksOf(source));
    }, 60_000);
  }
});

describe('neither invents a mark that is not there', () => {
  for (const source of NOT_MARKS) {
    it(`leaves alone: ${source}`, async () => {
      const back = await throughTheBoard(source);
      expect(wordsOf(back), 'the words').toBe(wordsOf(source));
      expect(marksOf(back), 'the marks').toBe(marksOf(source));
    }, 60_000);
  }
});

describe('and the trip is stable', () => {
  /**
   * A document that gains or loses a marker each time it is opened would decay
   * silently — the failure would only be visible after several rounds, by which
   * point nobody can say which edit caused it.
   */
  it('does not change on a second pass through the canvas', async () => {
    const source = [...REAL_MARKS, ...NOT_MARKS].join(String.fromCharCode(10, 10));
    const once = await throughTheBoard(source);
    const twice = await throughTheBoard(once);
    expect(parseMarkdown(twice)).toEqual(parseMarkdown(once));
  }, 120_000);
});
