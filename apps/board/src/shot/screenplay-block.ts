/**
 * The screenplay on the canvas — the same sheet as a document, and the same
 * editor as focus mode.
 *
 * ── THE PAGE AND THE EDITOR ARE ONE THING ────────────────────────────────────
 * It used to render a formatted page to read and swap in a plain textarea of
 * raw Fountain to write, which looked like the document being replaced by its
 * source. Now the page IS the editor (`screenplay-editor.ts`), read-only until
 * you double-click it, so writing is the page you were reading gaining a caret
 * — at the character you double-clicked, not merely the line.
 *
 * ── A MINIATURE OF THE PRINTED PAGE ──────────────────────────────────────────
 * Every measurement in `theme/screenplay-page.css` is in em, where an em is
 * 12pt of Courier. The sheet is 51em wide — 8.5in — so setting the font size
 * to a 51st of the block's width makes this an exact scale model of the PDF,
 * at any size the block is resized to.
 *
 * ── IT BEHAVES LIKE A DOCUMENT ───────────────────────────────────────────────
 *   click          selects it; a drag moves it, like any object
 *   double-click   writes, with the caret where you clicked
 *   Escape / away  saves, and it is a page again
 *   the board bar  "Open in focus" when it is selected (`ui/board-ui.ts`)
 *
 * While it is only being read, the editor takes no pointer at all, so every
 * click and drag belongs to the canvas; the wheel is turned into scrolling
 * here, because a long script scrolls inside its page.
 */
import { GfxBlockComponent } from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';
import { css, html } from 'lit';
import { state } from 'lit/decorators.js';

import { type ScreenplayBlockModel } from './screenplay-doc';
import { createScreenplayEditor, type ScreenplayEditor } from './screenplay-editor';
import { shotsByScene } from './screenplay-view';
import { isZoomWheel } from '../ui/wheel';

/** The sheet is 8.5in; at 12pt Courier that is 51em. */
const PAGE_EMS = 51;
/** Long enough to be one save per pause, short enough to feel live to the agent. */
const SAVE_AFTER_MS = 450;

export class ScreenplayBlockComponent extends GfxBlockComponent<ScreenplayBlockModel> {
  /** Only what is specific to the canvas. The page is `screenplay-page.css`. */
  static override styles = css`
    voidspace-screenplay {
      display: block;
      width: 100%;
      height: 100%;
    }
    .sp-card {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .sp-card .cm-editor { height: 100%; }
    /* Read-only: the canvas owns the pointer, so a click selects the sheet. */
    .sp-card:not(.is-writing) .cm-editor { pointer-events: none; }
    /* NO SCROLLBAR, not even a transparent one. A scrollbar takes its width out
       of the page whatever colour it is — measured: "(quietly, like a
       confession)", exactly the 28 characters a parenthetical holds, wrapped
       onto two lines on the canvas and not in the PDF. A document's sheet has
       none either; the wheel scrolls, and the page running off its foot says
       there is more. */
    .sp-card .cm-scroller { scrollbar-width: none; }
    .sp-card .cm-scroller::-webkit-scrollbar { display: none; }
  `;

  @state() private accessor _writing = false;

  private editor: ScreenplayEditor | null = null;
  /** The block's text as of the last time the editor and it agreed. */
  private synced = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposeDoc: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    /**
     * Keep the MARGIN MARKS true as shots come and go. They are coverage, read
     * off the shot blocks, and a page that went on calling a scene uncovered
     * after its shots arrived would be the most misleading thing it could say.
     * Coalesced to a frame: `blockUpdated` fires on every pointermove of a drag.
     */
    let queued = false;
    const sub = this.store.slots.blockUpdated.subscribe(({ id }) => {
      if (id === this.model.id || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (this.isConnected) this.editor?.setCoverage(shotsByScene(this.std));
      });
    });
    this.disposeDoc = () => sub.unsubscribe();
    // Culled and brought back: the editor was torn down with the block.
    if (this.hasUpdated) this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.save();
    this.disposeDoc?.();
    this.disposeDoc = null;
    this.editor?.destroy();
    this.editor = null;
    this._writing = false;
    super.disconnectedCallback();
  }

  override updated(): void {
    const mount = this.querySelector<HTMLElement>('.sp-card');
    if (!mount) return;
    const text = this.model.props.text ?? '';
    if (!this.editor) {
      this.synced = text;
      this.editor = createScreenplayEditor(mount, {
        text,
        coverage: shotsByScene(this.std),
        placeholder: 'No screenplay yet — ask the agent to write one, or double-click to start typing.',
        onChange: () => this.queueSave(),
        onBlur: () => this.stopWriting(),
        onEscape: () => this.editor?.view.contentDOM.blur(),
      });
      return;
    }
    /**
     * FROM OUTSIDE — the agent rewrote the script, or focus mode saved it.
     * Taken whenever this editor has nothing unsaved; with unsaved typing the
     * typing wins, because it is newer and it is about to be saved.
     */
    if (text === this.synced) return;
    if (this.editor.text() === this.synced) this.editor.setText(text);
    this.synced = text;
  }

  private queueSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_AFTER_MS);
  }

  /** Write the editor's text to the block, if it differs. One undo step each. */
  private save(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const next = this.editor?.text();
    if (next === undefined) return;
    this.synced = next;
    if (next === this.model.props.text) return;
    this.store.captureSync();
    this.store.updateBlock(this.model, { text: next });
  }

  private startWriting(e: MouseEvent): void {
    if (!this.editor) return;
    this._writing = true;
    /**
     * Take the pointer back BEFORE asking where the click landed. The class
     * would arrive with Lit's next render, but finding a character under a
     * point is hit-testing, and an editor that ignores the pointer is one the
     * hit-test passes straight through.
     */
    this.querySelector('.sp-card')?.classList.add('is-writing');
    /**
     * And put down the canvas selection the double-click's first click made.
     * It brings the element toolbar and resize handles with it — furniture
     * for arranging an OBJECT, floating over the words of a page being
     * written. A document being written shows none, so neither does this.
     */
    try { this.std.get(GfxControllerIdentifier).selection.clear(); } catch { /* cosmetic */ }
    this.editor.setEditable(true);
    this.editor.focusAt({ x: e.clientX, y: e.clientY });
  }

  private stopWriting(): void {
    this.save();
    this._writing = false;
    this.editor?.setEditable(false);
  }

  /**
   * THE WHEEL, while reading. The editor takes no pointer then, so the page
   * would never scroll — and letting the wheel through would pan the board
   * out from under the pointer instead. A pinch still zooms.
   */
  private onWheel(e: WheelEvent): void {
    if (isZoomWheel(e)) return;
    e.stopPropagation();
    if (this._writing) return; // the editor scrolls itself
    const scroller = this.editor?.view.scrollDOM;
    if (!scroller) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1;
    scroller.scrollTop += e.deltaY * unit;
    e.preventDefault();
  }

  override renderGfxBlock() {
    // A 51st of the width: one em of the page, so the sheet is the PDF to scale.
    const width = Number(JSON.parse(String(this.model.xywh ?? '[0,0,640,860]'))[2]) || 640;
    const stop = (e: Event) => { if (this._writing) e.stopPropagation(); };
    return html`<div
      class="sp-sheet sp-card ${this._writing ? 'is-writing' : ''}"
      style="font-size: ${width / PAGE_EMS}px"
      @wheel=${(e: WheelEvent) => this.onWheel(e)}
      @dblclick=${(e: MouseEvent) => {
        e.stopPropagation();
        if (!this._writing) this.startWriting(e);
      }}
      @pointerdown=${stop}
      @keydown=${stop}
    ></div>`;
  }
}
