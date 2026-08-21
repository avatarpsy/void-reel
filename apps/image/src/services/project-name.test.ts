/**
 * A project's library name.
 *
 * The library showed "Presentation 16:9 · 6 pages" eight times on one screen,
 * because a project is named after the format it was made from and never
 * renamed. The deck's own title slide already says what it is.
 *
 * The rule that matters most here is the one about NOT renaming: a name the
 * user typed is a decision, and quietly replacing it with a guess is worse than
 * the problem being fixed.
 */
import { describe, it, expect } from 'vitest';
import { projectDisplayName, isDefaultProjectName, titleFromPage } from './project-name';
import type { Project, Artboard, Layer } from '../types/project';

function page(id: string, layerIds: string[]): Artboard {
  return {
    id,
    name: 'Page 1',
    size: { width: 1920, height: 1080 },
    background: { type: 'color', color: '#000000' },
    layerIds,
    position: { x: 0, y: 0 },
  } as Artboard;
}

function project(name: string, layers: Record<string, Layer>, order: string[]): Project {
  return {
    id: 'p1',
    name,
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    artboards: [page('a1', order)],
    layers,
    assets: {},
    exportPresets: [],
    activeArtboardId: 'a1',
  } as unknown as Project;
}

const block = (slots: Record<string, string>): Layer => ({
  id: 'L', type: 'image', name: 'Slide', visible: true,
  transform: { x: 0, y: 0, width: 1920, height: 1080, rotation: 0, opacity: 1 },
  composition: { block: 'deck-title', slots, fillMode: 'render', poseTime: 'end',
                 frameWidth: 1920, frameHeight: 1080, renderHash: '' },
} as unknown as Layer);

const text = (content: string): Layer => ({
  id: 'T', type: 'text', name: 'Text', visible: true,
  transform: { x: 0, y: 0, width: 800, height: 200, rotation: 0, opacity: 1 },
  content,
  style: {},
} as unknown as Layer);

describe('isDefaultProjectName', () => {
  it('treats every format preset as unnamed', () => {
    for (const n of ['Presentation 16:9', 'Presentation 4:3', 'Instagram Post', 'Poster 18x24',
                     'A4 Portrait', 'YouTube Thumbnail', 'Post', 'Story', 'Thumbnail', 'Untitled']) {
      expect(isDefaultProjectName(n), n).toBe(true);
    }
  });

  it('treats a name somebody chose as named', () => {
    for (const n of ['Q3 board deck', 'Why cold showers work', 'Psy — launch', 'My presentation notes']) {
      expect(isDefaultProjectName(n), n).toBe(false);
    }
  });

  it('treats blank as unnamed', () => {
    expect(isDefaultProjectName('')).toBe(true);
    expect(isDefaultProjectName(undefined)).toBe(true);
  });
});

describe('titleFromPage', () => {
  it('reads a block headline', () => {
    const p = project('Presentation 16:9', { L: block({ headline: 'Your ideas deserve a face' }) }, ['L']);
    expect(titleFromPage(p, p.artboards[0])).toBe('Your ideas deserve a face');
  });

  it('ignores the eyebrow, which names a category and never the deck', () => {
    const p = project('Presentation 16:9',
      { L: block({ eyebrow: 'WHAT IT IS', headline: 'An AI creative studio' }) }, ['L']);
    expect(titleFromPage(p, p.artboards[0])).toBe('An AI creative studio');
  });

  it('falls back to a text layer when there is no block', () => {
    const p = project('Presentation 16:9', { T: text('A digital you') }, ['T']);
    expect(titleFromPage(p, p.artboards[0])).toBe('A digital you');
  });

  it('takes only the first line of a wrapped headline', () => {
    // Headline layers carry their wrapping baked in as newlines.
    const p = project('Presentation 16:9', { T: text('A DIGITAL YOU\nTHAT NEVER CLOCKS OFF') }, ['T']);
    expect(titleFromPage(p, p.artboards[0])).toBe('A DIGITAL YOU');
  });

  it('skips a hidden layer', () => {
    const hidden = { ...(text('Draft title') as any), visible: false } as Layer;
    const p = project('Presentation 16:9', { T: hidden, L: block({ headline: 'Real title' }) }, ['T', 'L']);
    expect(titleFromPage(p, p.artboards[0])).toBe('Real title');
  });

  it('is empty when the page has nothing to say', () => {
    const p = project('Presentation 16:9', {}, []);
    expect(titleFromPage(p, p.artboards[0])).toBe('');
  });
});

describe('projectDisplayName', () => {
  it('names an unnamed deck after its title slide', () => {
    const p = project('Presentation 16:9', { L: block({ headline: 'Your ideas deserve a face' }) }, ['L']);
    expect(projectDisplayName(p)).toBe('Your ideas deserve a face');
  });

  it('NEVER overwrites a name somebody chose', () => {
    // The load-bearing rule. A typed name is a decision; this is a guess.
    const p = project('Q3 board deck', { L: block({ headline: 'Your ideas deserve a face' }) }, ['L']);
    expect(projectDisplayName(p)).toBe('Q3 board deck');
  });

  it('keeps the default when the first page offers nothing', () => {
    const p = project('Presentation 16:9', {}, []);
    expect(projectDisplayName(p)).toBe('Presentation 16:9');
  });

  it('clips a long headline at a word boundary', () => {
    const long = 'From one creator to a real business that runs itself while you are asleep in bed';
    const p = project('Presentation 16:9', { L: block({ headline: long }) }, ['L']);
    const out = projectDisplayName(p);
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/);       // no space before the ellipsis
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('collapses whitespace rather than carrying layout into the library', () => {
    const p = project('Presentation 16:9', { L: block({ headline: '  Two   spaces\nand a break ' }) }, ['L']);
    expect(projectDisplayName(p)).toBe('Two spaces and a break');
  });

  it('survives a null project', () => {
    expect(projectDisplayName(null)).toBe('Untitled');
  });
});
