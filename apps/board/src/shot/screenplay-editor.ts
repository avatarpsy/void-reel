/**
 * THE screenplay editor — the page you read is the page you write.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ONE RENDERER, NOT TWO
 * ══════════════════════════════════════════════════════════════════════════
 * Reading was a formatted page; writing was a textarea of raw Fountain with
 * nothing indented and every `Title:` and `##` showing. Switching between
 * them looked like the document had been replaced by its source, and the two
 * could never be made to match because they were different things.
 *
 * This is one CodeMirror view for both. It formats each source line as it is
 * typed — sluglines bold and capitalised, cues and dialogue at their indents,
 * transitions flush right, the title page centred — so "reading" is the same
 * editor with the caret switched off. There is nothing to keep in step.
 *
 * ── SYNTAX HIDES UNTIL YOU ARE ON IT ──────────────────────────────────────
 * `Title: `, `## `, `= `, the `>`/`<` of centred text: shown faintly on the
 * line with the caret, hidden everywhere else. The page reads as a script and
 * the source is still one click away, the way a good markdown editor treats
 * its own markup.
 *
 * ── THE TEXT IS STILL FOUNTAIN ────────────────────────────────────────────
 * The document is the same string it always was — what the agent writes, what
 * the shots hang off, what exports. Nothing about the model changed; only how
 * it is drawn and edited.
 */
import { Compartment, EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import {
  Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

import { pageModel, type PageModel } from './screenplay-lines';

/** Shots per scene key — the coverage the margin marks show. */
export type Coverage = ReadonlyMap<string, number>;

const setCoverage = StateEffect.define<Coverage>();
const setRevealing = StateEffect.define<boolean>();

/** The page model, recomputed only when the TEXT or the coverage changes. */
const modelField = StateField.define<{ model: PageModel; coverage: Coverage }>({
  create(state) {
    const coverage: Coverage = new Map();
    return { model: pageModel(state.doc.toString(), (k) => coverage.get(k) ?? 0), coverage };
  },
  update(value, tr) {
    let coverage = value.coverage;
    for (const e of tr.effects) if (e.is(setCoverage)) coverage = e.value;
    if (!tr.docChanged && coverage === value.coverage) return value;
    return { model: pageModel(tr.state.doc.toString(), (k) => coverage.get(k) ?? 0), coverage };
  },
});

/** Whether the syntax on the caret's line is shown — true while focused. */
const revealField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRevealing)) return e.value;
    return value;
  },
});

/**
 * WHERE A PAGE TURNS — a hairline across the whole sheet with the page's
 * number at the right, drawn from the same layout the PDF is set by.
 */
class PageBreak extends WidgetType {
  constructor(readonly page: number) { super(); }
  override eq(other: PageBreak): boolean { return other.page === this.page; }
  override toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'sp-pagebreak';
    el.setAttribute('aria-hidden', 'true');
    // Page 1 carries no number on paper, so it carries none here.
    if (this.page > 1) el.dataset.page = `${this.page}.`;
    return el;
  }
  override ignoreEvent(): boolean { return true; }
}

const hideSyntax = Decoration.replace({});
const showSyntax = Decoration.mark({ class: 'sp-syntax' });
const hiddenMark = Decoration.mark({ class: 'sp-hidden' });

function decorate(state: EditorState): DecorationSet {
  const { model } = state.field(modelField);
  const revealing = state.field(revealField);
  const active = new Set<number>();
  if (revealing) {
    for (const r of state.selection.ranges) {
      const a = state.doc.lineAt(r.from).number;
      const b = state.doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) active.add(n);
    }
  }

  const out: Range<Decoration>[] = [];
  const count = Math.min(state.doc.lines, model.lines.length);
  for (let n = 1; n <= count; n++) {
    const line = state.doc.line(n);
    const info = model.lines[n - 1]!;
    if (info.pageStart !== undefined) {
      out.push(Decoration.widget({ widget: new PageBreak(info.pageStart), block: true, side: -1 }).range(line.from));
    }
    const classes = [`sp-${info.type}`];
    const attributes: Record<string, string> = {};
    if (n === 1) classes.push('sp-first');
    if (info.key) attributes['data-key'] = info.key;
    if (info.mark !== undefined) {
      classes.push('sp-marker');
      attributes['data-mark'] = info.mark;
      attributes['data-covered'] = info.covered ? 'yes' : 'no';
    }
    out.push(Decoration.line({ class: classes.join(' '), attributes }).range(line.from));
    for (const [a, b] of info.syntax) {
      if (b <= a) continue;
      out.push((active.has(n) ? showSyntax : hideSyntax).range(line.from + a, line.from + b));
    }
  }
  for (const [a, b] of model.hidden) {
    if (b > a && b <= state.doc.length) out.push(hiddenMark.range(a, b));
  }
  return Decoration.set(out, true);
}

const decorations = StateField.define<DecorationSet>({
  create: decorate,
  update(value, tr) {
    const moved = tr.selection && tr.state.field(revealField);
    const changed = tr.docChanged
      || tr.effects.some((e) => e.is(setCoverage) || e.is(setRevealing));
    return changed || moved ? decorate(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface ScreenplayEditorOptions {
  text: string;
  /** Writable from the start (focus mode) or only once asked (the canvas). */
  editable?: boolean;
  coverage?: Coverage;
  /** Shown on an empty page. */
  placeholder?: string;
  /** Every change to the text, as it happens. The caller debounces. */
  onChange?: (text: string) => void;
  /** The editor lost focus — the moment to save. */
  onBlur?: () => void;
  /** Escape, pressed while writing. */
  onEscape?: () => void;
}

export interface ScreenplayEditor {
  readonly view: EditorView;
  text(): string;
  /** Replace the text from outside — the agent rewrote it — keeping the caret. */
  setText(text: string): void;
  setCoverage(coverage: Coverage): void;
  setEditable(on: boolean): void;
  /** Focus, with the caret at a screen point (a double-click) or at the end. */
  focusAt(point?: { x: number; y: number }): void;
  /** Script pages, excluding the title page. */
  pages(): number;
  destroy(): void;
}

export function createScreenplayEditor(
  parent: HTMLElement,
  opts: ScreenplayEditorOptions,
): ScreenplayEditor {
  const editable = new Compartment();
  const isEditable = (on: boolean) => [EditorView.editable.of(on), EditorState.readOnly.of(!on)];

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.text ?? '',
      extensions: [
        modelField,
        revealField,
        decorations,
        history(),
        EditorView.lineWrapping,
        editable.of(isEditable(opts.editable ?? false)),
        placeholder(opts.placeholder ?? ''),
        EditorView.contentAttributes.of({
          spellcheck: 'true',
          'aria-label': 'Screenplay',
          // BlockSuite syncs the document selection into its own inline
          // editors; this one is not one of them and must be left alone.
          'data-range-sync-exclude': 'true',
        }),
        EditorView.focusChangeEffect.of((_state, focusing) => setRevealing.of(focusing)),
        keymap.of([
          { key: 'Escape', run: () => { if (!opts.onEscape) return false; opts.onEscape(); return true; } },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange?.(u.state.doc.toString());
          if (u.focusChanged && !u.view.hasFocus) opts.onBlur?.();
        }),
      ],
    }),
  });
  if (opts.coverage) view.dispatch({ effects: setCoverage.of(opts.coverage) });

  return {
    view,
    text: () => view.state.doc.toString(),
    setText(next: string) {
      const doc = view.state.doc.toString();
      if (next === doc) return;
      /**
       * THE SMALLEST CHANGE, not a replace-all: the common head and tail are
       * left alone, so the caret, the scroll and the undo history outside the
       * edited stretch all survive the agent rewriting one scene.
       */
      let head = 0;
      const max = Math.min(doc.length, next.length);
      while (head < max && doc.charCodeAt(head) === next.charCodeAt(head)) head++;
      let tail = 0;
      while (
        tail < max - head
        && doc.charCodeAt(doc.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
      ) tail++;
      view.dispatch({
        changes: { from: head, to: doc.length - tail, insert: next.slice(head, next.length - tail) },
      });
    },
    setCoverage(coverage: Coverage) {
      const current = view.state.field(modelField).coverage;
      if (current.size === coverage.size && [...coverage].every(([k, n]) => current.get(k) === n)) return;
      view.dispatch({ effects: setCoverage.of(coverage) });
    },
    setEditable(on: boolean) {
      view.dispatch({ effects: editable.reconfigure(isEditable(on)) });
    },
    focusAt(point) {
      const pos = point ? view.posAtCoords(point) : null;
      const at = pos ?? view.state.doc.length;
      view.dispatch({ selection: { anchor: at }, scrollIntoView: pos === null });
      view.focus();
    },
    pages: () => view.state.field(modelField).model.pages,
    destroy: () => view.destroy(),
  };
}
