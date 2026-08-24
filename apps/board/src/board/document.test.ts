/**
 * The board read as a document.
 *
 * These run against a REAL `BlockStdScope`, so what is asserted is what
 * BlockSuite actually stored — the same reason `canvas.test.ts` does. The bugs
 * worth catching here are all "the export looked fine and lost something":
 * dropped formatting, a section that swallowed its neighbour's contents, and an
 * order that reads nothing like the board.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard, placeTestImage } from '../blocksuite/test-board';
import { createShots } from '../shot/shots';
import { writeBlockMeta } from './board-meta';
import { encodeMediaRef } from './media-ref';
import { drawOnCanvas } from './canvas';
import { boardDocument, documentMarkdown } from './document';

const md = (std: Parameters<typeof boardDocument>[0], title = '') =>
  documentMarkdown(boardDocument(std, title));

describe('reading the board as a document', () => {
  it('turns a frame into a section and the notes inside it into its body', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [
      { kind: 'frame', title: 'Risks', x: 0, y: 0, w: 900, h: 700 },
      { kind: 'note', text: '# Cost\n- servers\n- people', x: 60, y: 80 },
    ]);

    const text = md(board.std, 'Q3 planning');
    expect(text).toContain('# Q3 planning');
    expect(text).toContain('## Risks');
    expect(text).toContain('# Cost');
    expect(text).toContain('- servers');
    expect(text).toContain('- people');
  });

  /**
   * A note writes its own headings starting at `#`, which is right on a canvas
   * where the note IS the document. Dropped verbatim into a section it produces
   * an `<h1>` nested under the section's `<h2>` — the subsection outranking its
   * own parent, so a printed PDF sets "Cost" larger than the "Risks" heading
   * containing it.
   *
   * Found in a browser against a real board. It cannot appear in a test that
   * renders one note on its own, which is why this asserts the NESTING.
   */
  it('demotes a note\'s headings beneath the section it sits in', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [
      { kind: 'frame', title: 'Risks', x: 0, y: 0, w: 900, h: 700 },
      { kind: 'note', text: '# Cost\n## Detail', x: 60, y: 80 },
    ]);

    const text = md(board.std, 'Q3 planning');
    expect(text).toContain('# Q3 planning');
    expect(text).toContain('## Risks');
    // The note's h1 becomes h3, its h2 becomes h4 — always below the section.
    expect(text).toContain('### Cost');
    expect(text).toContain('#### Detail');
    expect(text).not.toMatch(/^# Cost$/m);
  });

  it('demotes loose content one level, not two', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [{ kind: 'note', text: '# Loose thought', x: 0, y: 0 }]);
    // No section heading to sit under, only the document title.
    expect(md(board.std, 'Ideas')).toContain('## Loose thought');
  });

  /**
   * A model writes `**bold**` whether asked to or not, and the canvas renders it
   * as real formatting. Exported through `String(yText)` it comes back as flat
   * prose with the emphasis gone — the cheapest way to make a generated document
   * look unfinished.
   */
  it('keeps inline formatting', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [{ kind: 'note', text: 'The **pitch** outpaces the *life*.' }]);

    const text = md(board.std);
    expect(text).toContain('**pitch**');
    expect(text).toContain('*life*');
  });

  /**
   * A mind map IS an outline drawn radially. Flattening it to a nested list is
   * the one translation that gives a document something the picture cannot: an
   * order you can read.
   */
  it('flattens a mind map into a nested list', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [{
      kind: 'mindmap',
      tree: {
        text: 'This quarter',
        children: [
          { text: 'Ship the board', children: [{ text: 'document export' }] },
          { text: 'Hire' },
        ],
      },
    }]);

    const text = md(board.std);
    expect(text).toContain('- This quarter');
    expect(text).toContain('  - Ship the board');
    expect(text).toContain('    - document export');
    expect(text).toContain('  - Hire');
  });

  /**
   * ROW BANDING. Three cards laid side by side is a person saying "these are
   * alternatives"; a strict y-sort turns them into three sections because their
   * tops differ by a few pixels, and the document then reads nothing like the
   * board it came from.
   */
  it('reads a row left-to-right and rows top-to-bottom', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [
      { kind: 'note', text: 'second', x: 400, y: 10 },
      { kind: 'note', text: 'first', x: 0, y: 0 },
      { kind: 'note', text: 'below', x: 0, y: 900 },
      { kind: 'note', text: 'third', x: 800, y: 5 },
    ]);

    const text = md(board.std);
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));
    expect(text.indexOf('third')).toBeLessThan(text.indexOf('below'));
  });

  /**
   * A "Risks" frame drawn inside an "Options" frame must not have its contents
   * hoisted into the outer one — the inner frame is the more specific statement
   * about where that note belongs, and the user drew it for a reason.
   */
  it('gives a note to the smallest frame that contains it', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [
      { kind: 'frame', title: 'Options', x: 0, y: 0, w: 2000, h: 1600 },
      { kind: 'frame', title: 'Risks', x: 100, y: 100, w: 600, h: 500 },
      { kind: 'note', text: 'runway', x: 160, y: 200 },
    ]);

    const doc = boardDocument(board.std);
    const options = doc.sections.find(s => s.title === 'Options')!;
    const risks = doc.sections.find(s => s.title === 'Risks')!;
    expect(risks.chunks.join()).toContain('runway');
    expect(options.chunks.join()).not.toContain('runway');
  });

  /**
   * Shots and the screenplay are exported elsewhere, with typography a document
   * cannot reproduce. Dropping them SILENTLY is the failure — a user who cannot
   * see why their storyboard is missing assumes the export is broken.
   */
  it('leaves the storyboard out and says how much it left out', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Cold open', 'The turn']);
    drawOnCanvas(board.std, [{ kind: 'note', text: 'a thought', x: 0, y: 3000 }]);

    const doc = boardDocument(board.std);
    expect(doc.omittedOwned).toBe(2);
    expect(documentMarkdown(doc)).toContain('a thought');
    expect(documentMarkdown(doc)).not.toContain('Cold open');
  });

  /**
   * `sourceId` is an ENCODED MEDIA REF, not a url. Written straight into
   * markdown it produces `![](voidspace:…)`, which is a broken image in every
   * reader — and broken in a way that reads as "the picture did not export",
   * so nobody looks for a url bug.
   */
  it('writes a real url for a picture, not the media ref', () => {
    const board = makeTestBoard();
    const id = placeTestImage(board, '[0,0,320,180]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/small.png', kind: 'image', mime: 'image/png' }),
    });
    // The MASTER, not the display proxy — a document is printed and sent, so it
    // wants the full-quality file, which is the same rule `mediaUrlOf` follows.
    writeBlockMeta(board.doc, id, { kind: 'image', originalUrl: 'https://cdn.test/master.png' });

    const text = md(board.std);
    expect(text).toContain('![](https://cdn.test/master.png)');
    expect(text).not.toContain('vsmedia:');
  });

  /**
   * The document view repaints on `blockUpdated`, which fires on every
   * pointermove of a drag. Unmemoised this re-walks every element and
   * re-serialises every note per frame — the arithmetic that made the board
   * sluggish once already.
   */
  it('computes once per document revision', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [{ kind: 'note', text: 'a thought', x: 0, y: 0 }]);

    const a = boardDocument(board.std);
    const b = boardDocument(board.std);
    expect(b.sections[0]!.chunks).toEqual(a.sections[0]!.chunks);

    // ...and the caller gets a COPY, so writing into one result cannot corrupt
    // the cache that the next caller reads.
    a.sections[0]!.chunks.push('injected');
    expect(boardDocument(board.std).sections[0]!.chunks).not.toContain('injected');
  });

  /** A quick brainstorm has no frames at all, and must still export. */
  it('exports an unframed board in reading order', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [
      { kind: 'note', text: 'one', x: 0, y: 0 },
      { kind: 'note', text: 'two', x: 0, y: 900 },
    ]);

    const doc = boardDocument(board.std);
    expect(doc.unframed).toBe(true);
    expect(doc.sections).toHaveLength(1);
    expect(documentMarkdown(doc)).toContain('one');
    expect(documentMarkdown(doc)).toContain('two');
  });
});
