/**
 * Which references a right-click means.
 *
 * This has now been wrong twice, both times silently and both times looking
 * identical from the outside: the menu said "Generate from 1 reference" over a
 * selection of four. First because the selection was read after BlockSuite had
 * already collapsed it to the card under the cursor, then because a stray
 * `selection.updated` subscription overwrote the snapshot that fixed it.
 *
 * The third attempt stopped racing the collapse altogether: a multi-selection
 * is REMEMBERED when the user builds it — shift-clicking, or finishing a
 * marquee — and only a left-click forgets it. None of those bugs were in the
 * RULE, which is four lines; they were all in when it was asked. So this pins
 * the rule, and the comments above `remembered` pin the timing.
 */
import { describe, expect, it } from 'vitest';

import { chooseReferences } from './canvas-menu';

/** What a user has shift-clicked together. */
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

describe('nothing remembered', () => {
  it('defers to the live selection', () => {
    // Only selections of two or more are ever remembered, so one id here would
    // mean a bug upstream; either way the live answer is the honest one.
    expect(chooseReferences(['a'], 'b', ['b'])).toEqual(['b']);
    expect(chooseReferences([], 'b', ['b'])).toEqual(['b']);
  });

  it('is what a left-click leaves behind', () => {
    // Clicking elsewhere clears the memory (see `onPointerDown`), so a later
    // right-click acts on what is actually selected — four references from five
    // minutes ago must not reattach themselves to an unrelated image.
    expect(chooseReferences([], 'z', ['z'])).toEqual(['z']);
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
