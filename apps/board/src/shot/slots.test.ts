/**
 * Marrying a shot to its block.
 *
 * THE THING THIS REPLACED: a hardcoded background / figure / logo trio shown to
 * every graphic. Measured across the shipped kit, that is wrong for almost all
 * of them — `browser-mockup` wants a `screenshot`, `photo-quote-split` wants a
 * `portrait`, and the kit as a whole declares 371 text slots, 48 colour, 25
 * image and 1 video. Three fixed wells meant showing most blocks three controls
 * that do nothing while hiding the one that matters.
 *
 * The design that replaced it has one load-bearing idea: A GRAPHIC'S SLOT KEY
 * IS ITS MEDIA ROLE. Tagging a reference `screenshot` and dropping it on the
 * screenshot well are the same operation, so exclusivity, the inspector's
 * dropdown, drop-on-a-well and compile all keep working unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { setBlockCatalogue } from './blocks';
import { resolveSlots, slotFills } from './slots';
import type { ShotMedia } from './model';

/** Shapes taken from the real kit — `browser-mockup` verbatim. */
const BROWSER_MOCKUP = {
  name: 'browser-mockup',
  tier: 'starter',
  fill: 'slots',
  slots: {
    screenshot: { kind: 'image', sample: 'your site', sel: '.win img' },
    url: { kind: 'text', sample: 'voidspace.ai', sel: '.urltext' },
    headline: { kind: 'text', sample: 'See it for yourself.', sel: '.headline' },
    accent: { kind: 'color', sample: '#0066FF', var: '--accent' },
  },
};

/** The older style: bare variable names the block reads itself. */
const STAT_CARD = {
  name: 'stat-card',
  tier: 'starter',
  variables: ['stat', 'caption'],
};

/** One of the 26 that bake their content in and declare nothing. */
const HERO = { name: 'hero-pitch', tier: 'starter', fill: 'adapt' };

function media(over: Partial<ShotMedia> = {}): ShotMedia {
  return {
    id: 'm1', kind: 'image', role: 'reference',
    src: 'https://ex.test/thumb.png', url: 'https://ex.test/master.png', name: 'shot.png',
    ...over,
  } as ShotMedia;
}

beforeEach(() => setBlockCatalogue([BROWSER_MOCKUP, STAT_CARD, HERO]));

describe('resolveSlots', () => {
  it('splits a block’s declaration into what you drop and what you type', () => {
    const v = resolveSlots({ composition: 'browser-mockup' });
    expect(v.media.map(m => m.slot.key)).toEqual(['screenshot']);
    expect(v.values.map(m => m.slot.key)).toEqual(['url', 'headline', 'accent']);
    expect(v.total).toBe(4);
    expect(v.filled).toBe(0);
  });

  /** THE LOAD-BEARING IDEA: the slot key IS the media role. */
  it('fills a media slot from a reference tagged with that slot’s name', () => {
    const v = resolveSlots({
      composition: 'browser-mockup',
      media: [media({ role: 'screenshot', name: 'landing.png' })],
    });
    expect(v.media[0].empty).toBe(false);
    expect(v.media[0].media?.name).toBe('landing.png');
    expect(v.filled).toBe(1);
  });

  it('ignores media parked on the shot that is not filling a slot', () => {
    const v = resolveSlots({
      composition: 'browser-mockup',
      media: [media({ role: 'reference', name: 'mood.png' })],
    });
    expect(v.media[0].empty).toBe(true);
    expect(v.filled).toBe(0);
  });

  it('reads typed values, and treats whitespace as unfilled', () => {
    const v = resolveSlots({
      composition: 'browser-mockup',
      compositionVars: { headline: 'Ship it.', url: '   ' },
    });
    const byKey = Object.fromEntries(v.values.map(r => [r.slot.key, r]));
    expect(byKey.headline.value).toBe('Ship it.');
    expect(byKey.url.empty).toBe(true);
  });

  /** The older declaration style has to resolve identically. */
  it('handles a block that declares bare variables', () => {
    const v = resolveSlots({ composition: 'stat-card', compositionVars: { stat: '92%' } });
    expect(v.media).toEqual([]);
    expect(v.values.map(r => r.slot.key)).toEqual(['stat', 'caption']);
    expect(v.filled).toBe(1);
  });

  /** A baked-in design declares nothing; that is a real, valid state. */
  it('is empty for a block with no declaration, and does not throw', () => {
    const v = resolveSlots({ composition: 'hero-pitch' });
    expect(v.total).toBe(0);
    expect(v.block?.name).toBe('hero-pitch');
  });

  /** A board made on another machine references blocks that are not here. */
  it('survives a block that is not installed', () => {
    const v = resolveSlots({ composition: 'not-installed', compositionVars: { a: 'b' } });
    expect(v.block).toBeNull();
    expect(v.all).toEqual([]);
  });
});

describe('slotFills', () => {
  /**
   * WHAT THE 102 SLOT-DRIVEN BLOCKS NEED. They never read the values
   * themselves — the host patches the DOM by `sel` or `var` — so the selector
   * has to travel with the value or the preview shows the designer's
   * placeholder no matter what the user typed.
   */
  it('carries the selector and the css variable through', () => {
    const fills = slotFills({
      composition: 'browser-mockup',
      compositionVars: { headline: 'Ship it.', accent: '#FF0000' },
      media: [media({ role: 'screenshot' })],
    });
    const byKey = Object.fromEntries(fills.map(f => [f.key, f]));
    expect(byKey.screenshot).toMatchObject({ kind: 'image', sel: '.win img', value: 'https://ex.test/master.png' });
    expect(byKey.headline).toMatchObject({ kind: 'text', sel: '.headline', value: 'Ship it.' });
    expect(byKey.accent).toMatchObject({ kind: 'color', cssVar: '--accent', value: '#FF0000' });
  });

  /**
   * EMPTY IS OMITTED, not sent as ''. A blank value would wipe the designer's
   * placeholder, and an empty frame teaches the user less about the block than
   * the sample does.
   */
  it('omits every slot the shot has not filled', () => {
    const fills = slotFills({ composition: 'browser-mockup', compositionVars: { headline: '' } });
    expect(fills).toEqual([]);
  });

  it('takes the MASTER url, never the thumbnail', () => {
    const fills = slotFills({
      composition: 'browser-mockup',
      media: [media({ role: 'screenshot', src: 'https://ex.test/tiny.png', url: 'https://ex.test/full.png' })],
    });
    expect(fills[0].value).toBe('https://ex.test/full.png');
  });

  /** Compile resolves urls differently; the resolver is injectable for it. */
  it('lets the caller decide how a url is resolved', () => {
    const fills = slotFills(
      { composition: 'browser-mockup', media: [media({ role: 'screenshot' })] },
      m => `signed://${m.name}`,
    );
    expect(fills[0].value).toBe('signed://shot.png');
  });
});
