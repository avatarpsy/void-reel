/**
 * The screenplay, full size — where it is actually written.
 *
 * ── WHY A MODE AND NOT A BIGGER CARD ─────────────────────────────────────────
 * A screenplay's format is fixed for one reason: a page runs about a minute, so
 * page count IS pacing, and a writer judges pacing by looking. That only works
 * at page size. A 640px card on a canvas is a porthole — fine for checking which
 * scenes have shots, useless for deciding whether the second act drags.
 *
 * Every writing tool that people actually finish scripts in has this mode
 * (Final Draft, Highland, iA Writer, Ulysses): one column, page proportions,
 * everything else gone.
 *
 * ── WHAT STAYS, AND WHY THAT IS NOT A COMPROMISE ─────────────────────────────
 * The agent chat stays. This is deliberately NOT the classic distraction-free
 * mode, because the thing being removed is the CANVAS, not the collaborator —
 * "rewrite scene 4 tighter", "export this as a PDF" are the reasons to be here.
 * It matches the pattern people already know from every document tool with an
 * assistant beside it, and it costs nothing to implement: the chat lives in the
 * parent page, so hiding the board's own chrome leaves it exactly where it was.
 *
 * The layout therefore does not move. The LEFT pane changes what it contains;
 * the right pane is untouched. That consistency is the point — a mode that
 * rearranges the window makes people lose their place.
 *
 * ── READ AND WRITE, NOT TWO MODES INSIDE A MODE ──────────────────────────────
 * The card splits reading (a formatted page) from editing (a raw Fountain
 * textarea) because a contenteditable fights the writer over indentation. Focus
 * keeps that split but makes the seam cheap: click any line and you are editing
 * AT that line (`offsetOfLine`), Escape puts you back on the page at the same
 * scroll position. So it behaves like one document that happens to render.
 */
import { enterFocusMode } from './focus-lock';
import { offsetOfLine } from '../shot/fountain';
import { screenplayBlock, writeScript } from '../shot/screenplay-doc';
import { rowClass, screenplayView } from '../shot/screenplay-view';
import type { MountedBoard } from '../blocksuite/editor';
import { toast } from './toast';

const ESC_HTML: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
};
const esc = (s: string) => s.replace(/[&<>"]/g, c => ESC_HTML[c]);

export interface ScreenplayFocus {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Hand the page to the browser's print pipeline — see `exportPdf`. */
  print(): void;
  /** Download the raw Fountain, which is what other screenwriting apps read. */
  downloadFountain(): void;
  destroy(): void;
}

/** Released on close, so one definition of "a focus mode is open" holds
 *  for every mode — see `focus-lock.ts`. */
let leaveFocus: (() => void) | null = null;

export function installScreenplayFocus(
  board: MountedBoard,
  container: HTMLElement,
): ScreenplayFocus {
  const el = document.createElement('div');
  el.className = 'vs-focus';
  el.hidden = true;
  container.append(el);

  let editing = false;
  /** Where the page was scrolled, so leaving the editor does not jump. */
  let readScroll = 0;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  let docSub: { unsubscribe?: () => void } | null = null;

  // ── writing ───────────────────────────────────────────────────────────────

  function commit(ta: HTMLTextAreaElement): void {
    const model = screenplayBlock(board.std);
    if (model && ta.value !== model.props.text) {
      board.store.captureSync();
      board.store.updateBlock(model, { text: ta.value });
    }
    editing = false;
    render();
    requestAnimationFrame(() => {
      const scroll = el.querySelector<HTMLElement>('[data-page-scroll]');
      if (scroll) scroll.scrollTop = readScroll;
    });
  }

  function startEditing(line?: number): void {
    readScroll = el.querySelector<HTMLElement>('[data-page-scroll]')?.scrollTop ?? 0;
    editing = true;
    render();
    requestAnimationFrame(() => {
      const ta = el.querySelector<HTMLTextAreaElement>('[data-editor]');
      if (!ta) return;
      const at = line === undefined ? ta.value.length : offsetOfLine(ta.value, line);
      ta.focus();
      ta.setSelectionRange(at, at);
      // A textarea does not scroll a PROGRAMMATIC selection into view, only a
      // typed one — so without this the caret is correctly on line 312 and the
      // view is showing line 1, which looks exactly like the click was ignored.
      if (line !== undefined) {
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
        ta.scrollTop = Math.max(0, (line - 6) * lh);
      }
    });
  }

  // ── exporting ─────────────────────────────────────────────────────────────

  /**
   * PDF, VIA THE BROWSER'S OWN PRINT PIPELINE.
   *
   * Not a JS PDF builder. The page is already correct typography — 12pt Courier,
   * the industry margins, real indents — so the only thing a library would add
   * is a second, worse implementation of a layout we already have, plus a
   * megabyte of bundle. `@media print` (see `voidspace.css`) restates the same
   * page in real inches and lets the browser paginate it, which also gets
   * widow/orphan control and a page size the user can change in the dialog.
   *
   * Printing from INSIDE the iframe prints this frame alone, which is why the
   * board's chrome does not have to be torn down first.
   *
   * The page must be in READ mode: a textarea prints as a scrolled box showing
   * whatever fitted on screen, which is the one way this could silently produce
   * a wrong document.
   */
  const menuEl = (): HTMLElement | null => el.querySelector('[data-menu]');
  const nameEl = (): HTMLInputElement | null => el.querySelector('[data-name]');

  function setMenu(open2: boolean): void {
    const menu = menuEl();
    if (!menu) return;
    menu.hidden = !open2;
    el.querySelector('[data-act="menu"]')?.setAttribute('aria-expanded', String(open2));
  }

  /**
   * Rename the screenplay by rewriting its `Title:` line.
   *
   * Fountain keeps the title on its title page, so the name IS part of the
   * script — exactly as a document's name is its first heading. Renaming edits
   * the source, which is what stops the bar, the title page and the exported
   * file ever disagreeing. A script with no title page gets one.
   */
  function rename(next: string): void {
    const value = next.trim();
    const { script, text } = screenplayView(board.std);
    if (!value || value === script.title) return;
    const line = `Title: ${value}`;
    const updated = /^\s*Title:.*$/mi.test(text)
      ? text.replace(/^\s*Title:.*$/mi, line)
      : `${line}

${text}`;
    try {
      writeScript(board.std, board.surfaceId, updated);
    } catch (e: any) {
      console.warn('[screenplay-focus] rename failed:', e?.message ?? e);
    }
  }

  let exporting = false;

  /**
   * A REAL PDF FILE, typeset here.
   *
   * This was `window.print()`: the browser's dialog, which saves nothing, hands
   * back no file and needs a person sitting in front of it. A screenwriter
   * could not get a file out of their own script. `renderScreenplayPdf` sets
   * the page at the industry's actual measurements — 12pt Courier, 1.5in left
   * margin, character cues at 3.7in — so the page count still means what a
   * reader expects it to mean.
   */
  async function exportPdf(): Promise<void> {
    const view = screenplayView(board.std);
    if (view.script.empty) {
      toast('There is no screenplay to export yet.', 'error');
      return;
    }
    if (exporting) return;
    // Commit an open edit first, or the file is of the draft they just left.
    if (editing) {
      const ta = el.querySelector<HTMLTextAreaElement>('[data-editor]');
      if (ta) commit(ta);
    }

    exporting = true;
    const buttons = el.querySelectorAll<HTMLButtonElement>('.vs-focus__btn');
    buttons.forEach(b => { b.disabled = true; });
    toast('Making your PDF…', 'info');
    try {
      const { renderScreenplayPdf } = await import('../document/screenplay-pdf');
      const { documentFileName } = await import('../document/blocks');
      const { downloadDocument } = await import('../document');
      const fresh = screenplayView(board.std);
      const out = await renderScreenplayPdf(
        fresh.script.elements ?? fresh.rows,
        { title: fresh.script.title, credit: fresh.script.credit },
      );
      const fileName = documentFileName(fresh.script.title || 'screenplay', 'pdf');
      downloadDocument({ blob: out.blob, fileName, format: 'pdf', bytes: out.blob.size });
      toast(
        out.droppedGlyphs
          ? `${fileName} — ${out.droppedGlyphs} character(s) could not be set in Courier.`
          : `Downloaded ${fileName}`,
        out.droppedGlyphs ? 'error' : 'info',
      );
    } catch (e: any) {
      console.error('[screenplay-focus] pdf failed:', e);
      toast('That PDF could not be made.', 'error');
    } finally {
      exporting = false;
      buttons.forEach(b => { b.disabled = false; });
    }
  }

  /**
   * The raw Fountain, downloaded.
   *
   * Fountain is plain text and every screenwriting app reads it, so this is the
   * export that does not lock the user in — Final Draft, Highland, Slugline and
   * WriterDuet all open it. A PDF is for sending to a person; this is for
   * carrying the work somewhere else.
   */
  function downloadFountain(): void {
    const { script, text } = screenplayView(board.std);
    if (!text.trim()) {
      toast('There is no screenplay to download yet.', 'error');
      return;
    }
    const name = (script.title || 'screenplay')
      .replace(/[^a-zA-Z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'screenplay';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.fountain`;
    a.click();
    // Revoked on the next tick — immediately would race the download starting.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${name}.fountain`, 'info');
  }

  // ── painting ──────────────────────────────────────────────────────────────

  function pageHtml(): string {
    const { rows } = screenplayView(board.std);
    return rows.map(r => {
      if (r.type === 'blank') return '<div class="el-blank"></div>';
      if (r.type === 'page_break') return '<div class="el-page_break"></div>';
      return `<div class="${rowClass(r)}"`
        + ` data-depth="${r.depth ?? ''}"`
        + ` data-mark="${esc(r.mark ?? '')}"`
        + ` data-covered="${r.covered ? 'yes' : 'no'}"`
        + ` data-line="${r.line}">${esc(r.text)}</div>`;
    }).join('');
  }

  function render(): void {
    const { script, text, stat } = screenplayView(board.std);

    el.innerHTML = `
      <header class="vs-focus__bar">
        <button type="button" class="vs-focus__back" data-act="close" title="Back to the board (Esc)">
          ← Board
        </button>
        <!--
          THE SAME BAR AS A DOCUMENT, because a screenplay IS one. The name is a
          field you click, and the formats live inside one Download — the shape
          every office suite uses, and the shape the document mode already had.
          Only the PAGE below differs, because a script's typography is
          semantic and prose typography would destroy it.
        -->
        <div class="vs-focus__title">
          <input class="vs-focus__name" data-name value="${esc(script.title)}"
                 size="${Math.max(10, Math.min(40, (script.title || '').length + 1))}"
                 spellcheck="false" aria-label="Screenplay name"
                 placeholder="Untitled screenplay" />
          ${stat ? `<span>${esc(stat)}</span>` : ''}
        </div>
        <div class="vs-focus__actions">
          <button type="button" class="vs-focus__btn" data-act="${editing ? 'read' : 'write'}">
            ${editing ? 'Done' : 'Edit'}
          </button>
          <div class="vs-focus__menu-wrap">
            <button type="button" class="vs-focus__btn vs-focus__btn--primary"
                    data-act="menu" aria-haspopup="menu" aria-expanded="false">
              Download <span class="vs-focus__caret">&#9662;</span>
            </button>
            <div class="vs-focus__menu" data-menu hidden role="menu">
              <button type="button" role="menuitem" data-act="pdf">
                <strong>PDF document</strong>
                <em>Properly formatted, with a title page. Best for sending or printing.</em>
              </button>
              <button type="button" role="menuitem" data-act="fountain">
                <strong>Fountain</strong>
                <em>The plain-text source. Opens in Final Draft, Highland and Slugline.</em>
              </button>
            </div>
          </div>
        </div>
      </header>

      ${editing
        ? `<textarea class="vs-focus__editor" data-editor spellcheck="false">${esc(text)}</textarea>`
        : `<div class="vs-focus__scroll" data-page-scroll>
             ${script.empty
               ? `<div class="vs-focus__empty">
                    <b>No screenplay yet.</b>
                    <p>Tell the agent what you want to make and it will write one — or click
                    Edit and start typing. Fountain: <code>INT. KITCHEN — DAY</code> for a scene,
                    a name in CAPS for a character.</p>
                  </div>`
               : `<article class="page" data-page>${pageHtml()}</article>`}
           </div>`}

      <footer class="vs-focus__foot">
        <span>Click any line to edit it there · Esc to go back</span>
        <span>${script.scenes.length
          ? `${script.scenes.length} scene${script.scenes.length === 1 ? '' : 's'} · about ${estimateMinutes(text)} min`
          : ''}</span>
      </footer>`;
  }

  /**
   * Runtime, from page count, the way the industry does it.
   *
   * ~55 lines to a page and roughly a minute a page. Deliberately not a
   * word-count heuristic: the reason the format is fixed is that a page of
   * dense action and a page of sparse dialogue take the same time on screen,
   * and a word count would report the opposite.
   */
  function estimateMinutes(text: string): number {
    const lines = text ? text.split('\n').length : 0;
    return Math.max(1, Math.round(lines / 55));
  }

  // ── input ─────────────────────────────────────────────────────────────────

  /** A menu that does not close when you look away is a menu in the way. */
  const onDocPointer = (e: Event) => {
    if (menuEl()?.hidden !== false) return;
    if (!(e.target as HTMLElement).closest?.('.vs-focus__menu-wrap')) setMenu(false);
  };
  document.addEventListener('pointerdown', onDocPointer, true);

  /**
   * The name commits on Enter and on blur. Escape reverts it and must NOT reach
   * the mode's own Escape, or cancelling a rename would also leave the script.
   */
  el.addEventListener('keydown', e => {
    const input = nameEl();
    if (e.target !== input) return;
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); rename(input!.value); input!.blur(); }
    if (e.key === 'Escape') { input!.value = screenplayView(board.std).script.title; input!.blur(); }
  });
  el.addEventListener('input', e => {
    const input = nameEl();
    if (e.target === input) input!.size = Math.max(10, Math.min(40, input!.value.length + 1));
  });
  el.addEventListener('focusout', e => {
    if (e.target === nameEl()) rename(nameEl()!.value);
  });

  el.addEventListener('click', e => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') { close(); return; }
    if (act === 'menu') { setMenu(menuEl()?.hidden !== false); return; }
    // `.catch` because exportPdf is async; the toast has already spoken.
    if (act === 'pdf') { setMenu(false); exportPdf().catch(() => {}); return; }
    if (act === 'fountain') { setMenu(false); downloadFountain(); return; }
    if (act === 'write') { startEditing(); return; }
    if (act === 'read') {
      const ta = el.querySelector<HTMLTextAreaElement>('[data-editor]');
      if (ta) commit(ta);
      return;
    }

    // A click on the page opens the editor AT that line — the seam between
    // reading and writing, made cheap.
    const line = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')?.dataset.line;
    if (line !== undefined && !editing) startEditing(Number(line));
  });

  el.addEventListener('blur', e => {
    const ta = (e.target as HTMLElement).closest<HTMLTextAreaElement>('[data-editor]');
    if (ta) commit(ta);
  }, true);

  // ── lifecycle ─────────────────────────────────────────────────────────────

  function open(): void {
    if (!el.hidden) return;
    render();
    el.hidden = false;
    // The board underneath must not take keys or pointer events while a modal
    // surface is over it — and `inert` is the one line that guarantees both,
    // including for the toolbar buttons the canvas renders into the same host.
    leaveFocus?.();
    leaveFocus = enterFocusMode('screenplay');

    /**
     * Repaint when the SCRIPT changes underneath — which is the common case
     * here, because the reason the chat is still on screen is so the user can
     * say "tighten scene four". Without this the agent rewrites the screenplay
     * and the page in front of the user does not move.
     */
    docSub = board.store.slots.blockUpdated.subscribe(() => {
      if (el.hidden || editing) return;   // never repaint under a caret
      const scroll = el.querySelector<HTMLElement>('[data-page-scroll]')?.scrollTop ?? 0;
      render();
      const next = el.querySelector<HTMLElement>('[data-page-scroll]');
      if (next) next.scrollTop = scroll;
    });

    onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // Escape in the editor means "stop editing", not "leave" — the same rule
      // the media inspector follows.
      if (editing) {
        const ta = el.querySelector<HTMLTextAreaElement>('[data-editor]');
        if (ta) { ta.blur(); return; }
      }
      close();
    };
    document.addEventListener('keydown', onKey, true);
  }

  function close(): void {
    if (el.hidden) return;
    if (editing) {
      const ta = el.querySelector<HTMLTextAreaElement>('[data-editor]');
      if (ta) commit(ta);
    }
    el.hidden = true;
    editing = false;
    leaveFocus?.();
    leaveFocus = null;
    docSub?.unsubscribe?.();
    docSub = null;
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onKey = null;
  }

  // The card's Focus button. An event rather than a direct call, so the block
  // stays ignorant of the chrome — the same arrangement `voidspace-open-media`
  // uses for the media inspector.
  const onOpen = () => open();
  container.addEventListener('voidspace-open-screenplay', onOpen);

  return {
    open,
    close,
    isOpen: () => !el.hidden,
    print: exportPdf,
    downloadFountain,
    destroy() {
      document.removeEventListener('pointerdown', onDocPointer, true);
      container.removeEventListener('voidspace-open-screenplay', onOpen);
      close();
      el.remove();
    },
  };
}
