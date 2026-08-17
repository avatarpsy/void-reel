/**
 * Telling BlockSuite that this is a CANVAS.
 *
 * ── THE OMISSION, AND WHAT IT COST ───────────────────────────────────────────
 * A BlockSuite document is isomorphic: the same tree renders as a page or as an
 * edgeless canvas, and widgets branch on which one they are in. The board asks
 * for the `edgeless` VIEW SCOPE (see `extensions.view.ts`) but never registered
 * a `DocModeProvider`, and the stock service answers `getEditorMode(): null`.
 *
 * Null is not "page" and it is not "edgeless" — it is a third answer that no
 * caller tests for, so every `mode === 'edgeless'` guard in BlockSuite silently
 * took the page branch. The one that mattered is in the drag-handle widget
 * (`drag-event-watcher.ts`, `_makeDropTarget`):
 *
 *   if ( matchModels(view.model, [SurfaceBlockModel])
 *     || (mode === 'page'     && view.model.role === 'root')
 *     || (mode === 'edgeless' && !isNote && role !== 'root' && !isUnderNote) )
 *     return;                                   // ← never taken while mode is null
 *   ...
 *   if (matchModels(view.model, [AttachmentBlockModel, BookmarkBlockModel]))
 *     cleanups.push(this._makeDraggable(view)); // ← so this ran on the canvas
 *
 * `_makeDraggable` turns the block element into an HTML5 drag source. That is a
 * page-mode feature — drag a file chip to reorder it in a document — and on a
 * canvas it swallows the pointerdown before the gfx layer sees it. The result,
 * measured: a clip card that does not move AT ALL while you drag it, and on
 * release `_onDrop` takes the page branch, asks for the parent of a
 * surface-parented block, gets null, and throws on `parent.children`.
 *
 * Images were fine throughout, which is what made this look like a rendering
 * bug: `_makeDraggable` is only called for attachments and bookmarks.
 *
 * ── WHY A CONSTANT AND NOT A SETTING ─────────────────────────────────────────
 * The board has no mode switch and is not getting one — `extensions.view.ts`
 * states the reason: one surface, one meaning, because a user who dragged the
 * board into page shape would have made something the compiler has no meaning
 * for. So this reports `edgeless` for the editor and for every doc, and
 * `setEditorMode` is deliberately inert rather than a lie that stores a value
 * nothing reads.
 */
import type { DocMode } from '@blocksuite/affine/model';
import {
  DocModeExtension,
  type DocModeProvider,
} from '@blocksuite/affine/shared/services';
import type { ExtensionType } from '@blocksuite/store';
import { Subject } from 'rxjs';

const EDGELESS: DocMode = 'edgeless';

/**
 * One subject per doc id, so `onPrimaryModeChange` returns a real subscription.
 *
 * It will never emit — the mode cannot change — but a caller that gets a
 * subscription it can dispose is a caller that cannot leak, and the alternative
 * (returning something hand-rolled) would be a second thing to keep in step with
 * the interface.
 */
const silent = new Map<string, Subject<DocMode>>();

const boardDocMode: DocModeProvider = {
  getEditorMode: () => EDGELESS,
  getPrimaryMode: () => EDGELESS,
  setPrimaryMode: () => {},
  setEditorMode: () => {},
  togglePrimaryMode: () => EDGELESS,
  onPrimaryModeChange: (handler, docId) => {
    let subject = silent.get(docId);
    if (!subject) {
      subject = new Subject<DocMode>();
      silent.set(docId, subject);
    }
    return subject.subscribe(handler);
  },
};

/**
 * `DocModeExtension` uses `di.override`, which requires the identifier to be
 * registered already — `FoundationViewExtension` does that. So this must be
 * listed AFTER it, exactly like the media view extension is listed after the
 * attachment one.
 */
export const BoardDocModeExtension: ExtensionType = DocModeExtension(boardDocMode);
