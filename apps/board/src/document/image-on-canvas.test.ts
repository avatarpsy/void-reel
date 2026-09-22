/**
 * THE PICTURE ON THE CANVAS IS THE SIZE THE DOCUMENT ASKED FOR.
 *
 * `![](logo.png#w=38)` sized the logo in the exported PDF and the Word file,
 * because both renderers read the hint — and the canvas read nothing. The image
 * block was built with `width: 0`, which BlockSuite renders at the picture's
 * NATURAL size, so a 38-point masthead logo filled the top quarter of the
 * document the user was looking at while the file they exported was correct.
 *
 * Two different documents, and the one nobody could see was the right one.
 * Found by looking at a real board, which is the only place it shows.
 */
import { describe, it, expect, vi } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { placeMarkdownDocument, noteToMarkdown } from './note-io';
import { sizeImagesFromHints } from './doc-images';

const NL = String.fromCharCode(10);

/** A stand-in for the browser's loader: a 2:1 picture, measured instantly. */
function stubImage(aspect: number) {
  class FakeImage {
    naturalWidth = 100;
    naturalHeight = 100 * aspect;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('Image', FakeImage as any);
}

const imagesOf = (board: any, noteId: string) =>
  (board.store.getBlock(noteId)!.model.children as any[])
    .filter((c) => c.flavour === 'affine:image');

describe('a sized picture', () => {
  it('takes the width the document asked for, in canvas pixels', async () => {
    stubImage(1);
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/logo.png#w=38&align=left)' + NL + NL + 'Body.');

    await sizeImagesFromHints(board as any, noteId);
    const [image] = imagesOf(board, noteId);
    // 38 points at 96dpi against 72: about 51 pixels.
    expect(image.props.width).toBeGreaterThan(45);
    expect(image.props.width).toBeLessThan(56);
  }, 60_000);

  it('keeps the picture its own shape rather than guessing a square', async () => {
    stubImage(0.5); // twice as wide as it is tall
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/wide.png#w=120)' + NL + NL + 'Body.');

    await sizeImagesFromHints(board as any, noteId);
    const [image] = imagesOf(board, noteId);
    expect(image.props.height / image.props.width).toBeCloseTo(0.5, 1);
  }, 60_000);

  it('leaves a picture with NO hint at its natural size', async () => {
    stubImage(1);
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/chart.png)' + NL + NL + 'Body.');

    await sizeImagesFromHints(board as any, noteId);
    expect(imagesOf(board, noteId)[0].props.width).toBe(0);
  }, 60_000);

  /** A size the USER dragged to must never be overruled by a later pass. */
  it('does not resize a picture that already has a size', async () => {
    stubImage(1);
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/logo.png#w=38)' + NL + NL + 'Body.');

    const [image] = imagesOf(board, noteId);
    board.store.updateBlock(image, { width: 400, height: 400 });
    await sizeImagesFromHints(board as any, noteId);
    expect(image.props.width).toBe(400);
  }, 60_000);

  /** A picture that will not load keeps its natural size, as it did before. */
  it('survives a picture that never answers', async () => {
    class DeadImage {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', DeadImage as any);

    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/gone.png#w=38)' + NL + NL + 'Body.');

    await expect(sizeImagesFromHints(board as any, noteId)).resolves.toBeGreaterThanOrEqual(0);
    expect(imagesOf(board, noteId)[0].props.width).toBeGreaterThan(0);
  }, 60_000);
});

/**
 * RESIZING BY HAND HAS TO SURVIVE THE EXPORT.
 *
 * The size used to go one way only: `#w=38` set the block's width when the
 * document was placed, and the export then read the URL again — the same 38 it
 * started with. A user who dragged the logo bigger saw it bigger on the canvas,
 * exported, and got the old size back with nothing to say why.
 */
describe('a picture resized by hand', () => {
  const widthOf = (markdown: string): number | undefined => {
    const m = /#(?:[^)\s]*&)?w=(\d+)/.exec(markdown);
    return m ? Number(m[1]) : undefined;
  };

  it('leaves at the size it was dragged to, not the one it arrived with', async () => {
    stubImage(1);
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/logo.png#w=38&align=center)' + NL + NL + 'Body.');

    const [image] = imagesOf(board, noteId);
    // 160 CSS pixels is 120 points.
    board.store.updateBlock(image, { width: 160, height: 160 });

    const back = await noteToMarkdown(board as any, noteId);
    expect(widthOf(back)).toBe(120);
  }, 60_000);

  it('keeps the rest of the hint while replacing the width', async () => {
    stubImage(1);
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/logo.png#w=38&align=center)' + NL + NL + 'Body.');

    board.store.updateBlock(imagesOf(board, noteId)[0], { width: 160, height: 160 });
    expect(await noteToMarkdown(board as any, noteId)).toContain('align=center');
  }, 60_000);

  /**
   * A width of 0 is BlockSuite's default — the picture has not been sized yet.
   * Treating that as "the author wanted full width" silently deleted the size
   * from any document exported before its pictures finished loading.
   */
  it('keeps the document own size when the block has never been sized', async () => {
    stubImage(1);
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/logo.png#w=38)' + NL + NL + 'Body.');

    board.store.updateBlock(imagesOf(board, noteId)[0], { width: 0, height: 0 });
    expect(widthOf(await noteToMarkdown(board as any, noteId))).toBe(38);
  }, 60_000);

  it('leaves a picture that never had a size without one', async () => {
    stubImage(1);
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/chart.png)' + NL + NL + 'Body.');

    const back = await noteToMarkdown(board as any, noteId);
    expect(widthOf(back)).toBeUndefined();
    expect(back).toContain('chart.png');
  }, 60_000);
});

/**
 * DOCUMENTS THAT WERE ALREADY THERE.
 *
 * The sizing pass runs when a document is PLACED, which fixes everything made
 * from then on and nothing that already exists — those blocks still carry
 * width 0 and still render at the picture's natural size. A board opened the
 * next day would show the same full-width logo, and the fix would look like it
 * had never shipped.
 */
describe('a board that already has documents', () => {
  it('sizes the pictures in every document on it', async () => {
    stubImage(1);
    const board = makeTestBoard();
    const a = await placeMarkdownDocument(
      board as any, '# One' + NL + NL + '![](https://x.test/a.png#w=38)' + NL + NL + 'Body.');
    const b = await placeMarkdownDocument(
      board as any, '# Two' + NL + NL + '![](https://x.test/b.png#w=120)' + NL + NL + 'Body.');

    // Back to how they load from storage: no width on either.
    for (const id of [a.noteId, b.noteId]) {
      for (const image of imagesOf(board, id)) {
        board.store.updateBlock(image, { width: 0, height: 0 });
      }
    }

    const { sizeAllDocumentImages } = await import('./doc-images');
    await sizeAllDocumentImages(board as any);

    expect(imagesOf(board, a.noteId)[0].props.width).toBeGreaterThan(45);
    expect(imagesOf(board, b.noteId)[0].props.width).toBeGreaterThan(150);
  }, 90_000);

  /** Safe to repeat: a second mount must not overrule a size dragged by hand. */
  it('leaves a hand-set size alone on a second pass', async () => {
    stubImage(1);
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, '![](https://x.test/logo.png#w=38)' + NL + NL + 'Body.');

    const [image] = imagesOf(board, noteId);
    board.store.updateBlock(image, { width: 260, height: 260 });

    const { sizeAllDocumentImages } = await import('./doc-images');
    await sizeAllDocumentImages(board as any);
    expect(image.props.width).toBe(260);
  }, 60_000);
});
