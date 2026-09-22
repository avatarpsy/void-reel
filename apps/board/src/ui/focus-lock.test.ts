/**
 * The arithmetic that keeps a document on screen, and the one fact all three
 * focus modes share.
 *
 * The clamp itself is measured in a browser — jsdom has no layout, so it cannot
 * say where a page ended up. What CAN be pinned here is the rule the clamp
 * applies, which is where the bugs were: whether a page that fits is centred,
 * whether a page that does not fit can be scrolled to BOTH of its ends, and
 * whether it stops at the padding rather than sailing past it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { enterFocusMode, isCanvasFramed, overflow } from './focus-lock';

/** A 900px-tall window, the way a laptop presents one. */
const WIN = { near: 0, far: 900 };
const PAD = { top: 72, bottom: 48 };

/** Where the page ends up after one correction. */
function settle(near: number, size: number): { near: number; far: number } {
  const d = overflow(near, near + size, WIN.near, WIN.far, PAD.top, PAD.bottom);
  return { near: near - d, far: near - d + size };
}

describe('a page that fits is centred and cannot wander', () => {
  it('centres it wherever it started', () => {
    // 400 tall in 900 of room: the same answer from above, below and on top.
    for (const start of [-500, -20, 0, 250, 1200]) {
      expect(settle(start, 400).near).toBe((900 - 400) / 2);
    }
  });

  it('counts the padding, so a page that only just fits still centres', () => {
    // 780 + 72 + 48 = 900 exactly.
    expect(settle(0, 780).near).toBe(60);
    /**
     * One pixel more and it is a scrolling page, where the two paddings can
     * no longer both be honoured — that is what "does not fit" means. The
     * page settles against the bottom and its first line sits one pixel
     * higher than the bar would like, rather than oscillating between them.
     */
    expect(settle(0, 781).far).toBe(900 - PAD.bottom);
    expect(settle(0, 781).near).toBe(PAD.top - 1);
  });
});

describe('a page taller than the window scrolls, and stops', () => {
  const TALL = 1500;

  it('stops with its first line below the bar, not above it', () => {
    // Dragged far down: the top is what it can show, and no further.
    expect(settle(600, TALL).near).toBe(PAD.top);
  });

  it('stops with its last line above the bottom edge', () => {
    // Dragged far up: the bottom comes to rest one padding from the floor.
    expect(settle(-3000, TALL).far).toBe(WIN.far - PAD.bottom);
  });

  it('leaves a position in between exactly where it was', () => {
    // This is the whole point: scrolling has to feel like nothing is fighting.
    expect(overflow(-200, -200 + TALL, WIN.near, WIN.far, PAD.top, PAD.bottom)).toBe(0);
    expect(overflow(-500, -500 + TALL, WIN.near, WIN.far, PAD.top, PAD.bottom)).toBe(0);
  });

  it('can reach both ends of the same page', () => {
    // A document whose end could not be scrolled into view was the bug that
    // sent this to measuring the RENDERED page instead of the note's `xywh`,
    // which lags its own content by a couple of hundred pixels.
    const top = settle(9999, TALL);
    const bottom = settle(-9999, TALL);
    expect(top.near).toBe(PAD.top);
    expect(bottom.far).toBe(WIN.far - PAD.bottom);
    expect(bottom.near).toBeLessThan(top.near);
  });
});

describe('one answer to "is a focus mode open"', () => {
  const opened: Array<() => void> = [];
  afterEach(() => { opened.splice(0).forEach((f) => f()); });

  it('is false with nothing open', () => {
    expect(isCanvasFramed()).toBe(false);
    expect(document.documentElement.dataset.focusMode).toBeUndefined();
  });

  it('names the mode on the root, where every selector can read it', () => {
    opened.push(enterFocusMode('screenplay'));
    expect(isCanvasFramed()).toBe(true);
    expect(document.documentElement.dataset.focusMode).toBe('screenplay');
    expect(document.body.hasAttribute('data-canvas-framed')).toBe(true);
  });

  it('holds while any mode is open and lets go only when the last one closes', () => {
    // Opening a document from inside the board-as-page view overlaps the two
    // for a moment; a release that did not count would hand the board back
    // underneath the mode still on screen.
    const a = enterFocusMode('document');
    const b = enterFocusMode('screenplay');
    b();
    expect(isCanvasFramed()).toBe(true);
    a();
    expect(isCanvasFramed()).toBe(false);
    expect(document.documentElement.dataset.focusMode).toBeUndefined();
  });

  it('ignores a release called twice', () => {
    // `close()` and `destroy()` both release, and a teardown runs both.
    const release = enterFocusMode('document');
    release();
    release();
    expect(isCanvasFramed()).toBe(false);
  });
});

describe('the hold survives the page not being rendered', () => {
  /**
   * BlockSuite culls a note that is far from the viewport, so the further
   * the board strays the more certain it is that there is no element to
   * measure. The first version gave up in exactly that case — the one case
   * the hold exists for. Found on a real board: the viewport at x=-2456
   * with no note rendered and nothing pulling it back.
   *
   * The projection is the same arithmetic the clamp uses, written out here
   * so a change to it has to be deliberate: a note's model box, through the
   * viewport, lands where the element would have been.
   */
  const project = (b: { x: number; w: number }, centerX: number, zoom: number, win: { left: number; width: number }) => {
    const left = (b.x - centerX) * zoom + win.left + win.width / 2;
    return { left, right: left + b.w * zoom };
  };

  it('projects a note that is off screen back to where it belongs', () => {
    const win = { left: 0, width: 1600 };
    // The page sits at model x=0..800; the board has wandered 2456 to the left.
    const seen = project({ x: 0, w: 800 }, -2456, 1, win);
    // It is far to the RIGHT of the window, which is what the clamp must see.
    expect(seen.left).toBeGreaterThan(win.width);
    const d = overflow(seen.left, seen.right, win.left, win.left + win.width, 48, 48);
    // A correction big enough to bring it back, and in the right direction.
    expect(d).toBeGreaterThan(1000);
  });

  it('asks for no correction once the projection lands centred', () => {
    const win = { left: 0, width: 1600 };
    // Centred means the viewport centre is the page centre.
    const seen = project({ x: 0, w: 800 }, 400, 1, win);
    expect(overflow(seen.left, seen.right, win.left, win.left + win.width, 48, 48)).toBe(0);
  });
});
