/**
 * Model capability — what a shot may contain, and what it will be told about.
 *
 * The catalogue is RECEIVED from the parent page, so these tests set it up the
 * way the bridge does. Two models with genuinely different capabilities, taken
 * from the real `VideoGenConfig` entries: one that speaks, takes an end frame
 * and reads @-tags (Seedance), and one that does none of those (Kling).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { setBlockCatalogue } from './blocks';
import { rolesFor } from './model';
import {
  checkShot, defaultModel, effectiveModel, estimateShotCredits, findModel, formatCredits,
  plannedSeconds, referenceTag, setModelCatalogue, type ModelCaps,
} from './models';

const SEEDANCE: ModelCaps = {
  id: 'bytedance/seedance-2',
  label: 'ByteDance Seedance 2',
  minDurationSec: 4,
  maxDurationSec: 15,
  allowedDurations: [4, 5, 8, 10, 12, 15],
  pricePerSec: { '1080p': 2.4 },
  nativeDialogue: true,
  nativeAudio: true,
  acceptsVoiceReference: true,
  supportsLastFrame: true,
  usesReferenceTags: true,
  referenceTagSyntax: 'Image',
  deliveryModes: ['reference', 'first-frame'],
  defaultDelivery: 'reference',
};

const KLING: ModelCaps = {
  id: 'kling/v2-5-turbo-image-to-video-pro',
  label: 'Kling 2.5 Turbo Pro',
  minDurationSec: 5,
  maxDurationSec: 10,
  allowedDurations: [5, 10],
  credits: 45,
  nativeDialogue: false,
  nativeAudio: false,
  acceptsVoiceReference: false,
  supportsLastFrame: false,
  usesReferenceTags: false,
  referenceTagSyntax: 'image',
  deliveryModes: ['first-frame'],
  defaultDelivery: 'first-frame',
};

function shot(over: Partial<Parameters<typeof checkShot>[0]> = {}) {
  return { model: '', durationSec: 0, voiceover: '', media: [], ...over };
}

describe('model catalogue', () => {
  beforeEach(() => setModelCatalogue([SEEDANCE, KLING], SEEDANCE.id));

  it('resolves a shot with no model of its own to the default', () => {
    expect(effectiveModel('')?.id).toBe(SEEDANCE.id);
    expect(effectiveModel(KLING.id)?.id).toBe(KLING.id);
    expect(defaultModel()).toBe(SEEDANCE.id);
  });

  it('resolves an unknown id to the default rather than to nothing', () => {
    // A shot referencing a retired model must still compile — falling to null
    // would silently drop every capability check on it.
    expect(effectiveModel('bytedance/seedance-99')?.id).toBe(SEEDANCE.id);
    expect(findModel('bytedance/seedance-99')).toBeNull();
  });

  it('says nothing at all when there is no catalogue', () => {
    setModelCatalogue([], '');
    expect(checkShot(shot({ voiceover: 'a line' }))).toEqual([]);
  });
});

describe('reference tags', () => {
  beforeEach(() => setModelCatalogue([SEEDANCE, KLING], SEEDANCE.id));

  /** Numbered per KIND, in list order — the contract the generation step
   *  implements server-side. */
  it('numbers images, video and audio in separate sequences', () => {
    const media = [
      { id: 'a', kind: 'image' },
      { id: 'b', kind: 'image' },
      { id: 'c', kind: 'video' },
      { id: 'd', kind: 'audio' },
      { id: 'e', kind: 'image' },
    ];
    const caps = findModel(SEEDANCE.id);
    expect(referenceTag(caps, media, 'a')).toBe('@Image1');
    expect(referenceTag(caps, media, 'b')).toBe('@Image2');
    expect(referenceTag(caps, media, 'e')).toBe('@Image3');
    expect(referenceTag(caps, media, 'c')).toBe('@Video1');
    expect(referenceTag(caps, media, 'd')).toBe('@Audio1');
  });

  /** Seedance parses `@Image1`, Grok `@image1`. Handing a model the other
   *  spelling is a reference it does not resolve. */
  it('uses the model’s own spelling', () => {
    const media = [{ id: 'a', kind: 'image' }];
    expect(referenceTag(findModel(SEEDANCE.id), media, 'a')).toBe('@Image1');
  });

  it('writes no tag at all for a model that does not read them', () => {
    const media = [{ id: 'a', kind: 'image' }];
    expect(referenceTag(findModel(KLING.id), media, 'a')).toBe('');
  });

  it('returns nothing for media that is not in the list', () => {
    expect(referenceTag(findModel(SEEDANCE.id), [], 'ghost')).toBe('');
  });
});

describe('checkShot', () => {
  beforeEach(() => setModelCatalogue([SEEDANCE, KLING], SEEDANCE.id));

  it('is silent when the shot and its model agree', () => {
    const warnings = checkShot(shot({
      model: SEEDANCE.id,
      durationSec: 8,
      voiceover: 'Most diets fail.',
      media: [{ id: 'a', role: 'lastFrame', kind: 'image' }],
    }));
    expect(warnings).toEqual([]);
  });

  it('warns that an end frame will be ignored by a model without one', () => {
    const warnings = checkShot(shot({
      model: KLING.id,
      media: [{ id: 'a', role: 'lastFrame', kind: 'image' }],
    }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].mediaId).toBe('a');
    expect(warnings[0].message).toContain('end-frame');
  });

  it('warns that a spoken line will need separate TTS', () => {
    const warnings = checkShot(shot({ model: KLING.id, voiceover: 'A line.' }));
    expect(warnings.some(w => w.message.includes('does not speak'))).toBe(true);
  });

  it('warns when the beat is longer than the model can render', () => {
    const warnings = checkShot(shot({ model: KLING.id, durationSec: 20 }));
    expect(warnings.some(w => w.message.includes('caps a clip at 10s'))).toBe(true);
  });

  it('does not warn about a length inside the cap', () => {
    expect(checkShot(shot({ model: KLING.id, durationSec: 10 }))).toEqual([]);
  });

  /** The warnings are advice, not a gate — see the note on `ShotWarning`. */
  it('never refuses anything, it only reports', () => {
    const warnings = checkShot(shot({
      model: KLING.id,
      durationSec: 30,
      voiceover: 'A line.',
      media: [
        { id: 'a', role: 'lastFrame', kind: 'image' },
        { id: 'b', role: 'motionRef', kind: 'video' },
      ],
    }));
    // Four separate things wrong, four separate sentences, nothing blocked.
    expect(warnings.length).toBe(4);
    expect(warnings.every(w => typeof w.message === 'string' && w.message.length > 20)).toBe(true);
  });
});

/**
 * WHAT THE SHOT WILL COST, before a credit is spent.
 *
 * Approximate on purpose — the real figure depends on the length the model
 * snaps to and on retries — but it has to be approximately RIGHT, and it has to
 * be honestly absent rather than zero when it cannot be known. "Free" and
 * "unknown" are the two answers a user must never see confused.
 */
describe('estimateShotCredits', () => {
  beforeEach(() => setModelCatalogue([SEEDANCE, KLING], SEEDANCE.id));

  it('prices a per-second model by the planned length', () => {
    expect(estimateShotCredits({ model: SEEDANCE.id, durationSec: 8 })).toBeCloseTo(19.2, 5);
  });

  /** A shot nobody has set a length on still costs SOMETHING — the model's floor. */
  it('falls back to the model minimum when no length is planned', () => {
    expect(estimateShotCredits({ model: SEEDANCE.id, durationSec: 0 })).toBeCloseTo(9.6, 5);
  });

  it('clamps a length the model cannot render to what it can', () => {
    // Seedance caps at 15s, so a 30s beat is priced at 15s — not at 30.
    expect(estimateShotCredits({ model: SEEDANCE.id, durationSec: 30 })).toBeCloseTo(36, 5);
    expect(estimateShotCredits({ model: SEEDANCE.id, durationSec: 1 })).toBeCloseTo(9.6, 5);
  });

  it('uses the flat per-call price for a model with no per-second rate', () => {
    expect(estimateShotCredits({ model: KLING.id, durationSec: 10 })).toBe(45);
  });

  /** A graphic is rendered on the user's own machine — it costs nothing. */
  it('is exactly zero for a graphic, not unknown', () => {
    expect(estimateShotCredits({ kind: 'hyperframes', model: '', durationSec: 6 })).toBe(0);
  });

  it('is null — not zero — when no model resolves', () => {
    setModelCatalogue([], '');
    expect(estimateShotCredits({ model: '', durationSec: 8 })).toBeNull();
  });

  it('says "no gen cost" for free and nothing at all for unknown', () => {
    expect(formatCredits(0)).toBe('no gen cost');
    expect(formatCredits(null)).toBe('');
    expect(formatCredits(19.2)).toBe('~19 cr');
    expect(formatCredits(4.8)).toBe('~4.8 cr');
  });
});

/**
 * A graphic is not a clip, and a video is not a still.
 *
 * The list used to be "every non-audio role", so a video offered FIRST FRAME —
 * which no model reads from a clip — and a photograph offered MOTION REF, which
 * is a camera move copied from footage. Both are choices a user can make and
 * then wonder why nothing happened.
 */
describe('rolesFor', () => {
  it('offers a clip’s still the frames, and never a motion reference', () => {
    expect(rolesFor('clip', 'image')).toEqual(['reference', 'firstFrame', 'lastFrame']);
  });

  it('offers a clip’s video the motion reference, and never the frames', () => {
    expect(rolesFor('clip', 'video')).toEqual(['reference', 'motionRef']);
  });

  it('offers a graphic the composition holes instead of generation roles', () => {
    expect(rolesFor('hyperframes', 'image'))
      .toEqual(['background', 'figure', 'inset', 'logo', 'texture', 'reference']);
    // A video can be the backdrop or a picture-in-picture, but not a logo.
    expect(rolesFor('hyperframes', 'video'))
      .toEqual(['background', 'inset', 'texture', 'reference']);
  });

  it('gives audio the same two jobs whatever the shot is', () => {
    expect(rolesFor('clip', 'audio')).toEqual(['sfx', 'bgm', 'reference']);
    expect(rolesFor('hyperframes', 'audio')).toEqual(['sfx', 'bgm', 'reference']);
  });
});

describe('checkShot on a graphic', () => {
  beforeEach(() => {
    setModelCatalogue([SEEDANCE, KLING], SEEDANCE.id);
    setBlockCatalogue([{ name: 'stat-burst', fill: 'slots', slots: { stat: { kind: 'text' } } }]);
  });

  /**
   * A graphic renders locally from a block — the model is irrelevant to it. So
   * the model warnings must not fire, or every title card would carry a
   * complaint about a spoken line the block will happily show as text.
   */
  it('reports the block’s problems and none of the model’s', () => {
    const warnings = checkShot({
      kind: 'hyperframes',
      composition: 'stat-burst',
      model: KLING.id,
      durationSec: 30,
      voiceover: 'A line the model cannot speak.',
      media: [{ id: 'a', role: 'lastFrame', kind: 'image' }],
    } as Parameters<typeof checkShot>[0]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('sample content');
  });
});

/**
 * The runtime and the cost must not contradict each other.
 *
 * They did: the board summed durations one way and credits another, so a board
 * read "3 shots · 17s · ~103 cr" where the 17s ignored a shot the 103 cr had
 * charged for. One rule now answers both questions.
 */
describe('plannedSeconds', () => {
  beforeEach(() => setModelCatalogue([SEEDANCE, KLING], SEEDANCE.id));

  it('uses the model minimum for a clip nobody has set a length on', () => {
    // Priced at the minimum, so it must be COUNTED at the minimum too.
    const shot = { model: KLING.id, durationSec: 0 };
    expect(plannedSeconds(shot)).toBe(KLING.minDurationSec);
    expect(estimateShotCredits(shot)).not.toBeNull();
  });

  it('clamps to what the model can actually render', () => {
    expect(plannedSeconds({ model: KLING.id, durationSec: 30 })).toBe(10);
    expect(plannedSeconds({ model: KLING.id, durationSec: 1 })).toBe(5);
  });

  /** What the render pipeline uses for a graphic with no length set. */
  it('gives an unset graphic five seconds', () => {
    expect(plannedSeconds({ kind: 'hyperframes', model: '', durationSec: 0 })).toBe(5);
    expect(plannedSeconds({ kind: 'hyperframes', model: '', durationSec: 3 })).toBe(3);
  });

  it('is zero only when there is genuinely nothing to go on', () => {
    setModelCatalogue([], '');
    expect(plannedSeconds({ model: '', durationSec: 0 })).toBe(0);
  });

  /**
   * SNAPPING TO WHAT THE MODEL ACTUALLY PRODUCES.
   *
   * `allowedDurations` was reported to the agent and used by nothing, so a shot
   * planned at 7s was estimated at 7s, totalled at 7s and SENT as 7s — and
   * whatever Seedance then did with it (round, refuse, or choose for us) landed
   * after the charge, at a length nothing on screen had ever mentioned.
   */
  it('snaps to a length the model can actually render', () => {
    // Seedance does 4, 5, 8, 10, 12, 15. It does not do 6, 7 or 13.
    expect(plannedSeconds({ model: SEEDANCE.id, durationSec: 7 })).toBe(8);   // nearer 8
    expect(plannedSeconds({ model: SEEDANCE.id, durationSec: 6 })).toBe(5);   // nearer 5
    expect(plannedSeconds({ model: SEEDANCE.id, durationSec: 13 })).toBe(12); // nearer 12
    // 9 is equidistant from 8 and 10 — a tie, so it goes up. See the next test.
    expect(plannedSeconds({ model: SEEDANCE.id, durationSec: 9 })).toBe(10);
    // Exact hits are left alone.
    expect(plannedSeconds({ model: SEEDANCE.id, durationSec: 10 })).toBe(10);
  });

  it('breaks a tie UPWARD, because only the longer one can still be trimmed', () => {
    // 6.5 sits exactly between 5 and 8 for Seedance. Round down and the second
    // and a half is gone for good; round up and the user can trim it on the
    // timeline. The recoverable direction wins.
    expect(plannedSeconds({ model: SEEDANCE.id, durationSec: 6.5 })).toBe(8);
    // 7.5 between 5 and 10 on Kling.
    expect(plannedSeconds({ model: KLING.id, durationSec: 7.5 })).toBe(10);
  });

  it('clamps BEFORE snapping, so an out-of-range ask lands on a real value', () => {
    expect(plannedSeconds({ model: SEEDANCE.id, durationSec: 99 })).toBe(15);
    expect(plannedSeconds({ model: SEEDANCE.id, durationSec: 1 })).toBe(4);
  });

  it('leaves a model with no discrete list free to use anything in range', () => {
    // An empty `allowedDurations` means "anything in range" — snapping such a
    // model to its minimum would quietly forbid every length it supports.
    setModelCatalogue([LOCAL_H3], LOCAL_H3.id);
    expect(plannedSeconds({ model: LOCAL_H3.id, durationSec: 7 })).toBe(7);
    expect(plannedSeconds({ model: LOCAL_H3.id, durationSec: 13 })).toBe(13);
  });
});

/**
 * A model on the USER'S OWN MACHINE.
 *
 * Two things about it are genuinely different from every cloud model, and both
 * are visible on the card: it costs nothing, and it can be temporarily
 * impossible to run because a 19 GB weight file has not been downloaded yet.
 * Modelled on the MiniMax H3 recipe, which is the first one shipped.
 */
const LOCAL_H3: ModelCaps = {
  id: 'local:this-machine/minimax-h3-i2v',
  label: 'MiniMax H3 (image to video) · This computer',
  credits: 0,
  pricePerSec: {},
  minDurationSec: 4,
  maxDurationSec: 15,
  allowedDurations: [],
  nativeDialogue: true,
  nativeAudio: true,
  acceptsVoiceReference: false,
  supportsLastFrame: true,
  usesReferenceTags: false,
  referenceTagSyntax: 'Image',
  deliveryModes: ['first-frame'],
  defaultDelivery: 'first-frame',
  local: { nodeName: 'This computer', recipe: 'minimax-h3-i2v', ready: true },
};

const LOCAL_NOT_READY: ModelCaps = {
  ...LOCAL_H3,
  id: 'local:workhorse/minimax-h3-i2v',
  label: 'MiniMax H3 (image to video) · WORKHORSE',
  local: {
    nodeName: 'WORKHORSE',
    recipe: 'minimax-h3-i2v',
    ready: false,
    missing: 'Needs 4 model files (~40 GB), starting with minimax_h3_fl2va_pruned_int8_convrot.safetensors in models/diffusion_models.',
  },
};

describe('a model on the user’s own hardware', () => {
  beforeEach(() => setModelCatalogue([SEEDANCE, LOCAL_H3, LOCAL_NOT_READY], SEEDANCE.id));

  it('costs zero, not "unknown"', () => {
    // The catalogue sends credits: 0 and an empty pricePerSec, neither of which
    // passes the `> 0` guards — so without an explicit local branch this would
    // fall through to null and the card would print NOTHING where "no gen cost"
    // belongs. Silence reads as a missing price, not as a free one.
    expect(estimateShotCredits({ model: LOCAL_H3.id, durationSec: 8 })).toBe(0);
    expect(formatCredits(0)).toBe('no gen cost');
  });

  it('still clamps duration to what the workflow can render', () => {
    expect(plannedSeconds({ model: LOCAL_H3.id, durationSec: 30 })).toBe(15);
    expect(plannedSeconds({ model: LOCAL_H3.id, durationSec: 1 })).toBe(4);
  });

  it('says nothing extra while the machine can actually run it', () => {
    const warnings = checkShot({
      model: LOCAL_H3.id, durationSec: 8, voiceover: 'hello', media: [],
    });
    expect(warnings.map(w => w.message).join(' ')).not.toMatch(/not ready/i);
  });

  it('names the machine and the first missing thing when it cannot run yet', () => {
    const warnings = checkShot({
      model: LOCAL_NOT_READY.id, durationSec: 8, voiceover: '', media: [],
    });
    expect(warnings.length).toBeGreaterThan(0);
    // The MACHINE is named: with two nodes online, "not ready" without a name is
    // a message the user cannot act on.
    expect(warnings[0].message).toContain('WORKHORSE');
    expect(warnings[0].message).toContain('minimax_h3_fl2va_pruned_int8_convrot.safetensors');
  });

  it('does not warn about TTS for a model that speaks natively', () => {
    // H3 generates its own dialogue, so a voiceover line is NOT laid over the
    // clip afterwards. Getting this wrong would tell the user to expect a
    // separate TTS pass that never happens.
    const warnings = checkShot({
      model: LOCAL_H3.id, durationSec: 8, voiceover: 'she turns and speaks', media: [],
    });
    expect(warnings.map(w => w.message).join(' ')).not.toMatch(/does not speak/i);
  });

  it('accepts a last frame, because the fl2va checkpoint takes one', () => {
    const warnings = checkShot({
      model: LOCAL_H3.id,
      durationSec: 8,
      voiceover: '',
      media: [{ id: 'm1', role: 'lastFrame', kind: 'image' }],
    });
    expect(warnings.map(w => w.message).join(' ')).not.toMatch(/end-frame/i);
  });
});
