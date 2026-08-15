/**
 * What compile hands the editor when a shot has been generated.
 *
 * The rules here decide whether four generations become four things you can cut
 * between, or three of them quietly disappear. Each test names the failure it
 * prevents.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { compileBoard } from './screenplay';
import { setModelCatalogue, type ModelCaps } from './models';
import { addTake, chooseTake, createShots, setShotFields } from './shots';
import type { ShotTake } from './model';

const HEADER = { title: 'Test', aspect: '9:16', goal: 'A test' };

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

function take(over: Partial<ShotTake> = {}): Omit<ShotTake, 'id'> {
  return {
    src: 'https://example.test/p.jpg',
    url: 'https://example.test/a.mp4',
    kind: 'video',
    durationSec: 5,
    status: 'ready',
    createdAt: '2026-08-15T10:00:00.000Z',
    source: 'generated',
    ...over,
  };
}

function board() {
  const b = makeTestBoard();
  const [id] = createShots(b.std, b.surfaceId, ['Wide']);
  setShotFields(b.std, id, { action: 'She turns to the window' });
  return { b, id };
}

describe('compile · takes', () => {
  beforeEach(() => setModelCatalogue([MODEL], MODEL.id));

  it('omits takes entirely on a shot nobody has generated', () => {
    // Their ABSENCE is the signal that the pipeline should generate this scene
    // rather than assemble it. An empty array would read as "generated nothing".
    const { b } = board();
    expect(compileBoard(b.std, HEADER).shots[0]!.takes).toBeUndefined();
  });

  it('sends EVERY ready take, not just the one that plays', () => {
    // The whole point of generating four times is cutting between them. Sending
    // only the chosen one throws away three generations the user paid for.
    const { b, id } = board();
    addTake(b.std, id, take({ url: 'https://example.test/1.mp4' }));
    addTake(b.std, id, take({ url: 'https://example.test/2.mp4' }));
    addTake(b.std, id, take({ url: 'https://example.test/3.mp4' }));

    const takes = compileBoard(b.std, HEADER).shots[0]!.takes!;
    expect(takes).toHaveLength(3);
    expect(takes.map(t => t.url)).toEqual(expect.arrayContaining([
      'https://example.test/1.mp4',
      'https://example.test/2.mp4',
      'https://example.test/3.mp4',
    ]));
  });

  it('puts the PLAYING take first and marks exactly one primary', () => {
    // A consumer that only understands one clip per scene must still get the
    // right one, so order carries the answer as well as the flag.
    const { b, id } = board();
    addTake(b.std, id, take({ url: 'https://example.test/1.mp4' }));
    const second = addTake(b.std, id, take({ url: 'https://example.test/2.mp4' }))!;
    addTake(b.std, id, take({ url: 'https://example.test/3.mp4' }));
    chooseTake(b.std, id, second);

    const takes = compileBoard(b.std, HEADER).shots[0]!.takes!;
    expect(takes[0]!.id).toBe(second);
    expect(takes[0]!.primary).toBe(true);
    expect(takes.filter(t => t.primary)).toHaveLength(1);
  });

  it('falls back to the newest ready take when nothing was ticked', () => {
    // A shot generated once and never explicitly ticked still has an answer —
    // and it must be the SAME answer the card draws, or the clip on the timeline
    // is not the clip the user was looking at.
    const { b, id } = board();
    addTake(b.std, id, take({ createdAt: '2026-08-15T10:00:00.000Z', url: 'https://example.test/old.mp4' }));
    addTake(b.std, id, take({ createdAt: '2026-08-15T12:00:00.000Z', url: 'https://example.test/new.mp4' }));

    const takes = compileBoard(b.std, HEADER).shots[0]!.takes!;
    expect(takes[0]!.url).toBe('https://example.test/new.mp4');
    expect(takes[0]!.primary).toBe(true);
  });

  it('never sends a running or failed take — they have no url to play', () => {
    // A clip with no url arrives on the timeline as a hole in the film.
    const { b, id } = board();
    addTake(b.std, id, take({ url: 'https://example.test/ok.mp4' }));
    addTake(b.std, id, take({ status: 'running', url: '', src: '' }));
    addTake(b.std, id, take({ status: 'failed', error: 'boom', url: '', src: '' }));

    const takes = compileBoard(b.std, HEADER).shots[0]!.takes!;
    expect(takes).toHaveLength(1);
    expect(takes[0]!.url).toBe('https://example.test/ok.mp4');
  });

  it('keeps each take’s own length, because alternates genuinely differ', () => {
    // Forcing both into one slot would hide the difference at exactly the moment
    // the user is choosing between them.
    const { b, id } = board();
    const a = addTake(b.std, id, take({ durationSec: 5 }))!;
    addTake(b.std, id, take({ durationSec: 8 }));
    chooseTake(b.std, id, a);

    const takes = compileBoard(b.std, HEADER).shots[0]!.takes!;
    expect(takes.map(t => t.durationSec).sort()).toEqual([5, 8]);
  });

  it('carries the take id, so a timeline clip can say which take it is', () => {
    const { b, id } = board();
    const only = addTake(b.std, id, take())!;
    expect(compileBoard(b.std, HEADER).shots[0]!.takes![0]!.id).toBe(only);
  });

  it('still reports the shot id, so a render follows its shot', () => {
    // Phase 1's join key. Without it a reordered board re-attaches renders to
    // whichever shot lands on that index.
    const { b, id } = board();
    addTake(b.std, id, take());
    expect(compileBoard(b.std, HEADER).shots[0]!.id).toBe(id);
  });
});
