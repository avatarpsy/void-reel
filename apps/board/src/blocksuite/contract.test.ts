/**
 * The upgrade guard.
 *
 * WHAT THIS IS FOR
 * We consume ~50 pre-1.0 `@blocksuite/*` packages that move in lockstep. Their
 * public docs describe a package set that no longer exists, so the real
 * contract is whatever their source does this week. Reading release notes is
 * not a strategy; this file is.
 *
 * It exercises every capability the board depends on against the REAL store —
 * no editor, no DOM, no mocks — so a `pnpm up @blocksuite/*` that breaks any of
 * them fails in CI, in seconds, before a user opens a board.
 *
 * It has already earned its keep: the first run disproved the shot model this
 * board was designed around (see "the shape of a shot" below).
 *
 * RULE: if the board starts depending on a new BlockSuite behaviour, it gets a
 * case here in the same commit. A dependency you have not pinned with a test is
 * a dependency you have not pinned.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { boardStoreExtensions } from './extensions.store';
import { BoardWorkspace } from './workspace';

/** A store over a throwaway in-memory board. Mirrors mountBoard's data half. */
function makeStore() {
  const workspace = new BoardWorkspace({ id: 'test-board', ydoc: new Y.Doc({ guid: 'test-board' }) });
  const doc = workspace.createDoc('test-board');
  const store = doc.getStore({ extensions: boardStoreExtensions() });
  return { workspace, doc, store };
}

/** Seed the tree the board actually uses. Returns the ids it hangs work off. */
function seed(store: ReturnType<typeof makeStore>['store']) {
  const pageId = store.addBlock('affine:page', {});
  const surfaceId = store.addBlock('affine:surface', {}, pageId);
  return { pageId, surfaceId };
}

const frames = (store: ReturnType<typeof makeStore>['store'], surfaceId: string) =>
  store.getBlock(surfaceId)!.model.children.filter(c => c.flavour === 'affine:frame');

describe('BlockSuite contract — board tree', () => {
  it('creates the page/surface root the board is built on', () => {
    const { store } = makeStore();
    const { pageId, surfaceId } = seed(store);

    expect(store.root?.id).toBe(pageId);
    expect(store.getBlock(surfaceId)?.model.flavour).toBe('affine:surface');
    // The surface must be a CHILD of page — the canvas hangs off the document
    // root, and inverting that quietly breaks every xywh coordinate.
    expect(store.root?.children.some(c => c.flavour === 'affine:surface')).toBe(true);
  });

  it('puts a frame on the SURFACE — a frame is not a page child', () => {
    const { store } = makeStore();
    const { pageId, surfaceId } = seed(store);

    // VERIFIED against affine-model/src/blocks/frame/frame-model.ts:57 —
    // `parent: ['affine:surface']`. Adding a frame to the page silently
    // produces nothing: BlockSuite logs a schema error and returns an id that
    // resolves to undefined. Our first draft did exactly that.
    expect(store.addBlock('affine:frame', { xywh: '[0,0,480,270]' }, pageId)).toBeTruthy();
    expect(frames(store, surfaceId)).toHaveLength(0);

    const frameId = store.addBlock(
      'affine:frame',
      { title: 'SCENE 1 — Cold open', xywh: '[0,0,480,270]' },
      surfaceId,
    );
    const frame = store.getBlock(frameId)?.model;
    expect(frame?.flavour).toBe('affine:frame');
    // xywh is how the board positions every shot. If this stops round-tripping,
    // shots pile up at the origin.
    expect((frame?.props as Record<string, unknown>)?.xywh).toBe('[0,0,480,270]');
  });

  /**
   * THE SHAPE OF A SHOT, and why it needed a schema override.
   *
   * A shot used to be an `affine:frame` REGION with root-level notes positioned
   * inside its bounds, because a frame does not contain blocks and
   * `affine:note` is `parent: ['@root']`. Membership was therefore geometric,
   * which is what made a reference nudged one pixel out vanish from the compiled
   * video.
   *
   * It is now one `voidspace:shot` block that owns its text and its media as
   * props. Getting it onto the canvas took one thing that is easy to miss:
   * `affine:surface` declares a CLOSED `children` allowlist, so declaring
   * `parent: ['affine:surface']` is not enough on its own — `addBlock` throws
   * inside the Yjs transaction and returns an id that resolves to nothing. Both
   * halves are asserted here because either one alone fails silently.
   */
  it('puts a voidspace:shot on the surface — the schema override is what allows it', () => {
    const { store } = makeStore();
    const { pageId, surfaceId } = seed(store);

    const shotId = store.addBlock(
      'voidspace:shot',
      { title: 'Cold open', xywh: '[0,0,640,720]', index: 'a0' },
      surfaceId,
    );
    const shot = store.getBlock(shotId)?.model;
    expect(shot?.flavour).toBe('voidspace:shot');
    expect(store.getBlock(surfaceId)!.model.children.map(c => c.id)).toContain(shotId);

    // Not a page child. The page holds the document; the canvas holds objects.
    expect(store.addBlock('voidspace:shot', { xywh: '[0,0,640,720]' }, pageId)).toBeTruthy();
    expect(store.root!.children.some(c => c.flavour === 'voidspace:shot')).toBe(false);
  });

  it('a shot carries its media as props — no second structure to keep in step', () => {
    const { store } = makeStore();
    const { surfaceId } = seed(store);

    const media = [{
      id: 'm1', kind: 'image', role: 'firstFrame',
      src: 'https://example.test/thumb.png', url: 'https://example.test/master.png',
      name: 'open.png',
    }];
    const shotId = store.addBlock(
      'voidspace:shot',
      { title: 'Cold open', xywh: '[0,0,640,720]', index: 'a0', media },
      surfaceId,
    );

    const stored = (store.getBlock(shotId)!.model.props as { media: typeof media }).media;
    expect(stored).toHaveLength(1);
    // Round-trips as plain JSON, which is what lets the agent read a shot whole.
    expect(stored[0].role).toBe('firstFrame');
    expect(stored[0].url).toBe('https://example.test/master.png');
  });

  it('registers affine:embed-html — the composition preview block', () => {
    const { store } = makeStore();
    const { pageId } = seed(store);

    // Verified in 0.22.4: EmbedHtmlBlockComponent renders
    //   <iframe sandbox="allow-scripts" .srcdoc=${html}>
    // so compositions animate, and (no allow-same-origin) cannot reach us.
    // srcdoc has no base URL — hence absolute asset URLs are mandatory.
    const id = store.addBlock(
      'affine:embed-html',
      { html: '<h1 data-slot="headline">73%</h1>', xywh: '[0,0,1080,1920]' },
      pageId,
    );

    expect(store.getBlock(id)?.model.flavour).toBe('affine:embed-html');
  });

  it('adds an image block — reference stills', () => {
    const { store } = makeStore();
    const { pageId } = seed(store);
    const id = store.addBlock('affine:image', { xywh: '[0,0,320,180]' }, pageId);
    expect(store.getBlock(id)?.model.flavour).toBe('affine:image');
  });
});

describe('BlockSuite contract — undo', () => {
  it('reverses exactly one agent mutation per undo step', () => {
    const { store } = makeStore();
    const { surfaceId } = seed(store);
    store.captureSync();

    const frameId = store.addBlock('affine:frame', { xywh: '[0,0,480,270]' }, surfaceId);
    expect(frames(store, surfaceId)).toHaveLength(1);

    store.undo();
    expect(store.getBlock(frameId)).toBeUndefined();
    expect(frames(store, surfaceId)).toHaveLength(0);

    store.redo();
    expect(frames(store, surfaceId)).toHaveLength(1);
  });

  it('coalesces a batch into ONE undo step when wrapped in a transaction', () => {
    const { store } = makeStore();
    const { surfaceId } = seed(store);
    store.captureSync();

    // The agent adds six shots in one tool call. The user's Ctrl+Z must remove
    // the storyboard, not the sixth frame — the exact failure mode Phase F
    // fixed in openreel (F2: __LAST_ADDED__ single-slot undo).
    store.transact(() => {
      for (let i = 0; i < 6; i++) {
        store.addBlock(
          'affine:frame',
          { title: `SCENE ${i + 1}`, xywh: `[${i * 500},0,480,270]` },
          surfaceId,
        );
      }
    });
    expect(frames(store, surfaceId)).toHaveLength(6);

    store.undo();
    expect(frames(store, surfaceId)).toHaveLength(0);
  });
});

describe('BlockSuite contract — persistence', () => {
  it('round-trips a board through a Yjs binary snapshot', () => {
    const a = makeStore();
    const { surfaceId } = seed(a.store);
    a.store.addBlock(
      'affine:frame',
      { title: 'SCENE 1 — Cold open', xywh: '[0,0,480,270]' },
      surfaceId,
    );

    // This is exactly what gets written to Firebase Storage.
    const snapshot = Y.encodeStateAsUpdate(a.workspace.doc);
    expect(snapshot.byteLength).toBeGreaterThan(0);

    const restoredDoc = new Y.Doc({ guid: 'test-board' });
    Y.applyUpdate(restoredDoc, snapshot);

    const b = new BoardWorkspace({ id: 'test-board', ydoc: restoredDoc });
    const bStore = b.createDoc('test-board').getStore({ extensions: boardStoreExtensions() });

    const bSurface = bStore.root!.children.find(c => c.flavour === 'affine:surface')!;
    const restored = bSurface.children.filter(c => c.flavour === 'affine:frame');
    expect(restored).toHaveLength(1);
    expect((restored[0].props as Record<string, unknown>).title).toBe('SCENE 1 — Cold open');
  });

  it('does not re-seed a board that already has content', () => {
    const ydoc = new Y.Doc({ guid: 'test-board' });
    const first = new BoardWorkspace({ id: 'test-board', ydoc });
    const firstDoc = first.createDoc('test-board');
    const firstStore = firstDoc.getStore({ extensions: boardStoreExtensions() });
    firstDoc.load(() => seed(firstStore));
    const rootId = firstStore.root!.id;

    // Reopening the SAME Y.Doc must not stack a second page on the canvas.
    const second = new BoardWorkspace({ id: 'test-board', ydoc });
    const secondDoc = second.createDoc('test-board');
    const secondStore = secondDoc.getStore({ extensions: boardStoreExtensions() });
    secondDoc.load(() => seed(secondStore));

    expect(secondStore.root!.id).toBe(rootId);
    expect(secondStore.root!.children.filter(c => c.flavour === 'affine:surface')).toHaveLength(1);
  });
});

describe('BlockSuite contract — the allowlist holds', () => {
  // Unregistered flavours are rejected by the SCHEMA: BlockSuite logs
  // "schema for flavour: X not found" and creates nothing. Note it does NOT
  // throw synchronously from addBlock — asserting `.toThrow()` passes a board
  // full of blocks that were never created. Assert on the tree instead.
  it.each(['affine:database', 'affine:code', 'affine:bookmark', 'affine:callout'])(
    'creates no block for unregistered %s',
    flavour => {
      const { store } = makeStore();
      const { pageId } = seed(store);
      const before = store.root!.children.length;
      store.addBlock(flavour as never, {}, pageId);
      expect(store.root!.children.length).toBe(before);
    },
  );

  it('documents the embed umbrella: registering embed-html brings its siblings', () => {
    const { store } = makeStore();
    const { pageId } = seed(store);

    // HONEST LIMIT. `EmbedStoreExtension` is one provider covering every embed
    // flavour, so taking `affine:embed-html` for compositions also registers
    // youtube/figma/github/loom. They are absent from every toolbar and the
    // agent has no tool that emits them, but the SCHEMA accepts them — so this
    // is a UI-level absence, not a structural one, and the plan says so rather
    // than claiming a guarantee we do not have.
    const id = store.addBlock('affine:embed-youtube', { url: 'https://x' } as never, pageId);
    expect(store.getBlock(id)?.model.flavour).toBe('affine:embed-youtube');
  });
});
