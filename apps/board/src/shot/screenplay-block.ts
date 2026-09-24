/**
 * The screenplay, rendered as a screenplay — on the same sheet as a document.
 *
 * ── WHY IT LOOKS LIKE THIS ───────────────────────────────────────────────────
 * A script has a typographic form that is a hundred years old and every writer
 * recognises: 12pt Courier, sluglines hard left in caps, action full width,
 * character names indented to about 3.7in, dialogue in a narrow column beneath.
 * Those measurements are not decoration — they are why a page of screenplay runs
 * roughly a minute, which is the only reason anyone can judge pacing by looking.
 *
 * The block is 640 wide, which is within a hair of US letter's proportions, so
 * this card is the focus page (`theme/screenplay-focus.css`) at 0.78 scale:
 * the same margins, the same indents, the same rhythm. What you glance at on
 * the canvas is a miniature of what you read in focus and of what prints.
 *
 * ── AND IT IS THE SAME OBJECT AS A DOCUMENT ──────────────────────────────────
 * It used to be a card: a header strip with its own name, a coverage count and
 * Focus/Edit buttons, around a grey gutter, around a page. Beside a document —
 * a plain sheet with a tag on its corner — it read as a different product. Now
 * it is the sheet. The tag says SCREENPLAY (and how many scenes have shots;
 * see `document/tags.ts`), and it behaves like a document:
 *
 *   click          selects it, and a drag moves it, like any object
 *   double-click   writes, at the line under the pointer
 *   the board bar  "Open in focus" appears when it is selected (`ui/board-ui.ts`)
 *
 * ── EDITING ──────────────────────────────────────────────────────────────────
 * Reading is the default; writing is a mode. Double-click swaps the rendered
 * page for a plain textarea holding the raw Fountain, and blur commits. That
 * split exists because the two things want opposite layouts: you read a
 * formatted page, and you write plain text where every character is where you
 * put it. A contenteditable that tried to be both would fight the writer over
 * indentation. The textarea sits on the same sheet, so the switch reads as the
 * page becoming editable rather than as a different widget appearing.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * No sequence rows, no scene forms, no purpose dropdowns, no duration fields.
 * The structure is IN the text — `#` acts, `##` sequences, sluglines — and
 * anything that needs it parses it. Nothing about the film is authored twice.
 */
import { GfxBlockComponent } from '@blocksuite/std';
import { css, html, unsafeCSS } from 'lit';
import { state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { offsetOfLine } from './fountain';
import { type ScreenplayBlockModel } from './screenplay-doc';
import { rowClass, screenplayView, type ScreenplayRow } from './screenplay-view';
import { blockScrollWheel } from '../ui/wheel';

/** The Courier the focus page and the PDF are set in, in the same order. */
const COURIER = `'Courier Prime', 'Courier Final Draft', 'Courier Screenplay', 'Nimbus Mono PS', 'Courier New', Courier, monospace`;

export class ScreenplayBlockComponent extends GfxBlockComponent<ScreenplayBlockModel> {
  static override styles = css`
    voidspace-screenplay {
      display: block;
      width: 100%;
      height: 100%;
    }

    /* THE SHEET — the same paper, edge and corner as a document on the canvas.
       Tokens from voidspace.css, which both read, so the two cannot drift. */
    .sp {
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      overflow: hidden;
      background: var(--page-bg);
      color: var(--page-ink);
      border-radius: 3px;
      box-shadow: var(--page-shadow);
    }

    /* The focus page at 0.78 scale: 96/96/96/144px there, 75/75/75/113 here —
       1in round, 1.5in on the binding side. Courier at 12.5px is 12pt on a
       sheet this wide, so an action line holds the same ~60 characters it
       does on paper and the card wraps where the printed page will. */
    .sp__page,
    .sp__editor {
      flex: 1;
      min-height: 0;
      box-sizing: border-box;
      padding: 75px 60px 75px 113px;
      font-family: ${unsafeCSS(COURIER)};
      font-size: 12.5px;
      color: var(--page-ink);
    }
    /* The scrollbar only while the pointer is on the page. A document's sheet
       has none, and a bar drawn down the edge at rest read as a frame round
       this one. Coloured rather than removed, so the text does not reflow
       when it appears. */
    .sp__page {
      overflow-y: auto;
      line-height: 1.15;
      white-space: pre-wrap;
      word-break: break-word;
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
    }
    .sp:hover .sp__page { scrollbar-color: var(--page-rule) transparent; }

    /* Indents as a fraction of the 6in content box — the focus page's numbers. */
    .el-scene_heading {
      text-transform: uppercase;
      font-weight: 700;
      margin: 19px 0 8px;
      letter-spacing: 0.02em;
    }
    .el-action { margin: 0 0 8px; }
    .el-character { margin: 12px 0 0 36.7%; text-transform: uppercase; }
    .el-parenthetical { margin: 0 0 0 25%; }
    .el-dialogue { margin: 0 25% 0 16.7%; }
    .el-transition { text-align: right; text-transform: uppercase; margin: 11px 0 12px; }
    .el-centered { text-align: center; margin: 11px 0; }
    .el-blank { height: 1em; }
    .el-page_break { border-top: 1px dashed var(--page-rule); margin: 19px 0; height: 0; }

    /* THE TITLE PAGE — centred, as it prints. It used to show as the raw
       'Title: …' lines, which is the source, not the page. */
    .el-title_field {
      text-align: center;
      color: var(--page-synopsis);
    }
    .el-title_field[data-key='title'] {
      color: var(--page-ink);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-top: 1em;
    }
    .el-title_field[data-key='credit'],
    .el-title_field[data-key='author'],
    .el-title_field[data-key='authors'] { color: var(--page-ink); margin: 1em 0 0.5em; }
    .el-title_field + .el-blank { height: 2.5em; }

    /* SECTIONS AND SYNOPSES ARE NOT PART OF THE SCRIPT. Every Fountain tool
       omits them from the printed page, so they are drawn in the margin voice —
       visible while working, obviously not the film. */
    .el-section {
      font-family: var(--affine-font-family, Inter, sans-serif);
      color: var(--page-section);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 25px 0 3px;
      border-top: 1px solid var(--page-section-rule);
      padding-top: 11px;
    }
    .el-synopsis {
      font-family: var(--affine-font-family, Inter, sans-serif);
      font-style: italic;
      font-size: 10.5px;
      color: var(--page-synopsis);
      margin: 0 0 9px;
    }

    /* COVERAGE, in the margin beside the scene heading — never in the prose;
       the script must read as the script, not as a checklist. It sat 15px
       down, which put it beside the synopsis under the heading instead. The
       line box matches the heading's, so the mark centres on that line. */
    .marker { position: relative; }
    .marker::before {
      content: attr(data-mark);
      position: absolute;
      left: -36px;
      top: 0;
      width: 28px;
      line-height: 14.4px;
      text-align: right;
      font-family: var(--affine-font-family, sans-serif);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--page-mark);
    }
    .marker[data-covered='yes']::before { color: var(--page-mark-done); font-weight: 500; }

    /* WRITING — the same sheet, now plain text. */
    .sp__editor {
      width: 100%;
      border: none;
      outline: none;
      resize: none;
      background: transparent;
      line-height: 1.45;
      tab-size: 4;
      scrollbar-width: thin;
      scrollbar-color: var(--page-rule) transparent;
    }

    .sp__empty {
      margin: 30% 0 0 -53px;
      text-align: center;
      font: 400 12px/1.6 var(--affine-font-family, sans-serif);
      color: var(--page-synopsis);
      white-space: normal;
    }
    .sp__empty b { display: block; margin-bottom: 4px; color: var(--page-ink); font-weight: 600; }
  `;

  @state() private accessor _editing = false;

  /**
   * Repaint when SHOTS change, not only when the script does.
   *
   * The margin marks are coverage, read off the shot blocks. Without this the
   * page would keep marking a scene uncovered after its shots were added —
   * the single most misleading thing it could say, because those marks are the
   * whole reason the page is worth looking at while working.
   */
  private disposeDoc: (() => void) | null = null;

  /** Where the READ view was scrolled to, so returning to it does not jump. */
  private _readScroll = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    // Coalesced to one frame — same reasoning as the shot card. This page's
    // render is the most expensive on the board (parse + coverage over every
    // shot), and `blockUpdated` fires on every pointermove of a drag.
    let queued = false;
    const sub = this.store.slots.blockUpdated.subscribe(({ id }) => {
      if (id === this.model.id || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (this.isConnected) this.requestUpdate();
      });
    });
    this.disposeDoc = () => sub.unsubscribe();
  }

  override disconnectedCallback(): void {
    this.disposeDoc?.();
    this.disposeDoc = null;
    super.disconnectedCallback();
  }

  private commit(el: HTMLTextAreaElement): void {
    const next = el.value;
    if (next !== this.model.props.text) {
      this.store.captureSync();
      this.store.updateBlock(this.model, { text: next });
    }
    this._editing = false;

    /**
     * PUT THE READER BACK WHERE IT WAS.
     *
     * The page is re-rendered from the new text, so its scroll container is a
     * fresh element at the top. After editing scene 12 that meant being returned
     * to the title page — which reads as the edit having reset something.
     *
     * Restored on the next frame, once the page has been laid out; before that
     * the container has no scroll height and the assignment is a no-op.
     */
    const at = this._readScroll;
    requestAnimationFrame(() => {
      const scroll = this.querySelector<HTMLElement>('.sp__page');
      if (scroll) scroll.scrollTop = at;
    });
  }

  /**
   * Enter the editor WHERE THE USER CLICKED.
   *
   * It used to put the caret at the end of the document, always. On a forty-scene
   * screenplay, double-clicking scene 12 left the caret four hundred lines from
   * the thing being looked at — so every edit began with hunting for the place
   * you had just been pointing at.
   *
   * `line` comes from the element that was clicked (`data-line`), which the
   * parser records for exactly this. No line — an empty page, or the margin —
   * means the end.
   */
  private startEditing(line?: number): void {
    // Remember where the page was, so leaving the editor does not also scroll
    // the reader back to the top of the script.
    this._readScroll = this.querySelector<HTMLElement>('.sp__page')?.scrollTop ?? 0;
    this._editing = true;

    // Focus after the textarea exists.
    requestAnimationFrame(() => {
      const ta = this.querySelector<HTMLTextAreaElement>('.sp__editor');
      if (!ta) return;
      const at = line === undefined ? ta.value.length : offsetOfLine(ta.value, line);
      ta.focus();
      ta.setSelectionRange(at, at);

      /**
       * SCROLL THE CARET INTO VIEW — a textarea does not do it for a
       * programmatic selection, only for a typed one. Without this the caret is
       * correctly placed on line 312 and the view is showing line 1, which looks
       * exactly like the click was ignored.
       *
       * Measured from the line index and the computed line height rather than
       * with a mirror element: this is a fixed-width monospace block with no
       * wrapping tricks, so the arithmetic is exact and costs nothing.
       */
      if (line !== undefined) {
        const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18;
        ta.scrollTop = Math.max(0, (line - 3) * lineHeight);
      }
    });
  }

  private renderRow(row: ScreenplayRow) {
    if (row.type === 'blank') return html`<div class="el-blank"></div>`;
    if (row.type === 'page_break') return html`<div class="el-page_break"></div>`;
    return html`<div
      class=${rowClass(row)}
      data-depth=${row.depth ?? ''}
      data-key=${row.key ?? ''}
      data-mark=${row.mark ?? ''}
      data-covered=${row.covered ? 'yes' : 'no'}
      data-line=${row.line}
    >${row.type === 'title_field' ? row.value : row.text}</div>`;
  }

  override renderGfxBlock() {
    // ONE description of the page, shared with the focus overlay — see
    // `screenplay-view.ts`. Memoised per document revision underneath, which
    // matters because this render runs whenever ANY block changes.
    const { script, text, rows } = screenplayView(this.std);

    if (this._editing) {
      return html`<div class="sp"><textarea
        class="sp__editor"
        spellcheck="false"
        data-range-sync-exclude="true"
        .value=${text}
        @pointerdown=${(e: Event) => e.stopPropagation()}
        @dblclick=${(e: Event) => e.stopPropagation()}
        @wheel=${blockScrollWheel}
        @keydown=${(e: KeyboardEvent) => {
          // The canvas listens for keys on the host — Backspace deletes the
          // selected block, space pans. Without this, writing a script would
          // also drive the board.
          e.stopPropagation();
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
        }}
        @blur=${(e: FocusEvent) => this.commit(e.target as HTMLTextAreaElement)}
      ></textarea></div>`;
    }

    /**
     * READING. The pointer is NOT claimed here, deliberately: a click selects
     * the sheet and a drag moves it, exactly as it does a document — the
     * header strip that used to be the only handle is gone. The wheel IS
     * claimed, so a long script scrolls inside its page instead of panning
     * the board out from under the pointer.
     */
    return html`<div class="sp">
      <div
        class="sp__page"
        @wheel=${blockScrollWheel}
        @dblclick=${(e: MouseEvent) => {
          e.stopPropagation();
          // The line under the pointer, so writing starts where the user was
          // reading rather than at the end of the file.
          const line = (e.target as HTMLElement | null)
            ?.closest<HTMLElement>('[data-line]')?.dataset.line;
          this.startEditing(line === undefined ? undefined : Number(line));
        }}
      >${script.empty
        ? html`<div class="sp__empty">
            <b>No screenplay yet</b>
            Ask the agent to write one, or double-click to start typing.
          </div>`
        : repeat(rows, r => r.line, r => this.renderRow(r))}</div>
    </div>`;
  }
}
