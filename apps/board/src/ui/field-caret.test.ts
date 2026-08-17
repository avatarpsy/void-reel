/**
 * Selecting text in a field that lives on the canvas.
 *
 * ── THE BUG THESE EXIST FOR ──────────────────────────────────────────────────
 * `takeCaret` used to place a COLLAPSED caret on pointerdown and then do it
 * again inside `requestAnimationFrame`, "once the gesture settles". That second
 * call ran ~16 ms later — while the finger was still down — and it made three
 * ordinary things impossible on every shot card:
 *
 *   • dragging across words to select them (re-collapsed mid-drag);
 *   • double-clicking a word (the second pointerdown collapsed the browser's
 *     own word selection);
 *   • triple-clicking a line.
 *
 * Reported as "I'm struggling to select the text box and input text", which is
 * exactly what it feels like: the field takes focus, so it LOOKS like it worked,
 * and then the selection you were making disappears.
 *
 * The rule that fixes it is the thing to protect: the browser's own selection
 * logic is correct and irreplaceable, so this code may only act on the FIRST
 * click of a gesture, and the focus guard must never touch the DOM selection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { focusField, stopFieldKeys, takeCaret } from './field-caret';

/**
 * The two things `takeCaret` uses from the editor — and `clear` MODELS THE REAL
 * ONE, because the previous stub is why a shipping bug got through.
 *
 * BlockSuite's `clear()` takes an optional list of selection TYPES, and with no
 * argument it clears every one of them — including `text`, which `range-binding`
 * mirrors onto the DOM as `document.getSelection().removeAllRanges()`. The old
 * stub was "empty an array", so it could not express that, and a guard that
 * wiped the user's selection every frame passed every test here. It took a
 * browser to find.
 *
 * So this stub does the same thing the real one does: it clears only the types
 * it is asked for, and clearing `text` removes the DOM ranges.
 */
/**
 * The host is part of the fixture now, because the guard distinguishes THE
 * STEAL from the user leaving by where focus lands: `range-binding` focuses the
 * editor host and nothing else does. A fake with no host cannot tell them apart
 * and falls back to the bounded rAF tick.
 */
function fakeHost(): HTMLElement {
  const host = document.createElement('editor-host');
  host.tabIndex = 0;
  document.body.append(host);
  return host;
}

function fakeStd(selections: Array<{ type: string }> = [], host?: HTMLElement) {
  let value = [...selections];
  return {
    host,
    selection: {
      get value() { return value; },
      clear: vi.fn((types?: string[]) => {
        const kill = types ?? ['surface', 'block', 'text', 'cursor'];
        value = value.filter(s => !kill.includes(s.type));
        // What `range-binding` does when the text selection goes.
        if (kill.includes('text')) document.getSelection()?.removeAllRanges();
      }),
    },
  } as never;
}

function field(text = 'she turns to the window'): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'plaintext-only');
  el.textContent = text;
  document.body.append(el);
  return el;
}

/** Let the focus guard run a couple of its frames. */
function frames(n = 3): Promise<void> {
  return new Promise(resolve => {
    let left = n;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('takeCaret — the first click of a gesture', () => {
  it('focuses the field and puts a caret in it', () => {
    const el = field();
    takeCaret(fakeStd(), el, 10, 10);

    expect(document.activeElement).toBe(el);
    const sel = document.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    expect(el.contains(sel.getRangeAt(0).startContainer)).toBe(true);
  });

  /**
   * The canvas selection is what PROVOKES the steal: `range-binding` reacts to
   * any non-text selection by calling `host.focus()`. Clearing it is the actual
   * fix; everything else here is holding the line while that lands.
   */
  it('clears the canvas selection', () => {
    const std = fakeStd([{ type: 'surface' }]);
    takeCaret(std, field(), 10, 10);
    expect((std as never as { selection: { clear: ReturnType<typeof vi.fn> } })
      .selection.clear).toHaveBeenCalled();
  });

  /**
   * NEVER `clear()` WITH NO ARGUMENT. That form clears `text` too, and BlockSuite
   * mirrors a cleared text selection onto the DOM — so the guard meant to protect
   * the caret was deleting the user's selection one frame after they made it.
   * Found in a browser; pinned here.
   */
  it('never clears the TEXT selection type', () => {
    const std = fakeStd([{ type: 'surface' }]);
    takeCaret(std, field(), 10, 10);
    const clear = (std as never as { selection: { clear: ReturnType<typeof vi.fn> } }).selection.clear;
    for (const call of clear.mock.calls) {
      expect(call[0], 'clear() must be given explicit non-text types').toBeDefined();
      expect(call[0]).not.toContain('text');
    }
  });
});

describe('takeCaret — mid-gesture', () => {
  /**
   * THE REGRESSION. A second pointerdown on an already-focused field is the
   * browser mid-double-click, mid-drag, or clicking inside a live selection —
   * all three of which it handles correctly on its own. Touching the selection
   * here is what broke word-select everywhere on a shot card.
   */
  it('leaves an existing selection alone when the field already has focus', () => {
    const el = field();
    el.focus();

    const sel = document.getSelection()!;
    const range = document.createRange();
    range.setStart(el.firstChild!, 4);
    range.setEnd(el.firstChild!, 9);   // "turns"
    sel.removeAllRanges();
    sel.addRange(range);
    expect(sel.toString()).toBe('turns');

    takeCaret(fakeStd(), el, 10, 10);

    expect(document.getSelection()!.toString()).toBe('turns');
  });

  /**
   * The guard used to be the second half of the bug: it re-ran the whole caret
   * placement a frame later, so a selection made by dragging survived about one
   * frame. It now only clears the CANVAS selection and only repairs focus.
   */
  it('does not collapse the selection on later frames', async () => {
    const el = field();
    el.focus();

    const sel = document.getSelection()!;
    const range = document.createRange();
    range.setStart(el.firstChild!, 4);
    range.setEnd(el.firstChild!, 9);
    sel.removeAllRanges();
    sel.addRange(range);

    takeCaret(fakeStd(), el, 10, 10);
    await frames(4);

    expect(document.getSelection()!.toString()).toBe('turns');
    expect(document.getSelection()!.isCollapsed).toBe(false);
  });

  /**
   * The guard's real job, still done: BlockSuite calls `host.focus()` a frame
   * after the click to stop a stray contenteditable holding focus. Correct for a
   * document, exactly wrong for a block with its own fields.
   */
  it('takes focus back when the editor steals it', async () => {
    const el = field();
    const host = fakeHost();

    takeCaret(fakeStd([], host), el, 10, 10);
    expect(document.activeElement).toBe(el);

    host.focus();
    await frames(1);
    expect(document.activeElement).toBe(el);
  });

  /**
   * AND KEEPS TAKING IT BACK, long after the rAF tick's 400ms budget.
   *
   * This is the bug the budget could not reach: click the length box, pause to
   * reach the keyboard, and any pointer drift over the canvas changes
   * `std.selection`, which makes `range-binding` focus the host again. The old
   * guard had long since expired, so the keystrokes went to the canvas.
   */
  it('still takes it back after the tick budget has expired', async () => {
    const el = field();
    const host = fakeHost();

    takeCaret(fakeStd([], host), el, 10, 10);
    await new Promise(r => setTimeout(r, 500));

    host.focus();
    await frames(1);
    expect(document.activeElement).toBe(el);
  });

  /**
   * AND LETS GO WHEN THE USER MEANS TO LEAVE. Focus landing anywhere that is
   * not the host is a person moving on, and fighting that would be a field you
   * cannot get out of — worse than the bug.
   */
  it('lets go when focus moves somewhere that is not the host', async () => {
    const el = field();
    const host = fakeHost();
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);

    takeCaret(fakeStd([], host), el, 10, 10);
    elsewhere.focus();

    await frames(3);
    expect(document.activeElement).toBe(elsewhere);
  });

  /** Escape is the deliberate way out, and the guard must not undo it. */
  it('lets go on Escape', async () => {
    const el = field();
    const host = fakeHost();

    takeCaret(fakeStd([], host), el, 10, 10);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    el.blur();
    host.focus();

    await frames(3);
    expect(document.activeElement).not.toBe(el);
  });

  /**
   * A NEW GESTURE ENDS THE GUARD. Without this, clicking a shape straight after
   * typing had its selection cleared for the rest of the guard's budget — the
   * board looked like it refused to select anything for a quarter of a second
   * after every edit.
   */
  it('stops holding focus once the user starts a new gesture', async () => {
    const el = field();
    const elsewhere = document.createElement('div');
    elsewhere.tabIndex = 0;
    document.body.append(elsewhere);

    takeCaret(fakeStd(), el, 10, 10);
    await frames(2);

    // Dispatched from an ELEMENT, the way a real one arrives — it propagates up
    // through the capture phase to the window listener the guard installed.
    elsewhere.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    elsewhere.focus();
    await frames(3);

    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('focusField', () => {
  it('focuses and puts the caret at the end', () => {
    const el = field('half a sentence');
    focusField(fakeStd(), el);

    expect(document.activeElement).toBe(el);
    const sel = document.getSelection()!;
    expect(sel.isCollapsed).toBe(true);
    expect(sel.getRangeAt(0).startOffset).toBe('half a sentence'.length);
  });
});

describe('stopFieldKeys', () => {
  it('keeps every key away from the canvas', () => {
    const el = field();
    const e = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true });
    const stop = vi.spyOn(e, 'stopPropagation');
    Object.defineProperty(e, 'target', { value: el });

    stopFieldKeys(e);
    // Backspace on the canvas DELETES THE SELECTED BLOCK. Without this, typing
    // in a field would delete the shot being typed into.
    expect(stop).toHaveBeenCalled();
  });

  it('blurs on Escape — the only unambiguous way off a canvas field', () => {
    const el = field();
    el.focus();
    const e = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(e, 'target', { value: el });

    stopFieldKeys(e);
    expect(document.activeElement).not.toBe(el);
  });
});
