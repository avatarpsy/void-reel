/**
 * Compile is a ONE-WAY DOOR: it turns a board into a project and locks the board.
 *
 * So the thing worth testing is not the formatting — it is that nothing the user
 * made is lost or reordered on the way through. Every test here is a way the old
 * geometry-based compile silently dropped work.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { compileBoard } from './screenplay';
import { setModelCatalogue, type ModelCaps } from './models';
import { addMedia, createShots, setMediaRole, setShotFields, tagMedia, trimMedia } from './shots';
import type { ShotMedia } from './model';

/** Two real capability shapes — one that reads @-tags, one that does not. */
const SEEDANCE: ModelCaps = {
  id: 'bytedance/seedance-2', label: 'ByteDance Seedance 2',
  minDurationSec: 4, maxDurationSec: 15, allowedDurations: [4, 5, 8, 10, 12, 15],
  nativeDialogue: true, nativeAudio: true, acceptsVoiceReference: true,
  supportsLastFrame: true, usesReferenceTags: true, referenceTagSyntax: 'Image',
  deliveryModes: ['reference', 'first-frame'], defaultDelivery: 'reference',
};
const KLING: ModelCaps = {
  id: 'kling/v2-5-turbo-image-to-video-pro', label: 'Kling 2.5 Turbo Pro',
  minDurationSec: 5, maxDurationSec: 10, allowedDurations: [5, 10],
  nativeDialogue: false, nativeAudio: false, acceptsVoiceReference: false,
  supportsLastFrame: false, usesReferenceTags: false, referenceTagSyntax: 'image',
  deliveryModes: ['first-frame'], defaultDelivery: 'first-frame',
};

const HEADER = { title: 'Rain', aspect: '9:16', goal: 'Sell the mood' };

function media(over: Partial<ShotMedia> = {}): Omit<ShotMedia, 'id'> {
  return {
    kind: 'image',
    role: 'reference',
    src: 'https://example.test/thumb.png',
    url: 'https://example.test/master.png',
    name: 'still.png',
    ...over,
  };
}

describe('compileBoard', () => {
  it('emits exactly one beat per shot, in filmstrip order', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Kitchen', 'Street', 'Window']);

    const out = compileBoard(board.std, HEADER);
    expect(out.shots.map(s => s.title)).toEqual(['Kitchen', 'Street', 'Window']);
    expect(out.screenplay.match(/^SCENE \d+ — /gm)).toHaveLength(3);
    expect(out.screenplay).toContain('SCENE 2 — Street');
  });

  /** A shot named "SCENE 3 — Kitchen" by the user or the agent must not compile
   *  to "SCENE 1 — SCENE 3 — Kitchen". */
  it('does not double up a scene prefix the title already carries', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['SCENE 3 — Kitchen']);
    expect(compileBoard(board.std, HEADER).screenplay).toContain('SCENE 1 — Kitchen');
  });

  it('carries what the user wrote, and only what they wrote', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { action: 'She turns', camera: 'Slow push in' });

    const out = compileBoard(board.std, HEADER);
    expect(out.screenplay).toContain('ACTION: She turns');
    expect(out.screenplay).toContain('CAMERA: Slow push in');
    // An empty field must NOT become a line: the planner would read it as an
    // approved description of a scene nobody wrote.
    expect(out.screenplay).not.toContain('VO:');
    expect(out.shots[0].voiceover).toBeUndefined();
  });

  /**
   * THE INVARIANT THAT MATTERS MOST. Under the old model a reference nudged one
   * pixel outside its frame vanished from the compiled video with no warning.
   * A shot owns its media now, so there is no bounds test left to fail.
   */
  it('carries every reference on its shot, with full-quality urls', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    for (let i = 0; i < 40; i++) addMedia(board.std, id, media({ name: `ref-${i}.png` }));

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0].references).toHaveLength(40);
    // The MASTER, never the tile the canvas drew.
    expect(out.shots[0].references.every(r => r.url === 'https://example.test/master.png')).toBe(true);
  });

  it('orders references by role, slots before supporting material', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const song = addMedia(board.std, id, media({ kind: 'audio', name: 'score.mp3', role: 'bgm' }))!;
    addMedia(board.std, id, media({ name: 'mood.png' }));
    const first = addMedia(board.std, id, media({ name: 'open.png' }))!;
    setMediaRole(board.std, id, first, 'firstFrame');

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0].references.map(r => r.role)).toEqual(['firstFrame', 'reference', 'bgm']);
    expect(out.shots[0].references.at(-1)!.id).toBe(song);
    // And the screenplay says what each one is FOR, not just that it exists.
    expect(out.screenplay).toContain('FIRST FRAME: open.png');
    expect(out.screenplay).toContain('MUSIC: score.mp3');
  });

  it('puts the header above the beats', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Kitchen']);
    const out = compileBoard(board.std, HEADER);
    expect(out.screenplay.startsWith('Rain\nAspect: 9:16\nGoal: Sell the mood')).toBe(true);
  });
});

/**
 * The legend is what makes a numbered reference mean something. Without it a
 * motion prompt reads "@Image2 turns to the window" and nobody — not the user,
 * not the agent on its next turn — can say what @Image2 was.
 */
describe('compileBoard — reference tags', () => {
  beforeEach(() => setModelCatalogue([SEEDANCE, KLING], SEEDANCE.id));

  it('numbers references from the ORDER COMPILE EMITS, not storage order', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id });
    // Added mood-first, but a first frame outranks it in the compiled order —
    // so the FIRST FRAME must be @Image1, whatever order they went in.
    const mood = addMedia(board.std, id, media({ name: 'mood.png' }))!;
    const open = addMedia(board.std, id, media({ name: 'open.png' }))!;
    setMediaRole(board.std, id, open, 'firstFrame');

    const refs = compileBoard(board.std, HEADER).shots[0].references;
    expect(refs.map(r => [r.name, r.promptTag])).toEqual([
      ['open.png', '@Image1'],
      ['mood.png', '@Image2'],
    ]);
    expect(refs[0].id).toBe(open);
    expect(refs[1].id).toBe(mood);
  });

  it('writes a legend naming each reference', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id });
    const sarah = addMedia(board.std, id, media({ name: 'sarah-portrait.jpg' }))!;
    tagMedia(board.std, id, sarah, { tag: 'Sarah', refKind: 'character' });

    const out = compileBoard(board.std, HEADER);
    expect(out.screenplay).toContain('REFERENCES:');
    // The tag is normalised — a prompt token cannot carry a capital or a space.
    expect(out.screenplay).toContain('@Image1 — sarah, character: sarah-portrait.jpg');
    expect(out.shots[0].references[0].tag).toBe('sarah');
    expect(out.shots[0].references[0].refKind).toBe('character');
  });

  /**
   * A model that does not read @-tags gets no NUMBERS — but the user's own
   * words survive. Gating the legend on tag support (which is what this did at
   * first) silently dropped every name, note and trim window on Grok and Kling,
   * and those are the hardest things to notice missing: the reference is still
   * there and still listed.
   */
  it('writes no @-numbers for a tag-less model, but still says what things are', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: KLING.id });
    const m = addMedia(board.std, id, media({ name: 'mood.png' }))!;
    tagMedia(board.std, id, m, { tag: 'mood', refKind: 'style' });

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0].references[0].tag).toBe('mood');
    expect(out.shots[0].references[0].promptTag).toBeUndefined();
    expect(out.screenplay).toContain('REFERENCES:');
    expect(out.screenplay).toContain('mood, style: mood.png');
    // No numbering scheme the model does not use.
    expect(out.screenplay).not.toContain('@Image');
    expect(out.screenplay).not.toContain('@image');
  });

  it('carries a usage note and a trim window into the legend', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id });
    const clip = addMedia(board.std, id, media({
      kind: 'video', name: 'take-01.mp4', durationSec: 90,
    }))!;
    tagMedia(board.std, id, clip, { tag: 'the take', note: 'the bit where she turns to the window' });
    trimMedia(board.std, id, clip, { inSec: 12.5, outSec: 16.5 });

    const out = compileBoard(board.std, HEADER);
    const ref = out.shots[0].references[0];
    expect(ref.inSec).toBe(12.5);
    expect(ref.outSec).toBe(16.5);
    expect(ref.note).toBe('the bit where she turns to the window');
    expect(out.screenplay)
      .toContain('@Video1 — the-take: take-01.mp4 [0:12.5–0:16.5] — the bit where she turns to the window');
  });

  /** An untrimmed clip must not claim a window — a render step would apply a
   *  cut to something nobody cut. */
  it('emits no window for a clip that was never trimmed', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id });
    addMedia(board.std, id, media({ kind: 'video', name: 'take.mp4', durationSec: 30 }));

    const ref = compileBoard(board.std, HEADER).shots[0].references[0];
    expect(ref.inSec).toBeUndefined();
    expect(ref.outSec).toBeUndefined();
    expect(ref.durationSec).toBe(30);
  });

  it('carries the shot’s model and length into the screenplay', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id, durationSec: 8 });

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0].model).toBe(SEEDANCE.id);
    expect(out.shots[0].durationSec).toBe(8);
    expect(out.screenplay).toContain('LENGTH: 8s');
  });
});
