/**
 * The chrome hides, and — more importantly — comes back.
 *
 * An auto-hiding toolbar has exactly one catastrophic failure: it hides and the
 * user cannot get it back. So most of these are about the ways it must STAY
 * open, not the way it goes away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installChromeAutohide } from './chrome-autohide';

const root = () => document.documentElement;
const top = () => root().dataset.chromeTop === 'on';
const bottom = () => root().dataset.chromeBottom === 'on';

/** A container with a real box — proximity is measured against its rect. */
function stage(height = 900, width = 1400): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width, height, right: width, bottom: height, x: 0, y: 0 }) as DOMRect;
  return el;
}

function move(el: HTMLElement, clientY: number): void {
  el.dispatchEvent(new PointerEvent('pointermove', { clientY, bubbles: true }));
}

describe('installChromeAutohide', () => {
  let el: HTMLElement;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    // happy-dom answers matchMedia with `matches: false`, which would read as a
    // coarse pointer and disable the whole thing.
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('hover: hover'),
      media: q, addEventListener() {}, removeEventListener() {},
    }));
    el = stage();
  });

  afterEach(() => {
    stop?.(); stop = null;
    el.remove();
    vi.unstubAllGlobals();
  });

  it('starts hidden, so the canvas is what you see', () => {
    const c = installChromeAutohide(el);
    stop = c.destroy;
    expect(root().dataset.chrome).toBe('auto');
    expect(top()).toBe(false);
    expect(bottom()).toBe(false);
  });

  it('reveals the edge you reach for, and only that one', () => {
    const c = installChromeAutohide(el);
    stop = c.destroy;

    move(el, 20);
    expect(top()).toBe(true);
    expect(bottom()).toBe(false);

    move(el, 880);
    expect(bottom()).toBe(true);
    expect(top()).toBe(false);

    // The middle of the canvas is where the work is — nothing on top of it.
    move(el, 450);
    expect(top()).toBe(false);
    expect(bottom()).toBe(false);
  });

  it('gives the bottom edge a deeper band than the top', () => {
    // AFFiNE's pen and shape pickers open UPWARDS out of an 80px toolbar. A band
    // that only covered the toolbar would hide it the instant the pointer moved
    // into the picker it had just opened.
    const c = installChromeAutohide(el);
    stop = c.destroy;
    move(el, 900 - 180);
    expect(bottom()).toBe(true);
    move(el, 180);
    expect(top()).toBe(false);
  });

  it('holds both open while the empty state is up', () => {
    // Discovering "Add shot" must not require guessing that a hover exists.
    const c = installChromeAutohide(el);
    stop = c.destroy;
    c.setPinned(true);
    move(el, 450);
    expect(top()).toBe(true);
    expect(bottom()).toBe(true);
  });

  it('holds open while a button is held down', () => {
    const c = installChromeAutohide(el);
    stop = c.destroy;
    move(el, 20);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    // The pointer wanders off the bar mid-gesture; the bar must not vanish.
    move(el, 450);
    expect(top()).toBe(true);
  });

  it('reveals on keyboard focus, so Tab can reach the buttons', () => {
    const c = installChromeAutohide(el);
    stop = c.destroy;
    const bar = document.createElement('div');
    bar.className = 'vs-board-bar';
    const button = document.createElement('button');
    bar.append(button);
    el.append(bar);

    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(top()).toBe(true);

    // …and a bar with focus stays open when the pointer moves away.
    move(el, 450);
    expect(top()).toBe(true);
  });

  it('leaves everything alone on a device that cannot hover', () => {
    // "Reveal on hover" on a touch screen means "reveal never".
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const c = installChromeAutohide(el);
    stop = c.destroy;
    expect(c.active).toBe(false);
    expect(root().dataset.chrome).toBeUndefined();
  });

  it('puts the page back exactly as it found it', () => {
    const c = installChromeAutohide(el);
    move(el, 20);
    c.destroy();
    expect(root().dataset.chrome).toBeUndefined();
    expect(root().dataset.chromeTop).toBeUndefined();
    expect(root().dataset.chromeBottom).toBeUndefined();
  });
});
