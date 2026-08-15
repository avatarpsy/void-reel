/**
 * Takes: what a shot has produced, and which one IS the shot.
 *
 * The rules here are the ones that decide whether a user can trust the Generate
 * button. Each test names the failure it prevents.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { chosenTake, readyTakes, type ShotTake } from './model';
import {
  addTake, chooseTake, createShots, readShot, removeTake, updateTake,
} from './shots';

function take(over: Partial<ShotTake> = {}): Omit<ShotTake, 'id'> {
  return {
    src: 'https://example.test/poster.jpg',
    url: 'https://example.test/master.mp4',
    kind: 'video',
    durationSec: 5,
    status: 'ready',
    createdAt: '2026-08-15T10:00:00.000Z',
    source: 'generated',
    ...over,
  };
}

function newShot() {
  const board = makeTestBoard();
  const [id] = createShots(board.std, board.surfaceId, ['Wide']);
  return { board, id };
}

describe('takes', () => {
  it('appends rather than replaces, so trying again is free', () => {
    // THE product invariant. If generating ever overwrote, an agent — or an
    // impatient second click — could destroy footage the user paid for.
    const { board, id } = newShot();

    const a = addTake(board.std, id, take({ label: 'first' }));
    const b = addTake(board.std, id, take({ label: 'second' }));

    const takes = readShot(board.std, id)!.takes;
    expect(takes.map(t => t.label)).toEqual(['first', 'second']);
    expect(a).not.toBe(b);
  });

  it('creates the takes list on a shot that predates the field — THE MIGRATION', () => {
    // Boards made before `takes` existed have no such key in their Yjs
    // document; a schema default only applies to blocks created afterwards. A
    // helper that bailed on a missing list would make Generate do NOTHING, with
    // no error, on every board a real user already has work in.
    const { board, id } = newShot();
    const block = board.std.store.getBlock(id)!;

    // Reproduce the old document shape by removing the key outright.
    board.std.store.updateBlock(block.model, () => {
      delete (block.model.props as Record<string, unknown>).takes;
    });
    expect((block.model.props as { takes?: unknown }).takes).toBeUndefined();

    expect(addTake(board.std, id, take())).toBeTruthy();
    expect(readShot(board.std, id)!.takes).toHaveLength(1);
  });

  it('reads as an empty list — never undefined — on a shot that predates the field', () => {
    const { board, id } = newShot();
    const block = board.std.store.getBlock(id)!;
    board.std.store.updateBlock(block.model, () => {
      delete (block.model.props as Record<string, unknown>).takes;
    });

    // Every consumer reads through the view, so this is where the `?? []` has
    // to hold. `.length` on undefined is the crash this prevents.
    expect(readShot(board.std, id)!.takes).toEqual([]);
    expect(readShot(board.std, id)!.chosenTakeId).toBe('');
  });

  it('hands out PLAIN objects, because a Yjs proxy kills the whole postMessage', () => {
    // structuredClone refuses a reactive proxy, and it does not fail politely
    // on the offending field — it drops the entire message. That is how one
    // stat card's variables once made board_read error for a whole board.
    const { board, id } = newShot();
    addTake(board.std, id, take());

    const takes = readShot(board.std, id)!.takes;
    expect(() => structuredClone(takes)).not.toThrow();
  });

  it('updates a take in flight without disturbing its siblings', () => {
    const { board, id } = newShot();
    const running = addTake(board.std, id, take({ status: 'running', url: '', jobId: 'job-1' }))!;
    const other = addTake(board.std, id, take({ label: 'done' }))!;

    updateTake(board.std, id, running, {
      status: 'ready', url: 'https://example.test/out.mp4', durationSec: 6.2,
    });

    const takes = readShot(board.std, id)!.takes;
    expect(takes.find(t => t.id === running)).toMatchObject({
      status: 'ready', url: 'https://example.test/out.mp4', durationSec: 6.2,
      jobId: 'job-1',   // untouched fields survive a partial patch
    });
    expect(takes.find(t => t.id === other)!.label).toBe('done');
  });

  it('refuses to choose a take that is still running', () => {
    // Choosing one would put a url that does not exist yet onto the timeline.
    const { board, id } = newShot();
    const running = addTake(board.std, id, take({ status: 'running', url: '' }))!;

    expect(chooseTake(board.std, id, running)).toBe(false);
    expect(readShot(board.std, id)!.chosenTakeId).toBe('');
  });

  it('falls back to the NEWEST ready take when nothing is chosen', () => {
    // A shot generated once and never explicitly ticked still has an answer.
    // Asking someone to confirm the only candidate is ceremony.
    const takes: ShotTake[] = [
      { ...take({ createdAt: '2026-08-15T10:00:00.000Z' }), id: 'a' },
      { ...take({ createdAt: '2026-08-15T12:00:00.000Z' }), id: 'b' },
    ];
    expect(chosenTake(takes, '')?.id).toBe('b');
    expect(chosenTake(takes, 'a')?.id).toBe('a');
  });

  it('ignores running and failed takes when deciding what the shot is', () => {
    const takes: ShotTake[] = [
      { ...take(), id: 'ok' },
      { ...take({ status: 'running', url: '', createdAt: '2026-08-15T23:00:00.000Z' }), id: 'busy' },
      { ...take({ status: 'failed', error: 'boom', createdAt: '2026-08-15T23:30:00.000Z' }), id: 'bad' },
    ];
    // Newest overall is `bad`, but only a READY take can be the shot.
    expect(readyTakes(takes).map(t => t.id)).toEqual(['ok']);
    expect(chosenTake(takes, '')?.id).toBe('ok');
  });

  it('treats a ready take with no url as not ready — it has nothing to play', () => {
    const takes: ShotTake[] = [{ ...take({ url: '', src: '' }), id: 'empty' }];
    expect(readyTakes(takes)).toEqual([]);
    expect(chosenTake(takes, 'empty')).toBeNull();
  });

  it('answers null for a shot that has never generated', () => {
    expect(chosenTake([], '')).toBeNull();
    expect(chosenTake(undefined, '')).toBeNull();
  });

  it('clears the pointer when the chosen take is discarded, rather than promoting a neighbour', () => {
    // Falling back to "the newest ready one" is a rule a user can predict.
    // Silently promoting whatever sat next to it is not.
    const { board, id } = newShot();
    const a = addTake(board.std, id, take({ createdAt: '2026-08-15T10:00:00.000Z' }))!;
    const b = addTake(board.std, id, take({ createdAt: '2026-08-15T11:00:00.000Z' }))!;
    chooseTake(board.std, id, a);
    expect(readShot(board.std, id)!.chosenTakeId).toBe(a);

    removeTake(board.std, id, a);

    const shot = readShot(board.std, id)!;
    expect(shot.chosenTakeId).toBe('');
    expect(shot.takes.map(t => t.id)).toEqual([b]);
    expect(chosenTake(shot.takes, shot.chosenTakeId)?.id).toBe(b);
  });

  it('leaves the pointer alone when a DIFFERENT take is discarded', () => {
    const { board, id } = newShot();
    const a = addTake(board.std, id, take())!;
    const b = addTake(board.std, id, take())!;
    chooseTake(board.std, id, a);

    removeTake(board.std, id, b);
    expect(readShot(board.std, id)!.chosenTakeId).toBe(a);
  });

  it('refuses unknown ids instead of writing something meaningless', () => {
    const { board, id } = newShot();
    expect(chooseTake(board.std, id, 'nope')).toBe(false);
    expect(removeTake(board.std, id, 'nope')).toBe(false);
    expect(updateTake(board.std, id, 'nope', { status: 'ready' })).toBe(false);
    expect(addTake(board.std, 'not-a-shot', take())).toBeNull();
  });
});
