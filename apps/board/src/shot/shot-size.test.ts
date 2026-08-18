/**
 * What size and shape a shot renders at, and what that costs.
 *
 * Two rules carry all of this, and both are about a document outliving the
 * catalogue that made it:
 *
 *  • A shot stores `''` until someone picks. Unset must follow the MODEL, not a
 *    value frozen into the document at the moment it was created — otherwise a
 *    board made today keeps rendering at today's default after the model gains a
 *    better one.
 *  • A stored value the model does not offer is discarded. Models change under
 *    saved boards (Fast has no 1080p), and honouring a size the model cannot
 *    make is a generation that fails at the provider, after the wait, having
 *    quoted a price for something else.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  aspectFor, estimateShotCredits, resolutionFor, setModelCatalogue, type ModelCaps,
} from './models';

const BIG: ModelCaps = {
  id: 'bytedance/seedance-2-5',
  label: 'ByteDance Seedance 2.5',
  minDurationSec: 4,
  maxDurationSec: 30,
  allowedDurations: [4, 5, 8, 10, 12, 15, 20, 25, 30],
  // Deliberately ascending, and deliberately far apart: the whole point of the
  // picker is that the choice moves the price a lot.
  pricePerSec: { '480p': 0.5, '720p': 1.2, '1080p': 2.4 },
  resolutions: ['480p', '720p', '1080p'],
  aspectRatios: ['16:9', '9:16', '1:1'],
  nativeDialogue: true,
  nativeAudio: true,
  acceptsVoiceReference: true,
  supportsLastFrame: true,
  usesReferenceTags: true,
  referenceTagSyntax: 'Image',
  deliveryModes: ['reference', 'first-frame'],
  defaultDelivery: 'reference',
};

/** A model that offers no choice at all — the picker must not be drawn. */
const FIXED: ModelCaps = {
  ...BIG,
  id: 'fixed/one-size',
  label: 'Fixed',
  pricePerSec: {},
  credits: 7,
  resolutions: [],
  aspectRatios: [],
};

beforeEach(() => setModelCatalogue([BIG, FIXED], BIG.id));

describe('resolving what an unset shot renders at', () => {
  it('follows the model rather than a value baked into the document', () => {
    expect(resolutionFor({ resolution: '', model: BIG.id })).toBe('480p');
    expect(aspectFor({ aspect: '', model: BIG.id })).toBe('16:9');
  });

  it('honours a choice the model offers', () => {
    expect(resolutionFor({ resolution: '1080p', model: BIG.id })).toBe('1080p');
    expect(aspectFor({ aspect: '9:16', model: BIG.id })).toBe('9:16');
  });

  it('discards a choice the model cannot render', () => {
    // A board saved against Seedance 2.5 at 1080p, then switched to Fast.
    expect(resolutionFor({ resolution: '4k', model: BIG.id })).toBe('480p');
    expect(aspectFor({ aspect: '21:9', model: BIG.id })).toBe('16:9');
  });

  it('answers with nothing when the model offers nothing', () => {
    // '' is the signal to hide the control. An empty string is not a size, and
    // sending one to a generator would be worse than sending none.
    expect(resolutionFor({ resolution: '720p', model: FIXED.id })).toBe('');
    expect(aspectFor({ aspect: '16:9', model: FIXED.id })).toBe('');
  });

  it('falls back to the project default for a model that is gone', () => {
    // `effectiveModel` already resolves an unknown or empty model id to the
    // project default — a shot whose model was removed from the catalogue is
    // still a shot, and it renders at the default model's sizes rather than at
    // nothing. This asserts the existing rule reaches here rather than a new one.
    expect(resolutionFor({ resolution: '720p', model: 'nope/gone' })).toBe('720p');
    expect(resolutionFor({ resolution: '', model: 'nope/gone' })).toBe('480p');
  });
});

describe('the estimate prices the size that was chosen', () => {
  const shot = (resolution: string) =>
    ({ kind: 'clip', model: BIG.id, durationSec: 10, resolution });

  it('quotes the chosen resolution, not the cheapest one', () => {
    // THE BUG THIS PREVENTS: the estimate used to read the first entry of
    // pricePerSec unconditionally, which was right while nobody could choose.
    // On this model that is a 4.8× understatement of a 1080p shot.
    expect(estimateShotCredits(shot('480p'))).toBeCloseTo(5, 2);
    expect(estimateShotCredits(shot('1080p'))).toBeCloseTo(24, 2);
  });

  it('prices an unset shot exactly as it did before the picker existed', () => {
    // The fallback is the model's first resolution — the same value the old
    // `Object.values(pricePerSec)[0]` produced. No saved board changes price.
    expect(estimateShotCredits(shot(''))).toBeCloseTo(
      estimateShotCredits(shot('480p'))!, 2);
  });

  it('falls back rather than returning null for an unknown stored size', () => {
    expect(estimateShotCredits(shot('4k'))).toBeCloseTo(5, 2);
  });

  it('still handles a flat-priced model with no resolutions', () => {
    expect(estimateShotCredits({ kind: 'clip', model: FIXED.id, durationSec: 10, resolution: '' }))
      .toBe(7);
  });
});
