/**
 * What compile hands the editor when a shot has a graphic laid over it.
 *
 * The rules here decide whether a lower third reaches the timeline attached to
 * the right shot at the right moment, or arrives over the wrong picture. Each
 * test names the failure it prevents.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTestBoard, type TestBoard } from '../blocksuite/test-board';
import { compileBoard } from './screenplay';
import { setModelCatalogue, type ModelCaps } from './models';
import { addGraphic, createShots, updateGraphic } from './shots';

const HEADER = { title: 'Test', aspect: '16:9', goal: 'A test' };

const MODEL: ModelCaps = {
  id: 'test/model',
  label: 'Test Model',
  minDurationSec: 4,
  maxDurationSec: 15,
  allowedDurations: [],
  credits: 10,
  nativeDialogue: false,
  nativeAudio: false,
  acceptsVoiceReference: false,
  supportsLastFrame: false,
  usesReferenceTags: false,
  referenceTagSyntax: 'image',
  deliveryModes: ['first-frame'],
  defaultDelivery: 'first-frame',
};

let board: TestBoard;

beforeEach(() => {
  board = makeTestBoard();
  setModelCatalogue([MODEL], MODEL.id);
});

/** A shot with one rendered layer on it. */
function shotWithLayer(over: Record<string, unknown> = {}) {
  const [shotId] = createShots(board.std, board.surfaceId, ['A']);
  const gid = addGraphic(board.std, shotId, { block: 'lt-clean-bar', ...over })!;
  updateGraphic(board.std, shotId, gid, {
    renderedUrl: 'https://example.test/lower-third.webm',
    renderedDurationSec: 3,
    renderHash: 'h1',
  });
  return { shotId, gid };
}

describe('compile: graphic layers', () => {
  it('carries a rendered layer through with its timing rules intact', () => {
    const { gid } = shotWithLayer({ offsetSec: 1.5, durationSec: 3, anchor: 'start' });

    const out = compileBoard(board.std, HEADER);

    expect(out.shots[0].graphics).toHaveLength(1);
    expect(out.shots[0].graphics![0]).toMatchObject({
      id: gid,
      block: 'lt-clean-bar',
      url: 'https://example.test/lower-third.webm',
      durationSec: 3,
      offsetSec: 1.5,
      holdSec: 3,
      anchor: 'start',
    });
  });

  it('does NOT resolve the layer to a timeline position', () => {
    // The shot's real length is whatever take the user finally picks. Resolving
    // this at compile time would bake in the length of whichever take happened
    // to be ticked, and put the graphic in the wrong place the moment somebody
    // swapped it. The loader does it, where the chosen take is known.
    shotWithLayer({ offsetSec: 2 });

    const g = compileBoard(board.std, HEADER).shots[0].graphics![0];

    expect(g).not.toHaveProperty('startTime');
    expect(g).not.toHaveProperty('startSec');
    expect(g.offsetSec).toBe(2);
  });

  it('leaves out a layer that has NOT been rendered', () => {
    // A clip with no url arrives on the timeline as a hole. The same rule takes
    // follow, and for the same reason.
    const [shotId] = createShots(board.std, board.surfaceId, ['A']);
    addGraphic(board.std, shotId, { block: 'lt-clean-bar' });

    expect(compileBoard(board.std, HEADER).shots[0].graphics).toBeUndefined();
  });

  it('leaves out a layer with a file but no block', () => {
    const [shotId] = createShots(board.std, board.surfaceId, ['A']);
    const gid = addGraphic(board.std, shotId)!;
    updateGraphic(board.std, shotId, gid, { renderedUrl: 'https://example.test/x.webm' });

    expect(compileBoard(board.std, HEADER).shots[0].graphics).toBeUndefined();
  });

  it('omits the key entirely on a shot with no layers', () => {
    // Every shot made before layers existed. An empty array on every scene would
    // be noise in a payload that is already large.
    createShots(board.std, board.surfaceId, ['A']);
    expect(compileBoard(board.std, HEADER).shots[0]).not.toHaveProperty('graphics');
  });

  it('travels on a CLIP shot, which is the whole point', () => {
    // A layer is independent of what fills the frame. Gating it on the shot
    // being a graphic would drop every lower third anybody put on footage.
    shotWithLayer();

    const out = compileBoard(board.std, HEADER);

    expect(out.shots[0].kind).toBe('video');
    expect(out.shots[0].graphics).toHaveLength(1);
  });

  it('keeps the board\u2019s order, because the loader turns it into z-order', () => {
    const [shotId] = createShots(board.std, board.surfaceId, ['A']);
    for (const name of ['a-block', 'b-block', 'c-block']) {
      const gid = addGraphic(board.std, shotId, { block: name })!;
      updateGraphic(board.std, shotId, gid, {
        renderedUrl: `https://example.test/${name}.webm`,
        renderedDurationSec: 2,
      });
    }

    const g = compileBoard(board.std, HEADER).shots[0].graphics!;

    expect(g.map(x => x.block)).toEqual(['a-block', 'b-block', 'c-block']);
  });

  it('carries an END anchor, so a closer follows a longer take', () => {
    shotWithLayer({ anchor: 'end', durationSec: 2 });

    const g = compileBoard(board.std, HEADER).shots[0].graphics![0];

    expect(g.anchor).toBe('end');
    expect(g.holdSec).toBe(2);
  });

  it('holdSec 0 means "to the end of the shot" and is carried as 0', () => {
    // Not rewritten to the shot's planned length here: the planned length is not
    // the real one, and writing a number would lose the RULE.
    shotWithLayer({ durationSec: 0 });

    expect(compileBoard(board.std, HEADER).shots[0].graphics![0].holdSec).toBe(0);
  });
});

describe('compile: bake versus overlay', () => {
  it('carries the mode, because the container does not say it', () => {
    // "Is it a webm" is a fact about the file; "does it already contain the
    // footage" is a fact about the EDIT, and only the second one decides
    // whether it becomes a track or the picture.
    const [shotId] = createShots(board.std, board.surfaceId, ['A']);
    const gid = addGraphic(board.std, shotId, { block: 'browser-mockup', mode: 'bake' })!;
    updateGraphic(board.std, shotId, gid, {
      renderedUrl: 'https://example.test/baked.mp4',
      renderedDurationSec: 8,
    });

    const g = compileBoard(board.std, HEADER).shots[0].graphics![0];

    expect(g.mode).toBe('bake');
    expect(g.url).toBe('https://example.test/baked.mp4');
  });

  it('an overlay layer reports mode overlay', () => {
    shotWithLayer();
    expect(compileBoard(board.std, HEADER).shots[0].graphics![0].mode).toBe('overlay');
  });
});
