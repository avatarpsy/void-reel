/**
 * A document, full size — where it is actually written.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SAME MODE AS THE SCREENPLAY, AND DELIBERATELY SO
 * ══════════════════════════════════════════════════════════════════════════
 * Same shell (`vs-focus`), same bar, same Escape, same promise: the LEFT pane
 * becomes one thing and the agent chat on the right does not move. That
 * consistency is the whole point — "tighten this section, then give me the
 * Word file" is one sentence, and a mode that rearranges the window makes
 * people lose their place.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BUT THE CANVAS STAYS LIVE UNDERNEATH, WHICH THE OTHERS DO NOT
 * ══════════════════════════════════════════════════════════════════════════
 * The screenplay's focus mode renders its own DOM, because a screenplay is a
 * string of Fountain and editing it means a textarea. A document is not a
 * string: it is real blocks — headings, lists, tables, images — and BlockSuite
 * already edits those beautifully, with the slash menu, inline marks and drag
 * handles the board registers anyway.
 *
 * Rebuilding that in an overlay would be writing a worse editor and then
 * keeping two copies of the document in step. So this mode does not replace
 * the canvas; it FRAMES it. The viewport is flown to the document, the board's
 * own chrome is hidden, and a bar is floated on top. What you type into is the
 * real note, so there is nothing to save, nothing to sync, and no second
 * source of truth to drift.
 *
 * The cost is honest and small: other things on the canvas can show at the
 * margins. On an infinite canvas that reads as context, not as a bug.
 */
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';
import { Text } from '@blocksuite/store';

import { toast } from './toast';
import { focusOnBounds } from './viewport';
import { noteToMarkdown, documentTitle } from '../document/note-io';
import { OPEN_DOCUMENT_EVENT } from '../document/toolbar';
import { saveDocument, uploadDocument } from '../board/document-export';

import type { MountedBoard } from '../blocksuite/editor';
import type { RenderedDocument } from '../document';

export interface DocumentFocus {
  /** Fly to this note and put the document chrome up. */
  open(noteId: string): void;
  close(): void;
  isOpen(): boolean;
  /** The note being written, or null. */
  current(): string | null;
  /**
   * Make a real file from the focused document. `upload` only from an agent,
   * which needs a URL; a person pressing a button gets the download and no
   * request at all.
   */
  exportAs(
    format: 'pdf' | 'docx' | 'md',
    opts?: { upload?: boolean },
  ): Promise<RenderedDocument & { url?: string }>;
  destroy(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c
  ));
}

function boundsOf(board: MountedBoard, noteId: string): { x: number; y: number; w: number; h: number } | null {
  const model: any = board.store.getBlock(noteId)?.model;
  if (!model?.xywh) return null;
  try {
    const [x, y, w, h] = JSON.parse(String(model.xywh));
    return { x, y, w, h };
  } catch {
    return null;
  }
}

export function installDocumentFocus(
  board: MountedBoard,
  container: HTMLElement,
): DocumentFocus {
  /**
   * `--live` is what makes this transparent to pointer events in the middle.
   * The bar must take clicks and the canvas under it must keep taking clicks
   * everywhere else — an overlay that swallows them is a document you can look
   * at and not type into, which is the most frustrating way for this to fail.
   */
  const el = document.createElement('div');
  el.className = 'vs-focus vs-focus--doc vs-focus--live';
  el.hidden = true;
  container.append(el);

  let noteId: string | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  let titleSub: { unsubscribe?: () => void } | null = null;
  let exporting = false;

  const title = (): string => (noteId ? documentTitle(board, noteId) : '');

  const menuEl = (): HTMLElement | null => el.querySelector('[data-menu]');
  const nameEl = (): HTMLInputElement | null => el.querySelector('[data-name]');

  function setMenu(open: boolean): void {
    const menu = menuEl();
    if (!menu) return;
    menu.hidden = !open;
    el.querySelector('[data-act="menu"]')?.setAttribute('aria-expanded', String(open));
  }

  /**
   * Rename the document by rewriting its first heading.
   *
   * The title is not stored anywhere separate — it IS the first line, the way
   * it is in Notion and Google Docs — so renaming has to edit the document
   * rather than a field beside it. That is also what keeps the name, the page
   * and the exported file from ever disagreeing: there is only one of them.
   *
   * A document with nothing in it gets a heading made for it, because a user
   * who types a name into an empty page has plainly just titled it.
   */
  function rename(next: string): void {
    const value = next.trim();
    if (!noteId || !value || value === title()) return;
    const note: any = board.store.getBlock(noteId)?.model;
    if (!note) return;

    const first = note.children?.[0];
    try {
      if (first?.text) {
        board.store.transact(() => first.text.replace(0, first.text.length, value));
      } else {
        board.store.addBlock(
          'affine:paragraph',
          { type: 'h1', text: new Text(value) },
          noteId,
          0,
        );
      }
    } catch (e: any) {
      console.warn('[document-focus] rename failed:', e?.message ?? e);
    }
  }

  function paint(): void {
    el.innerHTML = `
      <header class="vs-focus__bar">
        <button type="button" class="vs-focus__back" data-act="close" title="Back to the board (Esc)">
          ← Board
        </button>
        <!--
          THE NAME IS AN INPUT, because it is the one thing a person always
          wants to change and could not. It was rendered as text taken from the
          document's first heading, which meant "rename this" had no answer
          except "go and retype your own heading" — and the file inherited
          whatever that said. Word, Pages and Docs all put the name in the bar
          and let you click it; so does this, and it writes straight back to the
          heading so the page and the file can never disagree.
        -->
        <div class="vs-focus__title">
          <input class="vs-focus__name" data-name value="${esc(title())}"
                 size="${Math.max(10, Math.min(40, title().length + 1))}"
                 spellcheck="false" aria-label="Document name"
                 placeholder="Untitled document" />
          <span data-hint>Type anywhere. Press / for headings, lists and tables.</span>
        </div>
        <!--
          ONE button, not three. Three labelled .md / Word / PDF named FORMATS
          and left the verb to a caption; every office suite instead puts one
          Download where the eye goes and the formats one click inside it, each
          with the reason you would pick it.
        -->
        <div class="vs-focus__actions">
          <div class="vs-focus__menu-wrap">
            <button type="button" class="vs-focus__btn vs-focus__btn--primary"
                    data-act="menu" aria-haspopup="menu" aria-expanded="false">
              Download <span class="vs-focus__caret">▾</span>
            </button>
            <div class="vs-focus__menu" data-menu hidden role="menu">
              <button type="button" role="menuitem" data-act="pdf">
                <strong>PDF document</strong>
                <em>Looks the same everywhere. Best for sending or printing.</em>
              </button>
              <button type="button" role="menuitem" data-act="docx">
                <strong>Microsoft Word</strong>
                <em>They can edit it and comment on it. Best for a colleague.</em>
              </button>
              <button type="button" role="menuitem" data-act="md">
                <strong>Markdown</strong>
                <em>The plain-text source, for Notion, Obsidian or a repo.</em>
              </button>
            </div>
          </div>
        </div>
      </header>`;
  }

  function open(id: string, opts: { focusName?: boolean } = {}): void {
    const bounds = boundsOf(board, id);
    if (!bounds) {
      toast('That document is not on the board any more.', 'error');
      return;
    }
    noteId = id;
    paint();
    el.hidden = false;
    // Hides the board's own chrome — the same attribute the screenplay's focus
    // mode uses, so the two modes cannot drift apart in what they conceal.
    container.setAttribute('data-focus-mode', 'document');
    /**
     * ── AND ON THE BODY, WHICH IS NOT REDUNDANT ───────────────────────────
     *
     * The attribute above is on the CHROME host, so it can only reach our own
     * bar and panels. The thing that has to change is inside the EDITOR host, a
     * sibling: AFFiNE covers every note on a canvas with an
     * `edgeless-note-mask`, so a single click SELECTS the note and only a
     * double click gets you a caret. Correct for a sticky note on a canvas and
     * wrong for a document — this mode's own header says "type anywhere", and
     * a user who clicks and gets a selection box concludes it is read-only.
     */
    document.body.setAttribute('data-doc-focus', '');

    /**
     * ── DROP THE SELECTION ────────────────────────────────────────────────
     *
     * You almost always arrive here from selecting the document, and the
     * selection brings its canvas furniture with it: resize handles at the
     * corners and AFFiNE's element toolbar floating over the first paragraph.
     * That is the right chrome for an OBJECT you are arranging and the wrong
     * chrome for a PAGE you are reading — it sits on top of the words, and it
     * invites dragging the thing you are about to type into.
     */
    try {
      board.std.get(GfxControllerIdentifier).selection.clear();
    } catch { /* selection is a nicety here; never block opening over it */ }

    focusOnBounds(bounds);

    /**
     * Repaint the header as the document is typed into. The title IS the first
     * heading, so a header that does not follow it shows the wrong name on the
     * file the user is about to export.
     */
    titleSub = board.store.slots.blockUpdated.subscribe(() => {
      const input = nameEl();
      // NOT while they are typing in it — writing the document's value back
      // into the field mid-edit fights the user for their own cursor.
      if (input && document.activeElement !== input && input.value !== title()) {
        input.value = title();
      }
    });

    /**
     * Name first, for a document that has just been created. After the paint
     * above, and selected rather than merely focused, so typing replaces the
     * placeholder instead of appending to it.
     */
    if (opts.focusName) {
      requestAnimationFrame(() => {
        const input = nameEl();
        input?.focus();
        input?.select();
      });
    }

    if (!onKey) {
      onKey = (e: KeyboardEvent) => {
        // Escape belongs to the EDITOR first: it closes the slash menu, clears
        // a selection, leaves a table cell. Only an Escape nobody else wanted
        // should close the mode, so this listens on the way up, not down.
        if (e.key !== 'Escape' || e.defaultPrevented || el.hidden) return;
        // The menu is the innermost thing open, so it goes first — Escape
        // closing the document out from under an open menu is a surprise.
        if (menuEl()?.hidden === false) { setMenu(false); return; }
        close();
      };
      document.addEventListener('keyup', onKey);
    }
  }

  function close(): void {
    setMenu(false);
    el.hidden = true;
    noteId = null;
    container.removeAttribute('data-focus-mode');
    document.body.removeAttribute('data-doc-focus');
    titleSub?.unsubscribe?.();
    titleSub = null;
  }

  async function exportAs(
    format: 'pdf' | 'docx' | 'md',
    opts: { upload?: boolean } = {},
  ): Promise<RenderedDocument & { url?: string }> {
    if (!noteId) throw new Error('No document is open.');
    // One at a time: a second press while the first is still typesetting is two
    // full passes over the same document.
    if (exporting) throw new Error('A document is already being made — one moment.');

    const markdown = await noteToMarkdown(board, noteId);
    if (!markdown.trim()) throw new Error('This document is empty.');

    exporting = true;
    const label = format === 'docx' ? 'Word document' : format === 'pdf' ? 'PDF' : 'markdown file';
    const buttons = el.querySelectorAll<HTMLButtonElement>('.vs-focus__btn');
    buttons.forEach(b => { b.disabled = true; });
    if (format !== 'md') toast(`Making your ${label}…`, 'info');
    try {
      const made = await saveDocument(markdown, title(), format);
      const out = opts.upload ? await uploadDocument(made) : made;
      toast(
        made.droppedGlyphs
          ? `${made.fileName} — ${made.droppedGlyphs} character`
            + `${made.droppedGlyphs === 1 ? '' : 's'} (emoji or non-Latin) could not be set in a `
            + 'PDF. Try Word for those.'
          : `Downloaded ${made.fileName}`,
        made.droppedGlyphs ? 'error' : 'info',
      );
      return out;
    } catch (e: any) {
      toast(e?.message || `That ${label} could not be made.`, 'error');
      // Rethrown: the button already showed the message, and an AGENT caller
      // must not be told a file exists when none does.
      throw e;
    } finally {
      exporting = false;
      buttons.forEach(b => { b.disabled = false; });
    }
  }

  /**
   * The bar raises the intent; this overlay owns itself — the same arrangement
   * `document-view` uses for `voidspace-open-document`, so the two focus modes
   * are opened the same way and neither reaches into the other.
   */
  const onOpenRequest = (e: Event) => {
    const detail = (e as CustomEvent<{ noteId?: string; focusName?: boolean }>).detail;
    if (detail?.noteId) open(detail.noteId, { focusName: detail.focusName });
  };
  // On `document`, not the container: the request now comes from AFFiNE's
  // contextual toolbar, which is inside the EDITOR host and so never bubbles
  // through the chrome host this overlay lives in.
  document.addEventListener(OPEN_DOCUMENT_EVENT, onOpenRequest);

  el.addEventListener('click', e => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') { close(); return; }
    if (act === 'menu') { setMenu(menuEl()?.hidden !== false); return; }
    // `.catch` and not `void`: exportAs rethrows for its agent caller, and an
    // unhandled rejection here would log an error for a failure the user has
    // already seen as a toast.
    if (act === 'md' || act === 'docx' || act === 'pdf') {
      setMenu(false);
      exportAs(act as 'md' | 'docx' | 'pdf').catch(() => {});
    }
  });

  /** A menu that does not close when you look away is a menu in the way. */
  const onDocClick = (e: Event) => {
    if (menuEl()?.hidden !== false) return;
    if (!(e.target as HTMLElement).closest?.('.vs-focus__menu-wrap')) setMenu(false);
  };
  document.addEventListener('pointerdown', onDocClick, true);

  /**
   * Renaming commits on Enter and on blur — the two moments a person means
   * "that is the name". Escape puts the old one back, and must NOT reach the
   * mode's own Escape handler, or cancelling a rename would also throw you out
   * of the document.
   */
  el.addEventListener('keydown', e => {
    const input = nameEl();
    if (e.target !== input) return;
    if (e.key === 'Enter') { e.preventDefault(); rename(input!.value); input!.blur(); }
    if (e.key === 'Escape') { e.stopPropagation(); input!.value = title(); input!.blur(); }
  });
  /** The field hugs its content, so the width has to follow the typing. */
  el.addEventListener('input', e => {
    const input = nameEl();
    if (e.target === input) input!.size = Math.max(10, Math.min(40, input!.value.length + 1));
  });

  el.addEventListener('focusout', e => {
    if (e.target === nameEl()) rename(nameEl()!.value);
  });

  return {
    open,
    close,
    isOpen: () => !el.hidden,
    current: () => noteId,
    exportAs,
    destroy() {
      document.removeEventListener(OPEN_DOCUMENT_EVENT, onOpenRequest);
      document.removeEventListener('pointerdown', onDocClick, true);
      if (onKey) document.removeEventListener('keyup', onKey);
      onKey = null;
      titleSub?.unsubscribe?.();
      container.removeAttribute('data-focus-mode');
      document.body.removeAttribute('data-doc-focus');
      el.remove();
    },
  };
}
