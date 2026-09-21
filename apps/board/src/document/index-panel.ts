/**
 * Every document, in one list.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ══════════════════════════════════════════════════════════════════════════
 * Documents live as notes on an infinite canvas, which is right for editing and
 * hopeless for finding: with three of them you are panning around looking for a
 * page you cannot see. Every document tool ever made has a list — Word's recent
 * files, Docs' home, Notion's sidebar — because "where is the thing I wrote" is
 * the second question anybody asks, right after "how do I write one".
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TWO SOURCES, ONE LIST — AND THE DIFFERENCE IS STATED
 * ══════════════════════════════════════════════════════════════════════════
 * ON THIS BOARD — notes you can open and edit right now.
 * IN YOUR LIBRARY — every PDF, Word file and document you have uploaded or
 *   exported, from any board and any surface, catalogued by the same Library
 *   the images live in.
 *
 * They are NOT the same thing and the list must not pretend they are: one
 * opens, the other has to be imported first. Showing them in one place with two
 * headings is what makes "that brief I uploaded last week" findable without
 * teaching anybody where Voidspace keeps its files.
 *
 * The library half is fetched through the PARENT, which owns the session — the
 * board has no credentials of its own, and the same request/response shape
 * carries it as everything else the board asks upwards.
 */
import { toast } from '../ui/toast';
import { arrangeDocuments, documentBoxes } from './layout';
import { requestOpenDocument } from './toolbar';

import type { MountedBoard } from '../blocksuite/editor';

export interface LibraryDocument {
  id: string;
  label: string;
  url: string;
  createdAt?: string;
}

const LIST_TIMEOUT_MS = 12_000;

/**
 * Ask the parent for the user's document library.
 *
 * Resolves to an empty list rather than throwing: the on-board half of this
 * index is always available, and a library that will not load should cost the
 * user that section, not the whole list.
 */
export function fetchLibraryDocuments(): Promise<LibraryDocument[]> {
  if (!window.parent || window.parent === window) return Promise.resolve([]);
  return new Promise((resolve) => {
    const requestId = `docs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { cleanup(); resolve([]); }, LIST_TIMEOUT_MS);
    const onMsg = (e: MessageEvent) => {
      const d = e.data as any;
      if (d?.type !== 'voidspace:board-docs-listed' || d?.requestId !== requestId) return;
      cleanup();
      resolve(Array.isArray(d.items) ? d.items : []);
    };
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMsg); };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: 'voidspace:board-list-docs', requestId }, '*');
  });
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c
  ));
}

/** "2,400 words" reads as a size; "2400" reads as an id. */
const words = (n: number) => `${n.toLocaleString()} word${n === 1 ? '' : 's'}`;

export interface DocumentIndex {
  open(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function installDocumentIndex(
  board: MountedBoard,
  container: HTMLElement,
  onImport: (doc: LibraryDocument) => void | Promise<void>,
): DocumentIndex {
  const el = document.createElement('div');
  el.className = 'vs-doc-index';
  el.hidden = true;
  container.append(el);

  let libraryCache: LibraryDocument[] | null = null;

  function paint(loadingLibrary: boolean): void {
    // `documentBoxes`, not `listDocuments`: the same documents, in the order
    // they are READ — left to right along the shelf, then down. A list that
    // disagrees with the canvas about which page is first is a list you have to
    // check against the canvas, which is the job it was supposed to do for you.
    const here = documentBoxes(board);
    const there = (libraryCache ?? []).filter(
      // A library row whose name matches something already open here is noise:
      // the user is looking at it, and importing a second copy is never what
      // they meant by clicking a list.
      (d) => !here.some((h) => h.title && d.label.toLowerCase().startsWith(h.title.toLowerCase())),
    );

    el.innerHTML = `
      <div class="vs-doc-index__head">
        <strong>Documents</strong>
        <div class="vs-doc-index__actions">
          ${here.length > 1
            ? '<button type="button" class="vs-doc-index__tidy" data-a="tidy">Tidy up</button>'
            : ''}
          <button type="button" class="vs-doc-index__close" data-a="close" aria-label="Close">×</button>
        </div>
      </div>

      <div class="vs-doc-index__group">
        <h4>On this board</h4>
        ${here.length
          ? here.map((d) => `
            <button type="button" class="vs-doc-index__row" data-a="open" data-id="${esc(d.noteId)}">
              <span class="vs-doc-index__name">${esc(d.title || 'Untitled document')}</span>
              <span class="vs-doc-index__meta">${esc(words(d.words))}</span>
            </button>`).join('')
          : `<p class="vs-doc-index__empty">Nothing yet. Press <b>New document</b>, or drop a
               .md, .docx or .pdf onto the canvas.</p>`}
      </div>

      <div class="vs-doc-index__group">
        <h4>In your library</h4>
        ${loadingLibrary
          ? '<p class="vs-doc-index__empty">Looking…</p>'
          : there.length
            ? there.map((d) => `
              <button type="button" class="vs-doc-index__row" data-a="import" data-id="${esc(d.id)}">
                <span class="vs-doc-index__name">${esc(d.label || 'Document')}</span>
                <span class="vs-doc-index__meta">Open a copy</span>
              </button>`).join('')
            : `<p class="vs-doc-index__empty">Documents you upload or export show up here,
                 from every board.</p>`}
      </div>`;
  }

  function open(): void {
    paint(libraryCache === null);
    el.hidden = false;
    /**
     * Fetched on OPEN, not on mount, and cached for the session. A list nobody
     * looked at should cost nothing, and a user opening it twice in a minute
     * should not wait twice.
     */
    if (libraryCache === null) {
      void fetchLibraryDocuments().then((items) => {
        libraryCache = items;
        if (!el.hidden) paint(false);
      });
    }
  }

  const close = () => { el.hidden = true; };

  el.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    const action = row?.dataset.a;
    if (action === 'close') { close(); return; }
    /**
     * Tidy up is a BUTTON, never automatic.
     *
     * Rearranging somebody's canvas without being asked is help nobody wanted —
     * a page parked next to a shot is parked there on purpose. But a board can
     * hold documents placed before any of this existed, sitting exactly on top
     * of each other with nothing on the canvas to say there are two.
     */
    if (action === 'tidy') {
      const moved = arrangeDocuments(board);
      paint(libraryCache === null);
      toast(
        moved
          ? `Arranged ${moved} document${moved === 1 ? '' : 's'}.`
          : 'Your documents are already tidy.',
        'info',
      );
      return;
    }
    if (action === 'open') {
      close();
      requestOpenDocument(row!.dataset.id!);
      return;
    }
    if (action === 'import') {
      const doc = (libraryCache ?? []).find((d) => d.id === row!.dataset.id);
      if (!doc) return;
      close();
      toast(`Opening ${doc.label}…`, 'info');
      void onImport(doc);
    }
  });

  // Clicking away closes it — a list left open over the canvas is in the way.
  const onAway = (e: Event) => {
    if (el.hidden) return;
    const t = e.target as HTMLElement;
    if (!t.closest?.('.vs-doc-index') && !t.closest?.('[data-act="doc-index"]')) close();
  };
  document.addEventListener('pointerdown', onAway, true);

  return {
    open,
    close,
    isOpen: () => !el.hidden,
    destroy() {
      document.removeEventListener('pointerdown', onAway, true);
      el.remove();
    },
  };
}
