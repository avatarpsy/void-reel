/**
 * Browser entry for the board SPA.
 *
 * Mirrors how apps/web and apps/image boot: read configuration from the query
 * string the parent Nuxt page put there, mount, then talk to the parent only
 * over postMessage. The board never reaches into the parent DOM and the parent
 * never reaches into ours — the iframe boundary is the contract.
 *
 * Query params (set by pages/ai/board.vue):
 *   board  — board id; also the Y.Doc guid and the IndexedDB database name
 *   theme  — 'light' | 'dark'; thereafter the parent sends voidspace:board-theme
 */
import './theme/voidspace.css';
// The screenplay's PAGE — one stylesheet for the canvas sheet, focus mode and
// the editor both of them are. Global rather than in the block's Lit styles,
// which BlockSuite removes whenever the canvas culls the block.
import './theme/screenplay-page.css';
// Its own file, not an appendix to the theme: it carries a `@media print` block
// that has to be read as one piece to be maintainable, and it is the only place
// in the app that reasons in inches.
import './theme/screenplay-focus.css';
// AFTER the screenplay's, and dependent on it: the overlay shell and the whole
// print unwrapping are shared, and only the typography differs.
import './theme/document-view.css';

import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import { defaultApiBase, installStorageFullWatch, setBlockTokenProvider } from '@openreel/asset-browser';

import { mountBoard, type MountedBoard } from './blocksuite/editor';
import { installFrameTitleScale } from './ui/frame-title-scale';
import * as shots from './shot/shots';
import * as boardMeta from './board/board-meta';
import { installCloudSync } from './board/cloud-sync';
import { installParentAuth, getParentToken } from './board/parent-auth';
import { installBoardRpc, getBoardRev } from './agent/rpc';
import { installScreenplayFocus } from './ui/screenplay-focus';
import { installDocumentView } from './ui/document-view';
import { installDocumentFocus } from './ui/document-focus';
import { installDocumentDrop } from './document/import-drop';
import { installDocumentTags } from './document/tags';
import { installDocumentIndex } from './document/index-panel';
import { installBoardUi } from './ui/board-ui';
import { installAssetPanel } from './ui/asset-panel';
import { installMediaInspector } from './ui/media-inspector';
import { installCanvasMenu } from './ui/canvas-menu';
import { installPendingMedia } from './ui/pending-media';
import { installSpacePan } from './ui/space-pan';
import { installCanvasFocus } from './ui/canvas-focus';
import { installHistoryKeys } from './ui/history-keys';
import { installPen } from './ui/pen';
import { installSpine } from './ui/spine';
import { installToasts, toast } from './ui/toast';
import { installViewportAnchor, installPaneShift } from './ui/viewport';

/** Replace the boot overlay with a message the user can act on. Reachable before
 *  any chrome exists, so it writes into the overlay rather than a toast. */
function showBootError(message: string): void {
  const el = document.getElementById('board-boot');
  if (el) {
    el.removeAttribute('hidden');
    el.textContent = message;
  }
}

const params = new URLSearchParams(location.search);
const boardId = params.get('board') || 'scratch';
const initialTheme = params.get('theme') === 'light' ? 'light' : 'dark';

document.documentElement.dataset.theme = initialTheme;

/**
 * Force theme-derived colours to recompute after a live theme switch.
 *
 * BlockSuite's `ThemeService.theme` getter is `theme$.peek()` — an explicitly
 * NON-reactive read. So components that colour themselves from it (the frame
 * title chip is the one that matters to us: it derives its background and text
 * colour from the frame's `background` prop resolved against the current theme)
 * never re-render when the theme changes. They are correct on a fresh mount and
 * stale on a toggle, which is exactly the kind of glitch that makes a canvas
 * feel broken.
 *
 * Nudging the elements is enough — their `colors` getter re-reads the service on
 * the next render. `requestUpdate()` on the WIDGET does not work: the widget's
 * template is unchanged, so Lit re-renders nothing; the title element inside its
 * shadow root is what has to update.
 */
function repaintThemedElements(): void {
  document.querySelectorAll('affine-frame-title-widget').forEach(widget => {
    widget.shadowRoot
      ?.querySelectorAll('affine-frame-title')
      .forEach(title => (title as unknown as { requestUpdate?: () => void }).requestUpdate?.());
  });
}

/**
 * Hydrate from IndexedDB BEFORE mounting.
 *
 * Mounting first and letting persistence catch up makes the user watch their
 * board pop in a frame later — and worse, `doc.load()` would see an empty tree
 * and seed a SECOND page/surface on top of the restored one. `whenSynced` is
 * what makes the seed idempotent in practice.
 */
async function boot(): Promise<void> {
  // BEFORE anything asks for a blob. Media on the canvas are Library references,
  // so the very first thing a restored board does is fetch them — and that needs
  // a token. Starting the listener here also catches the token the parent PUSHES
  // on iframe load, which is what closes the startup race for good.
  installParentAuth();
  /**
   * Tell the shared block preview how THIS app gets a token.
   *
   * The renderer moved into `@openreel/asset-browser` so the video editor could
   * use it too, and the one thing it cannot know is where the credentials live.
   * The board has none of its own — it asks the parent page. See the package's
   * `auth.ts`.
   */
  setBlockTokenProvider(() => getParentToken());
  // Storage full on a generation → the host's "Your storage is full" sheet.
  installStorageFullWatch();

  const ydoc = new Y.Doc({ guid: boardId });
  const persistence = new IndexeddbPersistence(`voidspace-board-${boardId}`, ydoc);
  // IndexedDB can remain locked briefly after a crashed/reloaded editor tab.
  // Do not leave the user on an indefinite “Opening board…” screen: the cloud
  // pull below still protects an empty document from being seeded or saved over
  // a real board, and a delayed local restore will merge through Yjs normally.
  await Promise.race([
    persistence.whenSynced,
    new Promise<void>((resolve) => window.setTimeout(resolve, 3_000)),
  ]);

  const root = document.getElementById('board-root');
  if (!root) throw new Error('#board-root missing from index.html');

  const cloud = installCloudSync({
    boardId,
    doc: ydoc,
    apiBase: defaultApiBase(),
    shotCount: () => shots.readShots(board.std).length,
    onLocked: () => toast('This board has been compiled — it is now read-only.', 'info'),
  });

  /**
   * A BOARD THIS DEVICE HAS NEVER SEEN MUST WAIT FOR THE CLOUD.
   *
   * Two things go wrong otherwise, and both are silent:
   *
   *  • Seeding first and merging second gives the document TWO page/surface
   *    roots — the local seed and the remote one — because a CRDT merge keeps
   *    both. The canvas then renders one of them and the user's work is in the
   *    other.
   *  • If the pull FAILS on a device with nothing local, seeding anyway produces
   *    a blank board that looks legitimate, and the next autosave overwrites the
   *    real one in Storage. That is data loss caused by a dropped request.
   *
   * So: an empty local doc waits, and a pull that FAILED refuses to open rather
   * than inventing an empty canvas. A doc we already have opens instantly and
   * merges in the background, which is the common case.
   *
   * SIGNED OUT IS NOT A FAILURE. There is no cloud board for an anonymous user,
   * so there is nothing to lose and nothing to wait for — the canvas opens and
   * runs from IndexedDB. (`cloud-sync` separately refuses to SAVE a board it
   * never managed to read, so signing in later cannot push this blank document
   * over a real one.) Treating that case as an error is what made the board
   * unopenable outside the signed-in Nuxt page.
   */
  const emptyLocally = ydoc.getMap('blocks').size === 0;
  if (emptyLocally) {
    const result = await cloud.pull();
    if (result === 'failed') {
      cloud.stop();
      showBootError(
        'Couldn’t load this board. Check your connection and reload — nothing has been lost.',
      );
      return;
    }
  }

  const board: MountedBoard = mountBoard({ boardId, container: root, ydoc });

  document.getElementById('board-boot')?.setAttribute('hidden', '');

  /**
   * Old boards said "SCENE 1 — untitled" on a card whose badge says SHOT 1.
   * Rewritten once, here, because the title is carried into compile — see
   * `normaliseShotTitles` for why touching stored text is justified in this one
   * case. Runs before the cloud pull so a merge cannot resurrect the old string
   * unnoticed; anything the pull brings in is normalised on the next open.
   */
  /**
   * FRAME TITLES SCALE WITH THE VIEWPORT.
   *
   * BlockSuite pins them at a constant screen size, so at fit-zoom a title is
   * proportionally three times too big and sits on whatever is above it. See
   * ui/frame-title-scale.ts — spacing cannot fix it, because the overlap is a
   * function of zoom and the spacing is fixed in model space.
   */
  installFrameTitleScale(board.std);

  shots.normaliseShotTitles(board.std);

  /**
   * AND LAY THE BOARD OUT AS THE FILM IT IS.
   *
   * Every board made before the grid existed is one long horizontal strip; this
   * is what turns it into acts, sequences and scenes the first time it opens.
   * On a board already in the grid it writes nothing — `relayoutShots` compares
   * each card's box and skips the ones that are already right — so it is free on
   * every open after the first.
   *
   * After `normaliseShotTitles` and before the chrome, so the spine draws once,
   * against the final geometry, rather than drawing the old strip and jumping.
   */
  shots.relayoutShots(board.std, shots.readShots(board.std).map(s => s.id));

  // Already-known board: merge whatever another device did, without making the
  // user wait for it.
  if (!emptyLocally) void cloud.pull();

  /** Assigned by the chrome install below; read lazily by the RPC — see the
   *  note on `BoardRpcOptions.screenplay`. */
  let screenplay: ReturnType<typeof installScreenplayFocus> | null = null;
  /** Same lazy-getter arrangement, and for the same reason. */
  let documentView: ReturnType<typeof installDocumentView> | null = null;
  let documentFocus: ReturnType<typeof installDocumentFocus> | null = null;

  installBoardRpc(board, {
    flushCloud: () => cloud.flush(),
    screenplay: () => screenplay,
    document: () => documentView,
    documentFocus: () => documentFocus,
    pending: () => pending,
  });

  /**
   * Stop the BROWSER zooming the page on ctrl/⌘+wheel — nothing else.
   *
   * BlockSuite owns canvas zoom (`edgeless-root-block._initWheelEvent`: zoom on
   * `isTouchPadPinchEvent`, pan otherwise, shift+wheel = horizontal on Windows)
   * and calls preventDefault itself for events that REACH it. Events over our
   * own chrome — the asset panel, the toolbars — never reach it, and the browser
   * then zooms the whole app.
   *
   * BUBBLE phase, not capture. An earlier build used `capture: true`, which ran
   * before BlockSuite's dispatcher and stopped canvas zoom working at all. On
   * the bubble phase their handler goes first and this only catches what escaped.
   */
  window.addEventListener(
    'wheel',
    e => { if (e.ctrlKey || e.metaKey) e.preventDefault(); },
    { passive: false },
  );

  // Canvas zoom/pan itself is BlockSuite's — see above.
  //
  // `edgeless-root-block._initWheelEvent` already calls `preventDefault()`,
  // zooms on `isTouchPadPinchEvent` (which is ctrl/⌘+wheel) and pans otherwise,
  // with `IS_WINDOWS && shiftKey` giving horizontal scroll. An earlier build
  // added a capture-phase `preventDefault` here to stop the browser zooming the
  // page; it was redundant AND harmful — running before their dispatcher, it
  // made ctrl+scroll stop zooming the canvas at all.
  //
  // Same lesson as the inline specs and `addImages`: check for the native
  // handler before writing one.
  /**
   * Chrome is a SIBLING of the editor, never a descendant of it.
   *
   * It used to be appended INSIDE `.affine-edgeless-viewport`, which is the
   * element `ViewportElementExtension` registers as THE viewport. Putting our
   * panel and toolbars in there made them part of the editor's own event and
   * layout region, and that single mistake produced a family of glitches:
   *
   *   • Space-pan "randomly" stopped. `UIEventDispatcher` deactivates when the
   *     active element is outside its host (`_isActiveElementOutsideHost`), so
   *     focusing our search box or a tile button silently switched keyboard
   *     handling off — space stopped panning until you clicked the canvas again.
   *   • Clicks on canvas items felt dead or needed a second try: pointer events
   *     that began in our chrome were still inside the viewport the dispatcher
   *     hit-tests against.
   *
   * `#board-root` has the same bounds as the viewport it contains, so absolutely
   * positioned chrome lands in exactly the same place — with none of the above.
   */
  const chromeHost = root;
  // The film's structure, drawn UNDER the cards — see ui/spine.ts. Installed
  // before the rest of the chrome so it prepends beneath it.
  installSpine(board, chromeHost);
  installToasts(chromeHost);
  installBoardUi(board, chromeHost);
  installAssetPanel(board, chromeHost);
  installMediaInspector(board, chromeHost);
  // Hold space and drag to pan — a gesture every other canvas tool has and
  // BlockSuite does not implement at all. See space-pan.ts.
  installSpacePan(board, chromeHost);

  // The keyboard half of pen work. Lifting the pen off the tablet fires
  // `pointerleave` on the editor host, which is how BlockSuite decides its
  // dispatcher is no longer active — and with it every shortcut it binds. These
  // two put the keys back: one keeps the host focused so the whole keymap stays
  // live, the other owns undo/redo outright so they never depend on it.
  installCanvasFocus(board);
  installHistoryKeys(board);

  // Pen behaviour the tablet expects: every sample the pen took (not one per
  // frame), and a tap that erases as well as a swipe. See ui/pen.ts.
  installPen(board);
  // Select references, right-click, make something from them. The generation
  // itself is the parent's — this only turns the gesture into a request.
  installCanvasMenu(board, chromeHost);
  // A card in the spot a generation will land, for as long as it takes. Handed
  // to the RPC so the parent — which owns the generation — can raise and clear
  // it without knowing anything about the canvas.
  const pending = installPendingMedia(board, chromeHost);
  // Hold the board still when the WINDOW around it changes size — which on this
  // surface means the studio shell collapsing the agent chat and handing this
  // iframe the extra width. See `installViewportAnchor` for the why and the
  // arithmetic. Installed after the editor is mounted, so it baselines against
  // the size the board actually opened at.
  installViewportAnchor(chromeHost);
  // …and the half of it that cannot be measured from in here: the studio shell
  // collapsing the agent chat moves this iframe's LEFT edge, which from inside
  // looks like the opposite of what it is. The parent posts the delta; this
  // cancels it. See `installPaneShift`.
  installPaneShift();
  // The screenplay at page size. Installed after the panel so its overlay sits
  // above it in paint order without needing a higher z-index than the toasts.
  screenplay = installScreenplayFocus(board, chromeHost);
  // The board as a page. Same host and the same shell class, so the two focus
  // modes cannot drift apart in look or in Esc behaviour.
  documentView = installDocumentView(board, chromeHost);
  // A single document ON the canvas, at page size. Unlike the two above it
  // does not replace the canvas — the note being written IS the document, so
  // this frames the real editor rather than rebuilding one.
  documentFocus = installDocumentFocus(board, chromeHost);
  // Dropping a .md or .txt makes a DOCUMENT rather than a file card. Only
  // the formats that need no parser — see import-drop.ts.
  // Not stored: this module has no teardown path — the board lives for the
  // life of the page, which is why nothing else installed here is disposed
  // either. A disposer kept in a variable nobody calls is worse than none.
  installDocumentDrop(board, root);
  // Which box is what: a PDF/DOCX/TEXT/SCREENPLAY tag on each document's
  // corner. See document/tags.ts for why it is an attribute and not an overlay.
  installDocumentTags(board, root);
  /**
   * Pictures in documents that were already here take the size their document
   * asked for. Without this the fix only reaches documents made from now on,
   * and a board opened tomorrow shows the same full-width logo as today.
   *
   * Not awaited: it measures each picture, and a slow one must not hold up a
   * board that is already on screen and usable.
   */
  void import('./document/doc-images')
    .then((m) => m.sizeAllDocumentImages(board))
    .catch(() => { /* natural size, exactly as before */ });

  /**
   * THE DOCUMENT INDEX — what is on this board, and what is in the Library.
   *
   * Importing a library document reuses the drop path's conversion: the bytes
   * go up to the parent, which owns the only parser, and markdown comes back.
   * One route in for every document, wherever it came from.
   */
  const docIndex = installDocumentIndex(board, chromeHost, async (doc) => {
    try {
      const [{ importDocumentFromUrl }] = await Promise.all([
        import('./document/import-drop'),
      ]);
      await importDocumentFromUrl(board, doc.url, doc.label);
    } catch (err) {
      console.error('[board] library import failed:', err);
    }
  });
  chromeHost.addEventListener('voidspace-open-doc-index', () => docIndex.open());

  // Theme is pushed, never re-navigated — an iframe reload would throw away the
  // in-memory editor state and the user's viewport. Same rule apps/web follows.
  //
  // We accept the SAME `voidspace:theme` message the video and image editors
  // already receive, so the parent page reuses its existing `postThemeToEditor()`
  // verbatim instead of learning a board-specific message.
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string; mode?: string; theme?: string } | null;
    if (data?.type !== 'voidspace:theme' && data?.type !== 'voidspace:board-theme') return;
    const next = data.mode ?? data.theme;
    document.documentElement.dataset.theme = next === 'light' ? 'light' : 'dark';
    repaintThemedElements();
  });

  /**
   * FORWARD Ctrl/⌘+M TO THE PARENT.
   *
   * The mic lives in the chat column, which is in the PARENT document — and a
   * keyboard event fired inside an iframe never leaves it. So the shortcut the
   * parent registers works everywhere except over the canvas, which is exactly
   * where someone describing a shot out loud is looking. Forwarding it closes
   * that gap; the parent owns what the shortcut MEANS, this only relays the key.
   *
   * Not while typing in a shot's own fields — a hotkey that fires mid-sentence
   * in ACTION is one people learn to fear. Capture phase so BlockSuite's
   * dispatcher does not swallow it first.
   */
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key?.toLowerCase() !== 'm' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.isContentEditable || /INPUT|TEXTAREA/.test(active?.tagName ?? '')) return;
    e.preventDefault();
    window.parent?.postMessage({ type: 'voidspace:board-hotkey', key: 'toggle-voice' }, '*');
  }, true);

  // Handshake: the parent's bridge waits for this before dispatching any RPC,
  // so a tool call can never land on a half-mounted editor.
  window.parent?.postMessage(
    {
      type: 'voidspace:board-ready',
      boardId,
      surfaceId: board.surfaceId,
      pageId: board.pageId,
      rev: getBoardRev(),
    },
    '*',
  );

  // Dev/E2E affordance, mirroring openreel's `__test` hook: lets Playwright
  // drive the REAL store and the REAL shot helpers, so a test exercises the
  // same code path the agent tools will — not a reimplementation of it.
  (window as unknown as {
    __board: MountedBoard & {
      shots: typeof shots;
      meta: typeof boardMeta;
      /** Bytes this board would write to IndexedDB and to Storage.
       *
       *  THE number for "does this handle large projects": media on a board are
       *  references, so it must stay in the kilobytes no matter how much footage
       *  is on the canvas. A probe that cannot measure it cannot catch the day
       *  someone reintroduces bytes-in-document. */
      docBytes(): number;
      cloud: typeof cloud;
    };
  }).__board = Object.assign(board, {
    shots,
    meta: boardMeta,
    docBytes: () => Y.encodeStateAsUpdate(ydoc).byteLength,
    cloud,
  });
}

boot().catch((err: unknown) => {
  console.error('[board] boot failed', err);
  showBootError(`Board failed to open: ${(err as Error)?.message ?? err}`);
});
