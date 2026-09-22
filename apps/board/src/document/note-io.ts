/**
 * Markdown in, an EDITABLE document on the canvas. And back out again.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A NOTE AND NOT A BLOCK OF OUR OWN
 * ══════════════════════════════════════════════════════════════════════════
 * The screenplay is a custom block holding a string, because Fountain is
 * whitespace-significant and a writer wants a plain textarea. A DOCUMENT wants
 * the opposite: you type into the formatted page, with headings, lists and
 * tables as real structure.
 *
 * BlockSuite already has that surface and the board already registers it — an
 * `affine:note` holds paragraphs, headings, lists, tables, dividers, callouts,
 * images and bookmarks, with the slash menu to reach them. A custom block could
 * not host any of it: `affine:paragraph` declares its permitted parents as
 * note, surface and edgeless-text, so children of a block we invented would be
 * rejected by the schema.
 *
 * So a document IS a note. Nothing new to render, nothing new to sync, and it
 * is editable the moment it lands.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MARKDOWN IS THE INTERCHANGE, BLOCKS ARE THE TRUTH
 * ══════════════════════════════════════════════════════════════════════════
 * The agent writes markdown, the exporters read markdown, and in between the
 * user edits blocks. Converting at the two ends rather than storing markdown
 * and re-parsing it on every keystroke means an edit is never lossy: the note
 * is the document, and markdown is only how it arrives and how it leaves.
 *
 * `MarkdownAdapter` does both directions. Its matchers are contributed by the
 * per-block STORE extensions, so it must be built with the store's provider —
 * with the view provider it silently produces a note with zero children, which
 * is exactly as confusing as it sounds.
 */
import { attributesToMarkers, markersToAttributes, unescapeSpans } from './inline-marks';
import {
  breaksToCarrier,
  breaksToCarrierSnapshot,
  carrierToBreaks,
  carrierToMarkdown,
  withoutMarks,
  commentsFromMarks,
  marksFromComments,
} from './align-marks';
import {
  countImages,
  liftImages,
  restoreImages,
  restoreMarkdownImages,
  stripImages,
} from './doc-images';

import type { MountedBoard } from '../blocksuite/editor';

/** Fenced code, which the board has no block for — see `droppedConstructs`. */
const FENCE = /^[ \t]{0,3}(```|~~~)/m;

/**
 * What a document loses on its way onto the canvas.
 *
 * The board deliberately does not register the code block: rendering one pulls
 * in Shiki's WASM engine and its grammars, which is a megabyte of bundle for
 * every board in order to syntax-highlight the rare document that has code in
 * it. Without the block, a fence is simply dropped by the adapter.
 *
 * Silently dropping it would be the wrong kind of quiet, so callers ask first
 * and tell the user. A document that must keep its code can still be exported
 * straight to a file, where the PDF and Word writers both set it properly.
 */
export function droppedConstructs(markdown: string): string[] {
  const lost: string[] = [];
  if (FENCE.test(String(markdown ?? ''))) lost.push('code blocks');
  return lost;
}

/**
 * Build a Transformer bound to this board.
 *
 * Dynamically imported, like everything else in this module's neighbourhood:
 * nothing here belongs in the bundle of a session that never opens a document.
 */
async function transformerFor(board: MountedBoard) {
  const { Transformer } = await import('@blocksuite/store');
  return new Transformer({
    schema: board.store.schema,
    blobCRUD: board.workspace.blobSync,
    docCRUD: {
      create: (id: string) => board.workspace.createDoc(id).getStore({ id }),
      get: (id: string) => board.workspace.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => board.workspace.removeDoc(id),
    },
  });
}

async function adapterFor(board: MountedBoard) {
  const transformer = await transformerFor(board);
  const { MarkdownAdapter } = await import('@blocksuite/affine/shared/adapters');
  // THE STORE'S provider, not `std.provider`. The block matchers are registered
  // by the store extensions; with the view provider every conversion returns an
  // empty note and nothing says why.
  return { transformer, adapter: new MarkdownAdapter(transformer, board.store.provider) };
}

export interface PlacedDocument {
  noteId: string;
  /** Constructs the canvas cannot hold, already dropped. Tell the user. */
  dropped: string[];
  /** Pictures placed with it, so an import can say what it brought. */
  images: number;
}

export interface PlaceOptions {
  /**
   * What the document came FROM — drawn as a tag on its corner, and the only
   * way to tell three white pages apart at a glance. Defaults to `text`, which
   * is what markdown the agent or the user wrote actually is.
   */
  kind?: 'pdf' | 'docx' | 'text';
  /**
   * Top-left on the canvas.
   *
   * OMIT IT unless the user pointed somewhere. Without it the document is laid
   * out by `reserveFlow`, which finds free space — the same placement every
   * other batch of blocks on this board goes through. Passing 0,0 to mean
   * "anywhere" is how documents ended up stacked on top of each other.
   */
  x?: number;
  y?: number;
  /** A comfortable measure — about 70 characters at the note's body size. */
  width?: number;
}

/** A4-ish proportions on the canvas, so it reads as a page before you open it. */
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 1120;

/**
 * Put a markdown document on the board as an editable note.
 *
 * Returns the note's id so the caller can select it, focus it, or hand it to
 * the agent. Throws with words fit for a person; every caller shows them.
 */
export async function placeMarkdownDocument(
  board: MountedBoard,
  markdown: string,
  opts: PlaceOptions = {},
): Promise<PlacedDocument> {
  const text = String(markdown ?? '');
  if (!text.trim()) throw new Error('There is nothing to put in the document.');

  const { transformer, adapter } = await adapterFor(board);
  /**
   * Pictures out before conversion, back in after — see `doc-images.ts`. The
   * adapter would otherwise download every one of them and store a copy that
   * only this browser can see.
   */
  // Alignment and page breaks become invisible marks the note can keep —
  // see `align-marks.ts` for why a comment cannot survive this trip.
  const lifted = liftImages(breaksToCarrier(marksFromComments(text)));
  const snapshot: any = await adapter.toBlockSnapshot({
    file: lifted.text,
    assets: transformer.assetsManager,
  });
  if (!snapshot?.children?.length) {
    throw new Error('That document could not be read as markdown.');
  }
  carrierToBreaks(snapshot);
  markersToAttributes(snapshot);
  if (lifted.images.length) {
    const { nanoid } = await import('@blocksuite/store');
    restoreImages(snapshot, lifted.images, nanoid);
  }

  /**
   * The adapter hands back a note snapshot with its own `xywh` — 800x95, which
   * is a one-line sticky note. Overriding it BEFORE the insert is what makes
   * the document land looking like a page rather than something to be resized.
   */
  const width = Math.max(320, opts.width ?? DEFAULT_WIDTH);
  /**
   * ── THE SHELF IS THE DEFAULT, NOT THE ORIGIN ──────────────────────────────
   *
   * This used to land every un-placed document at 0,0. Two callers remembered
   * to reserve space first and two did not, so opening a second document from
   * the Library dropped it precisely on top of the first — both real, both
   * editable, one invisible under the other, and no way to tell from the
   * canvas that anything had happened.
   *
   * Defaulting here rather than at each call site is the fix: a caller now has
   * to ASK for a position, which only the drop path does, because only it
   * knows where the user aimed.
   */
  let spot = { x: 0, y: 0 };
  if (Number.isFinite(opts.x) && Number.isFinite(opts.y)) {
    spot = { x: Number(opts.x), y: Number(opts.y) };
  } else {
    try {
      // `placementFor`, not bare `reserveFlow`: a document belongs NEXT TO the
      // other documents, and only then somewhere there is room. See layout.ts —
      // asking for room alone is what scattered them.
      const { placementFor } = await import('./layout');
      spot = placementFor(board, { w: width, h: DEFAULT_HEIGHT });
    } catch {
      // An empty or headless board has nothing to avoid; the origin is right.
    }
  }
  const { x, y } = spot;
  /**
   * ── ONLY `xywh`. DO NOT TOUCH `edgeless`. ─────────────────────────────────
   *
   * An earlier version also set `edgeless: { collapse: false }`, reasoning that
   * a document should size itself to its content. The adapter's snapshot has no
   * `edgeless` prop at all, so that did not merge with anything — it REPLACED
   * the schema's default, whose shape carries `style` (border, shadow) that the
   * edgeless note renderer requires.
   *
   * The result was a note that was perfect in the store — nine children, right
   * flavours, right text — and rendered as an empty element of height zero. No
   * error, no warning, just an invisible document. Caught by looking at it in a
   * browser; every unit test passed, because they assert on the model.
   *
   * The height in `xywh` is a hint for the canvas; the note grows to its
   * content by default, which is what a document should do anyway.
   */
  snapshot.props = {
    ...snapshot.props,
    xywh: `[${x},${y},${width},${DEFAULT_HEIGHT}]`,
  };

  const model = await transformer.snapshotToBlock(
    snapshot,
    board.store,
    board.pageId,
  );
  if (!model?.id) throw new Error('The document could not be added to the board.');

  /**
   * The tag, written once at birth. `document/tags.ts` reads it back — nothing
   * re-derives it, because the origin stops being visible in the content the
   * moment a PDF becomes markdown.
   */
  try {
    const { writeBlockMeta } = await import('../board/board-meta');
    writeBlockMeta(board.workspace.doc, model.id, { docKind: opts.kind ?? 'text' });
  } catch {
    // A missing tag is a cosmetic loss; it must never cost the document.
  }

  return { noteId: model.id, dropped: droppedConstructs(text), images: countImages(text) };
}

/**
 * Read a note back as markdown — what the exporters and the agent consume.
 *
 * Returns '' rather than throwing for a note that no longer exists: this runs
 * from an export button and from a tool call, and a deleted note is a thing to
 * report, not a crash.
 */
export async function noteToMarkdown(board: MountedBoard, noteId: string): Promise<string> {
  const model = board.store.getBlock(noteId)?.model;
  if (!model) return '';

  const { transformer, adapter } = await adapterFor(board);
  const { toDraftModel } = await import('@blocksuite/store');
  const snapshot = transformer.blockToSnapshot(toDraftModel(model as any));
  if (!snapshot) return '';

  // Library images become `![](url)` rather than `assets/x.png` — a path into a
  // zip that does not exist outside an export, and useless to the agent.
  const images = stripImages(snapshot as any);
  breaksToCarrierSnapshot(snapshot);
  attributesToMarkers(snapshot);
  const { file } = await adapter.fromBlockSnapshot({
    snapshot,
    assets: transformer.assetsManager,
  });
  return commentsFromMarks(unescapeSpans(carrierToMarkdown(restoreMarkdownImages(String(file ?? ''), images))));
}

/**
 * The document's own title — its first heading, or its first line of text.
 *
 * Used for the file name and the focus-mode header. A document whose first
 * block is an H1 is the overwhelmingly common case because that is what the
 * agent writes and what `parseMarkdown` guarantees.
 */
export function documentTitle(board: MountedBoard, noteId: string): string {
  const model: any = board.store.getBlock(noteId)?.model;
  for (const child of model?.children ?? []) {
    const text = withoutMarks(child?.text?.toString?.()).trim();
    if (text) return text.slice(0, 120);
  }
  return '';
}

/**
 * A SLICE of a note's blocks, as markdown.
 *
 * Used to read one section without re-serialising the whole document. It builds
 * the same `affine:note` snapshot shape the adapter produces for a real note and
 * hands it the chosen children, so the markdown is identical to the slice the
 * whole-document conversion would have emitted — there is no second serialiser
 * here to drift from the first.
 */
export async function sliceToMarkdown(board: MountedBoard, models: any[]): Promise<string> {
  if (!models.length) return '';
  const { transformer, adapter } = await adapterFor(board);
  const { toDraftModel } = await import('@blocksuite/store');

  const children = models
    .map((m) => transformer.blockToSnapshot(toDraftModel(m)))
    .filter(Boolean);
  if (!children.length) return '';

  const snapshot: any = {
    type: 'block',
    id: 'slice',
    flavour: 'affine:note',
    props: { xywh: '[0,0,800,95]', index: 'a0', hidden: false },
    children,
  };
  const images = stripImages(snapshot);
  breaksToCarrierSnapshot(snapshot);
  attributesToMarkers(snapshot);
  const { file } = await adapter.fromBlockSnapshot({
    snapshot,
    assets: transformer.assetsManager,
  });
  return commentsFromMarks(unescapeSpans(carrierToMarkdown(restoreMarkdownImages(String(file ?? '').trim(), images))));
}

/**
 * Put markdown INTO an existing note at a block index, and say how many blocks
 * it became.
 *
 * The count is what lets the caller fix up the indices of everything below —
 * `editSection` deletes the old blocks after inserting the new ones, and
 * without knowing how many arrived it would delete the wrong range. Returning
 * it is cheaper and far safer than re-reading the note and guessing.
 */
export async function insertMarkdownAt(
  board: MountedBoard,
  noteId: string,
  markdown: string,
  index: number,
): Promise<number> {
  const note: any = board.store.getBlock(noteId)?.model;
  if (!note) throw new Error('That document is not on the board any more.');

  const { transformer, adapter } = await adapterFor(board);
  const lifted = liftImages(breaksToCarrier(marksFromComments(String(markdown ?? ''))));
  const snapshot: any = await adapter.toBlockSnapshot({
    file: lifted.text,
    assets: transformer.assetsManager,
  });
  if (lifted.images.length) {
    const { nanoid } = await import('@blocksuite/store');
    restoreImages(snapshot, lifted.images, nanoid);
  }
  carrierToBreaks(snapshot);
  markersToAttributes(snapshot);
  const children: any[] = snapshot?.children ?? [];
  if (!children.length) throw new Error('That text could not be read as markdown.');

  const at = Math.max(0, Math.min(index < 0 ? 0 : index, (note.children ?? []).length));
  let n = 0;
  for (const child of children) {
    // One at a time, each after the last: `snapshotToBlock` takes a single
    // index, so inserting the whole run at one index would reverse it.
    await transformer.snapshotToBlock(child, board.store, noteId, at + n);
    n += 1;
  }
  return n;
}
