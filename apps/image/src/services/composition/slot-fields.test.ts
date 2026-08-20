/**
 * Slots are the surface the agent writes and the user edits, so the two have to
 * see the same holes. These pin the three rules that decide that: which rows
 * exist, that the designer's sample never becomes a value, and what a slot edit
 * does to the stored render.
 */
import { describe, it, expect } from 'vitest';
import { slotFields, slotLabel, withSlotValue } from './slot-fields';
import type { SlotSpec } from './document';
import { compositionHash, needsRerender } from './hash';
import type { CompositionSource } from '../../types/project';

const MANIFEST: Record<string, SlotSpec> = {
  headline: { kind: 'text', sel: '.headline', sample: 'Sample headline' },
  subtitle: { kind: 'text', sel: '.subtitle', sample: 'Sample subtitle' },
  screenshot: { kind: 'image', sel: '.shot', sample: 'a screenshot' },
  accent: { kind: 'color', var: '--accent', sample: '#0066FF' },
};

const source = (over: Partial<CompositionSource> = {}): CompositionSource => ({
  block: 'stat-punch',
  tier: 'starter',
  slots: { headline: 'Reach by month' },
  fillMode: 'render',
  poseTime: 'end',
  frameWidth: 1920,
  frameHeight: 1080,
  renderHash: '',
  ...over,
});

describe('naming a slot for a human', () => {
  it('turns the shapes blocks actually use into words', () => {
    expect(slotLabel('headline')).toBe('Headline');
    expect(slotLabel('key-text')).toBe('Key text');
    expect(slotLabel('key_text')).toBe('Key text');
    expect(slotLabel('keyText')).toBe('Key text');
  });

  it('leaves a key it cannot improve alone', () => {
    expect(slotLabel('')).toBe('');
  });
});

describe('which rows the panel draws', () => {
  it('draws every declared slot, filled or not', () => {
    // A hole you cannot see is a hole you cannot fill, and the empty row is the
    // only thing that says this block HAS a subtitle.
    const rows = slotFields(MANIFEST, { headline: 'Reach by month' });
    expect(rows.map((r) => r.key)).toEqual(['headline', 'subtitle', 'screenshot', 'accent']);
  });

  it('keeps the order the block declares them in', () => {
    const rows = slotFields(MANIFEST, {});
    expect(rows[0].key).toBe('headline');
    expect(rows[3].key).toBe('accent');
  });

  it('carries the kind through, so each slot gets the right control', () => {
    const byKey = Object.fromEntries(slotFields(MANIFEST, {}).map((r) => [r.key, r.kind]));
    expect(byKey).toEqual({
      headline: 'text', subtitle: 'text', screenshot: 'image', accent: 'color',
    });
  });

  it('shows a value the block does not declare, rather than stranding it', () => {
    // Usually a block edited after the slide was made. A value with no row is a
    // value the user set and has no way to unset.
    const rows = slotFields(MANIFEST, { legacy: 'left over' });
    const extra = rows.find((r) => r.key === 'legacy');
    expect(extra?.undeclared).toBe(true);
    expect(extra?.kind).toBe('text');
  });

  it('does not invent a row for an undeclared key that is empty', () => {
    expect(slotFields(MANIFEST, { legacy: '' }).some((r) => r.key === 'legacy')).toBe(false);
  });

  it('draws only the filled keys when there is no manifest at all', () => {
    // Authored html declares nothing, and a block that will not load answers
    // nothing. Fewer rows than the block really has, but never a lost value.
    const rows = slotFields({}, { headline: 'Reach by month', source: 'Analytics' });
    expect(rows.map((r) => r.key).sort()).toEqual(['headline', 'source']);
    expect(rows.every((r) => r.undeclared)).toBe(true);
  });

  it('draws nothing for a block with no slots and nothing filled', () => {
    // A decorative block — a transition, a sting — is chosen for what is baked
    // into it, and has no holes at all.
    expect(slotFields({}, {})).toEqual([]);
  });
});

describe('the designer sample stays a placeholder', () => {
  it('never becomes the value', () => {
    // Putting the sample in as a value fills the slot the moment somebody clicks
    // away, and shipping the designer's demo text inside a user's work is the
    // failure that survives all the way to a published deck.
    const row = slotFields(MANIFEST, {}).find((r) => r.key === 'headline');
    expect(row?.value).toBe('');
    expect(row?.placeholder).toBe('Sample headline');
  });

  it('treats a blank stored value as unfilled', () => {
    const row = slotFields(MANIFEST, { headline: '   ' }).find((r) => r.key === 'headline');
    expect(row?.value).toBe('');
  });

  it('shows a real value instead of the placeholder text', () => {
    const row = slotFields(MANIFEST, { headline: 'Reach by month' }).find((r) => r.key === 'headline');
    expect(row?.value).toBe('Reach by month');
  });
});

describe('editing a slot', () => {
  it('sets the value', () => {
    expect(withSlotValue(source(), 'subtitle', 'Jan-Jun').slots.subtitle).toBe('Jan-Jun');
  });

  it('REMOVES the key when the value is cleared', () => {
    // Blank and absent render identically but key differently, so storing the
    // blank would give two identical slides two cache entries — and make
    // clearing a slot look like an edit that changed nothing.
    const cleared = withSlotValue(source(), 'headline', '');
    expect('headline' in cleared.slots).toBe(false);
    expect(compositionHash(cleared)).toBe(compositionHash(source({ slots: {} })));
  });

  it('treats whitespace as clearing it', () => {
    expect('headline' in withSlotValue(source(), 'headline', '  ').slots).toBe(false);
  });

  it('leaves the rest of the composition alone', () => {
    const edited = withSlotValue(source(), 'subtitle', 'x');
    expect(edited.block).toBe('stat-punch');
    expect(edited.poseTime).toBe('end');
    expect(edited.frameWidth).toBe(1920);
  });

  it('does not mutate the source it was given', () => {
    const before = source();
    withSlotValue(before, 'subtitle', 'x');
    expect(before.slots.subtitle).toBeUndefined();
  });

  it('leaves renderHash alone, so the edit goes STALE', () => {
    // renderHash records which render the pixels came from. Stamping a fresh one
    // here would declare pixels that do not exist to be current, and
    // `needsRerender` would answer no for a slide nobody has rendered.
    const rendered: CompositionSource = { ...source(), renderHash: compositionHash(source()) };
    expect(needsRerender(rendered)).toBe(false);

    const edited = withSlotValue(rendered, 'headline', 'Something else');
    expect(edited.renderHash).toBe(rendered.renderHash);
    expect(needsRerender(edited)).toBe(true);
  });
});
