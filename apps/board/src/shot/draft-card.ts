/**
 * The block draft, rendered — the scratch pad's one card.
 *
 * ── WHAT IT SHOWS, AND IN WHAT ORDER ─────────────────────────────────────────
 * The DESIGN, big, at the top. That is the only thing anyone is really looking
 * at, so it gets the space; everything else is chrome around it.
 *
 * Under it, the SLOTS — because a block is judged twice. Once on how it looks,
 * and once on whether it is a template: does it let me change the headline, drop
 * my own photograph in, set the accent? A design with no slots is a picture, and
 * a person should be able to see that before it enters their library rather than
 * discovering it on a shot three days later.
 *
 * Then SAVE, which is deliberately the only prominent action. Discard is quiet:
 * this is a draft, it costs nothing, and an eye-catching delete on a piece of
 * work someone just made is the wrong emphasis.
 *
 * ── WHY THE PREVIEW IS THE SAME MACHINERY AS A SHOT'S ────────────────────────
 * `blockSrcdoc` — the same sandbox, the same GSAP driver, the same slot patcher
 * a graphic shot uses. So what a person judges here is exactly what they will
 * get on a shot, down to the poster frame an animated block settles on. A
 * bespoke preview would eventually disagree with the real one, and the whole
 * point of previewing is that it does not.
 */
import { GfxBlockComponent } from '@blocksuite/std';
import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';

import { blockSrcdoc } from '../ui/block-render';
import { ensureBlockRuntime } from '../ui/block-runtime';
import { draftMeta, type DraftBlockModel } from './draft-block';

/** Slot kinds, in the order a person reads a design: what it says, then shows. */
const KIND_ORDER = ['text', 'image', 'video', 'color'];

export class DraftBlockComponent extends GfxBlockComponent<DraftBlockModel> {
  static override styles = css`
    voidspace-blockdraft { display: block; width: 100%; height: 100%; }

    .d {
      position: relative;
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      border-radius: 14px;
      overflow: hidden;
      font-family: var(--affine-font-family, Inter, sans-serif);
      color: var(--vs-text, #1a1a2e);
      background: var(--vs-shot-bg, #fff);
      /* A DASHED, ACCENTED EDGE — the one visual cue that says "not yours yet".
         Shots are solid; a draft should never be mistaken for one at a glance
         while someone is scanning the board. */
      border: 2px dashed var(--vs-accent-b, #7C5CFF);
      box-shadow: 0 8px 28px rgba(124, 92, 255, 0.16);
    }
    .d[data-status='saved'] {
      border-style: solid;
      border-color: #16a34a;
      box-shadow: 0 6px 24px rgba(22, 163, 74, 0.14);
    }

    .d__head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      background: rgba(124, 92, 255, 0.09);
      cursor: grab;
      flex: none;
    }
    .d[data-status='saved'] .d__head { background: rgba(22, 163, 74, 0.1); }
    .d__tag {
      font: 700 9px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--vs-accent-b, #7C5CFF);
      flex: none;
    }
    .d[data-status='saved'] .d__tag { color: #16a34a; }
    .d__name {
      flex: 1;
      min-width: 0;
      font: 600 13px/1.3 var(--affine-font-family, sans-serif);
      outline: none;
      cursor: text;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .d__name:empty::before {
      content: 'name-this-block';
      color: var(--vs-muted, #94a3b8);
      font-weight: 400;
    }

    /* ── The design ─────────────────────────────────────────────────────── */
    .d__stage {
      flex: none;
      position: relative;
      width: 100%;
      /* 9:16 of the card width — the common case, and a stable box so the card
         does not jump as a block loads. */
      aspect-ratio: 9 / 16;
      background:
        repeating-conic-gradient(#f1f2f6 0% 25%, #e6e8ef 0% 50%) 50% / 18px 18px;
      overflow: hidden;
    }
    /**
     * THE FRAME IS NATIVE SIZE AND CSS-SCALED, never stretched.
     *
     * A block is designed at 1080x1920. Sizing the iframe to the card would give
     * the document a 230px viewport, so everything positioned by percentage or
     * pinned to the bottom lands outside it — the preview shows the top-left
     * corner of a page nobody designed, which reads as "the block is broken".
     * Same approach as mountBlockPreview, for the same reason.
     */
    .d__stage iframe {
      position: absolute;
      top: 50%;
      left: 50%;
      transform-origin: 50% 50%;
      border: 0;
      background: transparent;
    }
    .d__empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font: 400 11.5px/1.5 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #64748b);
      text-align: center;
      padding: 24px;
    }

    /* ── Slots ──────────────────────────────────────────────────────────── */
    .d__body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 10px 12px 12px;
    }
    .d__label {
      font: 600 9px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.13em;
      text-transform: uppercase;
      color: var(--vs-muted, #94a3b8);
      margin-bottom: 7px;
      display: block;
    }
    .slots { display: flex; flex-direction: column; gap: 5px; }
    .slot {
      display: flex;
      align-items: baseline;
      gap: 7px;
      font: 400 11px/1.35 var(--affine-font-family, sans-serif);
    }
    .slot__kind {
      font: 700 8.5px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 3px 5px;
      border-radius: 4px;
      flex: none;
      background: rgba(127, 140, 170, 0.16);
      color: var(--vs-muted, #64748b);
    }
    .slot__kind[data-k='image'], .slot__kind[data-k='video'] {
      background: rgba(124, 92, 255, 0.16);
      color: #7C5CFF;
    }
    .slot__kind[data-k='color'] { background: rgba(234, 88, 12, 0.16); color: #ea580c; }
    .slot__key { font-weight: 600; flex: none; }
    .slot__sample {
      color: var(--vs-muted, #94a3b8);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* A DESIGN WITH NO SLOTS IS A PICTURE, and the card says so plainly rather
       than showing an empty list the user has to interpret. */
    .noslots {
      font: 400 11px/1.45 var(--affine-font-family, sans-serif);
      color: #b45309;
      background: rgba(180, 83, 9, 0.08);
      border-radius: 7px;
      padding: 8px 9px;
    }

    /* ── Actions ────────────────────────────────────────────────────────── */
    .d__foot {
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      border-top: 1px solid var(--vs-border, rgba(127, 140, 170, 0.18));
    }
    .btn {
      font: 600 11px/1 var(--affine-font-family, sans-serif);
      border-radius: 7px;
      padding: 8px 12px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .btn--save {
      background: var(--vs-accent-b, #7C5CFF);
      color: #fff;
      flex: 1;
    }
    .btn--save:hover { filter: brightness(1.08); }
    .btn--save[disabled] { opacity: 0.55; cursor: default; }
    /* Quiet on purpose — a draft costs nothing, and a loud delete on work
       someone just made is the wrong emphasis. */
    .btn--ghost {
      background: none;
      border-color: var(--vs-border, rgba(127, 140, 170, 0.3));
      color: var(--vs-muted, #64748b);
    }
    .btn--ghost:hover { background: var(--vs-hover, rgba(127, 140, 170, 0.12)); }
    .note {
      font: 400 10.5px/1.4 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #64748b);
      padding: 0 12px 10px;
    }
    .note--warn { color: #b45309; }
  `;

  @state() private accessor _saving = false;
  /** Native-size to card-size. Recomputed on resize — the card is on a canvas
   *  the user can drag bigger, and a preview that stopped fitting would be a
   *  design judged at the wrong scale. */
  @state() private accessor _scale = 0.2;

  /**
   * Flipped once the animation runtime is in hand, purely to force a repaint.
   *
   * The preview is built synchronously inside `render()`, so a runtime that
   * arrives afterwards would sit in the cache while this card showed a frozen
   * first frame until something unrelated happened to re-render it.
   */
  @state() private accessor _runtimeReady = false;

  private ro: ResizeObserver | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void ensureBlockRuntime().then(() => { this._runtimeReady = true; });
    this.ro = new ResizeObserver(() => this.refit());
    requestAnimationFrame(() => {
      const stage = this.querySelector('.d__stage');
      if (stage) this.ro?.observe(stage);
      this.refit();
    });
  }

  override disconnectedCallback(): void {
    this.ro?.disconnect();
    this.ro = null;
    super.disconnectedCallback();
  }

  override updated(): void {
    this.refit();
  }

  private refit(): void {
    const stage = this.querySelector('.d__stage') as HTMLElement | null;
    if (!stage) return;
    /**
     * LAYOUT SIZE, NOT THE VISUAL BOX.
     *
     * getBoundingClientRect() reports the size AFTER the canvas transform, so on
     * a zoomed-out board it returns a fraction of the real width and the preview
     * scales itself down to match — the block ends up a postage stamp floating
     * in its own stage. clientWidth is the untransformed layout size, which is
     * what the iframe is actually laid out against.
     */
    const box = { width: stage.clientWidth, height: stage.clientHeight };
    if (!box.width || !box.height) return;
    const meta = draftMeta(this.model);
    const w = Number((meta as { width?: number }).width) || 1080;
    const h = Number((meta as { height?: number }).height) || 1920;
    const next = Math.min(box.width / w, box.height / h);
    // Guarded so `updated()` cannot loop: a re-render sets scale, which would
    // re-render again forever without this.
    if (Math.abs(next - this._scale) > 0.001) this._scale = next;
  }

  private renderPreview() {
    const html_ = this.model.props.html ?? '';
    if (!html_.trim()) {
      return html`<div class="d__empty">
        Nothing drafted yet — ask the agent for a design.
      </div>`;
    }
    const meta = draftMeta(this.model);
    const slots = (meta.slots ?? {}) as Record<string, { kind?: string; sample?: string }>;
    /**
     * PREVIEWED WITH ITS OWN SAMPLES.
     *
     * An author's `sample` is what they said belongs in each slot, so filling
     * with them shows the design as intended rather than with the placeholder
     * copy that happens to be in the HTML. It is also the honest test of the
     * slot manifest: if a selector is wrong, the sample does not appear, and the
     * user sees that here rather than on a shot next week.
     */
    const fills = Object.entries(slots)
      .filter(([, v]) => v?.kind === 'text' && v.sample)
      .map(([key, v]) => ({ key, kind: 'text', value: String(v.sample) }));

    const w = Number((meta as { width?: number }).width) || 1080;
    const h = Number((meta as { height?: number }).height) || 1920;
    // Read so lit tracks it: the srcdoc's contents depend on the runtime being
    // loaded, which is not otherwise visible to the reactivity system.
    void this._runtimeReady;
    const srcdoc = blockSrcdoc(html_, {}, `draft-${this.model.id}`, fills as never);
    return html`<iframe
      sandbox="allow-scripts"
      scrolling="no"
      width=${w}
      height=${h}
      style=${`width:${w}px;height:${h}px;transform:translate(-50%,-50%) scale(${this._scale})`}
      .srcdoc=${srcdoc}
      title="block draft preview"
    ></iframe>`;
  }

  override renderGfxBlock() {
    const p = this.model.props;
    const meta = draftMeta(this.model);
    const slots = (meta.slots ?? {}) as Record<string, { kind?: string; sample?: string }>;
    const entries = Object.entries(slots).sort(
      (a, b) => KIND_ORDER.indexOf(a[1]?.kind ?? 'text') - KIND_ORDER.indexOf(b[1]?.kind ?? 'text'),
    );
    const saved = p.status === 'saved';

    return html`<div class="d" data-status=${p.status}>
      <div class="d__head">
        <span class="d__tag">${saved ? 'In your library' : 'Draft · not saved'}</span>
        <div
          class="d__name"
          contenteditable=${saved ? 'false' : 'plaintext-only'}
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
          @blur=${(e: FocusEvent) => {
            const v = ((e.target as HTMLElement).textContent ?? '').trim();
            if (v && v !== p.name) {
              this.store.captureSync();
              this.store.updateBlock(this.model, { name: v });
            }
          }}
        >${p.name}</div>
      </div>

      <div class="d__stage" @pointerdown=${(e: Event) => e.stopPropagation()}>
        ${this.renderPreview()}
      </div>

      <div
        class="d__body"
        @pointerdown=${(e: Event) => e.stopPropagation()}
        @wheel=${(e: WheelEvent) => e.stopPropagation()}
      >
        <span class="d__label">
          ${entries.length ? `${entries.length} fillable slot${entries.length === 1 ? '' : 's'}` : 'Slots'}
        </span>
        ${entries.length
          ? html`<div class="slots">
              ${entries.map(([key, v]) => html`<div class="slot">
                <span class="slot__kind" data-k=${v?.kind ?? 'text'}>${v?.kind ?? 'text'}</span>
                <span class="slot__key">${key}</span>
                <span class="slot__sample">${v?.sample ?? ''}</span>
              </div>`)}
            </div>`
          : html`<div class="noslots">
              No slots — nothing here can be changed per shot, so this is a fixed
              picture rather than a template. Ask for slots before saving.
            </div>`}
      </div>

      ${p.note ? html`<div class="note ${saved ? '' : 'note--warn'}">${p.note}</div>` : nothing}

      <div class="d__foot" @pointerdown=${(e: Event) => e.stopPropagation()}>
        ${saved
          ? html`<button
              class="btn btn--ghost"
              style="flex:1"
              @click=${() => this.dispatch('draft-remove')}
            >Clear from board</button>`
          : html`
            <button
              class="btn btn--save"
              ?disabled=${this._saving || !p.html.trim()}
              @click=${() => { this._saving = true; this.dispatch('draft-save'); }}
            >${this._saving ? 'Saving…' : 'Save to my library'}</button>
            <button class="btn btn--ghost" @click=${() => this.dispatch('draft-remove')}>
              Discard
            </button>`}
      </div>
    </div>`;
  }

  /**
   * Ask the HOST page to act.
   *
   * Saving needs an authenticated request and the block library, neither of
   * which exists inside this iframe. The card raises intent; the page owns the
   * network. Same split as every other board action.
   */
  private dispatch(kind: 'draft-save' | 'draft-remove') {
    window.parent?.postMessage(
      { type: `voidspace:${kind}`, blockId: this.model.id, name: this.model.props.name },
      '*',
    );
  }

}
