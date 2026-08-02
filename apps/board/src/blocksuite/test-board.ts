/**
 * A board with a REAL `BlockStdScope`, so tests exercise the code the app runs.
 *
 * A bare `Store` would be enough to read block props, but not to create a shot:
 * `createShots` takes its z-index from the gfx layer manager, which is a view
 * extension. Building the same scope the browser does means a test that passes
 * is evidence about the real thing rather than about a simplified copy of it.
 *
 * `render()` THEN `mount()`, and both are required. The gfx spatial index
 * (`gfx.grid`) is filled by a LifeCycleWatcher that subscribes in `mounted()`,
 * and the order is fixed too — `mount()` reads `std.host`, which only `render()`
 * creates.
 *
 * The host is never appended to the document. Nothing here needs layout, and
 * keeping it detached is what keeps these tests in milliseconds.
 */
import { BlockStdScope } from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';
import type { Store } from '@blocksuite/store';
import * as Y from 'yjs';

import { boardStoreExtensions } from './extensions.store';
import { boardViewExtensions } from './extensions.view';
import { BoardWorkspace } from './workspace';

export interface TestBoard {
  workspace: BoardWorkspace;
  store: Store;
  std: BlockStdScope;
  doc: Y.Doc;
  pageId: string;
  surfaceId: string;
}

let seq = 0;

export function makeTestBoard(): TestBoard {
  // A fresh id per board: the workspace opens an IndexedDB-backed blob store
  // keyed by it, and sharing one across tests would share state between them.
  const id = `test-board-${++seq}`;
  const ydoc = new Y.Doc({ guid: id });
  const workspace = new BoardWorkspace({ id, ydoc });
  const store = workspace.createDoc(id).getStore({ extensions: boardStoreExtensions() });

  const pageId = store.addBlock('affine:page', {});
  const surfaceId = store.addBlock('affine:surface', {}, pageId);

  const std = new BlockStdScope({ store, extensions: boardViewExtensions() });
  std.render();
  std.mount();

  return { workspace, store, std, doc: ydoc, pageId, surfaceId };
}

/**
 * Put an image block on the canvas the way AFFiNE's own `addImages` does.
 *
 * `index` IS NOT OPTIONAL, and leaving it out fails in the least helpful way
 * available: the block is created, the document is correct, and it is simply
 * absent from the gfx grid — so every spatial query, including the containment
 * test compile depends on, reports it as not there. The first draft of the
 * compile tests asserted "no references were carried" and passed for exactly
 * that reason.
 */
export function placeTestImage(
  board: TestBoard,
  xywh: string,
  props: Record<string, unknown> = {},
): string {
  const gfx = board.std.get(GfxControllerIdentifier);
  return board.store.addBlock(
    'affine:image',
    {
      sourceId: 'vsmedia:test',
      xywh,
      size: 1,
      width: 80,
      height: 45,
      index: gfx.layer.generateIndex(),
      ...props,
    },
    board.surfaceId,
  );
}
