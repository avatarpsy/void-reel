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
// Its own file, not an appendix to the theme: it carries a `@media print` block
// that has to be read as one piece to be maintainable, and it is the only place
// in the app that reasons in inches.
import './theme/screenplay-focus.css';

import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import { defaultApiBase } from '@openreel/asset-browser';

import { mountBoard, type MountedBoard } from './blocksuite/editor';
import * as shots from './shot/shots';
import * as boardMeta from './board/board-meta';
import { installCloudSync } from './board/cloud-sync';
import { installParentAuth } from './board/parent-auth';
import { installBoardRpc, getBoardRev } from './agent/rpc';
import { installScreenplayFocus } from './ui/screenplay-focus';
import { installBoardUi } from './ui/board-ui';
import { installAssetPanel } from './ui/asset-panel';
import { installMediaInspector } from './ui/media-inspector';
import { installSpacePan } from './ui/space-pan';
import { installToasts, toast } from './ui/toast';

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

  const ydoc = new Y.Doc({ guid: boardId });
  const persistence = new IndexeddbPersistence(`voidspace-board-${boardId}`, ydoc);
  await persistence.whenSynced;

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

  // Already-known board: merge whatever another device did, without making the
  // user wait for it.
  if (!emptyLocally) void cloud.pull();

  /** Assigned by the chrome install below; read lazily by the RPC — see the
   *  note on `BoardRpcOptions.screenplay`. */
  let screenplay: ReturnType<typeof installScreenplayFocus> | null = null;

  installBoardRpc(board, {
    flushCloud: () => cloud.flush(),
    screenplay: () => screenplay,
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
  installToasts(chromeHost);
  installBoardUi(board, chromeHost);
  installAssetPanel(board, chromeHost);
  installMediaInspector(board, chromeHost);
  // Hold space and drag to pan — a gesture every other canvas tool has and
  // BlockSuite does not implement at all. See space-pan.ts.
  installSpacePan(board, chromeHost);
  // The screenplay at page size. Installed after the panel so its overlay sits
  // above it in paint order without needing a higher z-index than the toasts.
  screenplay = installScreenplayFocus(board, chromeHost);

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
