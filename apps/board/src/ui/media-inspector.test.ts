/**
 * The viewer, driven the way a person drives it.
 *
 * WHAT THESE PIN. A shot with five takes asks one question — "which of these?" —
 * and until now the card could not show you any of them: a click chose a take
 * you had only seen as a 104px poster, and the only way to actually WATCH one
 * was to drag it out onto the canvas. Opening one and paging through the rest is
 * the answer, and every rule below is one that made it wrong when it was missing.
 *
 * Real DOM (happy-dom) and a real store, because what broke here was always the
 * seam between them: which list an id belongs to, and what the document says
 * after a write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestBoard, type TestBoard } from '../blocksuite/test-board';
import { writeBlockMeta } from '../board/board-meta';
import { __setToken } from '../board/parent-auth';
import { takeAsMedia, type ShotTake } from '../shot/model';
import { addTake, chooseTake, createShots, readShot } from '../shot/shots';
import { installMediaInspector } from './media-inspector';
import type { MountedBoard } from '../blocksuite/editor';

function take(over: Partial<ShotTake> = {}): Omit<ShotTake, 'id'> {
  return {
    src: 'https://example.test/proxy.mp4',
    url: 'https://example.test/master.mp4',
    poster: 'https://example.test/poster.jpg',
    kind: 'video',
    durationSec: 5,
    status: 'ready',
    createdAt: '2026-08-15T10:00:00.000Z',
    source: 'generated',
    ...over,
  };
}

let board: TestBoard;
let container: HTMLElement;
let dispose: () => void;
let shotId: string;

function mounted(): MountedBoard {
  return board as unknown as MountedBoard;
}

/** Click a take tile the way the card does — one event carrying the item and the
 *  row it came out of. The viewer works the rest out from the document. */
function openTake(t: ShotTake): void {
  const host = document.createElement('div');
  host.dataset.blockId = shotId;
  container.append(host);
  host.dispatchEvent(new CustomEvent('voidspace-open-media', {
    detail: { media: takeAsMedia(t), row: 'takes' },
    bubbles: true,
  }));
}

/**
 * `open` is async — it takes a fresh token before painting, because an element
 * `src` cannot carry an Authorization header. A microtask is not enough to get
 * past that await, so every gesture here is followed by a real turn of the loop.
 */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function dialog(): HTMLElement | null {
  const el = container.querySelector<HTMLElement>('.vs-inspect');
  return el && !el.hidden ? el : null;
}

function stageSrc(): string {
  return dialog()?.querySelector('video, img, audio')?.getAttribute('src') ?? '';
}

function click(selector: string): void {
  dialog()?.querySelector<HTMLElement>(selector)?.click();
}

beforeEach(() => {
  // A synchronous token, so `open` does not spend the parent-auth backoff
  // waiting for a page that is not there. It also has to be OUR host to be
  // appended, and example.test is not — so `?t=` never appears below.
  __setToken('tok');
  board = makeTestBoard();
  container = document.createElement('div');
  document.body.append(container);
  dispose = installMediaInspector(mounted(), container);
  [shotId] = createShots(board.std, board.surfaceId, ['Wide']);
});

afterEach(() => {
  dispose();
  container.remove();
  __setToken(null);
});

describe('opening a take', () => {
  it('shows it on the stage, playing the proxy and not the master', async () => {
    // A take used to have nowhere to be watched. `src` is the display variant —
    // the recurring silent bug in this codebase is it and `url` being swapped,
    // and here that means the dialog streaming a 4K master to answer "which of
    // these five".
    const id = addTake(board.std, shotId, take());
    const t = readShot(board.std, shotId)!.takes.find(x => x.id === id)!;

    openTake(t);
    await settle();

    expect(dialog()).not.toBeNull();
    expect(stageSrc()).toBe('https://example.test/proxy.mp4');
  });

  it('offers the choice, and says so once it has been made', async () => {
    const a = addTake(board.std, shotId, take({ label: 'one' }));
    addTake(board.std, shotId, take({ label: 'two' }));
    // Something else is chosen, so the open one is not.
    chooseTake(board.std, shotId, readShot(board.std, shotId)!.takes[1]!.id);

    const t = readShot(board.std, shotId)!.takes.find(x => x.id === a)!;
    openTake(t);
    await settle();

    const use = dialog()!.querySelector<HTMLButtonElement>('[data-take-use]')!;
    expect(use.disabled).toBe(false);

    use.click();
    await settle();

    expect(readShot(board.std, shotId)!.chosenTakeId).toBe(a);
    // Repaints in place rather than closing: picking one is rarely the last
    // thing somebody does while comparing five.
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector<HTMLButtonElement>('[data-take-use]')!.disabled).toBe(true);
  });

  it('walks the row with the chevrons, and wraps at the end', async () => {
    for (const label of ['one', 'two', 'three']) {
      addTake(board.std, shotId, take({ label, src: `https://example.test/${label}.mp4` }));
    }
    const takes = readShot(board.std, shotId)!.takes;

    openTake(takes[0]!);
    await settle();
    expect(dialog()!.querySelector('.vs-inspect__count')!.textContent).toContain('1 / 3');

    click('[data-page="1"]');
    await settle();
    expect(stageSrc()).toBe('https://example.test/two.mp4');

    // WRAPS. A dead arrow at the end of a carousel reads as a broken button
    // rather than as an edge.
    click('[data-page="1"]');
    await settle();
    click('[data-page="1"]');
    await settle();
    expect(stageSrc()).toBe('https://example.test/one.mp4');
  });

  it('only walks the takes that finished', async () => {
    // A running take is a poster that does not exist yet and a failed one is a
    // sentence. Paging into either lands on an empty stage with a dead player.
    addTake(board.std, shotId, take({ label: 'done' }));
    addTake(board.std, shotId, take({ label: 'busy', status: 'running' }));
    addTake(board.std, shotId, take({ label: 'broke', status: 'failed' }));

    openTake(readShot(board.std, shotId)!.takes[0]!);
    await settle();

    // One ready take means no row to walk, so no chevrons at all.
    expect(dialog()!.querySelector('[data-page]')).toBeNull();
    expect(dialog()!.querySelector('.vs-inspect__count')).toBeNull();
  });

  it('discards, then shows what slid into the slot', async () => {
    for (const label of ['one', 'two']) {
      addTake(board.std, shotId, take({ label, src: `https://example.test/${label}.mp4` }));
    }
    const takes = readShot(board.std, shotId)!.takes;

    openTake(takes[0]!);
    await settle();
    click('[data-take-drop]');
    await settle();

    expect(readShot(board.std, shotId)!.takes.map(t => t.label)).toEqual(['two']);
    // Still open, on the survivor — "throw away the three bad ones" must not be
    // three round trips through the strip.
    expect(stageSrc()).toBe('https://example.test/two.mp4');
  });

  it('closes when the last one is discarded', async () => {
    const id = addTake(board.std, shotId, take());
    openTake(readShot(board.std, shotId)!.takes.find(t => t.id === id)!);
    await settle();

    click('[data-take-drop]');
    await settle();

    expect(dialog()).toBeNull();
  });

  it('offers no trim bar — a take is what the shot produced', async () => {
    /**
     * `trimMedia` addresses a reference inside a shot's `media` list. A take is
     * in `takes`, so every drag of a handle was written nowhere and the bar
     * sprang back on the next repaint: a control that cannot keep what you set
     * it to is worse than an absent one.
     */
    const id = addTake(board.std, shotId, take());
    openTake(readShot(board.std, shotId)!.takes.find(t => t.id === id)!);
    await settle();

    expect(dialog()!.querySelector('[data-trim]')).toBeNull();
  });
});

describe('opening a reference', () => {
  it('pages through the shot it belongs to', async () => {
    // Same gesture, same viewer, different row. A reference keeps its fields and
    // its trim; what it gains is the ability to compare it with its neighbours.
    const shot = readShot(board.std, shotId)!;
    expect(shot).not.toBeNull();

    const host = document.createElement('div');
    host.dataset.blockId = shotId;
    container.append(host);

    const media = [
      { id: 'm1', kind: 'image' as const, role: 'reference' as const,
        src: 'https://example.test/a.png', url: 'https://example.test/a.png', name: 'a' },
      { id: 'm2', kind: 'image' as const, role: 'reference' as const,
        src: 'https://example.test/b.png', url: 'https://example.test/b.png', name: 'b' },
    ];
    board.store.updateBlock(board.store.getBlock(shotId)!.model, { media });

    host.dispatchEvent(new CustomEvent('voidspace-open-media', {
      detail: { media: media[0], row: 'media' }, bubbles: true,
    }));
    await settle();

    expect(dialog()!.querySelector('.vs-inspect__count')!.textContent).toContain('1 / 2');
    click('[data-page="1"]');
    await settle();
    expect(stageSrc()).toBe('https://example.test/b.png');
  });
});

describe('when a file will not load', () => {
  it('says so without stranding the rest of the row', async () => {
    /**
     * The message used to be written over the stage's whole contents, which took
     * the ‹ › chevrons with it: a shot whose second take had a dead link became
     * a dead end, and the only way past it was to close the dialog and open a
     * different tile. One broken file must not strand the four that are fine.
     */
    for (const label of ['one', 'two']) {
      addTake(board.std, shotId, take({ label, src: `https://example.test/${label}.mp4` }));
    }
    openTake(readShot(board.std, shotId)!.takes[0]!);
    await settle();

    dialog()!.querySelector('video')!.dispatchEvent(new Event('error'));
    await settle();

    expect(dialog()!.querySelector('.vs-inspect__fail')).not.toBeNull();
    expect(dialog()!.querySelectorAll('[data-page]').length).toBe(2);

    click('[data-page="1"]');
    await settle();
    expect(stageSrc()).toBe('https://example.test/two.mp4');
  });
});

describe('the playhead clamp', () => {
  /**
   * WHAT THIS PREVENTS, precisely.
   *
   * `trimWindow` on an item whose duration is unknown returns
   * `{ start: 0, end: 0 }` — an EMPTY window, not an absent one. The clamp loop
   * read that as "everything past frame zero is out of bounds" and dragged the
   * playhead back to zero sixty times a second. The video really was playing:
   * decoding, showing a pause button, reporting `0:00 / 0:05`, and never moving.
   *
   * Every clip on the canvas hit it, because a canvas block has no shot — so
   * `commitTrim` had nowhere to record the duration it had just measured.
   */
  function stage(): HTMLVideoElement {
    return dialog()!.querySelector('video')!;
  }

  /** What `open` wires to `loadedmetadata`, driven with a duration the way a
   *  real element reports one. */
  async function reportDuration(seconds: number): Promise<void> {
    const v = stage();
    Object.defineProperty(v, 'duration', { value: seconds, configurable: true });
    v.dispatchEvent(new Event('loadedmetadata'));
    await settle();
  }

  it('does not run for an untrimmed canvas clip', async () => {
    const host = document.createElement('div');
    container.append(host);
    const meta = { kind: 'video' as const, originalUrl: 'https://example.test/canvas.mp4' };
    writeBlockMeta(board.doc, 'canvas-1', meta);
    board.store.addBlock('affine:attachment', {
      name: 'canvas.mp4', type: 'video/mp4', size: 1, xywh: '[0,0,360,203]', index: 'a1',
    }, board.surfaceId);

    host.dispatchEvent(new CustomEvent('voidspace-open-block', {
      detail: { blockId: 'canvas-1' }, bubbles: true,
    }));
    await settle();

    await reportDuration(5);

    // Playback moves and stays moved. Under the old loop this snapped to 0.
    stage().currentTime = 2.5;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    expect(stage().currentTime).toBe(2.5);
  });

  it('still holds a genuinely trimmed reference inside its window', async () => {
    // The clamp is the whole point of the trim bar — turning it off for the
    // untrimmed case must not turn it off for the case it was written for.
    const media = [{
      id: 'm1', kind: 'video' as const, role: 'reference' as const,
      src: 'https://example.test/ref.mp4', url: 'https://example.test/ref.mp4',
      name: 'ref', durationSec: 10, inSec: 4, outSec: 6,
    }];
    board.store.updateBlock(board.store.getBlock(shotId)!.model, { media });

    const host = document.createElement('div');
    host.dataset.blockId = shotId;
    container.append(host);
    host.dispatchEvent(new CustomEvent('voidspace-open-media', {
      detail: { media: media[0], row: 'media' }, bubbles: true,
    }));
    await settle();
    await reportDuration(10);

    stage().currentTime = 9;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    expect(stage().currentTime).toBe(4);
  });
});
