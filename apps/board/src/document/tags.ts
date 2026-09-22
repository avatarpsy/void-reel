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
import { readMark } from './align-marks';
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
    stampAlignment(board, container);
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

/**
 * -- THE CANVAS SHOWS THE ALIGNMENT THE FILE WILL USE ----------------------
 *
 * Two mismatches, both of which made a document on the board look like a
 * different document from the one it exported:
 *
 *   A PICTURE. `#align=left` left-aligns the logo in the PDF and in Word;
 *   BlockSuite CENTRES images in a note by default and has no alignment prop
 *   at all, so a left-aligned masthead sat in the middle of the canvas.
 *
 *   A PARAGRAPH. `<!-- align:right -->` right-aligns the date in the file.
 *   The alignment rides on the canvas as an invisible mark in the
 *   paragraph's own text (see `align-marks.ts`) because there is nowhere
 *   else to keep it — and nothing was READING that mark back to draw it, so
 *   the date sat on the left.
 *
 * Both are solved the same way: the alignment is copied onto the ELEMENT, in
 * the pass that already stamps the document tag, and CSS acts on it. Left is
 * stamped too, explicitly, because for a picture left is not the default —
 * it is a correction.
 */
function stampAlignment(board: MountedBoard, container: HTMLElement): void {
  /**
   * Scoped to what is INSIDE a document, and to the two flavours that can
   * carry an alignment. This re-runs on every frame in which anything changed
   * — which, while somebody is typing, is most of them.
   */
  const nodes = container.querySelectorAll<HTMLElement>(
    'affine-edgeless-note[data-vs-doc-tag] affine-image[data-block-id],'
    + 'affine-edgeless-note[data-vs-doc-tag] affine-paragraph[data-block-id]',
  );
  for (const el of nodes) {
    const id = el.dataset.blockId;
    const align = id ? alignOfBlock(board, id) : '';
    // Written only when it CHANGED: an attribute set to the value it already
    // has is still a DOM write, and this runs a lot.
    if (align === (el.dataset.vsAlign ?? '')) continue;
    if (align) el.dataset.vsAlign = align;
    else delete el.dataset.vsAlign;
  }
}

/**
 * What alignment a block carries, whichever way it carries it.
 *
 * A picture keeps it on its url, because that survives the round trip. A
 * paragraph keeps it as an invisible prefix in its text, because a paragraph
 * has no property to put it in. Neither is a design anybody would choose from
 * scratch; both are what BlockSuite leaves available.
 */
function alignOfBlock(board: MountedBoard, blockId: string): string {
  const model: any = board.store.getBlock(blockId)?.model;
  if (!model) return '';

  if (model.flavour === 'affine:image') {
    const source = String(model?.props?.sourceId ?? '');
    // The url sits inside the media ref; reading `align=` off the raw value
    // needs no decoding and costs nothing when it is absent.
    const hit = /align(?:%3D|=)(center|centre|right|left)/i.exec(source);
    const value = (hit?.[1] ?? '').toLowerCase();
    // LEFT is stamped for a picture: BlockSuite centres one by default, so
    // left has to be asked for rather than assumed.
    if (value === 'centre') return 'center';
    return value || 'left';
  }

  if (model.flavour === 'affine:paragraph') {
    const text = String(model?.text?.toString?.() ?? '');
    const { align } = readMark(text);
    return align && align !== 'left' ? align : '';
  }
  return '';
}

