/**
 * Pictures surviving the round trip.
 *
 * The risk this covers is specific and was real before the code existed: the
 * markdown adapter's own image handling FETCHES each url and stores a hashed
 * copy in this browser's IndexedDB, so a document imported on one device opened
 * with broken images on every other one — and nothing anywhere said so.
 *
 * These run against a real BlockStdScope, because the failure mode is entirely
 * inside BlockSuite's conversion. Nothing here touches the network: that is the
 * point of the design, and a test that needed a server would be testing
 * something else.
 */
import { describe, it, expect } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { decodeMediaRef } from '../board/media-ref';
import { countImages, liftImages, restoreMarkdownImages, stripImages } from './doc-images';
import { noteToMarkdown, placeMarkdownDocument } from './note-io';

const URL_A = 'https://cdn.test/figures/chart.png';
const URL_B = 'https://cdn.test/figures/team%20photo.jpg';

const MD = [
  '# Field Report',
  '',
  'Revenue by quarter:',
  '',
  `![Revenue chart](${URL_A})`,
  '',
  '## The team',
  '',
  `![The team](${URL_B})`,
].join('\n');

describe('liftImages', () => {
  it('takes http images out and leaves a sentinel behind', () => {
    const { text, images } = liftImages(MD);
    expect(images).toEqual([
      { url: URL_A, alt: 'Revenue chart' },
      { url: URL_B, alt: 'The team' },
    ]);
    expect(text).toContain('!!vsimg-0!!');
    expect(text).toContain('!!vsimg-1!!');
    expect(text).not.toContain('cdn.test');
  });

  it('leaves a data uri alone — there is no url to reference instead', () => {
    const inline = '![pasted](data:image/png;base64,iVBORw0KGgo=)';
    const { text, images } = liftImages(inline);
    expect(images).toEqual([]);
    expect(text).toBe(inline);
  });

  it('promotes an image inside a sentence to its own block', () => {
    const { text, images } = liftImages(`see ![x](${URL_A}) here`);
    expect(images).toHaveLength(1);
    // Blank lines either side, so the adapter reads three blocks not one.
    expect(text).toBe('see \n\n!!vsimg-0!!\n\n here');
  });

  it('counts what a document carries', () => {
    expect(countImages(MD)).toBe(2);
    expect(countImages('# No pictures here')).toBe(0);
  });
});

describe('a document with pictures, onto the board and back', () => {
  it('places real image blocks that point at the library, not at local bytes', async () => {
    const board = makeTestBoard();
    const { noteId, images } = await placeMarkdownDocument(board as any, MD);
    expect(images).toBe(2);

    const model: any = board.store.getBlock(noteId)!.model;
    const imageBlocks = model.children.filter((c: any) => c.flavour === 'affine:image');
    expect(imageBlocks).toHaveLength(2);

    // The whole point: a REFERENCE, resolvable anywhere, not a blob key that
    // only means something in the IndexedDB of the browser that imported it.
    const first = decodeMediaRef(String(imageBlocks[0].props.sourceId));
    expect(first).toMatchObject({ src: URL_A, kind: 'image' });
    expect(first?.mime).toBe('image/png');

    const second = decodeMediaRef(String(imageBlocks[1].props.sourceId));
    expect(second?.src).toBe(URL_B);

    // And no sentinel survived as visible text in the user's document.
    const paragraphs = model.children
      .map((c: any) => String(c.text?.toString?.() ?? ''))
      .join('\n');
    expect(paragraphs).not.toContain('vsimg');
  });

  it('reads back as markdown with the original urls', async () => {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, MD);

    const out = await noteToMarkdown(board as any, noteId);
    expect(out).toContain(`![Revenue chart](${URL_A})`);
    expect(out).toContain(`![The team](${URL_B})`);
    // `assets/…` is a path into an export zip. It is what the adapter emits on
    // its own and is useless to every caller we have.
    expect(out).not.toContain('assets/');
  });
});

describe('stripImages / restoreMarkdownImages', () => {
  it('ignores a local blob, which the adapter can serialise itself', () => {
    const snapshot: any = {
      type: 'block',
      flavour: 'affine:note',
      children: [
        { type: 'block', flavour: 'affine:image', props: { sourceId: 'abc123hash' }, children: [] },
      ],
    };
    expect(stripImages(snapshot)).toEqual([]);
    expect(snapshot.children[0].flavour).toBe('affine:image');
  });

  it('leaves an unknown sentinel alone rather than emitting a broken image', () => {
    expect(restoreMarkdownImages('!!vsimg-9!!', [{ url: URL_A, alt: '' }]))
      .toBe('!!vsimg-9!!');
  });
});
