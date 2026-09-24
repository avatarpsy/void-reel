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
 * The chat lives in the parent page, so hiding the board's own chrome leaves it
 * exactly where it was; the LEFT pane changes what it holds and nothing moves.
 *
 * ── THE PAGE IS THE EDITOR ───────────────────────────────────────────────────
 * It was a formatted page you clicked to swap for a textarea of raw Fountain —
 * two views that could never look alike. Now it is the same editor the canvas
 * sheet is (`shot/screenplay-editor.ts`), always writable: click anywhere and
 * type, and the line formats itself as a scene heading, a cue, dialogue or a
 * transition as you go. It saves as you pause, and again on the way out.
 */
import { enterFocusMode } from './focus-lock';
import { screenplayBlock, writeScript } from '../shot/screenplay-doc';
import { createScreenplayEditor, type ScreenplayEditor } from '../shot/screenplay-editor';
import { screenplayView, shotsByScene } from '../shot/screenplay-view';
import type { MountedBoard } from '../blocksuite/editor';
import { toast } from './toast';

const ESC_HTML: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
};
const esc = (s: string) => s.replace(/[&<>"]/g, c => ESC_HTML[c]);

/** One save per pause in the typing. */
const SAVE_AFTER_MS = 450;

export interface ScreenplayFocus {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** A real PDF of the script, saved to the user's downloads — see `exportPdf`.
   *  Resolves to what was made, or null when nothing was. */
  print(): Promise<{ fileName: string; pages: number } | null>;
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

  let editor: ScreenplayEditor | null = null;
  /** The block's text as of the last time this editor and it agreed. */
  let synced = '';
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  let docSub: { unsubscribe?: () => void } | null = null;
  let docQueued = false;

  const menuEl = (): HTMLElement | null => el.querySelector('[data-menu]');
  const nameEl = (): HTMLInputElement | null => el.querySelector('[data-name]');
  const hintEl = (): HTMLElement | null => el.querySelector('[data-hint]');

  // ── writing ───────────────────────────────────────────────────────────────

  /** Write the editor's text to the block, if it differs. One undo step each. */
  function save(): void {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const model = screenplayBlock(board.std);
    const next = editor?.text();
    if (!model || next === undefined) return;
    synced = next;
    if (next === model.props.text) return;
    board.store.captureSync();
    board.store.updateBlock(model, { text: next });
  }

  function queueSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(); paintHint(); }, SAVE_AFTER_MS);
  }

  /**
   * FROM OUTSIDE — the agent rewrote the script while it was open, which is
   * the reason the chat stays on screen. Taken whenever this editor has
   * nothing unsaved, focused or not: a caret blinking on the page must not
   * stop "tighten scene four" from appearing. With unsaved typing, the typing
   * wins — it is newer, and it is about to be saved.
   */
  function takeOutside(): void {
    if (!editor) return;
    const text = screenplayBlock(board.std)?.props.text ?? '';
    if (text === synced) return;
    if (editor.text() === synced) editor.setText(text);
    synced = text;
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
    save();
    const { script, text } = screenplayView(board.std);
    if (!value || value === script.title) return;
    const line = `Title: ${value}`;
    const updated = /^\s*Title:.*$/mi.test(text)
      ? text.replace(/^\s*Title:.*$/mi, line)
      : `${line}\n\n${text}`;
    try {
      writeScript(board.std, board.surfaceId, updated);
      takeOutside();
    } catch (e: any) {
      console.warn('[screenplay-focus] rename failed:', e?.message ?? e);
    }
  }

  // ── exporting ─────────────────────────────────────────────────────────────

  function setMenu(open2: boolean): void {
    const menu = menuEl();
    if (!menu) return;
    menu.hidden = !open2;
    el.querySelector('[data-act="menu"]')?.setAttribute('aria-expanded', String(open2));
  }

  let exporting = false;

  /**
   * A REAL PDF FILE, typeset here — set at the industry's measurements by the
   * same layout the page on screen marks its page breaks from, so the page
   * count in the bar is the page count in the file.
   */
  async function exportPdf(): Promise<{ fileName: string; pages: number } | null> {
    save();
    const view = screenplayView(board.std);
    if (view.script.empty) {
      toast('There is no screenplay to export yet.', 'error');
      return null;
    }
    if (exporting) return null;

    exporting = true;
    const buttons = el.querySelectorAll<HTMLButtonElement>('.vs-focus__btn');
    buttons.forEach(b => { b.disabled = true; });
    toast('Making your PDF…', 'info');
    try {
      const { renderScreenplayPdf } = await import('../document/screenplay-pdf');
      const { documentFileName } = await import('../document/blocks');
      const { downloadDocument } = await import('../document');
      const out = await renderScreenplayPdf(
        view.script.elements,
        { title: view.script.title, credit: view.script.credit },
      );
      const fileName = documentFileName(view.script.title || 'screenplay', 'pdf');
      downloadDocument({ blob: out.blob, fileName, format: 'pdf', bytes: out.blob.size });
      toast(
        out.droppedGlyphs
          ? `${fileName} — ${out.droppedGlyphs} character(s) could not be set in Courier.`
          : `Downloaded ${fileName}`,
        out.droppedGlyphs ? 'error' : 'info',
      );
      return { fileName, pages: out.pages };
    } catch (e: any) {
      console.error('[screenplay-focus] pdf failed:', e);
      toast('That PDF could not be made.', 'error');
      return null;
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
    save();
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

  /**
   * Beside the name — the slot a document uses for its hint. Pages, runtime
   * and coverage: the three numbers a storyboard is worked by. Pages come from
   * the same layout the PDF is set by, so "12 pages" is what prints.
   */
  function paintHint(): void {
    const hint = hintEl();
    if (!hint || !editor) return;
    const pages = editor.pages();
    if (!pages) {
      hint.textContent = 'Type anywhere — a line like INT. KITCHEN — DAY starts a scene';
      return;
    }
    const { stat } = screenplayView(board.std);
    const facts = [`${pages} page${pages === 1 ? '' : 's'}`, `about ${pages} min`];
    if (stat) facts.push(stat);
    hint.textContent = facts.join(' · ');
  }

  function paint(): void {
    const { script } = screenplayView(board.std);
    el.innerHTML = `
      <header class="vs-focus__bar">
        <button type="button" class="vs-focus__back" data-act="close" title="Back to the board (Esc)">
          ← Board
        </button>
        <!--
          THE SAME BAR AS A DOCUMENT, because a screenplay IS one: the name is
          a field you click, the formats live inside one Download, and the hint
          beside the name carries the page count, runtime and coverage.
        -->
        <div class="vs-focus__title">
          <input class="vs-focus__name" data-name value="${esc(script.title)}"
                 size="${Math.max(10, Math.min(40, (script.title || '').length + 1))}"
                 spellcheck="false" aria-label="Screenplay name"
                 placeholder="Untitled screenplay" />
          <span data-hint></span>
        </div>
        <div class="vs-focus__actions">
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
      <div class="vs-focus__scroll" data-page-scroll>
        <div class="sp-sheet sp-focus-page" data-page></div>
      </div>`;
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
    /**
     * A click in the grey around the sheet writes at the end — the page is
     * a document, and there is nowhere on it that should do nothing.
     */
    if ((e.target as HTMLElement).matches('[data-page-scroll]')) editor?.focusAt();
  });

  // ── lifecycle ─────────────────────────────────────────────────────────────

  function open(): void {
    if (!el.hidden) return;
    paint();
    el.hidden = false;
    // The board underneath must not take keys or pointer events while a modal
    // surface is over it — see `focus-lock.ts`.
    leaveFocus?.();
    leaveFocus = enterFocusMode('screenplay');

    const mount = el.querySelector<HTMLElement>('[data-page]')!;
    synced = screenplayBlock(board.std)?.props.text ?? '';
    editor = createScreenplayEditor(mount, {
      text: synced,
      editable: true,
      coverage: shotsByScene(board.std),
      placeholder: 'Type anywhere. INT. KITCHEN — DAY starts a scene; a NAME in capitals, then a line under it, is dialogue.',
      onChange: () => queueSave(),
      onBlur: () => save(),
    });
    paintHint();
    // An empty script is an invitation to type, so the caret is already there.
    if (!synced.trim()) editor.focusAt();

    /**
     * Follow the board while open: coverage as shots are made, and the script
     * itself when the agent rewrites it. Coalesced to a frame — `blockUpdated`
     * fires on every pointermove of a drag on the canvas behind.
     */
    docSub = board.store.slots.blockUpdated.subscribe(() => {
      if (el.hidden || docQueued) return;
      docQueued = true;
      requestAnimationFrame(() => {
        docQueued = false;
        if (el.hidden || !editor) return;
        editor.setCoverage(shotsByScene(board.std));
        takeOutside();
        paintHint();
      });
    });

    onKey = (ev: KeyboardEvent) => {
      /**
       * PRINTING MAKES THE PDF. The page is an editor that draws only the lines
       * on screen, so the browser's print would stop after a screenful — and
       * the real file is set by the same layout as the page breaks you see.
       */
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'p') {
        ev.preventDefault();
        exportPdf().catch(() => {});
        return;
      }
      if (ev.key !== 'Escape') return;
      // The name field and the open menu each own their Escape first.
      if (ev.target === nameEl()) return;
      if (menuEl()?.hidden === false) { setMenu(false); return; }
      close();
    };
    document.addEventListener('keydown', onKey, true);
  }

  function close(): void {
    if (el.hidden) return;
    save();
    setMenu(false);
    el.hidden = true;
    editor?.destroy();
    editor = null;
    leaveFocus?.();
    leaveFocus = null;
    docSub?.unsubscribe?.();
    docSub = null;
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onKey = null;
  }

  // The board bar's "Open in focus", with the screenplay selected. An event
  // rather than a direct call, so the bar stays ignorant of the overlay — the
  // same arrangement documents use.
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
