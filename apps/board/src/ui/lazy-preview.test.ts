/**
 * The preview reconciler.
 *
 * THE BUG THIS SUITE EXISTS FOR, reported from a real board: drag a different
 * block onto a graphic shot and the pill updated but the composition on the
 * card did not change. The card's own IntersectionObserver said
 * `if (visible && !mounted) mount()`, so with a preview already up — which is
 * the normal case when you are swapping one block for another — the branch was
 * skipped and the previous composition stayed on screen under the new name.
 *
 * The fix was to stop spreading the decision across callbacks: there is one
 * statement of what SHOULD be shown and one function that makes reality match.
 * These tests drive that function through the transitions that broke it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Captured so the tests can drive visibility the way the browser would. */
const observers: Array<{ cb: (e: Array<{ isIntersecting: boolean }>) => void; el: Element }> = [];

class FakeIO {
  constructor(private cb: (e: Array<{ isIntersecting: boolean }>) => void) {}
  observe(el: Element) { observers.push({ cb: this.cb, el }); }
  disconnect() { /* the tests drive `observers` directly */ }
}

/** Every mounted preview, so a stale one is visible to an assertion. */
const mounts: Array<{
  name: string; vars: Record<string, string>; alive: boolean;
  host: HTMLElement; looping?: boolean;
}> = [];

/**
 * The RENDERER is stubbed; the SCHEDULER is what is under test.
 *
 * This is the whole reason the two live in separate modules: with both in one
 * file the scheduler's call to `mountBlockPreview` was a module-local binding
 * that no spy could intercept, and the only testable surface was the DOM after
 * a real fetch. Now the seam is an import, so the expensive half can be a stub
 * that simply records what it was asked to do.
 */
vi.mock('./block-render', () => ({
  mountBlockPreview: (host: HTMLElement, name: string, vars: Record<string, string> = {}) => {
    const rec: (typeof mounts)[number] = { name, vars: { ...vars }, alive: true, host };
    mounts.push(rec);
    host.innerHTML = `<iframe data-name="${name}"></iframe>`;
    return {
      update(next: Record<string, string>) { rec.vars = { ...next }; },
      setLoop(on: boolean) { rec.looping = on; },
      destroy() { rec.alive = false; },
    };
  },
  loadBlock: async () => null,
  blockSrcdoc: (html: string) => html,
}));

let lazyBlockPreview: typeof import('./block-preview')['lazyBlockPreview'];

beforeEach(async () => {
  observers.length = 0;
  mounts.length = 0;
  vi.resetModules();
  (globalThis as any).IntersectionObserver = FakeIO;

  const mod = await import('./block-preview');
  lazyBlockPreview = mod.lazyBlockPreview;
});

/** Tell every observer whether its element is on screen. */
function setVisible(on: boolean): void {
  observers.forEach(o => o.cb([{ isIntersecting: on }]));
}

function host(): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = '<span class="glyph">◫</span>';
  document.body.append(el);
  return el;
}

const liveMounts = () => mounts.filter(m => m.alive);

describe('lazyBlockPreview', () => {
  it('mounts nothing until the host is on screen', () => {
    const p = lazyBlockPreview(host());
    p.set('stat-card');
    expect(liveMounts()).toHaveLength(0);

    setVisible(true);
    expect(liveMounts().map(m => m.name)).toEqual(['stat-card']);
  });

  /**
   * THE REPORTED BUG, exactly. A preview is up and the block changes.
   */
  it('swaps the composition when the block changes', () => {
    const p = lazyBlockPreview(host());
    p.set('stat-card');
    setVisible(true);
    expect(liveMounts().map(m => m.name)).toEqual(['stat-card']);

    p.set('apple-money-count');
    // The old one is GONE — a stale composition under a new name is the failure.
    expect(liveMounts().map(m => m.name)).toEqual(['apple-money-count']);
    expect(mounts.find(m => m.name === 'stat-card')!.alive).toBe(false);
  });

  /** Same block, new slot values: swapped in place so the animation survives. */
  it('updates values without remounting', () => {
    const p = lazyBlockPreview(host());
    p.set('stat-card', { stat: '73%' });
    setVisible(true);
    p.set('stat-card', { stat: '92%' });

    expect(mounts).toHaveLength(1);
    expect(mounts[0].vars).toEqual({ stat: '92%' });
  });

  it('does nothing at all when asked for what is already showing', () => {
    const p = lazyBlockPreview(host());
    p.set('stat-card', { stat: '73%' });
    setVisible(true);
    p.set('stat-card', { stat: '73%' });
    expect(mounts).toHaveLength(1);
  });

  /** Clearing the block — the shot went back to being a clip. */
  it('tears down when the block is cleared, and restores the host', () => {
    const h = host();
    const p = lazyBlockPreview(h);
    p.set('stat-card');
    setVisible(true);
    expect(h.querySelector('iframe')).toBeTruthy();

    p.set('');
    expect(liveMounts()).toHaveLength(0);
    // The tile's glyph comes back rather than leaving an empty square.
    expect(h.querySelector('.glyph')).toBeTruthy();
  });

  it('stops running once the host scrolls away, and comes back', () => {
    const p = lazyBlockPreview(host());
    p.set('stat-card');
    setVisible(true);
    expect(liveMounts()).toHaveLength(1);

    setVisible(false);
    expect(liveMounts()).toHaveLength(0);

    setVisible(true);
    expect(liveMounts().map(m => m.name)).toEqual(['stat-card']);
  });

  it('remounts when a re-render replaces the iframe under it', () => {
    const h = host();
    const p = lazyBlockPreview(h);
    p.set('stat-card');
    setVisible(true);
    // A template re-render wiped the host's children.
    h.innerHTML = '';
    p.set('stat-card');
    expect(h.querySelector('iframe')).toBeTruthy();
  });

  it('runs nothing after destroy', () => {
    const p = lazyBlockPreview(host());
    p.set('stat-card');
    setVisible(true);
    p.destroy();
    expect(liveMounts()).toHaveLength(0);

    setVisible(true);
    expect(liveMounts()).toHaveLength(0);
  });
});

describe('the board-wide budget', () => {
  /**
   * Every preview is a live document with keyframes and, often, GSAP. A panel
   * showing forty tiles must not run forty of them.
   */
  it('caps how many compositions run at once', () => {
    const previews = Array.from({ length: 30 }, () => lazyBlockPreview(host()));
    previews.forEach((p, i) => p.set(`block-${i}`));
    setVisible(true);

    expect(liveMounts().length).toBeLessThanOrEqual(24);
    expect(liveMounts().length).toBeGreaterThan(0);
  });

  /**
   * AND THE SHORTFALL HEALS. Without a wait-queue the tiles that missed out
   * would keep their glyph forever — nothing re-runs for a preview whose
   * visibility never changes again.
   */
  it('hands a freed slot to something that was waiting', () => {
    const hosts = Array.from({ length: 26 }, () => host());
    const previews = hosts.map(h => lazyBlockPreview(h));
    previews.forEach((p, i) => p.set(`block-${i}`));
    setVisible(true);

    const before = liveMounts().length;
    expect(before).toBe(24);
    // The first one goes away; a waiter should take its place.
    previews[0].destroy();
    expect(liveMounts().length).toBe(before);
  });
});

describe('playback control', () => {
  it('passes a loop request through to the running composition', () => {
    const p = lazyBlockPreview(host());
    p.set('stat-card');
    setVisible(true);
    p.setLoop(true);
    expect(liveMounts()[0].looping).toBe(true);
    p.setLoop(false);
    expect(liveMounts()[0].looping).toBe(false);
  });

  /** Hovering, then scrolling away and back, must not lose the request. */
  it('remembers a loop request across a remount', () => {
    const p = lazyBlockPreview(host());
    p.set('stat-card');
    setVisible(true);
    p.setLoop(true);
    setVisible(false);
    setVisible(true);
    expect(liveMounts()[0].looping).toBe(true);
  });
});

describe('budget priority', () => {
  /**
   * A SHOT CARD IS THE USER'S OWN WORK; a panel tile is one of 128 they are
   * scanning past. Opening the media panel on a graphic-heavy board must never
   * cost them sight of a scene they built — a blank card reads as a lost scene.
   */
  it('lets a shot card take a slot from a panel tile', () => {
    const tiles = Array.from({ length: 24 }, () => {
      const p = lazyBlockPreview(host(), { priority: 'tile' });
      return p;
    });
    tiles.forEach((p, i) => p.set(`tile-${i}`));
    setVisible(true);
    expect(liveMounts()).toHaveLength(24);

    const card = lazyBlockPreview(host(), { priority: 'card' });
    card.set('the-card');
    setVisible(true);

    expect(liveMounts().some(m => m.name === 'the-card')).toBe(true);
    expect(liveMounts().length).toBeLessThanOrEqual(24);
  });

  it('does not let a tile evict anything', () => {
    const cards = Array.from({ length: 24 }, () => lazyBlockPreview(host(), { priority: 'card' }));
    cards.forEach((p, i) => p.set(`card-${i}`));
    setVisible(true);

    const tile = lazyBlockPreview(host(), { priority: 'tile' });
    tile.set('late-tile');
    setVisible(true);
    expect(liveMounts().some(m => m.name === 'late-tile')).toBe(false);
    expect(liveMounts()).toHaveLength(24);
  });
});
