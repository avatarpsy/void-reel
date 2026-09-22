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
import { placeMarkdownDocument } from './note-io';
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
