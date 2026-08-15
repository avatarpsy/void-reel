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
import { offsetOfLine } from '../shot/fountain';
import { screenplayBlock } from '../shot/screenplay-doc';
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
  function exportPdf(): void {
    const { script } = screenplayView(board.std);
    if (script.empty) {
      toast('There is no screenplay to export yet.', 'error');
      return;
    }
    const wasEditing = editing;
    if (wasEditing) {
      const ta = el.querySelector<HTMLTextAreaElement>('[data-editor]');
      if (ta) commit(ta);
    }
    if (el.hidden) open();

    // After the render that read mode just queued, or the print snapshot is of
    // the editor that is on its way out. `data-focus-mode` is already set by
    // `open()` and is what gates the print stylesheet — so there is no separate
    // printing flag to keep in step.
    // Guarded because this fires from a rAF callback, where a throw is an
    // UNCAUGHT exception with no stack pointing back here. Every browser has
    // `print`; test DOMs do not, and the resulting uncaught error is the kind
    // of noise that hides a real one.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (typeof window.print === 'function') window.print();
    }));
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
        <div class="vs-focus__title">
          <strong>${esc(script.title || 'Untitled screenplay')}</strong>
          ${stat ? `<span>${esc(stat)}</span>` : ''}
        </div>
        <div class="vs-focus__actions">
          <button type="button" class="vs-focus__btn" data-act="${editing ? 'read' : 'write'}">
            ${editing ? 'Done' : 'Edit'}
          </button>
          <button type="button" class="vs-focus__btn" data-act="fountain" title="Download the plain-text source — opens in Final Draft, Highland, Slugline">
            .fountain
          </button>
          <button type="button" class="vs-focus__btn vs-focus__btn--primary" data-act="pdf" title="Export a properly formatted PDF">
            Export PDF
          </button>
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

  el.addEventListener('click', e => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') { close(); return; }
    if (act === 'pdf') { exportPdf(); return; }
    if (act === 'fountain') { downloadFountain(); return; }
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
    document.documentElement.dataset.focusMode = 'screenplay';

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
    delete document.documentElement.dataset.focusMode;
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
      container.removeEventListener('voidspace-open-screenplay', onOpen);
      close();
      el.remove();
    },
  };
}
