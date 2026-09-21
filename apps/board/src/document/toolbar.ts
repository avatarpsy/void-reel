/**
 * The one name both entry points agree on.
 *
 * ── WHY THIS IS NOT ON AFFiNE'S CONTEXTUAL TOOLBAR ──────────────────────────
 * That was the first attempt, and it is the right instinct: the toolbar that
 * floats above a selected note is exactly where a user looks. It cannot be
 * done. `ToolbarModuleExtension` registers ONE module per flavour variant
 * (`di.addImpl(ToolbarModuleIdentifier('affine:surface:note'), …)`), AFFiNE's
 * own note config already owns that variant, and a second registration throws
 * "Service already exists" — which took the whole editor down, not just the
 * button. Overriding it would mean re-declaring AFFiNE's own note actions and
 * keeping that copy in step forever.
 *
 * So the action lives on the board's own bar, and the bar is REVEALED when a
 * document is selected — see `board-ui.ts`. Same result, no fork.
 */

/** The event `installDocumentFocus` listens for. */
export const OPEN_DOCUMENT_EVENT = 'voidspace-open-note-document';

export interface OpenDocumentOptions {
  /**
   * Put the caret in the NAME, selected.
   *
   * For a document that was just created: the first thing anybody does with a
   * new page is call it something, and one that opens with the caret in the
   * body sends them looking for where the name lives. Carried on the event so
   * the overlay does it after its own paint — the opener has no business
   * reaching into another component's DOM to find an input.
   */
  focusName?: boolean;
}

/** Raise the intent. The overlay owns itself; nothing here knows about it. */
export function requestOpenDocument(noteId: string, opts: OpenDocumentOptions = {}): void {
  if (!noteId) return;
  document.dispatchEvent(new CustomEvent(OPEN_DOCUMENT_EVENT, {
    bubbles: true,
    detail: { noteId, ...opts },
  }));
}
