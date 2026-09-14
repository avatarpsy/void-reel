/**
 * Undo and redo, on the keys people actually press.
 *
 * ── WHY THIS IS OURS AND NOT BLOCKSUITE'S ────────────────────────────────────
 * `PageKeyboardManager` binds `Mod-z`, `Shift-Mod-z` and `Control-y`, and two of
 * the three do not survive contact with a pen user:
 *
 *   • Every one of them is gated on the dispatcher being ACTIVE, which it is not
 *     once the pen leaves the tablet. `canvas-focus.ts` fixes the general case,
 *     but undo is the one shortcut that must never be a maybe.
 *
 *   • `Shift-Mod-z` does not fire at all. The binding normalises to
 *     `Shift-Ctrl-z`, and a real shifted keypress reports `key: 'Z'`, so the
 *     lookup misses on case. Measured against the built board, with real
 *     keystrokes through CDP: Ctrl+Z undid, Ctrl+Y redid, Ctrl+Shift+Z did
 *     nothing at all. Redo on the key most people reach for was simply absent.
 *
 * So the board owns these three, the way it already owns space-to-pan and
 * Ctrl+M. `store.undo()` / `store.redo()` are the same calls the toolbar's own
 * buttons make, and they go straight to the Y.UndoManager without consulting the
 * `canUndo` signal, which is what makes them dependable.
 *
 * (That signal is a story of its own: it stayed false forever until the board
 * started calling `store.load()` instead of `doc.load()` — see `editor.ts`.
 * Undo was not "flaky", it was off, and the toolbar buttons were the only way to
 * reach it.)
 *
 * ── CAPTURE PHASE, AND WHY IT CANNOT DOUBLE-FIRE ─────────────────────────────
 * BlockSuite listens on `document` in the BUBBLE phase. This listens on
 * `document` in CAPTURE, which runs first, and calls `stopPropagation()` — so
 * for these three combinations their handler never runs and no undo is ever
 * applied twice.
 *
 * ── THE ONE PLACE IT STANDS ASIDE ────────────────────────────────────────────
 * A real `<input>` or `<textarea>` — the asset panel's search box, the media
 * inspector's fields. Those have a native undo stack of their own, and hijacking
 * Ctrl+Z there would throw away what the user was typing and revert something on
 * the canvas instead.
 *
 * `contenteditable` is deliberately NOT in that list. BlockSuite's rich text
 * suppresses native undo and routes it through the same store history, so
 * handling it here is what their handler would have done — and it means
 * Ctrl+Shift+Z works inside a note as well as on the canvas.
 */
import type { MountedBoard } from '../blocksuite/editor';

/** A field with its own native undo stack, which this must not take over. */
function isNativeTextField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function installHistoryKeys(board: MountedBoard): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

    const key = e.key?.toLowerCase();
    let action: 'undo' | 'redo' | null = null;
    if (key === 'z') action = e.shiftKey ? 'redo' : 'undo';
    // Ctrl+Y is the Windows redo. Not on ⌘, where it is not a redo at all.
    else if (key === 'y' && !e.shiftKey && !e.metaKey) action = 'redo';
    if (!action) return;

    if (isNativeTextField()) return;

    e.preventDefault();
    e.stopPropagation();
    if (action === 'undo') board.store.undo();
    else board.store.redo();
  };

  document.addEventListener('keydown', onKeyDown, true);
  return () => document.removeEventListener('keydown', onKeyDown, true);
}
