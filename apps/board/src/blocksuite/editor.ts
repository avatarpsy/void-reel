/**
 * mountBoard — stand up an edgeless editor over a board's Y.Doc.
 *
 * There is no prebuilt editor component in `@blocksuite/affine@0.22.4`. The
 * package's main entry is `export {}` (side-effect registration only), and the
 * old `@blocksuite/presets` / `EdgelessEditor` path that the public docs still
 * describe is frozen at 0.19.5 under a different licence. AFFiNE's own app
 * assembles the host itself, so we do too — it is ~40 lines, and owning them
 * means an upstream refactor of their app shell cannot move our floor.
 *
 * The assembly, in order:
 *   Y.Doc ──▶ BoardWorkspace ──▶ Doc ──▶ Store (schemas) ──▶ BlockStdScope (views) ──▶ <editor-host>
 *
 * WE DO NOT REGISTER CUSTOM ELEMENTS OURSELVES — the ViewExtensionProviders do.
 * Building the view extensions runs each provider's `effect()`, and that is what
 * calls `customElements.define`. An explicit `effects()` call here on top of that
 * throws `NotSupportedError: the name "editor-host" has already been used with
 * this registry` and kills boot. (Verified in the browser; the 0.22.4 type
 * declarations do not show `effect()` on the provider base class, so reading
 * alone suggested the opposite. `@blocksuite/affine/effects` is a red herring —
 * it is type-only and exports no runtime function at all.)
 */
import { BlockStdScope } from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';
import type { Store } from '@blocksuite/store';
import * as Y from 'yjs';

import { boardStoreExtensions } from './extensions.store';
import { boardViewExtensions } from './extensions.view';
import { BoardWorkspace } from './workspace';

export interface MountedBoard {
  workspace: BoardWorkspace;
  store: Store;
  std: BlockStdScope;
  /** The raw Y.Doc. `boardMeta` (roles, media identity) is a top-level map on
   *  it, sibling to the block tree — see `board/board-meta.ts`. */
  doc: Y.Doc;
  host: HTMLElement;
  /** The `affine:surface` block id — the canvas everything is drawn on. */
  surfaceId: string;
  /** The `affine:page` root block id. */
  pageId: string;
  destroy(): void;
}

export interface MountBoardOptions {
  /** Board id; also the Y.Doc guid, so persistence keys line up. */
  boardId: string;
  /** Where to append the editor host. */
  container: HTMLElement;
  /**
   * A Y.Doc already hydrated from IndexedDB. Pass one whenever the board has
   * been opened before — mounting against an empty doc and letting persistence
   * catch up makes the user watch their board pop in a frame later.
   */
  ydoc?: Y.Doc;
}

/**
 * The minimum viable board tree.
 *
 * `affine:page` → [`affine:surface`]. That is all a blank board needs: the
 * surface IS the canvas, and frames (shots) are its children.
 *
 * A SHOT IS NOT A CONTAINER. `affine:frame` is `parent: ['affine:surface']` and
 * `affine:note` is `parent: ['@root']` (verified in affine-model, and pinned by
 * contract.test.ts), so a frame cannot own the note holding its beat text. A
 * frame is a labelled REGION; the note sits at root level, positioned inside
 * that region's bounds, and `boardMeta[noteId].shotId` records the binding.
 * Membership is never inferred from geometry — nudging a note a pixel outside a
 * frame must not silently drop a beat from the compile.
 */
function seedBoardTree(store: Store): void {
  const pageId = store.addBlock('affine:page', {});
  store.addBlock('affine:surface', {}, pageId);
  // NO seed note. An empty `affine:note` renders as a grey card floating at the
  // canvas origin — on a fresh board it looks like a stray artifact, and it sits
  // exactly where SCENE 1 goes. Notes are created per shot, when there is text
  // to put in them.
}

function findChild(store: Store, flavour: string): string {
  const root = store.root;
  if (!root) throw new Error(`board tree has no root — cannot locate ${flavour}`);
  const hit = root.children.find(c => c.flavour === flavour);
  if (!hit) throw new Error(`board tree is missing a ${flavour} block`);
  return hit.id;
}

export function mountBoard(opts: MountBoardOptions): MountedBoard {
  const workspace = new BoardWorkspace({
    id: opts.boardId,
    ydoc: opts.ydoc ?? new Y.Doc({ guid: opts.boardId }),
  });

  const doc = workspace.createDoc(opts.boardId);
  const store = doc.getStore({ extensions: boardStoreExtensions() });

  /**
   * `store.load`, NOT `doc.load` — and that one word IS the undo stack.
   *
   * Both seed the tree, so the board looked identical either way. Only
   * `Store.load` goes on to run `ext.loaded()` over the store extensions, and
   * `HistoryExtension.loaded()` is where the Y.UndoManager's `stack-item-added`
   * observer is attached. Skip it and `canUndo` is a signal that is initialised
   * false and never updated again.
   *
   * Nothing looked broken from the store's side: the UndoManager was tracking
   * correctly the whole time (`undoManager.canUndo()` really was true), so the
   * toolbar's Undo button — which calls `store.undo()` and never consults the
   * signal — worked. CTRL+Z did not, because BlockSuite's keyboard manager
   * guards on the signal: `if (this._doc.canUndo) this._doc.undo()`. A false
   * signal there swallows every undo silently, and redo with it. That reads to
   * a user as "undo is broken", and it is worst for pen work, where Ctrl+Z is
   * the gesture you reach for after every stroke.
   *
   * It also loads `StoreSelectionExtension` — the selection constructors and
   * the awareness listener — and fires `slots.ready`.
   *
   * Still idempotent: seeds only when the Y.Doc has no blocks, so reopening a
   * saved board never stacks a second page/surface on the user's canvas.
   */
  store.load(() => seedBoardTree(store));

  // ORDER MATTERS, and both obvious orderings are wrong:
  //   render → append → mount  ⇒ the edgeless root reaches `firstUpdated` before
  //     the gfx watchers exist: "ViewportElementProvider: viewport element is
  //     not found".
  //   mount → render → append  ⇒ the event dispatcher's `mounted()` reads
  //     `std.host`, which `render()` has not created yet: "Host is not ready to
  //     use, the `render` method should be called first".
  // The only order satisfying both: build the host, mount the watchers against
  // it, and append LAST so Lit's first render happens with everything in place.
  /**
   * MOUNT EXACTLY ONCE — `connectedCallback` already does it.
   *
   * `EditorHost.connectedCallback()` ends with `this.std.mount()`, and
   * `BlockStdScope.mount()` has no idempotence guard: it simply calls
   * `mounted()` on every life-cycle watcher it holds. Calling it here as well
   * mounted every gfx extension TWICE, and the one that matters is
   * `ToolController`, whose `mounted()` subscribes to `dragStart` / `dragMove` /
   * `dragEnd`. Two subscriptions meant every tool event was delivered to the
   * active tool twice, and for the pen that produced two distinct defects:
   *
   *   • TWO `dragStart`s per stroke. The first creates a brush element, the
   *     second creates another and takes over `_draggingElement` — so every
   *     stroke left behind an orphaned ONE-POINT element sitting under its own
   *     start. Invisible while the stroke covers it, and still there after the
   *     stroke is erased: a speck the eraser never touches, because it is a
   *     separate element the eraser path never crossed. That is what "I can't
   *     cleanly erase" was.
   *
   *   • TWO `dragMove`s per pointer sample, each appending the SAME coordinate.
   *     Every stroke carried double the points, half of them exact duplicates of
   *     their neighbour, which is both wasted work on every frame (the whole
   *     perfect-freehand stroke is recomputed per append) and worse input to a
   *     smoothing pass that assumes samples carry new information.
   *
   * Measured on the built board, ten pointer moves per stroke, five strokes:
   * before, every stroke gave 2 dragStart / 20 dragMove and left two elements
   * (1 point + 21 points); after, 1 dragStart / 10 dragMove and one element.
   *
   * The host is appended to `.affine-edgeless-viewport` BEFORE that wrapper
   * enters the document, so by the time `connectedCallback` runs the viewport
   * element the gfx watchers look for is already its parent — which is the
   * constraint the old explicit call was there to satisfy.
   */
  const std = new BlockStdScope({ store, extensions: boardViewExtensions() });
  const host = std.render();

  // THE HOST MUST BE WRAPPED IN `.affine-edgeless-viewport` — WE provide it.
  //
  // `RootViewExtension` registers `ViewportElementExtension('.affine-edgeless-viewport')`
  // for the edgeless scope, and every gfx block resolves the scrolling viewport
  // through it on `firstUpdated`. BlockSuite does NOT render that element; in
  // AFFiNE it comes from the app shell. Without it each frame throws
  // "ViewportElementProvider: viewport element is not found" plus a
  // "Cannot read properties of undefined (reading 'observe')" from its resize
  // setup — once per block — and the canvas stays blank even though the
  // document, the gfx grid and the DOM elements are all correct. That
  // combination is what made this look like a rendering bug rather than a
  // missing wrapper.
  const viewport = document.createElement('div');
  viewport.className = 'affine-edgeless-viewport';
  viewport.append(host);
  opts.container.append(viewport);

  /**
   * Tell the blob source what the user is actually looking at.
   *
   * BlockSuite connects EVERY gfx block in the document, not only the visible
   * ones — `gfx-viewport` culls by visibility, so an off-screen image still runs
   * `connectedCallback` and still asks for its bytes. On a 200-image board that
   * is 200 simultaneous requests, and the ones the user can see finish last.
   * Handing the source this oracle makes its queue serve the viewport first, so
   * a big board paints as fast as a small one.
   *
   * Recomputed per call (not cached): the user pans while the board is still
   * loading, and the right answer is what is on screen NOW.
   */
  const gfx = std.get(GfxControllerIdentifier);
  workspace.blobSource.visibleKeys = () => {
    const keys = new Set<string>();
    try {
      const models = gfx.grid.search(gfx.viewport.viewportBounds, {
        useSet: true,
        filter: ['block'],
      }) as Set<{ props?: Record<string, unknown> }>;
      for (const model of models) {
        const sourceId = model?.props?.sourceId;
        if (typeof sourceId === 'string' && sourceId) keys.add(sourceId);
      }
    } catch { /* viewport not sized yet — FIFO is a fine answer for one frame */ }
    return keys;
  };

  return {
    workspace,
    store,
    std,
    doc: workspace.doc,
    host,
    // `affine:page` IS the root — it is not among root.children.
    pageId: store.root!.id,
    surfaceId: findChild(store, 'affine:surface'),
    destroy() {
      std.unmount();
      host.remove();
      workspace.dispose();
    },
  };
}
