/**
 * The export dialog told users PowerPoint keeps their text editable.
 *
 * True for a slide drawn from text layers; false for a slide built from a
 * designed block, which is baked to pixels and exports as one flat picture.
 * Since the presentation method now tells the agent to PREFER designed blocks,
 * the decks this product makes are exactly the ones the promise did not hold
 * for — and a promise broken at the moment of export is the expensive kind.
 */
import { describe, it, expect } from 'vitest';
import { pptxTextNote } from './pptx-text-note';
import type { Project, Artboard, Layer } from '../types/project';

const page = (id: string, layerIds: string[]): Artboard => ({
  id, name: id, size: { width: 1920, height: 1080 },
  background: { type: 'color', color: '#000' }, layerIds, position: { x: 0, y: 0 },
} as Artboard);

const block = (id: string): Layer => ({
  id, type: 'image', name: 'Slide', visible: true,
  transform: { x: 0, y: 0, width: 1920, height: 1080, rotation: 0, opacity: 1 },
  composition: { block: 'deck-title', slots: {}, fillMode: 'render', poseTime: 'end',
                 frameWidth: 1920, frameHeight: 1080, renderHash: '' },
} as unknown as Layer);

const text = (id: string): Layer => ({
  id, type: 'text', name: 'Text', visible: true,
  transform: { x: 0, y: 0, width: 800, height: 100, rotation: 0, opacity: 1 },
  content: 'Hello', style: {},
} as unknown as Layer);

const project = (pages: Artboard[], layers: Record<string, Layer>): Project => ({
  id: 'p', name: 'Deck', createdAt: 0, updatedAt: 0, version: 1,
  artboards: pages, layers, assets: {}, exportPresets: [], activeArtboardId: pages[0]?.id ?? null,
} as unknown as Project);

describe('pptxTextNote', () => {
  it('promises editable text for a deck of typed slides', () => {
    const p = project([page('a', ['t1'])], { t1: text('t1') });
    expect(pptxTextNote(p)).toBe('Text stays editable in PowerPoint.');
  });

  it('warns when every page is a designed block', () => {
    const p = project(
      [page('a', ['b1']), page('b', ['b2'])],
      { b1: block('b1'), b2: block('b2') },
    );
    const note = pptxTextNote(p);
    expect(note).toContain('All 2 pages');
    expect(note).toContain('not be editable');
  });

  it('says "This page" rather than "All 1 pages"', () => {
    const p = project([page('a', ['b1'])], { b1: block('b1') });
    expect(pptxTextNote(p)).toMatch(/^This page is a designed block/);
  });

  it('splits the difference honestly for a mixed deck', () => {
    const p = project(
      [page('a', ['b1']), page('b', ['t1']), page('c', ['t2'])],
      { b1: block('b1'), t1: text('t1'), t2: text('t2') },
    );
    const note = pptxTextNote(p);
    expect(note).toContain('1 of 3 pages');
    expect(note).toContain('text you typed yourself stays editable');
  });

  it('counts a page with BOTH as designed, because that page rasterises', () => {
    const p = project([page('a', ['b1', 't1'])], { b1: block('b1'), t1: text('t1') });
    expect(pptxTextNote(p)).toMatch(/^This page is a designed block/);
  });

  it('ignores a hidden block — it is not in the export', () => {
    const hidden = { ...(block('b1') as any), visible: false } as Layer;
    const p = project([page('a', ['b1', 't1'])], { b1: hidden, t1: text('t1') });
    expect(pptxTextNote(p)).toBe('Text stays editable in PowerPoint.');
  });

  it('says nothing at all about an empty project', () => {
    // No claim is better than a claim about nothing.
    expect(pptxTextNote(project([page('a', [])], {}))).toBe('');
    expect(pptxTextNote(null)).toBe('');
  });
});
