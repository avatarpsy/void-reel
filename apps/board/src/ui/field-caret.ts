/**
 * Putting a caret in a field that lives on the canvas.
 *
 * Extracted from the shot panel so the screenplay panel does not have to
 * rediscover any of it. Everything below was found by watching clicks fail, and
 * a second copy would drift from this one the first time either was touched.
 *
 * ── WHY A CLICK IS NOT ENOUGH ON ITS OWN ─────────────────────────────────────
 * Two separate things stop a click putting a caret in a contenteditable inside
 * an edgeless block, and BOTH have to be handled or the card looks editable and
 * silently swallows every keystroke:
 *
 *  1. The edgeless root `preventDefault()`s pointerdown to run its own
 *     selection, which also cancels the browser's default for a click on a
 *     contenteditable — focus it, and place the caret where you clicked.
 *
 *  2. Worse, the same gesture SELECTS the block as a canvas object, and
 *     `range-binding.ts:293` responds to any non-text selection by calling
 *     `host.focus()` — explicitly to stop a stray top-level contenteditable
 *     holding focus. Correct for a document, exactly wrong for a block with its
 *     own fields, and it fires a frame later, so focusing during pointerdown is
 *     undone before the user can type.
 *
 * So: take focus, place the caret from the pointer, and remove the canvas
 * selection so there is nothing left for that guard to react to.
 *
 * `std.selection.clear()` AND NOT `gfx.selection.clear()`. They sound alike and
 * are opposites here: the gfx one calls `set({ elements: [] })`, leaving an
 * EMPTY `SurfaceSelection` in place — still a non-text selection, still
 * `recoverable: false`, so it satisfies the guard's `selections.length > 0` and
 * re-triggers the steal every tick. Measured: eighteen steal/refocus cycles from
 * one click. The std-level clear removes them outright and the caret stays put.
 */
import type { BlockStdScope } from '@blocksuite/std';

export function takeCaret(
  std: BlockStdScope,
  el: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  const doc = el.ownerDocument;

  /**
   * Caret at the click, not at the start — landing at position 0 of text the
   * user clicked the END of is its own small betrayal.
   *
   * RE-RESOLVED FROM THE POINT each time, never cloned from a Range captured
   * earlier. A Lit re-render replaces the text node inside the field, so a Range
   * held across one points at a node no longer in the document: the selection
   * anchors outside the field and the first characters typed land in the wrong
   * place. The POINT stays valid; the nodes do not.
   */
  const put = () => {
    std.selection.clear();
    if (doc.activeElement !== el) el.focus({ preventScroll: true });

    const sel = doc.defaultView?.getSelection();
    if (!sel) return;
    const legacy = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const range = legacy.caretRangeFromPoint?.(clientX, clientY);
    // Only if it actually landed in this field — a point resolving into a
    // sibling would move the caret somewhere the user did not click.
    if (!range || !el.contains(range.startContainer)) {
      // Fall back to the end of the text, which is where someone who clicked a
      // filled field almost always wants to be.
      const end = doc.createRange();
      end.selectNodeContents(el);
      end.collapse(false);
      sel.removeAllRanges();
      sel.addRange(end);
      return;
    }
    sel.removeAllRanges();
    sel.addRange(range);
  };

  put();
  // Once more after the gesture settles: the edgeless tool sets its selection on
  // pointerup, after this handler has run, and the browser's own double-click
  // word-selection lands in between.
  requestAnimationFrame(() => { if (el.isConnected) put(); });
}

/**
 * Keep the canvas out of the way while typing.
 *
 * The editor's dispatcher listens on the host for keys — Backspace deletes the
 * selected block, space starts panning. Without this, typing in a field would
 * also drive the canvas.
 */
export function stopFieldKeys(e: KeyboardEvent): void {
  e.stopPropagation();
  if (e.key === 'Escape') (e.target as HTMLElement).blur();
}
