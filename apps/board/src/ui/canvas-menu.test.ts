/**
 * Which references a right-click means.
 *
 * This has now been wrong twice, both times silently and both times looking
 * identical from the outside: the menu said "Generate from 1 reference" over a
 * selection of four. First because the selection was read after BlockSuite had
 * already collapsed it to the card under the cursor, then because a stray
 * `selection.updated` subscription overwrote the snapshot that fixed it.
 *
 * Neither bug was in the RULE — the rule is four lines — so a test of the DOM
 * would have caught neither. What both needed was a place where the rule is
 * stated once, in terms of the three facts it depends on, so the next change to
 * the event plumbing has something to be checked against.
 */
import { describe, expect, it } from 'vitest';

import { chooseReferences } from './canvas-menu';

const FOUR = ['a', 'b', 'c', 'd'];

describe('right-clicking inside a multi-selection', () => {
  it('keeps the whole selection — the case that kept breaking', () => {
    // BlockSuite has already collapsed `now` to the clicked card by this point.
    expect(chooseReferences(FOUR, 'c', ['c'])).toEqual(FOUR);
  });

  it('keeps it for empty canvas inside the marquee too', () => {
    // A marquee then a right-click in the gap between the images is still
    // "these" — there is no block under the cursor to mean anything else.
    expect(chooseReferences(FOUR, '', ['c'])).toEqual(FOUR);
  });
});

describe('right-clicking outside it', () => {
  it('acts on the one thing clicked — this is how you change your mind', () => {
    expect(chooseReferences(FOUR, 'z', ['z'])).toEqual(['z']);
  });

  it('does not resurrect a selection the user has moved on from', () => {
    // Nothing selected now, and the click was elsewhere: a stale snapshot here
    // would generate from four images the user stopped pointing at.
    expect(chooseReferences(FOUR, 'z', [])).toEqual([]);
  });
});

describe('a snapshot of one carries no extra information', () => {
  it('defers to the live selection', () => {
    // Preferring it would keep one stale id alive across an unrelated click.
    expect(chooseReferences(['a'], 'b', ['b'])).toEqual(['b']);
    expect(chooseReferences([], 'b', ['b'])).toEqual(['b']);
  });
});

describe('the result is a copy', () => {
  it('never hands out the snapshot itself', () => {
    // The caller stores this on `refIds` and the snapshot is overwritten by the
    // next right-click; sharing the array would mutate a menu already open.
    const before = [...FOUR];
    const out = chooseReferences(before, 'c', ['c']);
    out.push('e');
    expect(before).toEqual(FOUR);
  });
});
