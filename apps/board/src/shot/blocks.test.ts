/**
 * The HyperFrames block library, as the board receives it.
 *
 * The shapes here are taken verbatim from real `block.json` files under
 * `~/Voidspace/.hyperframes/blocks` — a `slots` block, an `adapt` block, an
 * overlay, and one declaring the older bare `variables` list — because the
 * thing most likely to break is a block whose metadata is written in the style
 * this code did not anticipate.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  allBlocks, checkComposition, findBlock, onBlockCatalogue, searchBlocks, setBlockCatalogue,
} from './blocks';

const STAT: Record<string, unknown> = {
  name: 'stat-burst',
  description: 'One big number with a caption',
  category: 'data',
  tags: ['stat', 'number'],
  tier: 'starter',
  fill: 'slots',
  aspects: ['9:16', '1:1'],
  slots: {
    stat: { sel: '.stat', kind: 'text', sample: '92%' },
    caption: { sel: '.cap', kind: 'text', sample: 'of diets fail' },
  },
};

const ADAPTED: Record<string, unknown> = {
  name: 'hero-pitch',
  tier: 'starter',
  fill: 'adapt',
  tags: [],
};

const OVERLAY: Record<string, unknown> = {
  name: 'film-grain',
  tier: 'starter',
  fill: 'slots',
  overlay: true,
  tags: ['texture'],
};

/** The older declaration style — three of the shipped starters still use it. */
const LEGACY_VARS: Record<string, unknown> = {
  name: 'quote-card',
  tier: 'starter',
  variables: ['quote', 'attribution'],
};

describe('setBlockCatalogue', () => {
  beforeEach(() => setBlockCatalogue([STAT, ADAPTED, OVERLAY, LEGACY_VARS]));

  it('normalises a slots map into an ordered list, keeping the designer’s sample', () => {
    const b = findBlock('stat-burst')!;
    expect(b.slots.map(s => s.key)).toEqual(['stat', 'caption']);
    expect(b.slots[0].sample).toBe('92%');
    expect(b.slots[0].kind).toBe('text');
  });

  /** Two declaration styles, one answer to "what can I fill in". */
  it('normalises a bare variables list into the same shape', () => {
    const b = findBlock('quote-card')!;
    expect(b.slots.map(s => s.key)).toEqual(['quote', 'attribution']);
    expect(b.slots.every(s => s.kind === 'text')).toBe(true);
  });

  it('defaults fill to slots and tier to starter', () => {
    expect(findBlock('quote-card')!.fill).toBe('slots');
    expect(findBlock('quote-card')!.tier).toBe('starter');
  });

  it('drops entries with no name rather than listing a block nobody can pick', () => {
    setBlockCatalogue([STAT, { description: 'nameless' }, null, 'nonsense']);
    expect(allBlocks().map(b => b.name)).toEqual(['stat-burst']);
  });

  /**
   * THE RULE THE SERVER ALREADY APPLIES. `get_block` walks ['user','starter']
   * and takes the first hit, so listing both would offer the user a block that
   * is not the one they would actually get.
   */
  it('shadows a starter with the user’s own block of the same name', () => {
    setBlockCatalogue([
      { ...STAT, description: 'the shipped one' },
      { ...STAT, tier: 'user', description: 'mine' },
    ]);
    expect(allBlocks()).toHaveLength(1);
    expect(findBlock('stat-burst')!.tier).toBe('user');
    expect(findBlock('stat-burst')!.description).toBe('mine');
  });

  it('puts the user’s own blocks first — the ordering IS the recommendation', () => {
    setBlockCatalogue([STAT, { name: 'my-lower-third', tier: 'user' }, ADAPTED]);
    expect(allBlocks()[0].name).toBe('my-lower-third');
  });

  it('notifies listeners, because the library arrives after first paint', () => {
    let calls = 0;
    const stop = onBlockCatalogue(() => { calls++; });
    setBlockCatalogue([STAT]);
    expect(calls).toBe(1);
    stop();
    setBlockCatalogue([STAT]);
    expect(calls).toBe(1);
  });
});

describe('checkComposition', () => {
  beforeEach(() => setBlockCatalogue([STAT, ADAPTED, OVERLAY, LEGACY_VARS]));

  it('says nothing about a shot that has not chosen a block yet', () => {
    expect(checkComposition({ composition: '' })).toEqual([]);
  });

  it('is silent when the slots are filled', () => {
    expect(checkComposition({
      composition: 'stat-burst',
      compositionVars: { stat: '92%', caption: 'of diets fail' },
    })).toEqual([]);
  });

  it('warns that an unfilled block will render the designer’s sample content', () => {
    const w = checkComposition({ composition: 'stat-burst' });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('sample content');
    expect(w[0]).toContain('stat');
  });

  /** Whitespace is not a value — a slot filled with ' ' is still unfilled. */
  it('treats a blank string as unfilled', () => {
    const w = checkComposition({ composition: 'stat-burst', compositionVars: { stat: '  ' } });
    expect(w).toHaveLength(1);
  });

  it('warns that an adapt block bakes its content in', () => {
    const w = checkComposition({ composition: 'hero-pitch' });
    expect(w.some(m => m.includes('starting design'))).toBe(true);
  });

  it('warns that an overlay is meant to run over another shot', () => {
    const w = checkComposition({ composition: 'film-grain' });
    expect(w.some(m => m.includes('OVERLAY'))).toBe(true);
  });

  /**
   * A board made on one machine, opened on another. The name is real, the
   * block is not here — worth saying, and NOT worth saying before the library
   * has arrived, which is the empty-catalogue case below.
   */
  it('warns about a name that is not in this machine’s library', () => {
    const w = checkComposition({ composition: 'someone-elses-block' });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('not in the block library');
  });

  it('stays quiet before the library has loaded, rather than crying wolf', () => {
    setBlockCatalogue([]);
    expect(checkComposition({ composition: 'stat-burst' })).toEqual([]);
  });
});

/**
 * FINDING A BLOCK FROM A DESCRIPTION.
 *
 * A substring match over the whole query only fires when the words happen to be
 * adjacent in that order — "big number" found stat-card, "number stat" found
 * nothing. People describe what they want in their own order.
 */
describe('searchBlocks', () => {
  const KIT = [
    { name: 'stat-card', tier: 'starter', tags: ['stat', 'number', 'data'],
      description: 'One big number with a supporting line. The workhorse of short-form explainers.' },
    { name: 'lt-clean-bar', tier: 'starter', tags: ['lower-third', 'overlay'],
      description: 'Name and title strip that sits over footage.' },
    { name: 'my-stat', tier: 'user', tags: ['stat'], description: 'My own take on a number card.' },
    { name: 'code-typing', tier: 'starter', tags: ['code'], description: 'Code typing itself out.' },
  ];
  beforeEach(() => setBlockCatalogue(KIT));

  it('matches words in any order', () => {
    const names = searchBlocks('number stat').map(b => b.name);
    expect(names).toContain('stat-card');
    expect(names).toContain('my-stat');
  });

  /** Every word must appear, so more words NARROW the result. */
  it('ands the words together', () => {
    expect(searchBlocks('stat footage').map(b => b.name)).toEqual([]);
    expect(searchBlocks('stat number').length).toBeGreaterThan(0);
  });

  it('ranks a name match above a tag, and a tag above prose', () => {
    const names = searchBlocks('stat').map(b => b.name);
    // my-stat and stat-card both have it in the name; code-typing has it nowhere.
    expect(names).not.toContain('code-typing');
    expect(names.slice(0, 2).sort()).toEqual(['my-stat', 'stat-card']);
  });

  /** A user's own block wins a tie — the strongest signal of their taste. */
  it('breaks a tie towards the user’s own block', () => {
    expect(searchBlocks('stat')[0].name).toBe('my-stat');
  });

  it('finds a block by what it is for, from its prose alone', () => {
    expect(searchBlocks('explainers').map(b => b.name)).toEqual(['stat-card']);
  });

  it('returns everything for an empty query', () => {
    expect(searchBlocks('   ')).toHaveLength(4);
  });
});
