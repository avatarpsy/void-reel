/**
 * The screenplay, rendered as a screenplay.
 *
 * ── WHY IT LOOKS LIKE THIS ───────────────────────────────────────────────────
 * A script has a typographic form that is a hundred years old and every writer
 * recognises: 12pt Courier, sluglines hard left in caps, action full width,
 * character names indented to about 3.7in, dialogue in a narrow column beneath.
 * Those measurements are not decoration — they are why a page of screenplay runs
 * roughly a minute, which is the only reason anyone can judge pacing by looking.
 *
 * So this renders a PAGE: paper, margins, monospace, real indents. A person can
 * read it the way they read a PDF, and scroll it, and believe it.
 *
 * ── EDITING ──────────────────────────────────────────────────────────────────
 * Reading is the default; editing is a mode. Double-click (or the Edit button)
 * swaps the rendered page for a plain textarea holding the raw Fountain, and
 * blur commits. That split exists because the two things want opposite layouts:
 * you read a formatted page, and you write plain text where every character is
 * where you put it. Trying to serve both at once produces a contenteditable that
 * fights the writer over indentation.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * No sequence rows, no scene forms, no purpose dropdowns, no duration fields.
 * All of that was deleted. The structure is IN the text — `#` acts, `##`
 * sequences, sluglines — and anything that needs it parses it. Nothing about the
 * film is authored twice.
 */
import { GfxBlockComponent } from '@blocksuite/std';
import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { offsetOfLine } from './fountain';
import { type ScreenplayBlockModel } from './screenplay-doc';
import { rowClass, screenplayView, type ScreenplayRow } from './screenplay-view';

/** Shown on a board whose screenplay has not been started. */
const PLACEHOLDER = `Title: Untitled

# ACT ONE

## SEQUENCE 1 — the opening
= What this run has to do.

INT. SOMEWHERE — DAY

Something happens.
`;

export class ScreenplayBlockComponent extends GfxBlockComponent<ScreenplayBlockModel> {
  static override styles = css`
    voidspace-screenplay {
      display: block;
      width: 100%;
      height: 100%;
    }
    .sp {
      position: relative;
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      border: 1px solid var(--vs-border, rgba(255, 255, 255, 0.12));
      border-radius: 14px;
      background: var(--vs-shot-bg, #ffffff);
      box-shadow: 0 6px 24px rgba(15, 23, 42, 0.08);
      overflow: hidden;
      font-family: var(--affine-font-family, Inter, sans-serif);
      color: var(--vs-text, #1a1a2e);
    }

    /* THE DRAG HANDLE — no pointer claiming, so the page moves like any other
       object on the canvas. */
    .sp__head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border-bottom: 1px solid var(--vs-border, rgba(255, 255, 255, 0.1));
      background: var(--vs-shot-head, rgba(127, 140, 170, 0.08));
      cursor: grab;
      flex: none;
    }
    .sp__kind {
      font: 600 10px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--vs-muted, #64748b);
    }
    .sp__title {
      flex: 1;
      min-width: 0;
      font: 600 13px/1.3 var(--affine-font-family, sans-serif);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sp__stat {
      font: 400 10px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #94a3b8);
      white-space: nowrap;
    }
    .sp__btn {
      font: 500 10px/1 var(--affine-font-family, sans-serif);
      border: 1px solid var(--vs-border, rgba(127, 140, 170, 0.32));
      background: none;
      color: var(--vs-text, #1a1a2e);
      border-radius: 6px;
      padding: 4px 8px;
      cursor: pointer;
      flex: none;
    }
    .sp__btn:hover { background: var(--vs-hover, rgba(127, 140, 170, 0.14)); }

    /* ── The page ───────────────────────────────────────────────────────────
       A tinted sheet inside a darker gutter, so it reads as paper on a desk
       rather than as a text field. */
    .sp__scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      background: var(--vs-page-gutter, #e8eaf0);
      padding: 14px 0 28px;
    }
    .page {
      width: 100%;
      max-width: 520px;
      margin: 0 auto;
      background: var(--vs-page, #fffef9);
      border: 1px solid rgba(15, 23, 42, 0.1);
      box-shadow: 0 2px 10px rgba(15, 23, 42, 0.1);
      /* 1in top/bottom, 1.5in left, 1in right — scaled to this width. */
      padding: 34px 26px 40px 38px;
      /* 12pt Courier is the standard. Anything else and the page-per-minute
         relationship a writer judges pacing by stops holding. */
      font-family: 'Courier New', Courier, monospace;
      font-size: 11.5px;
      line-height: 1.36;
      color: #14151a;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .el-scene_heading {
      text-transform: uppercase;
      font-weight: 700;
      margin: 14px 0 6px;
      letter-spacing: 0.02em;
    }
    .el-action { margin: 0 0 6px; }
    .el-character {
      margin: 10px 0 0 36%;
      text-transform: uppercase;
    }
    .el-parenthetical { margin: 0 0 0 28%; }
    .el-dialogue { margin: 0 12% 0 20%; }
    .el-transition {
      text-align: right;
      text-transform: uppercase;
      margin: 8px 0 10px;
    }
    .el-centered { text-align: center; margin: 8px 0; }
    .el-blank { height: 0.7em; }
    .el-page_break {
      border-top: 1px dashed rgba(15, 23, 42, 0.25);
      margin: 16px 0;
      height: 0;
    }

    /* SECTIONS AND SYNOPSES ARE NOT PART OF THE SCRIPT.
       Every Fountain tool omits them from the printed page, so they are drawn in
       the margin voice — visible while working, obviously not the film. */
    .el-section {
      font-family: var(--affine-font-family, Inter, sans-serif);
      color: #7c3aed;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 20px 0 2px;
      border-top: 1px solid rgba(124, 58, 237, 0.22);
      padding-top: 10px;
    }
    .el-section[data-depth='1'] { font-size: 11px; }
    .el-section[data-depth='2'] { font-size: 10px; margin-top: 16px; }
    .el-synopsis {
      font-family: var(--affine-font-family, Inter, sans-serif);
      font-style: italic;
      font-size: 10.5px;
      color: #6b7280;
      margin: 0 0 8px;
    }

    /* A scene the board has no shots for. Marked in the MARGIN, never in the
       prose — the script must read as the script, not as a checklist. */
    .marker {
      position: relative;
    }
    .marker::before {
      content: attr(data-mark);
      position: absolute;
      left: -34px;
      top: 15px;
      width: 28px;
      text-align: right;
      font-family: var(--affine-font-family, sans-serif);
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #b45309;
    }
    .marker[data-covered='yes']::before { color: #16a34a; font-weight: 500; }

    /* ── The editor ─────────────────────────────────────────────────────── */
    .editor {
      flex: 1;
      min-height: 0;
      width: 100%;
      box-sizing: border-box;
      border: none;
      outline: none;
      resize: none;
      padding: 16px 18px;
      background: var(--vs-page, #fffef9);
      color: #14151a;
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      line-height: 1.45;
      tab-size: 4;
    }

    .empty {
      max-width: 520px;
      margin: 0 auto;
      padding: 26px 24px;
      font: 400 12px/1.6 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #64748b);
      background: var(--vs-page, #fffef9);
      border: 1px dashed rgba(15, 23, 42, 0.18);
      border-radius: 8px;
      text-align: center;
    }
    .empty b { display: block; margin-bottom: 6px; color: var(--vs-text, #1a1a2e); }
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
     * to the title page — which reads as the edit having reset something, and is
     * the reason people avoided the Edit button and asked the agent instead.
     *
     * Restored on the next frame, once the page has been laid out; before that
     * the container has no scroll height and the assignment is a no-op.
     */
    const at = this._readScroll;
    requestAnimationFrame(() => {
      const scroll = this.querySelector<HTMLElement>('.sp__scroll');
      if (scroll) scroll.scrollTop = at;
    });
  }

  /**
   * Enter the editor WHERE THE USER CLICKED.
   *
   * It used to put the caret at the end of the document, always. On a two-scene
   * sketch that is harmless; on a forty-scene screenplay, double-clicking scene
   * 12 scrolled to the bottom of the file and left the caret four hundred lines
   * from the thing being looked at — so every edit began with hunting for the
   * place you had just been pointing at. That is the single reason writing on
   * this board felt like a mode rather than a document.
   *
   * `line` comes from the element that was clicked (`data-line`), which the
   * parser records for exactly this. No line — the Edit button, an empty page —
   * still means the end.
   */
  private startEditing(opts: { seed?: string; line?: number } = {}): void {
    if (opts.seed !== undefined && !this.model.props.text.trim()) {
      this.store.captureSync();
      this.store.updateBlock(this.model, { text: opts.seed });
    }
    // Remember where the page was, so leaving the editor does not also scroll
    // the reader back to the top of the script.
    this._readScroll = this.querySelector<HTMLElement>('.sp__scroll')?.scrollTop ?? 0;
    this._editing = true;

    // Focus after the textarea exists.
    requestAnimationFrame(() => {
      const ta = this.querySelector<HTMLTextAreaElement>('.editor');
      if (!ta) return;
      const at = opts.line === undefined
        ? ta.value.length
        : offsetOfLine(ta.value, opts.line);
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
      if (opts.line !== undefined) {
        const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 17;
        ta.scrollTop = Math.max(0, (opts.line - 3) * lineHeight);
      }
    });
  }

  /** Where the READ view was scrolled to, so returning to it does not jump. */
  private _readScroll = 0;

  /** Group elements so a scene heading and its body share one marker element. */
  private renderElement(row: ScreenplayRow) {
    if (row.type === 'blank') return html`<div class="el-blank"></div>`;
    if (row.type === 'page_break') return html`<div class="el-page_break"></div>`;
    return html`<div
      class=${rowClass(row)}
      data-depth=${row.depth ?? ''}
      data-mark=${row.mark ?? ''}
      data-covered=${row.covered ? 'yes' : 'no'}
      data-line=${row.line}
    >${row.text}</div>`;
  }

  override renderGfxBlock() {
    // ONE description of the page, shared with the focus overlay — see
    // `screenplay-view.ts`. Memoised per document revision underneath, which
    // matters because this render runs whenever ANY block changes.
    const { script, text, rows, stat } = screenplayView(this.std);

    return html`<div class="sp">
      <div class="sp__head">
        <span class="sp__kind">Screenplay</span>
        <span class="sp__title">${script.title || 'Untitled'}</span>
        ${stat ? html`<span class="sp__stat">${stat}</span>` : nothing}
        <!--
          FOCUS — the way out of a 640px card and into a page.

          A screenplay is READ at page size and WRITTEN at page size; judging
          pace is the whole reason the format is fixed, and you cannot judge it
          through a porthole on a canvas. This is the primary action on the card
          once there is a script, which is why it sits before Edit.
        -->
        <button
          class="sp__btn sp__btn--primary"
          title="Open full size — write, read and export from here"
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @click=${(e: Event) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('voidspace-open-screenplay', {
              bubbles: true, composed: true,
            }));
          }}
        >Focus</button>
        <button
          class="sp__btn"
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @click=${(e: Event) => {
            e.stopPropagation();
            if (this._editing) {
              this.querySelector<HTMLTextAreaElement>('.editor')?.blur();
            } else {
              this.startEditing();
            }
          }}
        >${this._editing ? 'Done' : 'Edit'}</button>
      </div>

      ${this._editing
        ? html`<textarea
            class="editor"
            spellcheck="false"
            data-range-sync-exclude="true"
            .value=${text}
            @pointerdown=${(e: Event) => e.stopPropagation()}
            @dblclick=${(e: Event) => e.stopPropagation()}
            @wheel=${(e: WheelEvent) => e.stopPropagation()}
            @keydown=${(e: KeyboardEvent) => {
              // The canvas listens for keys on the host — Backspace deletes the
              // selected block, space pans. Without this, writing a script would
              // also drive the board.
              e.stopPropagation();
              if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
            }}
            @blur=${(e: FocusEvent) => this.commit(e.target as HTMLTextAreaElement)}
          ></textarea>`
        : html`<div
            class="sp__scroll"
            @pointerdown=${(e: Event) => e.stopPropagation()}
            @wheel=${(e: WheelEvent) => e.stopPropagation()}
            @dblclick=${(e: MouseEvent) => {
              e.stopPropagation();
              // The line under the pointer, so editing opens where the user was
              // reading rather than at the end of the file.
              const line = (e.target as HTMLElement | null)
                ?.closest<HTMLElement>('[data-line]')?.dataset.line;
              this.startEditing(line === undefined ? {} : { line: Number(line) });
            }}
          >
            ${script.empty
              ? html`<div class="empty">
                  <b>No screenplay yet.</b>
                  Tell the agent what you want to make and it will write one —
                  or double-click here to start typing.
                </div>`
              : html`<div class="page">
                  ${repeat(rows, r => r.line, r => this.renderElement(r))}
                </div>`}
          </div>`}
    </div>`;
  }
}

export { PLACEHOLDER as SCREENPLAY_PLACEHOLDER };
