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

import { makeTestBoard, type TestBoard } from '../blocksuite/test-board';
import { setBlockCatalogue } from '../shot/blocks';
import { setModelCatalogue, type ModelCaps } from '../shot/models';
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
  });
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
