/**
 * What a shot must always be true of.
 *
 * These are the invariants the old frame-based model could not hold, which is
 * why it was replaced — so each test here names the failure it prevents rather
 * than restating the implementation.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { SHOT_GAP, SHOT_W, trimWindow, type ShotMedia } from './model';
import {
  addMedia, createShots, deleteShot, moveMedia, readShot, readShots,
  relayoutShots, removeMedia, setMediaRole, setShotFields, shotAtPoint, tagMedia, trimMedia,
} from './shots';

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

describe('shots', () => {
  it('lays new shots out left to right, and that order is the scene order', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['One', 'Two', 'Three']);

    const shots = readShots(board.std);
    expect(shots.map(s => s.title)).toEqual(['One', 'Two', 'Three']);
    expect(shots.map(s => s.x)).toEqual([0, SHOT_W + SHOT_GAP, (SHOT_W + SHOT_GAP) * 2]);
  });

  /**
   * The z-index trap that made shots unclickable, pinned.
   *
   * `generateIndex()` reads the layer manager's CURRENT state, and the manager
   * does not see a block until its transaction commits — so calling it once per
   * shot inside one transaction returned the SAME key every time and every shot
   * was tied in z-order.
   */
  it('gives every shot a distinct z-index, even when created in one batch', () => {
    const board = makeTestBoard();
    const ids = createShots(board.std, board.surfaceId, ['a', 'b', 'c', 'd']);
    const indexes = ids.map(id => (board.store.getBlock(id)!.model.props as { index: string }).index);
    expect(new Set(indexes).size).toBe(ids.length);
  });

  it('reorders by the given order, not by where the user dragged a panel', () => {
    const board = makeTestBoard();
    const [a, b, c] = createShots(board.std, board.surfaceId, ['A', 'B', 'C']);

    relayoutShots(board.std, [c, a, b]);
    expect(readShots(board.std).map(s => s.title)).toEqual(['C', 'A', 'B']);
  });

  it('closes the gap when a shot is deleted, so scene numbers stay contiguous', () => {
    const board = makeTestBoard();
    const [, b] = createShots(board.std, board.surfaceId, ['A', 'B', 'C']);

    expect(deleteShot(board.std, b)).toBe(true);
    expect(readShots(board.std).map(s => s.x)).toEqual([0, SHOT_W + SHOT_GAP]);
  });

  /** A shot OWNS its media — the whole point of the rewrite. Deleting it takes
   *  its references with it, so nothing is left stranded on the canvas. */
  it('carries its media as props, and deleting the shot takes them with it', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    addMedia(board.std, id, media());
    addMedia(board.std, id, media({ kind: 'video', name: 'clip.mp4' }));

    expect(readShot(board.std, id)!.media).toHaveLength(2);
    deleteShot(board.std, id);
    expect(readShots(board.std)).toHaveLength(0);
    // Nothing else was created on the surface to be left behind.
    expect(board.store.getBlock(board.surfaceId)!.model.children).toHaveLength(0);
  });

  it('removes one reference by id without touching its neighbours', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const first = addMedia(board.std, id, media({ name: 'one.png' }))!;
    addMedia(board.std, id, media({ name: 'two.png' }));

    expect(removeMedia(board.std, id, first)).toBe(true);
    expect(readShot(board.std, id)!.media.map(m => m.name)).toEqual(['two.png']);
    // A second removal is a no-op, not a crash and not a silent success.
    expect(removeMedia(board.std, id, first)).toBe(false);
  });

  /**
   * A shot with two first frames is a contradiction the pipeline would have to
   * guess about, and guessing produces the wrong video with no visible cause.
   */
  it('demotes the previous holder when a slot role is reassigned', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const a = addMedia(board.std, id, media({ name: 'a.png' }))!;
    const b = addMedia(board.std, id, media({ name: 'b.png' }))!;

    setMediaRole(board.std, id, a, 'firstFrame');
    setMediaRole(board.std, id, b, 'firstFrame');

    const roles = Object.fromEntries(readShot(board.std, id)!.media.map(m => [m.name, m.role]));
    expect(roles).toEqual({ 'a.png': 'reference', 'b.png': 'firstFrame' });
  });

  it('leaves plain references alone when another is added — they are not exclusive', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    addMedia(board.std, id, media({ name: 'a.png' }));
    const b = addMedia(board.std, id, media({ name: 'b.png' }))!;
    setMediaRole(board.std, id, b, 'reference');

    expect(readShot(board.std, id)!.media.every(m => m.role === 'reference')).toBe(true);
  });

  /** Order is what a model receives as `@ref1`, `@ref2`, so it has to be the
   *  user's to change. */
  it('moves a reference within its list and clamps at the ends', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const a = addMedia(board.std, id, media({ name: 'a.png' }))!;
    addMedia(board.std, id, media({ name: 'b.png' }));
    addMedia(board.std, id, media({ name: 'c.png' }));

    expect(moveMedia(board.std, id, a, 2)).toBe(true);
    expect(readShot(board.std, id)!.media.map(m => m.name)).toEqual(['b.png', 'c.png', 'a.png']);
    // Already last: nothing to do, and it says so rather than reporting success.
    expect(moveMedia(board.std, id, a, 5)).toBe(false);
  });

  /**
   * A tag is written into a generation prompt beside an `@Image2`, so it has to
   * survive being a prompt token: no spaces, no capitals, no punctuation.
   */
  it('normalises a reference name into something a prompt can carry', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const m = addMedia(board.std, id, media())!;

    tagMedia(board.std, id, m, { tag: '  My Co-Founder, Priya!  ', refKind: 'character' });
    const item = readShot(board.std, id)!.media[0];
    expect(item.tag).toBe('my-co-founder-priya');
    expect(item.refKind).toBe('character');
  });

  it('clears a name rather than storing an empty one', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const m = addMedia(board.std, id, media())!;

    tagMedia(board.std, id, m, { tag: 'sarah' });
    tagMedia(board.std, id, m, { tag: '   ' });
    // Either named or not — no third state for the compile step to reason about.
    expect(readShot(board.std, id)!.media[0].tag).toBeUndefined();
  });

  it('sets a name and a kind independently', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const m = addMedia(board.std, id, media())!;

    tagMedia(board.std, id, m, { refKind: 'location' });
    expect(readShot(board.std, id)!.media[0].refKind).toBe('location');
    expect(readShot(board.std, id)!.media[0].tag).toBeUndefined();

    tagMedia(board.std, id, m, { tag: 'kitchen' });
    expect(readShot(board.std, id)!.media[0].refKind).toBe('location');
    expect(readShot(board.std, id)!.media[0].tag).toBe('kitchen');
  });

  it('carries a per-shot model and length', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    // Unset by default: the agent is meant to ASK, and a silent default would
    // hide a shot nobody was ever asked about.
    expect(readShot(board.std, id)!.model).toBe('');
    expect(readShot(board.std, id)!.durationSec).toBe(0);

    setShotFields(board.std, id, { model: 'bytedance/seedance-2', durationSec: 8 });
    expect(readShot(board.std, id)!.model).toBe('bytedance/seedance-2');
    expect(readShot(board.std, id)!.durationSec).toBe(8);
  });

  it('writes the three fields the pipeline reads', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);

    setShotFields(board.std, id, {
      action: 'She turns to the window',
      voiceover: 'It had rained all week.',
      camera: 'Slow push in, 4s',
    });

    const shot = readShot(board.std, id)!;
    expect(shot.action).toBe('She turns to the window');
    expect(shot.voiceover).toBe('It had rained all week.');
    expect(shot.camera).toBe('Slow push in, 4s');
  });

  it('hit-tests a point against the panel that is actually under it', () => {
    const board = makeTestBoard();
    const [a, b] = createShots(board.std, board.surfaceId, ['A', 'B']);

    expect(shotAtPoint(board.std, [10, 10])).toBe(a);
    expect(shotAtPoint(board.std, [SHOT_W + SHOT_GAP + 10, 10])).toBe(b);
    // The gap between panels belongs to neither — a drop there is open canvas.
    expect(shotAtPoint(board.std, [SHOT_W + 10, 10])).toBeNull();
  });

  /** A missing shot is a normal outcome (the user deleted it while the agent was
   *  thinking), so every mutator reports it rather than throwing. */
  it('reports a missing shot instead of throwing', () => {
    const board = makeTestBoard();
    expect(readShot(board.std, 'nope')).toBeNull();
    expect(deleteShot(board.std, 'nope')).toBe(false);
    expect(setShotFields(board.std, 'nope', { action: 'x' })).toBe(false);
    expect(addMedia(board.std, 'nope', media())).toBeNull();
    expect(setMediaRole(board.std, 'nope', 'm1', 'firstFrame')).toBe(false);
  });

  /**
   * THE size question, and the reason `shots.ts` edits its list in place.
   *
   * A board must stay small however much footage is on it, because media are
   * references and never bytes — this is what gets read off disk on open and
   * pushed to Storage on every save.
   *
   * The bound is deliberately just above what the incremental path costs
   * (~220 KB). Replacing the whole `media` array on each append — the obvious
   * way to write these helpers, and how they were written first — rewrites every
   * element every time and lands at 2.2 MB. This test is the thing that catches
   * that coming back.
   */
  it('stays in the kilobytes with fifty shots and a thousand references', async () => {
    const Y = await import('yjs');
    const board = makeTestBoard();
    const ids = createShots(
      board.std,
      board.surfaceId,
      Array.from({ length: 50 }, (_, i) => `Scene ${i + 1}`),
    );
    ids.forEach(id => {
      for (let i = 0; i < 20; i++) addMedia(board.std, id, media({ name: `ref-${i}.png` }));
    });

    expect(readShots(board.std).reduce((n, s) => n + s.media.length, 0)).toBe(1000);
    expect(Y.encodeStateAsUpdate(board.doc).byteLength).toBeLessThan(400_000);
  });
});

/**
 * TRIM — which seconds of a clip are the reference.
 *
 * The clamping rules live in `trimMedia` so nothing downstream has to wonder,
 * and each of these is a state that would otherwise reach compile and become a
 * cut nobody can see until the video comes back wrong.
 */
describe('trimMedia', () => {
  const clip = (over: Partial<ShotMedia> = {}) =>
    media({ kind: 'video', name: 'take.mp4', durationSec: 60, ...over });

  function withClip() {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const m = addMedia(board.std, id, clip())!;
    return { board, id, m };
  }

  it('stores a window', () => {
    const { board, id, m } = withClip();
    expect(trimMedia(board.std, id, m, { inSec: 12.5, outSec: 16.5 })).toBe(true);
    const item = readShot(board.std, id)!.media[0];
    expect([item.inSec, item.outSec]).toEqual([12.5, 16.5]);
  });

  it('clamps an out-point past the end of the clip', () => {
    const { board, id, m } = withClip();
    trimMedia(board.std, id, m, { inSec: 50, outSec: 999 });
    const item = readShot(board.std, id)!.media[0];
    expect(item.outSec).toBe(60);
  });

  /** Dragging one handle past the other means "swap them", not "make a window
   *  that ends before it starts". */
  it('orders a reversed window instead of storing it backwards', () => {
    const { board, id, m } = withClip();
    trimMedia(board.std, id, m, { inSec: 40, outSec: 10 });
    const item = readShot(board.std, id)!.media[0];
    expect(item.inSec).toBe(10);
    expect(item.outSec).toBe(40);
  });

  /** A window covering the whole clip is NOT a trim. Storing it would make
   *  every untrimmed reference claim to be trimmed, and compile would emit a
   *  cut for something nobody cut. */
  it('treats a full-length window as no window at all', () => {
    const { board, id, m } = withClip();
    trimMedia(board.std, id, m, { inSec: 0, outSec: 60 });
    const item = readShot(board.std, id)!.media[0];
    expect(item.inSec).toBeUndefined();
    expect(item.outSec).toBeUndefined();
    expect(trimWindow(item).trimmed).toBe(false);
  });

  it('clears an end when given null, and keeps the other', () => {
    const { board, id, m } = withClip();
    trimMedia(board.std, id, m, { inSec: 10, outSec: 20 });
    trimMedia(board.std, id, m, { outSec: null });
    const item = readShot(board.std, id)!.media[0];
    expect(item.inSec).toBe(10);
    expect(item.outSec).toBeUndefined();
    // In-point only still counts as trimmed — it starts 10s in.
    expect(trimWindow(item).trimmed).toBe(true);
    expect(trimWindow(item).end).toBe(60);
  });

  it('records the duration whatever measured it', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const m = addMedia(board.std, id, media({ kind: 'video', name: 'x.mp4' }))!;
    expect(readShot(board.std, id)!.media[0].durationSec).toBeUndefined();
    trimMedia(board.std, id, m, { durationSec: 42.345 });
    // Rounded — a trim bar does not need microseconds and the document does not
    // need the noise.
    expect(readShot(board.std, id)!.media[0].durationSec).toBe(42.35);
  });

  it('reports a missing reference rather than throwing', () => {
    const { board, id } = withClip();
    expect(trimMedia(board.std, id, 'nope', { inSec: 1 })).toBe(false);
  });
});

describe('usage notes', () => {
  it('stores a direction verbatim and clears it when emptied', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const m = addMedia(board.std, id, media({ kind: 'audio', name: 'sting.wav' }))!;

    const said = 'use this for the intro opener when the avatar says "hello everybody"';
    tagMedia(board.std, id, m, { note: said });
    // VERBATIM. It is an instruction in the user's words, and normalising it
    // the way a tag is normalised would change what they asked for.
    expect(readShot(board.std, id)!.media[0].note).toBe(said);

    tagMedia(board.std, id, m, { note: '   ' });
    expect(readShot(board.std, id)!.media[0].note).toBeUndefined();
  });
});

describe('graphic shots', () => {
  it('treats a shot written before graphics existed as a clip', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    const s = readShot(board.std, id)!;
    expect(s.kind).toBe('clip');
    expect(s.composition).toBe('');
    expect(s.compositionVars).toEqual({});
  });

  /**
   * THE BUG THIS PINS. `compositionVars` is backed by Yjs, so the store hands
   * back a REACTIVE PROXY — and `postMessage` structured-clones its argument,
   * which refuses a proxy. So the instant one shot carried a composition
   * variable, every digest crossing the iframe boundary died with "could not be
   * cloned" and `board_read` failed for the WHOLE board. Measured live before
   * the fix; the symptom names no field, so it is worth a test that does.
   */
  it('hands back composition variables as plain, structured-cloneable data', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    setShotFields(board.std, id, {
      kind: 'hyperframes',
      composition: 'stat-card',
      compositionVars: { stat: '92%', caption: 'quit by week two' },
    });

    const s = readShot(board.std, id)!;
    expect(s.kind).toBe('hyperframes');
    expect(s.compositionVars).toEqual({ stat: '92%', caption: 'quit by week two' });
    // The real assertion: it survives the boundary the agent bridge uses.
    expect(() => structuredClone(s.compositionVars)).not.toThrow();
    expect(structuredClone(s.compositionVars)).toEqual(s.compositionVars);
  });

  /** A copy, not a live view — mutating the read must not touch the document. */
  it('does not let a caller write into the document through the read', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    setShotFields(board.std, id, { compositionVars: { stat: '92%' } });

    const s = readShot(board.std, id)!;
    s.compositionVars.stat = 'tampered';
    expect(readShot(board.std, id)!.compositionVars.stat).toBe('92%');
  });

  /** The references are the user's work — switching kind must not rewrite them. */
  it('keeps the shot’s media and model when it becomes a graphic', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['A']);
    addMedia(board.std, id, media({ role: 'firstFrame' }));
    setShotFields(board.std, id, { model: 'kling/v2-5-turbo-image-to-video-pro' });

    setShotFields(board.std, id, { kind: 'hyperframes', composition: 'stat-card' });
    const s = readShot(board.std, id)!;
    expect(s.media).toHaveLength(1);
    expect(s.media[0].role).toBe('firstFrame');
    expect(s.model).toBe('kling/v2-5-turbo-image-to-video-pro');
  });
});
