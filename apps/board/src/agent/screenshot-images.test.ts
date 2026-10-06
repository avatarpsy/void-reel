/**
 * The screenshot's image gate: what keeps one never-loading picture from
 * stalling every capture, and what names it instead.
 *
 * Reported as "board_screenshot of the founder's uploaded PNGs stalls past 30s,
 * even one id at a time". html2canvas clones the whole document and waits on
 * every `<img>` in it with no timeout, so a single image that never finishes,
 * anywhere on the board, held every capture until our 30s render bound fired.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestBoard, placeTestImage, type TestBoard } from '../blocksuite/test-board';
import type { MountedBoard } from '../blocksuite/editor';
import { writeBlockMeta } from '../board/board-meta';
import { encodeMediaRef } from '../board/media-ref';
import { IGNORE_ATTR, describePictureSource, gateImages } from './screenshot-images';

let board: TestBoard;
let blocks: Map<string, HTMLElement>;
let stage: HTMLElement;

function mounted(): MountedBoard {
  return board as unknown as MountedBoard;
}

/** An `<img>` in a given load state. happy-dom never loads anything, so the
 *  state is set the way a browser would report it. */
function img(state: 'loading' | 'loaded' | 'broken'): HTMLImageElement {
  const el = document.createElement('img');
  el.setAttribute('src', 'blob:http://board/x');
  Object.defineProperty(el, 'complete', { configurable: true, get: () => state !== 'loading' });
  Object.defineProperty(el, 'naturalWidth', { configurable: true, get: () => (state === 'loaded' ? 800 : 0) });
  return el;
}

/** The block's element as the view would return it, holding one picture. */
function blockElement(id: string, picture?: HTMLImageElement): HTMLElement {
  const el = document.createElement('div');
  el.dataset.blockId = id;
  if (picture) el.append(picture);
  stage.append(el);
  blocks.set(id, el);
  return el;
}

beforeEach(() => {
  board = makeTestBoard();
  blocks = new Map();
  stage = document.createElement('div');
  document.body.append(stage);
  // The detached test host renders no block DOM; answer as the live view does.
  (board.std.view as unknown as { getBlock: (id: string) => HTMLElement | null }).getBlock =
    id => blocks.get(id) ?? null;
});

afterEach(() => {
  stage.remove();
});

describe('gateImages', () => {
  it('keeps a never-loading picture OUTSIDE the shot out of the clone, and puts it back', async () => {
    const id = placeTestImage(board, '[0,0,100,100]');
    blockElement(id, img('loaded'));
    const elsewhere = img('loading');
    stage.append(elsewhere);

    const gate = await gateImages(mounted(), [id], 20);
    // This is the element that stalled every capture: excluded, not waited on.
    expect(elsewhere.getAttribute(IGNORE_ATTR)).toBe('true');
    expect(gate.missing).toEqual([]);

    gate.release();
    expect(elsewhere.hasAttribute(IGNORE_ATTR)).toBe(false);
  });

  it('names a dropped PNG in the shot that never loads, with its source, instead of hanging', async () => {
    const id = placeTestImage(board, '[0,0,100,100]', { sourceId: 'sha-local-png' });
    writeBlockMeta(board.doc, id, { name: 'Rainbow Orb Mascot Character Sheet.png', kind: 'image' });
    const picture = img('loading');
    blockElement(id, picture);

    const started = Date.now();
    const gate = await gateImages(mounted(), [id], 30);
    expect(Date.now() - started).toBeLessThan(2_000);

    expect(gate.missing).toHaveLength(1);
    expect(gate.missing[0]!.id).toBe(id);
    expect(gate.missing[0]!.source).toContain('file stored on the board');
    expect(gate.missing[0]!.source).toContain('Rainbow Orb Mascot Character Sheet.png');
    expect(picture.getAttribute(IGNORE_ATTR)).toBe('true');
    gate.release();
  });

  it('names a picture block whose bytes never arrived (no <img> at all)', async () => {
    const id = placeTestImage(board, '[0,0,100,100]', { sourceId: 'sha-missing' });
    blockElement(id);

    const gate = await gateImages(mounted(), [id], 10);
    expect(gate.missing.map(m => m.id)).toEqual([id]);
    expect(gate.missing[0]!.problem).toMatch(/never arrived/);
    gate.release();
  });

  it('leaves loaded pictures alone and reports nothing', async () => {
    const id = placeTestImage(board, '[0,0,100,100]');
    const picture = img('loaded');
    blockElement(id, picture);

    const gate = await gateImages(mounted(), [id], 10);
    expect(gate.missing).toEqual([]);
    expect(picture.hasAttribute(IGNORE_ATTR)).toBe(false);
    gate.release();
  });

  it('reports a broken picture as failed', async () => {
    const id = placeTestImage(board, '[0,0,100,100]');
    blockElement(id, img('broken'));
    const gate = await gateImages(mounted(), [id], 10);
    expect(gate.missing[0]!.problem).toMatch(/failed to load/);
    gate.release();
  });
});

describe('describePictureSource', () => {
  it('gives the Library url for a referenced picture', () => {
    const id = placeTestImage(board, '[0,0,100,100]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/engineer45-720.jpg', kind: 'image' }),
    });
    writeBlockMeta(board.doc, id, { kind: 'image', originalUrl: 'https://cdn.test/engineer45.jpg' });
    expect(describePictureSource(mounted(), id)).toBe('Library image https://cdn.test/engineer45.jpg');
  });
});
