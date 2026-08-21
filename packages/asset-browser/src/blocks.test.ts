/**
 * THE BLOCK PARSER, WHICH TWO EDITORS NOW DEPEND ON.
 *
 * The trap it exists to close: the library declares what a block can be filled
 * with in TWO ways — `slots{}` carrying a selector the host patches, and a bare
 * `variables[]` the block reads itself. 102 of the 128 starters use the first.
 * A browser that implements only `variables` shows almost the whole library with
 * the designer's placeholder text no matter what the user typed, and looks like
 * it is working the entire time.
 */
import { describe, expect, it } from 'vitest';
import { normalizeBlocks, searchBlocks, mediaSlots, valueSlots, blocksForScope } from './blocks';

describe('normalizeBlocks', () => {
  it('reads the slots{} style, keeping the selector VERBATIM', () => {
    // `sel` and `var` are how a value physically reaches the composition. A
    // parser that dropped them would produce a fillable-looking block that
    // renders its sample content forever.
    const [b] = normalizeBlocks([{
      name: 'lt-clean-bar',
      slots: {
        name: { kind: 'text', sample: 'Dr. Sarah Chen', sel: '.lt-name' },
        accent: { kind: 'color', var: '--accent' },
      },
    }]);
    expect(b!.slots).toEqual([
      { key: 'name', kind: 'text', sample: 'Dr. Sarah Chen', sel: '.lt-name', cssVar: undefined },
      { key: 'accent', kind: 'color', sample: undefined, sel: undefined, cssVar: '--accent' },
    ]);
  });

  it('reads the bare variables[] style too', () => {
    const [b] = normalizeBlocks([{ name: 'old-style', variables: ['title', 'subtitle'] }]);
    expect(b!.slots.map((s) => s.key)).toEqual(['title', 'subtitle']);
    expect(b!.slots.every((s) => s.kind === 'text')).toBe(true);
  });

  it('folds both into one list, slots winning a collision', () => {
    // A slot carries a selector and a sample; a bare variable name carries
    // neither, so preferring the variable would lose information.
    const [b] = normalizeBlocks([{
      name: 'both',
      slots: { title: { kind: 'text', sel: '.t', sample: 'Hello' } },
      variables: ['title', 'extra'],
    }]);
    expect(b!.slots.map((s) => s.key)).toEqual(['title', 'extra']);
    expect(b!.slots[0]!.sel).toBe('.t');
  });

  it('defaults an unknown slot kind to text rather than dropping it', () => {
    // An unrecognised kind is still something the user can type into. Dropping
    // it would silently remove a field the designer published.
    const [b] = normalizeBlocks([{ name: 'x', slots: { odd: { kind: 'gradient' } } }]);
    expect(b!.slots[0]).toMatchObject({ key: 'odd', kind: 'text' });
  });

  it('puts user blocks first and lets one SHADOW a starter of the same name', () => {
    // The server takes the first hit walking ['user','starter'] when it reads a
    // block. A listing that showed both would offer a block that is not the one
    // you would actually get.
    const out = normalizeBlocks([
      { name: 'lower-third', tier: 'starter' },
      { name: 'lower-third', tier: 'user' },
      { name: 'a-starter', tier: 'starter' },
    ]);
    expect(out.map((b) => `${b.name}:${b.tier}`)).toEqual(['lower-third:user', 'a-starter:starter']);
  });

  it('keeps `shared` as its own tier, with the credit', () => {
    // An adopted block is neither yours nor shipped, and the handle is how the
    // user knows whose it is.
    const [b] = normalizeBlocks([{ name: 'x', tier: 'shared', credit: 'mara' }]);
    expect(b!.tier).toBe('shared');
    expect(b!.credit).toBe('mara');
  });

  it('drops a row with no name and survives junk', () => {
    expect(normalizeBlocks([{ name: '  ' }, null, 42, { name: 'ok' }] as unknown[])
      .map((b) => b.name)).toEqual(['ok']);
    expect(normalizeBlocks(undefined as never)).toEqual([]);
  });

  it('defaults fill/overlay conservatively', () => {
    // `slots` and not-an-overlay are the safe assumptions: they let a block be
    // offered for filling and placed as a full frame, which is recoverable.
    const [b] = normalizeBlocks([{ name: 'x' }]);
    expect(b!.fill).toBe('slots');
    expect(b!.overlay).toBe(false);
    expect(b!.tags).toEqual([]);
  });
});

describe('mediaSlots / valueSlots', () => {
  const [b] = normalizeBlocks([{
    name: 'x',
    slots: {
      name: { kind: 'text' }, accent: { kind: 'color' },
      shot: { kind: 'image' }, clip: { kind: 'video' },
    },
  }]);

  it('splits what you DROP from what you TYPE', () => {
    expect(mediaSlots(b!).map((s) => s.key)).toEqual(['shot', 'clip']);
    expect(valueSlots(b!).map((s) => s.key)).toEqual(['name', 'accent']);
  });

  it('answers empty for no block, so a caller need not guard', () => {
    expect(mediaSlots(null)).toEqual([]);
    expect(valueSlots(undefined)).toEqual([]);
  });
});

describe('searchBlocks', () => {
  const all = normalizeBlocks([
    { name: 'lt-clean-bar', description: 'Minimal lower third', category: 'lower-third', tags: ['name', 'speaker'] },
    { name: 'stat-callout', description: 'Big number', category: 'callout', tags: ['data'] },
  ]);

  it('matches across name, description, category and tags', () => {
    expect(searchBlocks(all, 'lower').map((b) => b.name)).toEqual(['lt-clean-bar']);
    expect(searchBlocks(all, 'speaker').map((b) => b.name)).toEqual(['lt-clean-bar']);
    expect(searchBlocks(all, 'number').map((b) => b.name)).toEqual(['stat-callout']);
  });

  it('requires EVERY word, so a second term narrows', () => {
    expect(searchBlocks(all, 'lower speaker')).toHaveLength(1);
    expect(searchBlocks(all, 'lower data')).toHaveLength(0);
  });

  it('returns everything for an empty query rather than nothing', () => {
    expect(searchBlocks(all, '   ')).toHaveLength(2);
  });
});

/**
 * WHAT A SCOPE PILL MEANS FOR A BLOCK.
 *
 * The board and the video editor show the same library under the same five
 * words. These are the rules both of them now read from here rather than each
 * deciding for itself — which is the whole reason the function moved.
 */
describe('blocksForScope', () => {
  const all = normalizeBlocks([
    { name: 'mine-1', tier: 'user' },
    { name: 'mine-2', tier: 'user' },
    { name: 'ship-1', tier: 'starter' },
    { name: 'adopted-1', tier: 'shared', credit: 'mara' },
  ]);

  it('"mine" is what the user AUTHORED — never the 128 shipped designs', () => {
    // Filing designs they never touched under "My files" would claim authorship.
    expect(blocksForScope(all, 'mine').map((b) => b.name)).toEqual(['mine-1', 'mine-2']);
  });

  it('"shared" is everything they did NOT author — shipped and adopted alike', () => {
    // Splitting these would need a sixth pill for one kind; who made it is on
    // the tile as a credit instead.
    expect(blocksForScope(all, 'shared').map((b) => b.name).sort())
      .toEqual(['adopted-1', 'ship-1']);
  });

  it('"generated" is honestly EMPTY — a block is authored or installed', () => {
    // Quietly showing everything here would misdescribe where they came from,
    // and the panel says so in words rather than showing a blank grid.
    expect(blocksForScope(all, 'generated')).toEqual([]);
  });

  it('"device" has no block meaning, so it hides nothing', () => {
    expect(blocksForScope(all, 'device')).toHaveLength(4);
  });

  it('"project" is what this document already uses, and nothing without the set', () => {
    // A panel with no notion of "used here" passes none and gets none, rather
    // than falling back to everything and implying they are all in use.
    expect(blocksForScope(all, 'project', new Set(['ship-1'])).map((b) => b.name)).toEqual(['ship-1']);
    expect(blocksForScope(all, 'project')).toEqual([]);
  });
});
