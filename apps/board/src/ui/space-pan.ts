/**
 * Hold space, drag, pan the board — everywhere, including over a card.
 *
 * ── IT WAS NOT BROKEN. IT DID NOT EXIST. ─────────────────────────────────────
 * Reported as "space-bar drag is not working on screenplay and shot boxes",
 * which sounds like the cards are swallowing the gesture. They are — but that is
 * not the whole story, and assuming it was would have produced a fix that
 * changed nothing. Measured over EMPTY canvas, with no card anywhere near the
 * cursor: the viewport does not move either.
 *
 * BlockSuite has no space-to-pan. `default-tool.ts` reads `spaceKey$` for one
 * unrelated purpose — `_spaceTranslationRect`, which lets you reposition the
 * MARQUEE while you are dragging a selection box. Panning is on the wheel and on
 * nothing else. So the gesture every other canvas tool has (Figma, Miro, tldraw,
 * Illustrator) simply was not implemented, and this implements it.
 *
 * ── THE GUARD THAT MATTERS MOST ──────────────────────────────────────────────
 * `KeyboardController` sets `spaceKey$ = (evt.code === 'Space')` with NO check
 * for where the keystroke went. So typing a space in a shot's ACTION field
 * raises it, every time. Anything driven off that signal alone — including the
 * `pointer-events: none` this module toggles — would fire in the middle of
 * writing a sentence and make the card the user is typing into unclickable.
 *
 * So this tracks space itself, and ignores it whenever the caret is in a field.
 * That is the difference between a pan gesture and a haunted text box.
 *
 * ── AND ZOOM, BECAUSE A PEN HAS NO WHEEL ─────────────────────────────────────
 * Zoom on this canvas is ⌘/Ctrl + wheel. Someone drawing with a Wacom has no
 * wheel under their hand, so their only way to change zoom was the toolbar in
 * the far bottom-left corner — a round trip across the screen in the middle of
 * a drawing. So the gesture that already means "I am moving the canvas, not
 * drawing on it" gained a second half:
 *
 *     Space + drag                     → pan
 *     Space + ⌘/Ctrl/Shift + drag      → zoom, anchored where the drag began
 *
 * Dragging RIGHT zooms in, which is Photoshop's scrubby zoom and the muscle
 * memory most people arrive with. The anchor is the model point under the pen
 * when the drag started, so the thing you are zooming towards stays put instead
 * of sliding out from under the nib.
 *
 * Three modifiers all mean zoom on purpose. Ctrl+Space switches keyboard layout
 * on some Windows setups and Alt+Space opens the window menu, neither of which
 * a web page can prevent — so Shift is offered as the one combination no
 * platform has already claimed, and the user reaches for whichever they know.
 * The modifier is read ONCE, at pointerdown: deciding per move would flip a pan
 * into a zoom mid-gesture if a thumb brushed Shift.
 */
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

import { isCanvasFramed } from './focus-lock';

import type { MountedBoard } from '../blocksuite/editor';

/** True when the keystroke belongs to something the user is writing in. */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function installSpacePan(board: MountedBoard, container: HTMLElement): () => void {
  const gfx = board.std.get(GfxControllerIdentifier);

  let armed = false;      // space is held, and not into a text field
  let panning = false;
  let last: { x: number; y: number } | null = null;

  /** Decided once, at pointerdown — see the note on modifiers above. */
  let mode: 'pan' | 'zoom' = 'pan';
  /** Zoom only: where the gesture began, and what it is zooming around. */
  let zoomFromX = 0;
  let zoomFromZoom = 1;
  let zoomAnchor: [number, number] | null = null;

  function setArmed(next: boolean): void {
    if (armed === next) return;
    armed = next;
    // The flag the CSS keys off — it makes the cards pointer-transparent so the
    // gesture reaches the canvas, and shows the grab cursor across the whole
    // viewport rather than only over its empty parts.
    if (next) document.documentElement.dataset.spacePan = 'true';
    else delete document.documentElement.dataset.spacePan;
  }

  const onKeyDown = (e: KeyboardEvent) => {
    /**
     * Not while a document is in focus. This gesture exists to move around
     * a BOARD, and inside a document there is no board to move around —
     * using it there could only take the page off screen.
     */
    if (e.code !== 'Space' || isTyping() || isCanvasFramed()) return;
    /**
     * Space scrolls a document by default. There is nothing to scroll here, but
     * the default also produces a keypress the canvas would rather not see, and
     * suppressing it is what stops the page jumping on a long pan.
     */
    e.preventDefault();
    setArmed(true);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== 'Space') return;
    setArmed(false);
    endPan();
  };

  /**
   * CAPTURE PHASE, and it has to be. BlockSuite's own dispatcher listens on the
   * host; letting the event reach it first would start a marquee selection under
   * the pan, so the board would pan AND draw a selection box at the same time.
   */
  const onPointerDown = (e: PointerEvent) => {
    if (!armed || e.button !== 0) return;
    panning = true;
    last = { x: e.clientX, y: e.clientY };

    mode = (e.ctrlKey || e.metaKey || e.shiftKey) ? 'zoom' : 'pan';
    if (mode === 'zoom') {
      zoomFromX = e.clientX;
      zoomFromZoom = gfx.viewport.zoom || 1;
      // The MODEL point under the nib. Passing this to `setZoom` on every move
      // is what keeps it pinned to the same pixel while the scale changes.
      zoomAnchor = gfx.viewport.toModelCoordFromClientCoord([e.clientX, e.clientY]) as [number, number];
      document.documentElement.dataset.spacePan = 'zoom';
    }

    e.preventDefault();
    e.stopPropagation();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!panning || !last) return;

    if (mode === 'zoom') {
      /**
       * Exponential, not linear: a fixed drag distance should be the same
       * PROPORTIONAL change at 10% as at 400%, which is the only mapping that
       * feels the same at both ends. 260px per e-fold lands a full zoom range
       * inside a comfortable arm movement.
       */
      const factor = Math.exp((e.clientX - zoomFromX) / 260);
      gfx.viewport.setZoom(zoomFromZoom * factor, zoomAnchor ? { x: zoomAnchor[0], y: zoomAnchor[1] } : undefined);
      last = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };

    // The viewport centre moves OPPOSITE the hand, and in model units — so the
    // content tracks the cursor 1:1 at any zoom, which is what makes a pan feel
    // attached to the finger rather than geared.
    const zoom = gfx.viewport.zoom || 1;
    gfx.viewport.applyDeltaCenter(-dx / zoom, -dy / zoom);

    e.preventDefault();
    e.stopPropagation();
  };

  function endPan(): void {
    panning = false;
    last = null;
    zoomAnchor = null;
    // Back to the pan cursor while space is still held, so the next drag looks
    // like what it will do.
    if (mode === 'zoom' && armed) document.documentElement.dataset.spacePan = 'true';
    mode = 'pan';
  }

  const onPointerUp = () => endPan();

  /**
   * A window that loses focus mid-pan never sees the keyup — alt-tabbing away
   * with space held would otherwise leave the board permanently un-clickable,
   * with no way for the user to work out why.
   */
  const onBlur = () => { setArmed(false); endPan(); };

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  container.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('blur', onBlur);

  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    container.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('blur', onBlur);
    setArmed(false);
  };
}
