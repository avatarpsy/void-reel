/**
 * The screenplay panel, rendered.
 *
 * A block on the board, exactly like a shot — same drag-handle header, same
 * claimed body, same commit-on-blur. It is the document the shots come from, so
 * it is a thing you can see and type into rather than state hidden behind a
 * button.
 *
 * ── WHAT IT SHOWS, AND WHY IN THIS ORDER ─────────────────────────────────────
 * The top half is the film's identity — title, logline, who it is for, how it
 * speaks. The logline sits directly under the title and is the widest thing on
 * the card, because it is the sentence you re-read when a shot stops making
 * sense, and a screenplay whose logline is buried is a screenplay nobody checks
 * against.
 *
 * The bottom half is the STRUCTURE: one row per sequence, each showing what it
 * is for, how long it should run, and how many shots exist for it. That last
 * number is the whole point of the panel — a sequence reading "no shots" is the
 * next piece of work, visible without counting cards on the canvas.
 *
 * ── THE RUNTIME BAR ──────────────────────────────────────────────────────────
 * Planned seconds against the shots actually placed. Videos fail by running long
 * far more often than they fail by any single bad shot, and by the time a person
 * notices in the editor the fix is expensive. Here it costs a sentence.
 */
import { GfxBlockComponent } from '@blocksuite/std';
import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { takeCaret, stopFieldKeys } from '../ui/field-caret';
import { readShots } from './shots';
import {
  PURPOSE_HINT, SEQUENCE_PURPOSES, nextSceneId, nextSequenceId, plannedRuntimeSec,
  readScreenplay, sceneLetter,
  type Scene, type ScreenplayBlockModel, type Sequence, type SequencePurpose,
} from './screenplay-doc';

/** The identity fields, in the order a writer settles them. */
const HEAD_FIELDS = [
  {
    key: 'logline' as const,
    label: 'LOGLINE',
    placeholder: 'One sentence: what this video IS.',
  },
  {
    key: 'audience' as const,
    label: 'AUDIENCE',
    placeholder: 'Who it is for, and where it plays.',
  },
  {
    key: 'notes' as const,
    label: 'DIRECTION',
    placeholder: 'Tone, references, what to avoid.',
  },
];

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

    /* THE DRAG HANDLE — deliberately does not claim pointer events, so the
       panel moves like any other object on the canvas. */
    .sp__head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
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
      font: 600 15px/1.3 var(--affine-font-family, sans-serif);
      outline: none;
      cursor: text;
    }
    .sp__title:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-muted, #94a3b8);
      font-weight: 400;
    }

    .sp__body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 12px 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .field__label {
      font: 600 9px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.13em;
      color: var(--vs-muted, #94a3b8);
    }
    .field__text {
      font: 400 12.5px/1.5 var(--affine-font-family, sans-serif);
      outline: none;
      cursor: text;
      border-radius: 6px;
      padding: 4px 6px;
      margin: 0 -6px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .field__text:hover {
      background: var(--vs-hover, rgba(127, 140, 170, 0.07));
    }
    .field__text:focus {
      background: var(--vs-hover, rgba(127, 140, 170, 0.1));
    }
    .field__text:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-muted, #94a3b8);
    }
    .field--logline .field__text {
      font-size: 14px;
      line-height: 1.45;
      font-weight: 500;
    }

    /* ── The runtime bar ───────────────────────────────────────────────── */
    .runtime {
      display: flex;
      align-items: baseline;
      gap: 6px;
      font: 400 11px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #64748b);
    }
    .runtime b {
      font-weight: 600;
      font-size: 13px;
      color: var(--vs-text, #1a1a2e);
    }
    .runtime--over b {
      color: #dc2626;
    }

    .sect {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-top: 1px solid var(--vs-border, rgba(127, 140, 170, 0.16));
      padding-top: 10px;
    }
    .sect__label {
      font: 600 9px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.13em;
      color: var(--vs-muted, #94a3b8);
    }

    .seqs {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .seq {
      border: 1px solid var(--vs-border, rgba(127, 140, 170, 0.2));
      border-radius: 9px;
      padding: 7px 9px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: var(--vs-hover, rgba(127, 140, 170, 0.04));
    }
    /* A sequence with nothing shot for it is the next piece of work, so it is
       drawn as an invitation rather than as an error. */
    .seq--empty {
      border-style: dashed;
      background: none;
    }
    .seq__top {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .seq__n {
      font: 600 10px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #94a3b8);
      flex: none;
    }
    .seq__title {
      flex: 1;
      min-width: 0;
      font: 500 12.5px/1.35 var(--affine-font-family, sans-serif);
      outline: none;
      cursor: text;
    }
    .seq__title:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-muted, #94a3b8);
      font-weight: 400;
    }
    .seq__purpose {
      font: 600 9px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 3px 6px;
      border-radius: 999px;
      border: 1px solid var(--vs-border, rgba(127, 140, 170, 0.3));
      background: none;
      color: var(--vs-text, #1a1a2e);
      cursor: pointer;
      flex: none;
    }
    .seq__purpose:hover {
      background: var(--vs-hover, rgba(127, 140, 170, 0.12));
    }
    .seq__sec {
      font: 500 10px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #64748b);
      width: 34px;
      text-align: right;
      outline: none;
      cursor: text;
      flex: none;
    }
    .seq__sec:empty::before {
      content: '—s';
      color: var(--vs-muted, #cbd5e1);
    }
    .seq__sum {
      font: 400 11.5px/1.45 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #64748b);
      outline: none;
      cursor: text;
    }
    .seq__sum:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-muted, #cbd5e1);
    }
    /* ── Scenes, nested inside their sequence ──────────────────────────── */
    .scenes {
      display: flex;
      flex-direction: column;
      gap: 4px;
      /* Indented and rule-marked so the nesting is legible at a glance —
         three levels of plain rows read as one flat list. */
      margin-left: 8px;
      padding-left: 8px;
      border-left: 2px solid var(--vs-border, rgba(127, 140, 170, 0.22));
    }
    .scene {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px 6px;
      border-radius: 7px;
      background: var(--vs-shot-bg, #fff);
      border: 1px solid var(--vs-border, rgba(127, 140, 170, 0.16));
    }
    .scene--empty {
      border-style: dashed;
      background: none;
    }
    .scene__top {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .scene__letter {
      font: 700 10px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #94a3b8);
      width: 14px;
      flex: none;
    }
    .scene__slug {
      flex: 1;
      min-width: 0;
      font: 600 11px/1.35 var(--affine-font-family, sans-serif);
      letter-spacing: 0.02em;
      text-transform: uppercase;
      outline: none;
      cursor: text;
    }
    .scene__slug:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-muted, #cbd5e1);
      font-weight: 400;
    }
    .scene__count {
      font: 400 9.5px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #94a3b8);
      flex: none;
    }
    .scene__count--empty {
      color: #b45309;
      font-weight: 600;
    }
    .scene__sum {
      font: 400 11px/1.4 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #64748b);
      outline: none;
      cursor: text;
      padding-left: 20px;
    }
    .scene__sum:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-muted, #cbd5e1);
    }

    .seq__foot {
      display: flex;
      align-items: center;
      gap: 8px;
      font: 400 10px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #94a3b8);
    }
    .seq__add {
      border: none;
      background: none;
      font: 500 10px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #64748b);
      cursor: pointer;
      padding: 3px 5px;
      border-radius: 5px;
    }
    .seq__add:hover {
      background: var(--vs-hover, rgba(127, 140, 170, 0.14));
      color: var(--vs-text, #1a1a2e);
    }
    .seq__count--empty {
      color: #b45309;
      font-weight: 600;
    }
    .seq__x {
      margin-left: auto;
      border: none;
      background: none;
      color: var(--vs-muted, #94a3b8);
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 2px 4px;
      border-radius: 5px;
    }
    .seq__x:hover {
      background: rgba(220, 38, 38, 0.1);
      color: #dc2626;
    }

    .add {
      border: 1px dashed var(--vs-border, rgba(127, 140, 170, 0.34));
      border-radius: 9px;
      padding: 7px;
      font: 500 11px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #64748b);
      background: none;
      cursor: pointer;
      width: 100%;
    }
    .add:hover {
      background: var(--vs-hover, rgba(127, 140, 170, 0.08));
      color: var(--vs-text, #1a1a2e);
    }

    .empty {
      font: 400 11.5px/1.5 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #94a3b8);
      text-align: center;
      padding: 10px 4px;
    }

    /* The purpose menu. Bounded and scrollable, so it can never overflow the
       fixed-height card — the mistake the block picker made first time. */
    .menu {
      position: absolute;
      z-index: 20;
      right: 12px;
      max-height: 232px;
      overflow-y: auto;
      background: var(--vs-shot-bg, #fff);
      border: 1px solid var(--vs-border, rgba(127, 140, 170, 0.28));
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
      padding: 4px;
      min-width: 210px;
    }
    .menu__item {
      display: block;
      width: 100%;
      text-align: left;
      border: none;
      background: none;
      border-radius: 6px;
      padding: 6px 8px;
      cursor: pointer;
      color: var(--vs-text, #1a1a2e);
    }
    .menu__item:hover {
      background: var(--vs-hover, rgba(127, 140, 170, 0.12));
    }
    .menu__k {
      font: 600 10px/1.3 var(--affine-font-family, sans-serif);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .menu__h {
      font: 400 10.5px/1.35 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #94a3b8);
    }
  `;

  /** Which sequence's purpose menu is open, by id. */
  @state() private accessor _menuFor = '';

  /**
   * Re-render when SHOTS change, not just when the screenplay does.
   *
   * The per-sequence shot count and the actual runtime are read off the shot
   * blocks, so without this the panel would keep saying "no shots" after one was
   * added — the single most misleading thing it could do, because that count is
   * the reason the panel exists.
   */
  private disposeShots: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    const sub = this.store.slots.blockUpdated.subscribe(() => this.requestUpdate());
    this.disposeShots = () => sub.unsubscribe();
  }

  override disconnectedCallback(): void {
    this.disposeShots?.();
    this.disposeShots = null;
    super.disconnectedCallback();
  }

  private get screenplay() {
    return readScreenplay(this.std);
  }

  private readonly claimCaret = (e: PointerEvent) => {
    e.stopPropagation();
    takeCaret(this.std, e.currentTarget as HTMLElement, e.clientX, e.clientY);
  };

  /** Commit on blur — a store write per keystroke would flood undo history. */
  private commitHead(key: 'title' | 'logline' | 'audience' | 'notes', el: HTMLElement): void {
    const value = (el.textContent ?? '').trim();
    if (value !== this.model.props[key]) {
      this.store.captureSync();
      this.store.updateBlock(this.model, { [key]: value });
    }
  }

  /**
   * Write one field of one sequence.
   *
   * The whole array is replaced rather than mutated in place: `sequences` is a
   * plain array prop, and mutating the stored object would not be seen as a
   * change by the store — the edit would appear to work and then vanish on
   * reload. See [[feedback-iframe-boundary-plain-data]] for the same class of
   * bug at the other boundary.
   */
  private patchSequence(id: string, patch: Partial<Sequence>): void {
    const next = this.screenplay.sequences.map(q => (q.id === id ? { ...q, ...patch } : q));
    this.store.captureSync();
    this.store.updateBlock(this.model, { sequences: next });
  }

  private commitSequence(id: string, key: 'title' | 'summary', el: HTMLElement): void {
    const value = (el.textContent ?? '').trim();
    const current = this.screenplay.sequences.find(q => q.id === id);
    if (current && current[key] !== value) this.patchSequence(id, { [key]: value });
  }

  private commitSeconds(id: string, el: HTMLElement): void {
    const n = Math.max(0, Math.round(Number((el.textContent ?? '').replace(/[^0-9.]/g, '')) || 0));
    const current = this.screenplay.sequences.find(q => q.id === id);
    if (current && current.targetSec !== n) this.patchSequence(id, { targetSec: n });
    // Repaint so "12" becomes "12s" and rubbish becomes the placeholder.
    this.requestUpdate();
  }

  private addSequence(): void {
    const sequences = this.screenplay.sequences;
    const next: Sequence = {
      id: nextSequenceId(sequences),
      title: '',
      // The first sequence of anything is the hook; after that, most writers are
      // adding the next stage rather than another opening.
      purpose: sequences.length === 0 ? 'hook' : 'setup',
      summary: '',
      targetSec: 0,
      music: '',
      look: '',
    };
    this.store.captureSync();
    this.store.updateBlock(this.model, { sequences: [...sequences, next] });
  }

  /**
   * Remove a sequence — and DETACH its scenes rather than deleting them.
   *
   * Deleting a structural row must never destroy work. The scenes survive with
   * an empty `sequenceId`, keeping every shot still attached to its scene, and
   * they reappear under "not in a sequence" where they can be re-placed in one
   * click. Nothing on the canvas moves and nothing is lost.
   */
  private removeSequence(id: string): void {
    this.store.captureSync();
    this.store.updateBlock(this.model, {
      sequences: this.screenplay.sequences.filter(q => q.id !== id),
      scenes: this.screenplay.scenes.map(c =>
        (c.sequenceId === id ? { ...c, sequenceId: '' } : c)),
    });
  }

  /**
   * Remove a scene — and DETACH its shots, same rule one level down.
   *
   * The shots stay on the board with an empty `sceneId`, exactly like shots
   * someone sketched before writing a screenplay.
   */
  private removeScene(id: string): void {
    this.store.captureSync();
    this.store.transact(() => {
      this.store.updateBlock(this.model, {
        scenes: this.screenplay.scenes.filter(c => c.id !== id),
      });
      for (const shot of readShots(this.std)) {
        if (shot.sceneId !== id) continue;
        const block = this.store.getBlock(shot.id);
        if (block) this.store.updateBlock(block.model, { sceneId: '' });
      }
    });
  }

  private patchScene(id: string, patch: Partial<Scene>): void {
    const next = this.screenplay.scenes.map(c => (c.id === id ? { ...c, ...patch } : c));
    this.store.captureSync();
    this.store.updateBlock(this.model, { scenes: next });
  }

  private commitScene(id: string, key: 'slug' | 'summary', el: HTMLElement): void {
    const value = (el.textContent ?? '').trim();
    const current = this.screenplay.scenes.find(c => c.id === id);
    if (current && current[key] !== value) this.patchScene(id, { [key]: value });
  }

  /** A new scene inside a sequence. Appended AFTER that sequence's last scene,
   *  so the array order stays the reading order rather than creation order. */
  private addScene(sequenceId: string): void {
    const scenes = this.screenplay.scenes;
    const next: Scene = { id: nextSceneId(scenes), sequenceId, slug: '', summary: '' };
    let at = scenes.length;
    for (let i = scenes.length - 1; i >= 0; i--) {
      if (scenes[i].sequenceId === sequenceId) { at = i + 1; break; }
    }
    this.store.captureSync();
    this.store.updateBlock(this.model, {
      scenes: [...scenes.slice(0, at), next, ...scenes.slice(at)],
    });
  }

  private setPurpose(id: string, purpose: SequencePurpose): void {
    this._menuFor = '';
    this.patchSequence(id, { purpose });
  }

  /** One scene row — used inside a sequence and in the unplaced list. */
  private renderScene(c: Scene, letter: string, shots: number) {
    return html`<div class="scene ${shots === 0 ? 'scene--empty' : ''}">
      <div class="scene__top">
        <span class="scene__letter">${letter}</span>
        <div
          class="scene__slug"
          contenteditable="plaintext-only"
          data-placeholder="INT. KITCHEN — DAY"
          title="Where and when. A scene ends when either changes."
          @pointerdown=${this.claimCaret}
          @keydown=${stopFieldKeys}
          @blur=${(e: FocusEvent) => this.commitScene(c.id, 'slug', e.target as HTMLElement)}
        >${c.slug}</div>
        <span class="scene__count ${shots === 0 ? 'scene__count--empty' : ''}"
          >${shots === 0 ? 'no shots' : shots === 1 ? '1 shot' : `${shots} shots`}</span>
        <button
          class="seq__x"
          title="Remove this scene — its shots stay on the board"
          @click=${(e: Event) => { e.stopPropagation(); this.removeScene(c.id); }}
        >×</button>
      </div>
      <div
        class="scene__sum"
        contenteditable="plaintext-only"
        data-placeholder="What happens here"
        @pointerdown=${this.claimCaret}
        @keydown=${stopFieldKeys}
        @blur=${(e: FocusEvent) => this.commitScene(c.id, 'summary', e.target as HTMLElement)}
      >${c.summary}</div>
    </div>`;
  }

  override renderGfxBlock() {
    const s = this.screenplay;
    const shots = readShots(this.std);
    /**
     * Shot counts are per SCENE, and a sequence's count is the sum of its
     * scenes'. Counted once here rather than filtered inside the template: the
     * panel repaints on every document update, and a filter per row would walk
     * the whole shot list once per scene.
     */
    const countByScene = new Map<string, number>();
    for (const shot of shots) {
      if (!shot.sceneId) continue;
      countByScene.set(shot.sceneId, (countByScene.get(shot.sceneId) ?? 0) + 1);
    }
    // Letters are assigned by ARRAY position across the whole screenplay, so a
    // scene keeps its letter when a sequence above it is edited.
    const letterOf = new Map(s.scenes.map((c, i) => [c.id, sceneLetter(i)] as const));
    const shotsInSequence = (qid: string) => s.scenes
      .filter(c => c.sequenceId === qid)
      .reduce((n, c) => n + (countByScene.get(c.id) ?? 0), 0);

    const planned = plannedRuntimeSec(s);
    // What the shots actually add up to. Shots with no duration set contribute
    // nothing, so this reads low early on — which is honest: an unplanned shot
    // has no length yet, and pretending otherwise would hide the overrun.
    const actual = shots.reduce((n, sh) => n + (sh.durationSec > 0 ? sh.durationSec : 0), 0);
    const over = planned > 0 && actual > planned;
    const unplaced = s.scenes.filter(c => !s.sequences.some(q => q.id === c.sequenceId));

    return html`<div class="sp">
      <!-- Header = drag handle. No pointer claiming: the panel must move like
           any other canvas object. -->
      <div class="sp__head">
        <span class="sp__kind">Screenplay</span>
        <div
          class="sp__title"
          contenteditable="plaintext-only"
          data-placeholder="Untitled video"
          @pointerdown=${this.claimCaret}
          @keydown=${stopFieldKeys}
          @blur=${(e: FocusEvent) => this.commitHead('title', e.target as HTMLElement)}
        >${s.title}</div>
      </div>

      <div
        class="sp__body"
        @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
        @dblclick=${(e: Event) => e.stopPropagation()}
        @wheel=${(e: WheelEvent) => e.stopPropagation()}
      >
        ${HEAD_FIELDS.map(f => html`<div class="field field--${f.key}">
          <span class="field__label">${f.label}</span>
          <div
            class="field__text"
            contenteditable="plaintext-only"
            data-placeholder=${f.placeholder}
            @pointerdown=${this.claimCaret}
            @keydown=${stopFieldKeys}
            @blur=${(e: FocusEvent) => this.commitHead(f.key, e.target as HTMLElement)}
          >${s[f.key]}</div>
        </div>`)}

        <div class="sect">
          <span class="sect__label">Structure</span>
          ${planned > 0
            ? html`<span class="runtime ${over ? 'runtime--over' : ''}">
                <b>${actual}s</b> of ${planned}s planned
              </span>`
            : nothing}
        </div>

        ${s.sequences.length
          ? html`<div class="seqs">
              ${repeat(s.sequences, q => q.id, (q, i) => {
                const scenes = s.scenes.filter(c => c.sequenceId === q.id);
                const n = shotsInSequence(q.id);
                return html`<div class="seq ${n === 0 ? 'seq--empty' : ''}">
                  <div class="seq__top">
                    <span class="seq__n">${i + 1}</span>
                    <div
                      class="seq__title"
                      contenteditable="plaintext-only"
                      data-placeholder="What this run has to do"
                      @pointerdown=${this.claimCaret}
                      @keydown=${stopFieldKeys}
                      @blur=${(e: FocusEvent) =>
                        this.commitSequence(q.id, 'title', e.target as HTMLElement)}
                    >${q.title}</div>
                    <div
                      class="seq__sec"
                      contenteditable="plaintext-only"
                      title="Time budget for this run"
                      @pointerdown=${this.claimCaret}
                      @keydown=${stopFieldKeys}
                      @blur=${(e: FocusEvent) =>
                        this.commitSeconds(q.id, e.target as HTMLElement)}
                    >${q.targetSec ? `${q.targetSec}s` : ''}</div>
                    <button
                      class="seq__purpose"
                      title=${PURPOSE_HINT[q.purpose]}
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        this._menuFor = this._menuFor === q.id ? '' : q.id;
                      }}
                    >${q.purpose}</button>
                  </div>
                  <div
                    class="seq__sum"
                    contenteditable="plaintext-only"
                    data-placeholder=${PURPOSE_HINT[q.purpose]}
                    @pointerdown=${this.claimCaret}
                    @keydown=${stopFieldKeys}
                    @blur=${(e: FocusEvent) =>
                      this.commitSequence(q.id, 'summary', e.target as HTMLElement)}
                  >${q.summary}</div>

                  ${scenes.length
                    ? html`<div class="scenes">
                        ${repeat(scenes, c => c.id, c => this.renderScene(
                          c, letterOf.get(c.id) ?? '?', countByScene.get(c.id) ?? 0))}
                      </div>`
                    : nothing}

                  <div class="seq__foot">
                    <button
                      class="seq__add"
                      @click=${(e: Event) => { e.stopPropagation(); this.addScene(q.id); }}
                    >+ scene</button>
                    ${q.music ? html`<span>♪ ${q.music}</span>` : nothing}
                    <button
                      class="seq__x"
                      title="Remove this sequence — its scenes and shots stay"
                      @click=${(e: Event) => { e.stopPropagation(); this.removeSequence(q.id); }}
                    >×</button>
                  </div>

                  ${this._menuFor === q.id
                    ? html`<div class="menu" @click=${(e: Event) => e.stopPropagation()}>
                        ${SEQUENCE_PURPOSES.map(pp => html`<button
                          class="menu__item"
                          @click=${() => this.setPurpose(q.id, pp)}
                        >
                          <div class="menu__k">${pp}</div>
                          <div class="menu__h">${PURPOSE_HINT[pp]}</div>
                        </button>`)}
                      </div>`
                    : nothing}
                </div>`;
              })}
            </div>`
          : html`<div class="empty">
              No structure yet. Tell the agent what you want to make, or add the
              first sequence yourself.
            </div>`}

        <!--
          SCENES NOBODY HAS PLACED YET, shown rather than hidden.

          A scene loses its sequence when that sequence is deleted, and shots
          attached to it are real work. Dropping it out of the panel would make
          those shots look unaccounted for while they sit on the canvas.
        -->
        ${unplaced.length
          ? html`<div class="sect"><span class="sect__label">Not in a sequence</span></div>
            <div class="scenes">
              ${repeat(unplaced, c => c.id, c => this.renderScene(
                c, letterOf.get(c.id) ?? '?', countByScene.get(c.id) ?? 0))}
            </div>`
          : nothing}

        <button class="add" @click=${(e: Event) => { e.stopPropagation(); this.addSequence(); }}>
          + Add sequence
        </button>
      </div>
    </div>`;
  }
}
