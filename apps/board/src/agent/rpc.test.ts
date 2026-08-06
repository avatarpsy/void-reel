/**
 * The agent's wire, end to end.
 *
 * This layer had no tests and produced two live failures in one afternoon: a
 * digest that could not be structured-cloned (so `board_read` returned an error
 * for the WHOLE board the moment any shot had a composition variable), and an
 * attach that silently dropped the usage note it advertised accepting. Both are
 * invisible from the shot helpers below and from the page above — they only
 * exist at this boundary, which is exactly why it needs its own tests.
 *
 * Handlers are driven the way the parent page drives them: a `postMessage` in,
 * one reply out carrying the same `requestId`.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTestBoard, placeTestImage, type TestBoard } from '../blocksuite/test-board';
import { writeBlockMeta } from '../board/board-meta';
import { encodeMediaRef } from '../board/media-ref';
import { setBlockCatalogue } from '../shot/blocks';
import { setModelCatalogue, type ModelCaps } from '../shot/models';
import { installScreenplayFocus, type ScreenplayFocus } from '../ui/screenplay-focus';
import { installBoardRpc } from './rpc';

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

const BLOCKS = [
  { name: 'stat-card', tier: 'starter', fill: 'slots', slots: { stat: { kind: 'text' }, caption: { kind: 'text' } } },
  { name: 'my-lower-third', tier: 'user', fill: 'slots' },
  {
    name: 'browser-mockup', tier: 'starter', fill: 'slots',
    slots: {
      screenshot: { kind: 'image', sel: '.win img' },
      headline: { kind: 'text', sel: '.headline' },
    },
  },
];

let board: TestBoard;
let dispose: () => void;
/** The real focus overlay, so the screenplay handlers are exercised end to end
 *  rather than against a stub that cannot disagree with them. */
let focus: ScreenplayFocus | null = null;
let focusHost: HTMLElement | null = null;

/**
 * One RPC round trip, exactly as the page performs it.
 *
 * In the browser the request and the reply cross an iframe boundary. Here there
 * is one window, so this listener ALSO sees the request it just sent — same
 * requestId, no `ok`. Matching on the requestId alone resolved with the request
 * itself and every assertion read `undefined`. The reply always carries a
 * different `type` (`…-result`, or `voidspace:error`), which is the honest
 * discriminator.
 */
function call(type: string, args: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = `t${Math.random()}`;
    const timer = setTimeout(() => reject(new Error(`${type} never replied`)), 2000);
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { requestId?: string; type?: string };
      if (d?.requestId !== requestId || d.type === type) return;
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      resolve(e.data);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ type, requestId, ...args }, '*');
  });
}

beforeEach(() => {
  dispose?.();
  focus?.destroy();
  focusHost?.remove();
  board = makeTestBoard();
  setModelCatalogue([SEEDANCE], SEEDANCE.id);
  setBlockCatalogue(BLOCKS);
  dispose = installBoardRpc({
    workspace: board.workspace,
    store: board.store,
    std: board.std,
    doc: board.doc,
    host: board.std.host as unknown as HTMLElement,
    surfaceId: board.surfaceId,
    pageId: board.pageId,
    destroy: () => {},
  }, { screenplay: () => focus });

  focusHost = document.createElement('div');
  document.body.append(focusHost);
  focus = installScreenplayFocus({
    workspace: board.workspace,
    store: board.store,
    std: board.std,
    doc: board.doc,
    host: board.std.host as unknown as HTMLElement,
    surfaceId: board.surfaceId,
    pageId: board.pageId,
    destroy: () => {},
  }, focusHost);
});

describe('board_read', () => {
  it('returns a digest that survives postMessage — including composition variables', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A', 'B'] });
    expect(add.ok).toBe(true);

    await call('voidspace:board-set-composition', {
      shotId: add.shots[1].id,
      composition: 'stat-card',
      variables: { stat: '92%', caption: 'quit by week two' },
    });

    const read = await call('voidspace:board-read');
    expect(read.ok).toBe(true);
    // The reply ARRIVED, which is the assertion — a proxy in the payload makes
    // postMessage throw at the sender and nothing comes back at all.
    expect(read.shots[1].compositionVars).toEqual({ stat: '92%', caption: 'quit by week two' });
    expect(() => structuredClone(read)).not.toThrow();
  });

  it('reports the shot kind, so the agent stops offering a model for a title card', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    await call('voidspace:board-set-composition', { shotId: add.shots[0].id, composition: 'stat-card' });

    const read = await call('voidspace:board-read');
    expect(read.shots[0].kind).toBe('hyperframes');
    // A graphic has no model, so it must not inherit the board default.
    expect(read.shots[0].modelLabel).toBe('');
    expect(read.shots[0].estimatedCredits).toBe(0);
  });

  it('estimates the cost of a clip from its model and planned length', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    await call('voidspace:board-set-shot-model', {
      shotId: add.shots[0].id, model: SEEDANCE.id, durationSec: 8,
    });
    const read = await call('voidspace:board-read');
    expect(read.shots[0].estimatedCredits).toBeCloseTo(19.2, 5);
  });
});

describe('board_attach_media', () => {
  /**
   * THE BUG THIS PINS. The tool schema advertises `tag`, `refKind` and `note`
   * on attach precisely so the agent does not need a second round trip for
   * "find a kitchen shot, call it sarah-kitchen, use it under the intro". The
   * handler accepted them and wrote only the tag, so the direction the user
   * gave out loud reached neither the scene doc nor the screenplay — and the
   * call still returned success.
   */
  it('stores the tag, the kind and the usage note given on the same call', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const res = await call('voidspace:board-attach-media', {
      shotId: add.shots[0].id,
      url: 'https://ex.test/sting.wav',
      kind: 'audio',
      name: 'sting.wav',
      role: 'sfx',
      tag: 'intro-sting',
      note: 'right as she says hello everybody',
    });

    const m = res.shots[0].media[0];
    expect(m.tag).toBe('intro-sting');
    expect(m.note).toBe('right as she says hello everybody');
    expect(m.role).toBe('sfx');
  });

  it('carries the note through to the compiled screenplay, not just the digest', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    await call('voidspace:board-attach-media', {
      shotId: add.shots[0].id,
      url: 'https://ex.test/sting.wav',
      kind: 'audio',
      name: 'sting.wav',
      role: 'sfx',
      note: 'right as she says hello everybody',
    });

    const out = await call('voidspace:board-compile-payload', { title: 'T', aspect: '9:16' });
    expect(out.screenplay).toContain('right as she says hello everybody');
    expect(out.shots[0].references[0].note).toBe('right as she says hello everybody');
  });
});

describe('board_set_composition', () => {
  it('naming a block implies the shot is a graphic', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const res = await call('voidspace:board-set-composition', {
      shotId: add.shots[0].id, composition: 'my-lower-third',
    });
    expect(res.shots[0].kind).toBe('hyperframes');
    expect(res.shots[0].composition).toBe('my-lower-third');
  });

  /**
   * A name the library does not have would render the built-in text card with
   * no warning — the user would see a plain caption where they asked for their
   * own block and have nothing to go on.
   */
  it('refuses a block name that is not in the library', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const res = await call('voidspace:board-set-composition', {
      shotId: add.shots[0].id, composition: 'not-a-real-block',
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_block');
  });

  /**
   * SLOT VALUES BELONG TO THEIR BLOCK. The shim passes every key through
   * whether the new block declared it or not, so a leftover `stat` renders as
   * a number where the quote goes — and the drag path already cleared them, so
   * the same shot behaved differently depending on who changed it.
   */
  it('clears the old block’s slot values when the block changes', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const id = add.shots[0].id;
    await call('voidspace:board-set-composition', {
      shotId: id, composition: 'stat-card', variables: { stat: '92%' },
    });
    const swapped = await call('voidspace:board-set-composition', {
      shotId: id, composition: 'my-lower-third',
    });
    expect(swapped.shots[0].compositionVars).toEqual({});
  });

  it('keeps values that arrive WITH the new block — they are its own', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const id = add.shots[0].id;
    await call('voidspace:board-set-composition', {
      shotId: id, composition: 'stat-card', variables: { stat: '92%' },
    });
    const swapped = await call('voidspace:board-set-composition', {
      shotId: id, composition: 'my-lower-third', variables: { name: 'Sarah' },
    });
    expect(swapped.shots[0].compositionVars).toEqual({ name: 'Sarah' });
  });

  it('leaves values alone when the block is unchanged', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const id = add.shots[0].id;
    await call('voidspace:board-set-composition', {
      shotId: id, composition: 'stat-card', variables: { stat: '92%' },
    });
    const again = await call('voidspace:board-set-composition', {
      shotId: id, composition: 'stat-card',
    });
    expect(again.shots[0].compositionVars).toEqual({ stat: '92%' });
  });

  it('turns a graphic back into a clip without touching its references', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const id = add.shots[0].id;
    await call('voidspace:board-attach-media', {
      shotId: id, url: 'https://ex.test/a.jpg', kind: 'image', name: 'a.jpg', role: 'reference',
    });
    await call('voidspace:board-set-composition', { shotId: id, composition: 'stat-card' });
    const back = await call('voidspace:board-set-composition', { shotId: id, kind: 'clip' });

    expect(back.shots[0].kind).toBe('clip');
    expect(back.shots[0].media).toHaveLength(1);
  });
});

describe('board_block_catalog', () => {
  it('filters by what a block does, not only by its name', async () => {
    setBlockCatalogue([
      ...BLOCKS,
      { name: 'lt-clean-bar', tier: 'starter', tags: ['lower-third', 'overlay'] },
    ]);
    // 'lt-clean-bar' matches only on its TAG; the user's own block matches on
    // its name — and comes first, because a user block outranks a starter.
    const res = await call('voidspace:board-block-catalog', { q: 'lower-third' });
    expect(res.blocks.map((b: any) => b.name)).toEqual(['my-lower-third', 'lt-clean-bar']);
    expect(res.total).toBe(4);
    expect(res.matched).toBe(2);

    // And a term that only ever appears in a tag still finds it.
    const byTag = await call('voidspace:board-block-catalog', { q: 'overlay' });
    expect(byTag.blocks.map((b: any) => b.name)).toEqual(['lt-clean-bar']);
  });

  /**
   * A stock install ships 128 starter blocks. Truncating silently would read as
   * "that is the whole library" and the agent would stop looking.
   */
  it('says so when it truncates, rather than passing a slice off as the library', async () => {
    setBlockCatalogue(
      Array.from({ length: 80 }, (_, i) => ({ name: `b${String(i).padStart(3, '0')}`, tier: 'starter' })),
    );
    const res = await call('voidspace:board-block-catalog');
    expect(res.blocks).toHaveLength(60);
    expect(res.truncated).toBe(true);
    expect(res.matched).toBe(80);
    expect(res.note).toContain('Showing 60 of 80');
  });
});

describe('the user outranks the agent', () => {
  it('refuses a write computed from a stale read', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const staleRev = add.rev;
    // The user edits in the gap.
    await call('voidspace:board-update-shot', { shotId: add.shots[0].id, action: 'their edit' });

    const res = await call('voidspace:board-update-shot', {
      shotId: add.shots[0].id, action: 'the agent’s guess', expectRev: staleRev,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('board_changed');

    const read = await call('voidspace:board-read');
    expect(read.shots[0].action).toBe('their edit');
  });
});

/**
 * THE BLOCK IS THE CONTRACT.
 *
 * The preview shim passes every key through whether the block declared it or
 * not, so a typo renders the placeholder and looks exactly like the value never
 * arriving. The agent has to be told, in the same turn, what it got wrong AND
 * what the block actually takes.
 */
describe('slot validation', () => {
  it('drops a key the block never declared, and names the ones it does', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const res = await call('voidspace:board-set-composition', {
      shotId: add.shots[0].id,
      composition: 'browser-mockup',
      variables: { headline: 'Ship it.', headine: 'typo', stat: '92%' },
    });

    expect(res.ok).toBe(true);
    expect(res.ignoredKeys).toEqual(['headine', 'stat']);
    expect(res.accepted).toEqual(['headline']);
    // The message has to carry the real vocabulary or the agent guesses again.
    expect(res.note).toContain('screenshot (image)');
    expect(res.note).toContain('headline (text)');
    // And the good key still landed — a half-working call beats a refusal.
    expect(res.shots[0].compositionVars).toEqual({ headline: 'Ship it.' });
  });

  it('says nothing when every key is legal', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const res = await call('voidspace:board-set-composition', {
      shotId: add.shots[0].id, composition: 'stat-card', variables: { stat: '92%' },
    });
    expect(res.ignoredKeys).toBeUndefined();
    expect(res.shots[0].compositionVars).toEqual({ stat: '92%' });
  });

  /** The 26 baked-in designs declare nothing and must still accept values. */
  it('accepts anything for a block that declares no slots', async () => {
    const add = await call('voidspace:board-add-shots', { titles: ['A'] });
    const res = await call('voidspace:board-set-composition', {
      shotId: add.shots[0].id, composition: 'my-lower-third', variables: { anything: 'goes' },
    });
    expect(res.ignoredKeys).toBeUndefined();
    expect(res.shots[0].compositionVars).toEqual({ anything: 'goes' });
  });
});

/**
 * THE OPEN CANVAS over the wire.
 *
 * The drawing logic itself is pinned in `board/canvas.test.ts`. What only exists
 * at this boundary is the contract the agent sees: the rev guard, the batch cap,
 * and the fact that a partly-applied batch still reports success plus the
 * problems — so an agent that draws nine boxes and one bad arrow keeps the boxes
 * and knows why the arrow is missing.
 */
describe('the open canvas', () => {
  it('reads an empty canvas, and names the colours the drawing tool takes', async () => {
    const r = await call('voidspace:board-canvas-read');
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([]);
    // The read teaches the write — a vocabulary the agent has to guess at is one
    // it will guess wrong.
    expect(r.colors).toContain('blue');
  });

  it('draws a diagram in one call and reports the refs back', async () => {
    const r = await call('voidspace:board-draw', {
      elements: [
        { ref: 'a', kind: 'shape', text: 'Problem', x: 0, y: 0 },
        { ref: 'b', kind: 'shape', text: 'Solution', x: 400, y: 0 },
        { kind: 'connector', from: { ref: 'a' }, to: { ref: 'b' } },
      ],
    });

    expect(r.ok).toBe(true);
    expect(r.created).toBe(3);
    expect(r.refs.a).toBe(r.ids[0]);
    expect(r.problems).toBeUndefined();

    const read = await call('voidspace:board-canvas-read');
    expect(read.count).toBe(3);
  });

  /** A reply that cannot be structured-cloned fails for the WHOLE call — the bug
   *  this file was written for. Every new handler has to be checked for it. */
  it('returns a canvas read that survives the iframe boundary', async () => {
    await call('voidspace:board-draw', {
      elements: [{ kind: 'note', text: 'thinking', x: 0, y: 0 }],
    });
    const r = await call('voidspace:board-canvas-read');
    expect(() => structuredClone(r)).not.toThrow();
  });

  it('keeps the good half of a batch and says what failed', async () => {
    const r = await call('voidspace:board-draw', {
      elements: [
        { kind: 'shape', text: 'kept', x: 0, y: 0 },
        { kind: 'connector', from: { id: 'ghost' }, to: { x: 10, y: 10 } },
      ],
    });

    expect(r.ok).toBe(true);
    expect(r.created).toBe(1);
    expect(r.problems).toHaveLength(1);
  });

  it('refuses an empty draw rather than reporting a no-op as success', async () => {
    const r = await call('voidspace:board-draw', { elements: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty');
  });

  /** A board that gains 500 things at once is one nobody can review. */
  it('caps a batch and says so', async () => {
    const r = await call('voidspace:board-draw', {
      elements: Array.from({ length: 201 }, (_, i) => ({ kind: 'note', text: `n${i}` })),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too_many');
  });

  it('edits and deletes through the wire', async () => {
    const drawn = await call('voidspace:board-draw', {
      elements: [{ kind: 'shape', text: 'x', x: 0, y: 0, w: 100, h: 100 }],
    });
    const id = drawn.ids[0];

    const moved = await call('voidspace:board-edit-canvas', {
      ops: [{ id, op: 'move', x: 250, y: 300 }],
    });
    expect(moved.changed).toBe(1);

    const read = await call('voidspace:board-canvas-read');
    expect(read.items[0].x).toBe(250);

    const gone = await call('voidspace:board-edit-canvas', { ops: [{ id, op: 'delete' }] });
    expect(gone.changed).toBe(1);
  });

  /**
   * DRAWING IS ADDITIVE, SO THE REVISION DOES NOT GUARD IT — and this test
   * asserted the opposite until a live board proved it wrong.
   *
   * `expectRev` exists to stop the agent overwriting a value the user changed
   * while it was thinking. A new note overwrites nothing, so there is nothing to
   * lose. Meanwhile `rev` counts EVERY document update rather than the user's
   * edits — a freshly opened, empty canvas already reported `rev: 444` — so
   * guarding a draw with it refused work on a board nobody had touched, twice in
   * one turn, at a full LLM round trip each.
   *
   * The guard still applies where it means something: see the `edit` and `shot`
   * cases below.
   */
  it('draws even from a stale read — nothing can be lost by adding', async () => {
    const before = (await call('voidspace:board-read')).rev;
    await call('voidspace:board-draw', { elements: [{ kind: 'note', text: 'a' }] });

    const r = await call('voidspace:board-draw', {
      elements: [{ kind: 'note', text: 'b' }],
      expectRev: before,
    });
    expect(r.ok).toBe(true);
  });

  /**
   * A SHOT IS NOT CANVAS FURNITURE. The filmstrip order IS the compile order, so
   * a generic move would silently renumber the film.
   */
  it('reports shots as owned anchors and refuses to move one', async () => {
    await call('voidspace:board-add-shots', { titles: ['Cold open'] });
    const read = await call('voidspace:board-canvas-read');
    const shot = read.items.find((i: { kind: string }) => i.kind === 'shot');
    expect(shot.owned).toBe(true);

    const r = await call('voidspace:board-edit-canvas', {
      ops: [{ id: shot.id, op: 'move', x: 9999, y: 9999 }],
    });
    expect(r.changed).toBe(0);
    expect(r.problems[0]).toContain('board_update_shot');
  });
});

/**
 * THE SELECTION CHANNEL, and the media urls behind it.
 *
 * "Make me one like these" is the sentence the canvas exists to make sayable,
 * and every word of it except the style is carried by the selection. The urls
 * are the part that must NOT reach the model — they are long, signed, and burn
 * context — so they come back on this call, which the page makes, and never on
 * a canvas read.
 */
describe('selection', () => {
  it('reports nothing selected without inventing an answer', async () => {
    const r = await call('voidspace:board-selection');
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual([]);
    expect(r.mediaUrls).toEqual([]);
  });

  it('resolves named ids to full-quality urls, in the order asked for', async () => {
    const a = placeTestImage(board, '[0,1200,320,180]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/a-small.png', kind: 'image', mime: 'image/png' }),
    });
    const b = placeTestImage(board, '[400,1200,320,180]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/b-small.png', kind: 'image', mime: 'image/png' }),
    });
    writeBlockMeta(board.doc, a, { kind: 'image', originalUrl: 'https://cdn.test/a-master.png' });
    writeBlockMeta(board.doc, b, { kind: 'image', originalUrl: 'https://cdn.test/b-master.png' });

    // Order follows the CALLER: a model takes references positionally, so
    // "use the first one for the style" only means anything if it survives.
    const r = await call('voidspace:board-selection', { ids: [b, a] });
    expect(r.mediaUrls).toEqual([
      'https://cdn.test/b-master.png',
      'https://cdn.test/a-master.png',
    ]);
  });

  /** The master, never the proxy — an image model handed a 320px thumbnail
   *  returns 320px worth of detail and the user blames the model. */
  it('hands over the master, not the variant the canvas draws', async () => {
    const id = placeTestImage(board, '[0,1200,320,180]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/proxy.png', kind: 'image', mime: 'image/png' }),
    });
    writeBlockMeta(board.doc, id, { kind: 'image', originalUrl: 'https://cdn.test/MASTER.png' });

    const r = await call('voidspace:board-selection', { ids: [id] });
    expect(r.mediaUrls).toEqual(['https://cdn.test/MASTER.png']);
  });

  it('skips ids that are not media rather than returning holes', async () => {
    const drawn = await call('voidspace:board-draw', {
      elements: [{ kind: 'note', text: 'not media', x: 0, y: 2000 }],
    });
    const r = await call('voidspace:board-selection', { ids: [drawn.ids[0]] });
    expect(r.mediaUrls).toEqual([]);
  });

  it('carries selected ids on a canvas read too', async () => {
    const r = await call('voidspace:board-canvas-read');
    expect(Array.isArray(r.selectedIds)).toBe(true);
  });
});

describe('progress', () => {
  /** Generation runs in the parent and takes a minute; the user is looking at
   *  the board. A silent canvas reads as nothing having happened. */
  it('opens and closes a pending message by id', async () => {
    const started = await call('voidspace:board-progress', { id: 'g1', message: 'Generating…' });
    expect(started.ok).toBe(true);
    const done = await call('voidspace:board-progress', { id: 'g1', done: true });
    expect(done.ok).toBe(true);
  });

  it('refuses one with no id rather than leaking a toast nothing can close', async () => {
    const r = await call('voidspace:board-progress', { message: 'x' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty');
  });
});

/**
 * ATTACHING WHAT IS ALREADY ON THE BOARD.
 *
 * The hole this closes: the USER could drag a picture off the canvas onto a shot
 * and the AGENT could not do the same thing, because attaching took a url and a
 * canvas read deliberately withholds urls. So "put that one on scene 2" — about
 * a picture the agent had just generated and could see — was unanswerable.
 */
describe('attaching canvas media to a shot', () => {
  async function boardWithShotAndImage() {
    const shots = await call('voidspace:board-add-shots', { titles: ['Cold open'] });
    const canvasId = placeTestImage(board, '[0,1400,320,180]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/small.png', kind: 'image', mime: 'image/png' }),
    });
    writeBlockMeta(board.doc, canvasId, {
      kind: 'image', originalUrl: 'https://cdn.test/master.png', name: 'the kitchen', mediaId: 'lib-9',
    });
    return { shotId: shots.shots[0].id, canvasId };
  }

  it('moves it into the shot, keeping the master url', async () => {
    const { shotId, canvasId } = await boardWithShotAndImage();
    const r = await call('voidspace:board-attach-media', { shotId, canvasId });

    expect(r.ok).toBe(true);
    expect(r.movedFromCanvas).toBe(canvasId);

    const shot = r.shots.find((s: { id: string }) => s.id === shotId);
    expect(shot.media).toHaveLength(1);
    expect(shot.media[0].name).toBe('the kitchen');
    // Library identity survives, or the compiled project cannot find the asset.
    expect(shot.media[0].mediaId).toBe('lib-9');

    // MOVED, like the drag: two of the same picture with no way to tell which
    // one the video uses is worse than one.
    const canvas = await call('voidspace:board-canvas-read');
    expect(canvas.items.some((i: { id: string }) => i.id === canvasId)).toBe(false);
  });

  it('can leave a copy behind when the same reference serves two scenes', async () => {
    const { shotId, canvasId } = await boardWithShotAndImage();
    await call('voidspace:board-attach-media', { shotId, canvasId, keepOnCanvas: true });

    const canvas = await call('voidspace:board-canvas-read');
    expect(canvas.items.some((i: { id: string }) => i.id === canvasId)).toBe(true);
  });

  it('honours a role the shot can legally hold', async () => {
    const { shotId, canvasId } = await boardWithShotAndImage();
    const r = await call('voidspace:board-attach-media', { shotId, canvasId, role: 'firstFrame' });
    expect(r.shots.find((s: { id: string }) => s.id === shotId).media[0].role).toBe('firstFrame');
  });

  it('names a canvas id that is not media instead of failing silently', async () => {
    const shots = await call('voidspace:board-add-shots', { titles: ['A'] });
    const drawn = await call('voidspace:board-draw', {
      elements: [{ kind: 'note', text: 'not media', x: 0, y: 3000 }],
    });
    const r = await call('voidspace:board-attach-media', {
      shotId: shots.shots[0].id, canvasId: drawn.ids[0],
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not media on the canvas');
  });

  it('refuses a call with neither a url nor a canvasId, and names both ways in', async () => {
    const shots = await call('voidspace:board-add-shots', { titles: ['A'] });
    const r = await call('voidspace:board-attach-media', { shotId: shots.shots[0].id });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('canvasId');
  });
});

/**
 * PROVENANCE — what made this picture.
 *
 * The difference between "that one, but warmer" being an EDIT and being a fresh
 * guess. It costs the user nothing, which is the point: no labelling, no
 * discipline. The board remembers instead.
 */
describe('provenance on canvas media', () => {
  it('reports the prompt and the references a generation used', async () => {
    const id = placeTestImage(board, '[0,1600,320,180]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/gen.png', kind: 'image', mime: 'image/png' }),
    });
    writeBlockMeta(board.doc, id, {
      kind: 'image',
      originalUrl: 'https://cdn.test/gen.png',
      prompt: 'a scandinavian kitchen at dusk, warm practicals',
      referenceIds: ['ref-a', 'ref-b'],
      model: 'nano-banana',
    });

    const item = (await call('voidspace:board-canvas-read'))
      .items.find((i: { id: string }) => i.id === id);
    expect(item.prompt).toContain('scandinavian kitchen');
    expect(item.referenceIds).toEqual(['ref-a', 'ref-b']);
  });

  /** A read of a 200-item board must not carry 200 full prompts. */
  it('truncates the prompt on a list read', async () => {
    const id = placeTestImage(board, '[0,1800,320,180]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/long.png', kind: 'image', mime: 'image/png' }),
    });
    writeBlockMeta(board.doc, id, { kind: 'image', prompt: 'x'.repeat(500) });

    const item = (await call('voidspace:board-canvas-read'))
      .items.find((i: { id: string }) => i.id === id);
    expect(item.prompt.length).toBeLessThanOrEqual(160);
  });

  it('says nothing about media that was simply dropped in', async () => {
    const id = placeTestImage(board, '[0,2000,320,180]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/plain.png', kind: 'image', mime: 'image/png' }),
    });
    writeBlockMeta(board.doc, id, { kind: 'image', originalUrl: 'https://cdn.test/plain.png' });

    const item = (await call('voidspace:board-canvas-read'))
      .items.find((i: { id: string }) => i.id === id);
    expect(item.prompt).toBeUndefined();
    expect(item.referenceIds).toBeUndefined();
  });
});

/**
 * THE SCREENPLAY AT PAGE SIZE, driven by the agent.
 *
 * The reason the chat stays on screen in focus mode is that "tighten scene four,
 * then send me the PDF" is one sentence and should be one exchange.
 */
describe('screenplay focus and export', () => {
  it('opens and closes the page view', async () => {
    const opened = await call('voidspace:board-screenplay', { action: 'open' });
    expect(opened.ok).toBe(true);
    expect(opened.open).toBe(true);

    const closed = await call('voidspace:board-screenplay', { action: 'close' });
    expect(closed.ok).toBe(true);
    expect(closed.open).toBe(false);
  });

  it('defaults to opening', async () => {
    const r = await call('voidspace:board-screenplay', {});
    expect(r.open).toBe(true);
  });

  /**
   * THE AGENT MUST NOT CLAIM TO HAVE SAVED A FILE. Export hands the page to the
   * user's own print dialog — they choose "Save as PDF" and where it goes — so
   * the reply says that in words the agent will repeat.
   */
  it('says the print dialog is the user’s, not a file it wrote', async () => {
    await call('voidspace:board-write-script', { text: 'INT. ROOM — DAY\n\nShe waits.\n' });
    const r = await call('voidspace:board-screenplay', { action: 'pdf' });
    expect(r.ok).toBe(true);
    expect(r.note).toContain('print dialog');
    expect(r.note).not.toMatch(/\bsaved\b/i);
  });

  it('offers the .fountain source as the portable export', async () => {
    await call('voidspace:board-write-script', { text: 'INT. ROOM — DAY\n\nShe waits.\n' });
    const r = await call('voidspace:board-screenplay', { action: 'fountain' });
    expect(r.ok).toBe(true);
    expect(r.note).toContain('Final Draft');
  });
});

/**
 * ARGUMENTS AS THE MODEL ACTUALLY SENDS THEM.
 *
 * Smaller models routinely emit a nested array as a JSON string. Observed live:
 * two of four `board_draw` attempts in one turn arrived as
 * `"elements": "[{\"kind\":\"text\",…}]"`, were refused as empty, and the agent
 * retried the identical call — a full LLM round trip each, while the user
 * watched a spinner.
 */
describe('tolerant list arguments', () => {
  it('accepts elements sent as a JSON string', async () => {
    const r = await call('voidspace:board-draw', {
      elements: JSON.stringify([{ kind: 'note', text: 'stringified', x: 0, y: 0 }]),
    });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(1);
  });

  it('accepts edit ops sent as a JSON string', async () => {
    const drawn = await call('voidspace:board-draw', {
      elements: [{ kind: 'shape', text: 'x', x: 0, y: 0, w: 100, h: 100 }],
    });
    const r = await call('voidspace:board-edit-canvas', {
      ops: JSON.stringify([{ id: drawn.ids[0], op: 'move', x: 40, y: 60 }]),
    });
    expect(r.changed).toBe(1);
  });

  it('still refuses a genuinely empty list, and says so', async () => {
    const r = await call('voidspace:board-draw', { elements: '[]' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty');
  });

  it('does not mistake a non-array string for a list', async () => {
    const r = await call('voidspace:board-draw', { elements: 'a note please' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty');
  });
});

/**
 * ADDITIVE WRITES ARE NOT GUARDED BY THE REVISION.
 *
 * `rev` counts every `blockUpdated`, not the user's edits — a freshly opened
 * empty board already reported `rev: 444`. Guarding an ADDITIVE draw with it
 * produced `board_changed` on a board nobody had touched, twice in one turn,
 * and the agent dutifully re-read and retried each time.
 */
describe('the revision guard applies where it means something', () => {
  it('draws even when the rev has moved on — nothing can be lost by adding', async () => {
    const before = (await call('voidspace:board-read')).rev;
    await call('voidspace:board-draw', { elements: [{ kind: 'note', text: 'a', x: 0, y: 0 }] });

    const r = await call('voidspace:board-draw', {
      elements: [{ kind: 'note', text: 'b', x: 600, y: 0 }],
      expectRev: before,          // deliberately stale
    });
    expect(r.ok).toBe(true);
  });

  it('still refuses a stale EDIT, which really can overwrite the user', async () => {
    const drawn = await call('voidspace:board-draw', {
      elements: [{ kind: 'shape', text: 'x', x: 0, y: 0, w: 100, h: 100 }],
    });
    const stale = (await call('voidspace:board-read')).rev - 1;
    const r = await call('voidspace:board-edit-canvas', {
      ops: [{ id: drawn.ids[0], op: 'delete' }],
      expectRev: stale,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('board_changed');
  });

  /** And a stale SHOT write is still refused — the case the guard was built for. */
  it('still refuses a stale shot update', async () => {
    const shots = await call('voidspace:board-add-shots', { titles: ['A'] });
    const r = await call('voidspace:board-update-shot', {
      shotId: shots.shots[0].id, title: 'B', expectRev: shots.rev - 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('board_changed');
  });
});
