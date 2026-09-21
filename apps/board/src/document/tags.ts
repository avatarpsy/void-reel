/**
 * WHICH BOX IS WHAT.
 *
 * A board can hold a dropped PDF, an imported Word file, a screenplay and
 * something the agent wrote, and on the canvas all four are the same white
 * page. You find out what one is by opening it.
 *
 * So each one gets a small tag on its corner — PDF, DOCX, TEXT, SCREENPLAY —
 * the way a file has an extension.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A DATA ATTRIBUTE AND A `::after`, AND NOTHING ELSE
 * ══════════════════════════════════════════════════════════════════════════
 * The obvious build is an overlay layer with the tags positioned in canvas
 * coordinates — and then it has to track pan, zoom and every drag, which is a
 * second renderer to keep in sync with the first and the usual source of labels
 * that lag a frame behind the thing they label.
 *
 * Stamping the attribute onto the block's own element instead means the tag is
 * drawn by CSS INSIDE the transformed canvas layer: it pans, zooms and drags
 * with the page for free, because it is part of it. The cost is one attribute
 * per document, rewritten when the canvas changes.
 */
import { readBlockMeta } from '../board/board-meta';
import { listDocuments } from './sections';

import type { MountedBoard } from '../blocksuite/editor';

/** The screenplay is its own flavour on the surface, not a note. */
const SCREENPLAY = 'voidspace:screenplay';
/**
 * And its own element. The tag is `voidspace-screenplay` — registered in
 * `shot/view.ts` — NOT `voidspace-screenplay-block`; a selector that guesses
 * the suffix matches nothing and the screenplay is the one box on the board
 * that silently never gets a tag.
 */
const SCREENPLAY_TAG = 'voidspace-screenplay';

const LABEL: Record<string, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  text: 'TEXT',
  screenplay: 'SCREENPLAY',
};

/** What a given block should be tagged, or '' for anything that is not a document. */
export function tagFor(board: MountedBoard, blockId: string, isDocument: boolean): string {
  const model: any = board.store.getBlock(blockId)?.model;
  if (!model) return '';
  if (model.flavour === SCREENPLAY) return LABEL.screenplay!;
  if (!isDocument) return '';
  const kind = readBlockMeta(board.workspace.doc, blockId)?.docKind;
  return LABEL[kind ?? 'text'] ?? LABEL.text!;
}

/**
 * Keep every document's tag on its element.
 *
 * Re-stamped on canvas mutations rather than subscribed per block: a board has
 * a handful of documents, the work is a map lookup and an attribute write each,
 * and one pass that always runs cannot go stale the way per-block listeners do
 * when a note is deleted and recreated by an undo.
 */
export function installDocumentTags(board: MountedBoard, container: HTMLElement): () => void {
  let queued = 0;

  const stamp = (): void => {
    queued = 0;
    // Only notes with words are documents — an empty sticky is not one, and
    // tagging it TEXT would label every note on the board.
    const docs = new Set(listDocuments(board).map((d) => d.noteId));
    const nodes = container.querySelectorAll<HTMLElement>(
      `affine-edgeless-note[data-block-id], ${SCREENPLAY_TAG}[data-block-id]`,
    );
    for (const el of nodes) {
      const id = el.dataset.blockId;
      const tag = id ? tagFor(board, id, docs.has(id)) : '';
      if (tag) el.dataset.vsDocTag = tag;
      else delete el.dataset.vsDocTag;
    }
  };

  const schedule = (): void => {
    if (queued) return;
    queued = requestAnimationFrame(stamp);
  };

  // Blocks arriving, leaving, or having their text edited all change the answer.
  const observer = new MutationObserver(schedule);
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  const off = board.store.slots.blockUpdated.subscribe(schedule);
  schedule();

  return () => {
    observer.disconnect();
    off?.unsubscribe?.();
    if (queued) cancelAnimationFrame(queued);
  };
}
