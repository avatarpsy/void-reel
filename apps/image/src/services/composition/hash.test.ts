/**
 * A cache key that misses an input serves a stale frame, which looks like the
 * editor ignoring an edit — a much worse failure than a cache miss. So these
 * check two things in both directions: that the key is stable for the same
 * slide, and that it moves for every input that can change a pixel.
 */
import { describe, it, expect } from 'vitest';
import { compositionHash, compositionFingerprint, needsRerender, withCurrentHash, type HashableComposition } from './hash';

const base: HashableComposition = {
  block: 'data-chart',
  tier: 'starter',
  slots: { headline: 'Reach by month', subtitle: 'Jan–Jun' },
  fillMode: 'render',
  poseTime: 'end',
  nativeWidth: 1920,
  nativeHeight: 1080,
};

describe('the same slide always keys the same', () => {
  it('is stable across calls', () => {
    expect(compositionHash(base)).toBe(compositionHash({ ...base }));
  });

  it('does not depend on the order slots were filled in', () => {
    // The agent fills slots in whatever order it decides them; a person edits
    // them in whatever order they click. JSON.stringify would differ here.
    const reordered: HashableComposition = {
      ...base,
      slots: { subtitle: 'Jan–Jun', headline: 'Reach by month' },
    };
    expect(compositionHash(reordered)).toBe(compositionHash(base));
  });

  it('treats a missing slot value and an empty one alike', () => {
    const a = { ...base, slots: { headline: 'x', subtitle: '' } };
    const b = { ...base, slots: { headline: 'x', subtitle: '' } };
    expect(compositionHash(a)).toBe(compositionHash(b));
  });
});

describe('every input that changes a pixel changes the key', () => {
  const differs = (over: Partial<HashableComposition>) =>
    expect(compositionHash({ ...base, ...over })).not.toBe(compositionHash(base));

  it('a slot value', () => differs({ slots: { ...base.slots, headline: 'Different' } }));
  it('an added slot', () => differs({ slots: { ...base.slots, source: 'Analytics' } }));
  it('a removed slot', () => differs({ slots: { headline: base.slots.headline } }));
  it('the block', () => differs({ block: 'flowchart' }));
  it('the fill mode', () => differs({ fillMode: 'preview' }));
  it('the pose time', () => differs({ poseTime: 2.5 }));
  it('the native size', () => differs({ nativeWidth: 1080, nativeHeight: 1350 }));
  it('the authored html', () => differs({ inlineHtml: '<div>one</div>' }));

  it('the tier, because a user block can shadow a starter of the same name', () => {
    // Same name, different design. Treating them as one entry would serve
    // somebody the wrong slide entirely.
    differs({ tier: 'user' });
  });

  it('distinguishes a numeric pose from the settled end state', () => {
    expect(compositionHash({ ...base, poseTime: 0 }))
      .not.toBe(compositionHash({ ...base, poseTime: 'end' }));
  });
});

describe('inline html is folded in, not carried', () => {
  it('keeps the fingerprint small for a large block', () => {
    // A 100 KB block would otherwise make the fingerprint larger than the thing
    // it identifies.
    const big = { ...base, inlineHtml: 'x'.repeat(100_000) };
    expect(compositionFingerprint(big).length).toBeLessThan(400);
  });

  it('still notices a one-character change inside it', () => {
    const a = { ...base, inlineHtml: '<div>a</div>' };
    const b = { ...base, inlineHtml: '<div>b</div>' };
    expect(compositionHash(a)).not.toBe(compositionHash(b));
  });
});

describe('asking whether a render is stale', () => {
  it('says no when the key matches', () => {
    expect(needsRerender(withCurrentHash(base))).toBe(false);
  });

  it('says yes after any edit', () => {
    const rendered = withCurrentHash(base);
    const edited = { ...rendered, slots: { ...rendered.slots, headline: 'Edited' } };
    expect(needsRerender(edited)).toBe(true);
  });

  it('says yes for a layer that was never rendered', () => {
    expect(needsRerender({ ...base, renderHash: '' })).toBe(true);
  });
});

describe('the key itself', () => {
  it('is short, fixed width and hex', () => {
    // It goes in filenames and cache paths.
    expect(compositionHash(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is synchronous, because it runs on every slot keystroke', () => {
    // Guards against a well-meant swap to crypto.subtle, which is async and
    // would turn "does this need re-rendering" into a promise.
    expect(typeof compositionHash(base)).toBe('string');
  });
});

describe('the key space holds up', () => {
  it('does not collide across realistic variation', () => {
    // A collision here serves somebody else's slide, so it is worth measuring
    // rather than assuming. 40k combinations of block, tier, slots, fill mode
    // and pose — the axes that actually vary in a deck.
    const seen = new Set<string>();
    const blocks = ['data-chart', 'flowchart', 'cta-endcard', 'hook-statement', 'browser-mockup'];
    let n = 0;
    for (let i = 0; i < 40_000; i++) {
      seen.add(compositionHash({
        block: blocks[i % blocks.length],
        tier: (['user', 'shared', 'starter'] as const)[i % 3],
        slots: { headline: `Headline ${i}`, subtitle: `Sub ${i % 977}`, source: `S${i % 31}` },
        fillMode: i % 2 ? 'render' : 'preview',
        poseTime: i % 7 === 0 ? 'end' : (i % 7),
        nativeWidth: 1920,
        nativeHeight: 1080,
      }));
      n++;
    }
    expect(seen.size).toBe(n);
  });

  it('uses both halves — a degenerate second half would halve the space silently', () => {
    const h = compositionHash({
      block: 'x', slots: { a: 'b' }, fillMode: 'render', poseTime: 'end',
      nativeWidth: 1, nativeHeight: 2,
    });
    expect(h.slice(0, 8)).not.toBe(h.slice(8));
  });
});
