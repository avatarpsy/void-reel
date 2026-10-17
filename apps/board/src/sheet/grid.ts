/**
 * The sheet grid — our own, in lit-html, virtualised with @tanstack/virtual-core.
 *
 * Loaded lazily by focus mode only; the canvas card never imports it.
 *
 * ── HOW IT IS BUILT ──────────────────────────────────────────────────────────
 * Plain DOM, not canvas, so phone keyboards (and non-Latin input), screen
 * readers and text selection work. Rows and columns are virtualised: only what
 * is on screen exists. The row-number gutter and the frozen columns are
 * `position: sticky` cells inside each (absolutely placed) row, which is what
 * lets them stay put while the rest scrolls with no scroll-syncing script.
 *
 * Keys go to one hidden textarea that follows the active cell (the "sink"), so
 * typing or an IME composition starts an edit where the user is looking, and
 * Ctrl+C / Ctrl+V reach real clipboard events.
 *
 * Sort, filter and search are VIEWS: they change what this person sees and
 * never the stored order. They are kept per person, in this browser.
 */
import type { BlockStdScope } from '@blocksuite/std';
import {
  Virtualizer, elementScroll, observeElementOffset, observeElementRect,
} from '@tanstack/virtual-core';
import { html, nothing, render, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { live } from 'lit/directives/live.js';
import * as Y from 'yjs';

import {
  type CellValue, type ColumnType, type DisplayRow, type SheetColumn, type StatusChoice,
  COLUMN_TYPES, MULTI_SEPARATOR, SHEET_LIMITS, cellText, formatDuration, readTabs,
} from './sheet-data';
import {
  type CellWrite, type TabSnapshot, SheetError, addColumn, addRows, addRowsPaced, coerce, deleteColumn,
  deleteRows, moveColumn, moveRows, parseDate, readTab, setCells, setCellsPaced, setRowLink,
  sheetYBlock, updateColumn, updateTab, STATUS_COLORS,
} from './ops';
import { parseDelimited, toDelimited } from './csv';
import { type TotalKind, TOTAL_LABEL, computeTotal, totalsFor } from './totals';
import { toast } from '../ui/toast';
import { MONTH, prettyDate } from './format';
import {
  type SheetActivity, type TabKind, ActivityPoller, createEpisodeBoard, episodeFields, listSeries,
  ownBoardId, readyRows, rowValues, runAsSeries, sendRowForApproval, tabKind, type SeriesChoice,
} from './activity';
import { readShots } from '../shot/shots';
import { readParsed } from '../shot/screenplay-doc';
import { decodeMediaRef, isMediaRef } from '../board/media-ref';

import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
const LINK_ICON = unsafeSVG('<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6.5 9.5l3-3"/><path d="M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2"/><path d="M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"/></svg>');

export const ROW_H = 34;
export const HEADER_H = 36;
export const FOOTER_H = 32;
export const GUTTER_W = 48;

export const TYPE_LABEL: Record<ColumnType, string> = {
  text: 'Text', longtext: 'Long text', number: 'Number', duration: 'Duration', date: 'Date',
  time: 'Time', status: 'Status', person: 'Person', checkbox: 'Checkbox', url: 'Link (web)',
  media: 'Picture or clip', link: 'Shot or board',
};

const TYPE_ICON: Record<ColumnType, string> = {
  text: 'T', longtext: '¶', number: '#', duration: '◷', date: '▦', time: '◔',
  status: '◉', person: '☺', checkbox: '☑', url: '↗', media: '▣', link: '⇢',
};

type Filter = { col: string; op: 'contains' | 'is' | 'not' | 'empty' | 'filled' | 'any'; value: string; values?: string[] };
interface View { sort: { col: string; dir: 1 | -1 } | null; filters: Filter[]; totals: Record<string, TotalKind> }

interface Sel { r: number; c: number; ar: number; ac: number }
interface Edit { r: number; c: number; value: string; kind: 'input' | 'textarea' }

type Popover =
  | { kind: 'column'; col: string; x: number; y: number }
  | { kind: 'type'; col: string; x: number; y: number }
  | { kind: 'choices'; col: string }
  | { kind: 'status'; r: number; c: number; x: number; y: number; query: string }
  | { kind: 'date'; r: number; c: number; x: number; y: number; month: string }
  | { kind: 'link'; r: number; c: number; x: number; y: number; query: string }
  | { kind: 'row'; r: number; x: number; y: number }
  | { kind: 'filter'; x: number; y: number }
  | { kind: 'hidden'; x: number; y: number }
  | { kind: 'delete-linked'; keys: string[] }
  | { kind: 'rename'; col: string; value: string; x: number; y: number }
  | { kind: 'series'; choices: SeriesChoice[] | null; busy?: boolean; error?: string }
  | { kind: 'repost'; rowKey: string };

/** A read-only column drawn from Activity (never stored in the sheet). */
interface ActCol { id: 'post' | 'episode' | 'board'; name: string; width: number }

/** What happened when a row was last sent, until the next status read. */
interface RowNote { tone: 'ok' | 'warn' | 'error'; text: string }

export interface GridOptions {
  std: BlockStdScope;
  blockId: string;
  tabId: string;
  readonly: boolean;
  /** "Make cards from rows" — focus mode owns it (it needs the surface id). */
  onMakeCards?: (rowKeys: string[]) => void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
void esc;

function viewKey(blockId: string, tabId: string) { return `vs-sheet-view:${blockId}:${tabId}`; }
function loadView(blockId: string, tabId: string): View {
  try {
    const raw = localStorage.getItem(viewKey(blockId, tabId));
    if (raw) { const v = JSON.parse(raw); return { sort: v.sort ?? null, filters: Array.isArray(v.filters) ? v.filters : [], totals: v.totals ?? {} }; }
  } catch { /* per-viewer convenience only */ }
  return { sort: null, filters: [], totals: {} };
}
function saveView(blockId: string, tabId: string, v: View) {
  try { localStorage.setItem(viewKey(blockId, tabId), JSON.stringify(v)); } catch { /* fine */ }
}

function initials(name: string): string {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function mediaSrc(v: string): string {
  if (isMediaRef(v)) return decodeMediaRef(v)?.src ?? '';
  return /^https?:\/\//i.test(v) ? v : '';
}

export class SheetGrid {
  private std: BlockStdScope;
  private blockId: string;
  tabId: string;
  private readonly: boolean;
  private host: HTMLElement;
  private opts: GridOptions;

  private snap: TabSnapshot | null = null;
  private cols: SheetColumn[] = [];
  private rows: DisplayRow[] = [];
  private view: View;
  private sel: Sel = { r: 0, c: 0, ar: 0, ac: 0 };
  private edit: Edit | null = null;
  private pop: Popover | null = null;
  private search = { q: '', hits: [] as Array<[number, number]>, i: 0 };
  private widthsPreview = new Map<string, number>();
  private drag: null | { kind: 'select' | 'fill' | 'col-move' | 'row-move' | 'resize'; [k: string]: unknown } = null;
  private dropAt: { kind: 'col' | 'row'; index: number } | null = null;
  private kind: TabKind = null;
  private actCols: ActCol[] = [];
  private activity: SheetActivity | null = null;
  private notes = new Map<string, RowNote>();
  private poller: ActivityPoller | null = null;
  private sending = false;
  /** A clipboard key was pressed and its native event has not arrived yet. */
  private clipExpect: 'c' | 'x' | 'v' | null = null;

  private scroller!: HTMLElement;
  private sink!: HTMLTextAreaElement;
  private rowV!: Virtualizer<HTMLElement, HTMLElement>;
  private colV!: Virtualizer<HTMLElement, HTMLElement>;
  private cleanup: Array<() => void> = [];
  private frame = 0;
  private dirty = true;
  private yBlock: Y.Map<unknown> | null = null;

  constructor(host: HTMLElement, opts: GridOptions) {
    this.host = host;
    this.opts = opts;
    this.std = opts.std;
    this.blockId = opts.blockId;
    this.tabId = opts.tabId;
    this.readonly = opts.readonly;
    this.view = loadView(this.blockId, this.tabId);
    host.classList.add('vsg');
    this.mount();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private mount(): void {
    this.host.innerHTML = `
      <div class="vsg-toolbar" data-toolbar></div>
      <div class="vsg-scroller" data-scroller tabindex="-1">
        <div class="vsg-inner" data-inner></div>
      </div>
      <textarea class="vsg-sink" data-sink aria-label="Sheet cell" autocapitalize="off" autocomplete="off" spellcheck="false" rows="1"></textarea>
      <div class="vsg-layer" data-layer></div>`;
    this.scroller = this.host.querySelector('[data-scroller]')!;
    this.sink = this.host.querySelector('[data-sink]')!;

    this.rowV = new Virtualizer<HTMLElement, HTMLElement>({
      count: 0,
      getScrollElement: () => this.scroller,
      estimateSize: () => ROW_H,
      overscan: 10,
      scrollMargin: HEADER_H,
      observeElementRect, observeElementOffset, scrollToFn: elementScroll,
      onChange: () => this.schedule(),
    });
    this.colV = new Virtualizer<HTMLElement, HTMLElement>({
      count: 0,
      horizontal: true,
      getScrollElement: () => this.scroller,
      estimateSize: i => (i < this.cols.length ? this.widthOf(this.cols[i]) : this.actCols[i - this.cols.length]?.width ?? 160),
      overscan: 3,
      scrollMargin: GUTTER_W,
      rangeExtractor: range => {
        const f = this.frozenCount();
        const out = new Set<number>();
        for (let i = 0; i < Math.min(f, range.count); i++) out.add(i);
        for (let i = Math.max(0, range.startIndex - range.overscan); i <= Math.min(range.count - 1, range.endIndex + range.overscan); i++) out.add(i);
        return [...out].sort((a, b) => a - b);
      },
      observeElementRect, observeElementOffset, scrollToFn: elementScroll,
      onChange: () => this.schedule(),
    });
    this.cleanup.push(this.rowV._didMount(), this.colV._didMount());

    this.yBlock = sheetYBlock(this.std.store, this.blockId);
    const onDeep = () => { this.dirty = true; this.schedule(); };
    this.yBlock?.observeDeep(onDeep);
    this.cleanup.push(() => this.yBlock?.unobserveDeep(onDeep));
    const sub = this.std.store.slots.blockUpdated.subscribe(e => {
      if ((e as { flavour?: string }).flavour === 'voidspace:shot') { this.dirty = true; this.schedule(); }
    });
    this.cleanup.push(() => sub.unsubscribe());

    this.poller = new ActivityPoller(data => { this.activity = data; this.schedule(); });
    this.cleanup.push(() => this.poller?.destroy());
    this.bindEvents();
    this.refresh();
    this.renderNow();
    this.focusSink();
  }

  destroy(): void {
    this.commitEdit();
    cancelAnimationFrame(this.frame);
    this.cleanup.forEach(f => { try { f(); } catch { /* gone */ } });
    this.cleanup = [];
    const inner = this.host.querySelector<HTMLElement>('[data-inner]'); if (inner) render(nothing, inner);
    this.host.innerHTML = '';
    this.host.classList.remove('vsg');
  }

  setTab(tabId: string): void {
    if (tabId === this.tabId) return;
    this.commitEdit();
    this.tabId = tabId;
    this.view = loadView(this.blockId, tabId);
    this.sel = { r: 0, c: 0, ar: 0, ac: 0 };
    this.pop = null;
    this.search = { q: '', hits: [], i: 0 };
    this.dirty = true;
    this.scroller.scrollTo({ top: 0, left: 0 });
    this.schedule();
  }

  setReadonly(ro: boolean): void { this.readonly = ro; this.schedule(); }

  focusSink(): void {
    if (this.edit) return;
    try { this.sink.focus({ preventScroll: true }); } catch { /* detached */ }
  }

  /** The rows on screen now (filtered and sorted), for exports of "what I see". */
  visibleRowKeys(): string[] { return this.rows.map(r => r.key); }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderNow(); });
  }

  // ── data ───────────────────────────────────────────────────────────────────

  private frozenCount(): number {
    const f = this.snap?.tab.frozen ?? 1;
    return Math.max(0, Math.min(f, Math.max(0, this.cols.length - 1)));
  }

  private widthOf(col: SheetColumn | undefined): number {
    if (!col) return 160;
    return this.widthsPreview.get(col.id) ?? col.width;
  }

  value(row: DisplayRow, col: SheetColumn): CellValue {
    if (!this.yBlock || !this.snap) return null;
    if (col.bind && this.snap.tab.binding?.kind === 'shots' && row.shotId) {
      if (row.removed) return null;
      const p = this.std.store.getBlock(row.shotId)?.model.props as Record<string, unknown> | undefined;
      const key = col.bind.slice(5);
      const v = p?.[key];
      if (col.bind === 'shot.durationSec') return typeof v === 'number' && v > 0 ? v : null;
      return typeof v === 'string' ? v : v == null ? null : String(v);
    }
    if (!row.rowId) return null;
    const cells = this.yBlock.get('prop:cells');
    const v = cells instanceof Y.Map ? cells.get(`${row.rowId}:${col.id}`) : undefined;
    return v === undefined ? null : (v as CellValue);
  }

  private refresh(): void {
    this.dirty = false;
    this.yBlock = sheetYBlock(this.std.store, this.blockId) ?? this.yBlock;
    this.snap = readTab(this.std, this.blockId, this.tabId);
    if (!this.snap) {
      const first = this.yBlock ? readTabs(this.yBlock)[0] : undefined;
      if (first && first.id !== this.tabId) { this.tabId = first.id; this.snap = readTab(this.std, this.blockId, this.tabId); }
    }
    if (!this.snap) { this.cols = []; this.rows = []; return; }
    this.cols = this.snap.columns.filter(c => !c.hidden);
    // The read-only "from Activity" columns — the owner's own board only.
    const kind = ownBoardId() ? tabKind(this.snap.tab, this.snap.columns) : null;
    if (kind !== this.kind) {
      this.kind = kind;
      this.actCols = kind === 'calendar' ? [{ id: 'post', name: 'Post', width: 240 }]
        : kind === 'episodes' ? [{ id: 'episode', name: 'Episode', width: 230 }, { id: 'board', name: 'Board', width: 160 }]
        : [];
      this.colV?.measure();
    }
    this.poller?.setTarget(this.blockId, kind ? this.snap.tab : null);
    let rows = this.snap.rows;
    const colById = new Map(this.snap.columns.map(c => [c.id, c] as const));
    for (const f of this.view.filters) {
      const col = colById.get(f.col);
      if (!col) continue;
      rows = rows.filter(r => this.matches(f, col, this.value(r, col)));
    }
    if (this.view.sort) {
      const col = colById.get(this.view.sort.col);
      if (col) {
        const dir = this.view.sort.dir;
        const keyed = rows.map(r => ({ r, v: this.value(r, col) }));
        keyed.sort((a, b) => {
          const av = a.v; const bv = b.v;
          const ae = av === null || av === ''; const be = bv === null || bv === '';
          if (ae || be) return ae && be ? 0 : ae ? 1 : -1; // empties last, both ways
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
          if (col.type === 'status' && col.options) {
            const ia = col.options.findIndex(o => o.label === av); const ib = col.options.findIndex(o => o.label === bv);
            if (ia !== ib) return ((ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)) * dir;
          }
          return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
        });
        rows = keyed.map(k => k.r);
      }
    }
    this.rows = rows;
    this.clampSel();
    this.recomputeSearch();
  }

  private matches(f: Filter, col: SheetColumn, v: CellValue): boolean {
    const text = cellText(v, col.type).toLowerCase();
    const want = (f.value ?? '').toLowerCase().trim();
    switch (f.op) {
      case 'empty': return text === '';
      case 'filled': return text !== '';
      case 'is': return want === '' ? true : text === want || (col.type === 'checkbox' && String(v) === want);
      case 'not': return want === '' ? true : text !== want;
      case 'any': {
        const set = (f.values ?? []).map(s => s.toLowerCase());
        if (!set.length) return true;
        const parts = text.split(/\s*,\s*/);
        return parts.some(p => set.includes(p));
      }
      default: return want === '' ? true : text.includes(want);
    }
  }

  private clampSel(): void {
    const maxR = Math.max(0, this.rows.length - 1); const maxC = Math.max(0, this.cols.length - 1);
    const s = this.sel;
    this.sel = { r: Math.min(s.r, maxR), c: Math.min(s.c, maxC), ar: Math.min(s.ar, maxR), ac: Math.min(s.ac, maxC) };
  }

  private recomputeSearch(): void {
    const q = this.search.q.trim().toLowerCase();
    if (!q) { this.search.hits = []; this.search.i = 0; return; }
    const hits: Array<[number, number]> = [];
    this.rows.forEach((row, r) => this.cols.forEach((col, c) => {
      if (hits.length < 5000 && this.display(row, col).toLowerCase().includes(q)) hits.push([r, c]);
    }));
    this.search.hits = hits;
    if (this.search.i >= hits.length) this.search.i = 0;
  }

  /** The text a cell shows (and copies). */
  display(row: DisplayRow, col: SheetColumn): string {
    const v = this.value(row, col);
    if (col.type === 'link' && typeof v === 'string') return this.linkLabel(v);
    return cellText(v, col.type);
  }

  private linkLabel(v: string): string {
    if (v.startsWith('shot:')) {
      const id = v.slice(5);
      const shots = readShots(this.std);
      const i = shots.findIndex(s => s.id === id);
      return i < 0 ? 'Shot removed' : `Shot ${i + 1}${shots[i]!.title ? ` · ${shots[i]!.title}` : ''}`;
    }
    if (v.startsWith('board:')) return 'Board';
    return v;
  }

  // ── geometry helpers ───────────────────────────────────────────────────────

  private range(): { r0: number; r1: number; c0: number; c1: number } {
    const s = this.sel;
    return { r0: Math.min(s.r, s.ar), r1: Math.max(s.r, s.ar), c0: Math.min(s.c, s.ac), c1: Math.max(s.c, s.ac) };
  }

  private inRange(r: number, c: number): boolean {
    const g = this.range();
    return r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
  }

  private cellEl(r: number, c: number): HTMLElement | null {
    return this.host.querySelector(`[data-r="${r}"][data-c="${c}"]`);
  }

  private reveal(r: number, c: number): void {
    if (r >= 0 && r < this.rows.length) this.rowV.scrollToIndex(r, { align: 'auto' });
    if (c >= this.frozenCount() && c < this.cols.length) this.colV.scrollToIndex(c, { align: 'auto' });
  }

  private move(dr: number, dc: number, extend = false): void {
    if (!this.rows.length || !this.cols.length) return;
    const r = Math.max(0, Math.min(this.rows.length - 1, this.sel.r + dr));
    const c = Math.max(0, Math.min(this.cols.length - 1, this.sel.c + dc));
    this.sel = extend ? { ...this.sel, r, c } : { r, c, ar: r, ac: c };
    this.reveal(r, c);
    this.schedule();
  }

  private jumpEdge(dr: number, dc: number, extend: boolean): void {
    const r = dr > 0 ? this.rows.length - 1 : dr < 0 ? 0 : this.sel.r;
    const c = dc > 0 ? this.cols.length - 1 : dc < 0 ? 0 : this.sel.c;
    this.sel = extend ? { ...this.sel, r, c } : { r, c, ar: r, ac: c };
    this.reveal(r, c);
    this.schedule();
  }

  // ── writing ────────────────────────────────────────────────────────────────

  private guard(): boolean {
    if (this.readonly) { toast('This board is open to view only.', 'info'); return false; }
    return true;
  }

  private run<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e) {
      toast(e instanceof SheetError ? e.message : `That did not work: ${(e as Error)?.message ?? e}`, 'error');
      return undefined;
    }
  }

  private writeCell(r: number, c: number, raw: unknown): void {
    const row = this.rows[r]; const col = this.cols[c];
    if (!row || !col || !this.guard()) return;
    if (row.removed && col.bind) { toast('This shot was removed from the board.', 'info'); return; }
    this.run(() => setCells(this.std, this.blockId, [{ row: row.key, col: col.id, value: raw }]));
  }

  private clearRange(): void {
    if (!this.guard()) return;
    const g = this.range();
    const writes: CellWrite[] = [];
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
      const row = this.rows[r]; const col = this.cols[c];
      if (!row || !col) continue;
      if (col.bind && row.removed) continue;
      if (this.value(row, col) === null) continue;
      writes.push({ row: row.key, col: col.id, value: null });
    }
    if (writes.length) this.run(() => setCells(this.std, this.blockId, writes));
  }

  // ── clipboard ──────────────────────────────────────────────────────────────

  private copyText(): string {
    const g = this.range();
    const out: string[][] = [];
    for (let r = g.r0; r <= g.r1; r++) {
      const row = this.rows[r]; if (!row) continue;
      const line: string[] = [];
      for (let c = g.c0; c <= g.c1; c++) {
        const col = this.cols[c]; if (!col) continue;
        const v = this.value(row, col);
        line.push(col.type === 'link' ? String(v ?? '') : cellText(v, col.type));
      }
      out.push(line);
    }
    return toDelimited(out, '\t');
  }

  /** Copy, cut or paste through the async Clipboard API (see onKey). */
  private async clipFallback(k: 'c' | 'x' | 'v'): Promise<void> {
    try {
      if (k === 'v') {
        const text = await navigator.clipboard.readText();
        if (text) await this.paste(text);
        return;
      }
      await navigator.clipboard.writeText(this.copyText());
      if (k === 'x') this.clearRange();
    } catch {
      toast(k === 'v' ? 'Paste with Ctrl+V after clicking a cell, or allow clipboard access.' : 'Copy did not work here. Allow clipboard access and try again.', 'info');
    }
  }

  private async paste(text: string): Promise<void> {
    if (!this.guard() || !this.snap) return;
    const matrix = /[\t\n\r]/.test(text) ? parseDelimited(text.replace(/\r?\n$/, ''), '\t') : [[text]];
    if (!matrix.length) return;
    const g = this.range();
    const writes: CellWrite[] = [];
    // One value into a bigger selection: fill the selection, like every sheet app.
    if (matrix.length === 1 && matrix[0]!.length === 1 && (g.r1 > g.r0 || g.c1 > g.c0)) {
      for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
        const row = this.rows[r]; const col = this.cols[c];
        if (row && col && !(col.bind && row.removed)) writes.push({ row: row.key, col: col.id, value: matrix[0]![0] });
      }
      this.run(() => setCells(this.std, this.blockId, writes));
      return;
    }
    const height = matrix.length;
    const width = Math.max(...matrix.map(r => r.length));
    const startR = this.rows.length ? g.r0 : 0;
    const startC = g.c0;
    const tabId = this.tabId;

    if (this.view.sort || this.view.filters.length) {
      if (startR + height > this.rows.length) {
        toast('Turn off sort and filters to paste past the last row.', 'info');
        return;
      }
    }
    // Room: new columns, then new rows.
    const needCols = startC + width - this.cols.length;
    if (needCols > 0) {
      if (this.snap.columns.length + needCols > SHEET_LIMITS.columns) { toast(`A tab can have up to ${SHEET_LIMITS.columns} columns.`, 'error'); return; }
      let after = this.cols.at(-1)?.id ?? null;
      for (let i = 0; i < needCols; i++) {
        const id = this.run(() => addColumn(this.std.store, this.blockId, tabId, { name: `Column ${this.cols.length + i + 1}` }, after));
        if (!id) return;
        after = id;
      }
      this.refresh();
    }
    const needRows = startR + height - this.rows.length;
    const done = needRows > 300 || height * width > 3000 ? toastProgress('Pasting…') : null;
    try {
      if (needRows > 0) {
        if ((this.snap?.rows.length ?? 0) + needRows > SHEET_LIMITS.rowsPerTab) { toast(`A tab can have up to ${SHEET_LIMITS.rowsPerTab.toLocaleString('en')} rows.`, 'error'); return; }
        await addRowsPaced(this.std.store, this.blockId, tabId, needRows, this.snap?.rows.at(-1)?.rowId ?? null);
        this.refresh();
      }
      for (let i = 0; i < height; i++) {
        const row = this.rows[startR + i]; if (!row) continue;
        for (let j = 0; j < matrix[i]!.length; j++) {
          const col = this.cols[startC + j]; if (!col) continue;
          if (col.bind && row.removed) continue;
          writes.push({ row: row.key, col: col.id, value: matrix[i]![j] });
        }
      }
      const res = await setCellsPaced(this.std, this.blockId, writes);
      this.sel = { r: startR, c: startC, ar: startR + height - 1, ac: Math.min(this.cols.length - 1, startC + width - 1) };
      if (height * width > 1) toast(`Pasted ${height.toLocaleString('en')} row${height === 1 ? '' : 's'} × ${width} column${width === 1 ? '' : 's'}.`, 'info');
      void res;
    } catch (e) {
      toast(e instanceof SheetError ? e.message : 'That paste did not work.', 'error');
    } finally {
      done?.();
      this.schedule();
    }
  }

  private fillDown(): void {
    if (!this.guard()) return;
    const g = this.range();
    if (g.r1 === g.r0) return;
    const writes: CellWrite[] = [];
    for (let c = g.c0; c <= g.c1; c++) {
      const col = this.cols[c]; const src = this.rows[g.r0];
      if (!col || !src) continue;
      const v = this.value(src, col);
      for (let r = g.r0 + 1; r <= g.r1; r++) {
        const row = this.rows[r];
        if (row && !(col.bind && row.removed)) writes.push({ row: row.key, col: col.id, value: v });
      }
    }
    this.run(() => setCells(this.std, this.blockId, writes));
  }

  /** The fill handle: repeat the selected rows' pattern down to `toRow`. A single date counts on by a day. */
  private fillTo(toRow: number): void {
    if (!this.guard()) return;
    const g = this.range();
    if (toRow <= g.r1) return;
    const h = g.r1 - g.r0 + 1;
    const writes: CellWrite[] = [];
    for (let c = g.c0; c <= g.c1; c++) {
      const col = this.cols[c]; if (!col) continue;
      const first = this.rows[g.r0] ? this.value(this.rows[g.r0]!, col) : null;
      const series = h === 1 && col.type === 'date' && typeof first === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(first);
      const numStep = h === 2 && (col.type === 'number') ? (() => {
        const a = this.value(this.rows[g.r0]!, col); const b = this.value(this.rows[g.r0 + 1]!, col);
        return typeof a === 'number' && typeof b === 'number' ? b - a : null;
      })() : null;
      for (let r = g.r1 + 1; r <= toRow; r++) {
        const row = this.rows[r]; if (!row) continue;
        if (col.bind && row.removed) continue;
        let v: CellValue;
        if (series) {
          const d = new Date(`${first}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + (r - g.r0));
          v = d.toISOString().slice(0, 10);
        } else if (numStep !== null) {
          v = (this.value(this.rows[g.r0 + 1]!, col) as number) + numStep * (r - g.r0 - 1);
        } else {
          v = this.value(this.rows[g.r0 + ((r - g.r0) % h)]!, col);
        }
        writes.push({ row: row.key, col: col.id, value: v });
      }
    }
    this.run(() => setCells(this.std, this.blockId, writes));
    this.sel = { ...this.sel, r: toRow, ar: g.r0, c: g.c1, ac: g.c0 };
  }

  // ── editing ────────────────────────────────────────────────────────────────

  /** Start editing the active cell. `initial` replaces the content (typing); undefined keeps it (F2/Enter). */
  startEdit(initial?: string): void {
    if (!this.guard()) return;
    const { r, c } = this.sel;
    const row = this.rows[r]; const col = this.cols[c];
    if (!row || !col) return;
    if (col.bind && row.removed) {
      toast('This shot was removed from the board.', 'info');
      return;
    }
    const cell = this.cellEl(r, c);
    const rect = cell?.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    const x = rect ? rect.left - hostRect.left : 80; const y = rect ? rect.bottom - hostRect.top : 80;
    if (col.type === 'checkbox') { this.writeCell(r, c, this.value(row, col) !== true); return; }
    if (col.type === 'status' || col.bind === 'shot.sceneKey') {
      this.pop = { kind: col.bind === 'shot.sceneKey' ? 'link' : 'status', r, c, x, y, query: initial ?? '' };
      this.openPickerNow();
      return;
    }
    if (col.type === 'link') { this.pop = { kind: 'link', r, c, x, y, query: initial ?? '' }; this.openPickerNow(); return; }
    const current = this.value(row, col);
    let text = current === null ? '' : col.type === 'duration' && typeof current === 'number' ? formatDuration(current) : String(current);
    if (initial !== undefined) text = initial;
    if (col.type === 'date' && initial === undefined) {
      const month = typeof current === 'string' && /^\d{4}-\d{2}/.test(current) ? current.slice(0, 7) : new Date().toISOString().slice(0, 7);
      this.pop = { kind: 'date', r, c, x, y, month };
    }
    this.edit = { r, c, value: text, kind: col.type === 'longtext' ? 'textarea' : 'input' };
    // NOW, not on the next frame: the keys after the first one must land in the
    // editor, and a fast typist's second key arrives before any frame does.
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.renderNow();
    const el = this.host.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-editor]');
    if (el) {
      el.value = text;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  /** Draw a picker now and give it the keyboard, so the next key lands in it. */
  private openPickerNow(): void {
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.renderNow();
    const q = this.host.querySelector<HTMLInputElement>('[data-pick]');
    if (q) { q.focus({ preventScroll: true }); q.setSelectionRange(q.value.length, q.value.length); }
  }

  commitEdit(): void {
    const e = this.edit;
    if (!e) return;
    this.edit = null;
    const el = this.host.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-editor]');
    const value = el ? el.value : e.value;
    const row = this.rows[e.r]; const col = this.cols[e.c];
    if (row && col) {
      const before = this.value(row, col);
      const beforeText = before === null ? '' : col.type === 'duration' && typeof before === 'number' ? formatDuration(before) : String(before);
      if (value !== beforeText) this.writeCell(e.r, e.c, value);
    }
    if (this.pop?.kind === 'date') this.pop = null;
    this.schedule();
  }

  private cancelEdit(): void {
    this.edit = null;
    if (this.pop?.kind === 'date') this.pop = null;
    this.schedule();
    this.focusSink();
  }

  // ── events ─────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(this.sink, 'keydown', e => this.onKey(e));
    on(this.sink, 'input', () => {
      const text = this.sink.value;
      if (!text || (this.sink as unknown as { _composing?: boolean })._composing) return;
      this.sink.value = '';
      const open = this.host.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-editor]');
      if (this.edit && open) { open.value += text; open.focus(); return; }
      this.startEdit(text);
    });
    on(this.sink, 'compositionstart', () => { (this.sink as unknown as { _composing?: boolean })._composing = true; });
    on(this.sink, 'compositionend', () => {
      (this.sink as unknown as { _composing?: boolean })._composing = false;
      const text = this.sink.value; this.sink.value = '';
      if (text) this.startEdit(text);
    });
    on(this.sink, 'copy', e => { this.clipExpect = null; e.preventDefault(); e.stopPropagation(); e.clipboardData?.setData('text/plain', this.copyText()); });
    on(this.sink, 'cut', e => {
      this.clipExpect = null;
      e.preventDefault(); e.stopPropagation();
      e.clipboardData?.setData('text/plain', this.copyText());
      this.clearRange();
    });
    on(this.sink, 'paste', e => {
      this.clipExpect = null;
      e.preventDefault(); e.stopPropagation();
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text) void this.paste(text);
    });
    on(this.host, 'pointerdown', e => this.onPointerDown(e));
    on(this.host, 'dblclick', e => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-r][data-c]');
      if (!cell || (e.target as HTMLElement).closest('.vsg-check')) return;
      this.sel = { r: +cell.dataset.r!, c: +cell.dataset.c!, ar: +cell.dataset.r!, ac: +cell.dataset.c! };
      this.startEdit();
    });
    on(this.host, 'contextmenu', e => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea')) return;
      const cell = t.closest<HTMLElement>('[data-r]');
      const head = t.closest<HTMLElement>('[data-head]');
      const hostRect = this.host.getBoundingClientRect();
      if (head) {
        e.preventDefault();
        this.pop = { kind: 'column', col: head.dataset.head!, x: e.clientX - hostRect.left, y: e.clientY - hostRect.top };
        this.schedule();
        return;
      }
      if (cell) {
        e.preventDefault();
        const r = +cell.dataset.r!;
        if (!this.inRange(r, this.sel.c) || cell.dataset.c === undefined) {
          const c = cell.dataset.c !== undefined ? +cell.dataset.c : 0;
          if (!(r >= this.range().r0 && r <= this.range().r1)) this.sel = { r, c, ar: r, ac: c };
        }
        this.pop = { kind: 'row', r, x: e.clientX - hostRect.left, y: e.clientY - hostRect.top };
        this.schedule();
      }
    });
    const onDocDown = (e: PointerEvent) => {
      if (!this.pop) return;
      if ((e.target as HTMLElement).closest?.('.vsg-pop, .vsg-modal')) return;
      if (this.pop.kind === 'date' && (e.target as HTMLElement).closest?.('[data-editor]')) return;
      if (this.pop.kind === 'date') this.commitEdit();
      this.pop = null;
      this.schedule();
    };
    document.addEventListener('pointerdown', onDocDown, true);
    this.cleanup.push(() => document.removeEventListener('pointerdown', onDocDown, true));
    on(this.scroller, 'scroll', () => { if (this.pop && this.pop.kind !== 'choices' && this.pop.kind !== 'delete-linked') { if (this.pop.kind === 'date') this.commitEdit(); this.pop = null; } this.schedule(); }, { passive: true });
    // The canvas must not take the wheel from a sheet.
    on(this.host, 'wheel', e => { if (!e.ctrlKey) e.stopPropagation(); }, { passive: true });
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (this.pop && k === 'Escape') { stop(); this.pop = null; this.schedule(); return; }
    if (mod && !e.altKey && (k === 'z' || k === 'Z')) { stop(); if (e.shiftKey) this.std.store.redo(); else this.std.store.undo(); return; }
    if (mod && !e.altKey && k === 'y') { stop(); this.std.store.redo(); return; }
    if (mod && !e.shiftKey && (k === 'c' || k === 'x' || k === 'v' || k === 'C' || k === 'X' || k === 'V')) {
      // The browser's own copy/cut/paste events normally follow this key and
      // carry the clipboard (handled on the sink). Some hosts deliver the key
      // without them; then the async Clipboard API does the same job.
      e.stopPropagation();
      this.clipExpect = k.toLowerCase() as 'c' | 'x' | 'v';
      const expected = this.clipExpect;
      setTimeout(() => { if (this.clipExpect === expected) { this.clipExpect = null; void this.clipFallback(expected); } }, 80);
      return;
    }
    if (mod && k === 'a') { stop(); this.sel = { r: this.rows.length - 1, c: this.cols.length - 1, ar: 0, ac: 0 }; this.schedule(); return; }
    if (mod && k === 'd') { stop(); this.fillDown(); return; }
    if (mod && k === 'f') { stop(); this.host.querySelector<HTMLInputElement>('[data-search]')?.focus(); return; }
    switch (k) {
      case 'ArrowUp': stop(); return mod ? this.jumpEdge(-1, 0, e.shiftKey) : this.move(-1, 0, e.shiftKey);
      case 'ArrowDown': stop(); return mod ? this.jumpEdge(1, 0, e.shiftKey) : this.move(1, 0, e.shiftKey);
      case 'ArrowLeft': stop(); return mod ? this.jumpEdge(0, -1, e.shiftKey) : this.move(0, -1, e.shiftKey);
      case 'ArrowRight': stop(); return mod ? this.jumpEdge(0, 1, e.shiftKey) : this.move(0, 1, e.shiftKey);
      case 'Tab': stop(); return this.move(0, e.shiftKey ? -1 : 1);
      case 'Home': stop(); return mod ? this.jumpEdge(-1, -1, e.shiftKey) : this.jumpEdge(0, -1, e.shiftKey);
      case 'End': stop(); return mod ? this.jumpEdge(1, 1, e.shiftKey) : this.jumpEdge(0, 1, e.shiftKey);
      case 'PageDown': stop(); return this.move(Math.max(1, Math.floor(this.scroller.clientHeight / ROW_H) - 1), 0, e.shiftKey);
      case 'PageUp': stop(); return this.move(-Math.max(1, Math.floor(this.scroller.clientHeight / ROW_H) - 1), 0, e.shiftKey);
      case 'Enter': case 'F2':
        stop();
        if (k === 'Enter' && e.shiftKey) return this.move(-1, 0);
        return this.startEdit();
      case 'Escape': {
        if (this.search.q) { stop(); this.search.q = ''; this.recomputeSearch(); this.schedule(); return; }
        const g = this.range();
        if (g.r1 > g.r0 || g.c1 > g.c0) { stop(); this.sel = { ...this.sel, ar: this.sel.r, ac: this.sel.c }; this.schedule(); return; }
        return; // nothing to cancel: let focus mode close
      }
      case 'Delete': case 'Backspace': stop(); return this.clearRange();
      case ' ': {
        const col = this.cols[this.sel.c];
        if (col?.type === 'checkbox') { stop(); this.startEdit(); return; }
        break;
      }
    }
    /**
     * A PRINTABLE KEY STARTS AN EDIT, decided here on keydown rather than from
     * the sink's input event: the editor then exists before the next key is
     * delivered, so a fast typist's letters all land in it. An IME composition
     * (key "Process") still goes through the sink and starts the edit on
     * compositionend.
     */
    if (!mod && !e.altKey && k.length === 1 && !e.isComposing) {
      // NOT prevented: focus moves to the editor now, and the browser delivers
      // this very character to it — exactly once, in every input method.
      if (this.cols[this.sel.c]?.type === 'checkbox') { stop(); return; }
      e.stopPropagation();
      this.startEdit('');
      return;
    }
    e.stopPropagation();
  }

  private onEditorKey(e: KeyboardEvent): void {
    const k = e.key;
    e.stopPropagation();
    const ed = this.edit;
    if (!ed) return;
    if (k === 'Escape') { e.preventDefault(); this.cancelEdit(); return; }
    const newline = ed.kind === 'textarea' && (e.shiftKey || e.altKey);
    if (k === 'Enter' && !newline && !(e as KeyboardEvent & { isComposing?: boolean }).isComposing) {
      e.preventDefault();
      this.commitEdit();
      this.move(e.shiftKey ? -1 : 1, 0);
      this.focusSink();
      return;
    }
    if (k === 'Enter' && newline && e.altKey) {
      e.preventDefault();
      const t = e.target as HTMLTextAreaElement;
      const at = t.selectionStart;
      t.setRangeText('\n', at, t.selectionEnd, 'end');
      return;
    }
    if (k === 'Tab') {
      e.preventDefault();
      this.commitEdit();
      this.move(0, e.shiftKey ? -1 : 1);
      this.focusSink();
    }
  }

  private onPointerDown(e: PointerEvent): void {
    const t = e.target as HTMLElement;
    if (e.button !== 0) return;
    if (t.closest('.vsg-pop, .vsg-modal, .vsg-toolbar, [data-editor]')) return;

    const resize = t.closest<HTMLElement>('[data-resize]');
    if (resize) { e.preventDefault(); this.beginResize(e, resize.dataset.resize!); return; }

    const headMenu = t.closest<HTMLElement>('[data-head-menu]');
    if (headMenu) {
      e.preventDefault();
      const rect = headMenu.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
      this.pop = { kind: 'column', col: headMenu.dataset.headMenu!, x: rect.left - hr.left, y: rect.bottom - hr.top + 4 };
      this.schedule();
      return;
    }

    const head = t.closest<HTMLElement>('[data-head]');
    if (head) { e.preventDefault(); this.beginColumnPress(e, head.dataset.head!); return; }

    const fill = t.closest<HTMLElement>('[data-fill]');
    if (fill) { e.preventDefault(); this.beginFill(e); return; }

    const gutter = t.closest<HTMLElement>('[data-gutter]');
    if (gutter) { e.preventDefault(); this.beginRowPress(e, +gutter.dataset.gutter!); return; }

    const cell = t.closest<HTMLElement>('[data-r][data-c]');
    if (!cell) return;
    e.preventDefault();
    this.commitEdit();
    const r = +cell.dataset.r!; const c = +cell.dataset.c!;
    const check = t.closest('.vsg-check');
    const wasActive = this.sel.r === r && this.sel.c === c && this.sel.ar === r && this.sel.ac === c;
    this.sel = e.shiftKey ? { ...this.sel, r, c } : { r, c, ar: r, ac: c };
    if (check) { this.focusSink(); this.startEdit(); return; }
    const link = t.closest<HTMLAnchorElement>('a[data-open]');
    if (link && (e.ctrlKey || e.metaKey || wasActive)) { window.open(link.href, '_blank', 'noopener'); }
    const col = this.cols[c];
    if (wasActive && !e.shiftKey && col && (col.type === 'status' || col.type === 'link' || col.type === 'date' || col.bind === 'shot.sceneKey')) {
      this.startEdit();
      return;
    }
    this.focusSink();
    this.schedule();
    this.drag = { kind: 'select' };
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-r][data-c]');
      if (!el || !this.host.contains(el)) return;
      const nr = +el.dataset.r!; const nc = +el.dataset.c!;
      if (nr !== this.sel.r || nc !== this.sel.c) { this.sel = { ...this.sel, r: nr, c: nc }; this.schedule(); }
    };
    const up = () => { this.drag = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private beginFill(e: PointerEvent): void {
    if (!this.guard()) return;
    let to = this.range().r1;
    this.drag = { kind: 'fill', to };
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-r]');
      if (!el) return;
      const r = +el.dataset.r!;
      if (r !== to) { to = Math.max(this.range().r1, r); this.drag = { kind: 'fill', to }; this.schedule(); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      this.drag = null;
      this.fillTo(to);
      this.schedule();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    void e;
  }

  private beginResize(e: PointerEvent, colId: string): void {
    if (!this.guard()) return;
    const col = this.cols.find(c => c.id === colId); if (!col) return;
    const startX = e.clientX; const start = this.widthOf(col);
    const move = (ev: PointerEvent) => {
      this.widthsPreview.set(colId, Math.max(60, Math.min(800, start + ev.clientX - startX)));
      this.colV.measure();
      this.schedule();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const w = this.widthsPreview.get(colId);
      this.widthsPreview.delete(colId);
      if (w && w !== start) this.run(() => updateColumn(this.std.store, this.blockId, colId, { width: w }));
      this.colV.measure();
      this.schedule();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private beginColumnPress(e: PointerEvent, colId: string): void {
    const c = this.cols.findIndex(x => x.id === colId);
    const startX = e.clientX; let moving = false;
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - startX) > 6 && !this.readonly) moving = true;
      if (!moving) return;
      const heads = [...this.host.querySelectorAll<HTMLElement>('[data-head]')];
      let index = this.cols.length;
      for (const h of heads) {
        const r = h.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) { index = this.cols.findIndex(x => x.id === h.dataset.head); break; }
      }
      this.dropAt = { kind: 'col', index };
      this.schedule();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moving && this.dropAt) {
        const index = this.dropAt.index;
        this.dropAt = null;
        if (index !== c && index !== c + 1) {
          const before = this.cols[index]?.id ?? null;
          this.run(() => moveColumn(this.std.store, this.blockId, colId, before));
        }
      } else if (c >= 0) {
        // A click selects the whole column.
        this.sel = e.shiftKey ? { ...this.sel, r: Math.max(0, this.rows.length - 1), c } : { r: Math.max(0, this.rows.length - 1), c, ar: 0, ac: c };
        this.focusSink();
      }
      this.schedule();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private beginRowPress(e: PointerEvent, r: number): void {
    const startY = e.clientY; let moving = false;
    const range = this.range();
    const selected = r >= range.r0 && r <= range.r1 && range.c0 === 0 && range.c1 === this.cols.length - 1;
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientY - startY) > 6 && !this.readonly) {
        if (this.view.sort) { toast('Turn off sorting to move rows.', 'info'); window.removeEventListener('pointermove', move); return; }
        moving = true;
      }
      if (!moving) return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-row]');
      if (!el) return;
      const rr = el.getBoundingClientRect();
      const idx = +el.dataset.row! + (ev.clientY > rr.top + rr.height / 2 ? 1 : 0);
      this.dropAt = { kind: 'row', index: idx };
      this.schedule();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moving && this.dropAt) {
        const index = this.dropAt.index; this.dropAt = null;
        const g = selected ? range : { r0: r, r1: r };
        const keys = this.rows.slice(g.r0, g.r1 + 1).map(x => x.key);
        if (index < g.r0 || index > g.r1 + 1) {
          const before = this.rows[index]?.key ?? null;
          this.run(() => moveRows(this.std, this.blockId, this.tabId, keys, before));
        }
      } else {
        // A click selects the whole row (shift extends).
        const last = Math.max(0, this.cols.length - 1);
        this.sel = e.shiftKey ? { ...this.sel, r, c: last } : { r, c: last, ar: r, ac: 0 };
        this.focusSink();
      }
      this.schedule();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ── view changes ───────────────────────────────────────────────────────────

  private setView(next: Partial<View>): void {
    this.view = { ...this.view, ...next };
    saveView(this.blockId, this.tabId, this.view);
    this.dirty = true;
    this.schedule();
  }

  private cycleTotal(col: SheetColumn): void {
    const kinds = totalsFor(col.type);
    const cur = this.view.totals[col.id] ?? kinds[0]!;
    const next = kinds[(kinds.indexOf(cur) + 1) % kinds.length]!;
    this.setView({ totals: { ...this.view.totals, [col.id]: next } });
  }

  addRow(): void {
    if (!this.guard() || !this.snap) return;
    if (this.view.filters.length || this.search.q) this.setView({ filters: [] });
    const ids = this.run(() => addRows(this.std.store, this.blockId, this.tabId, 1));
    if (!ids?.length) return;
    this.refresh();
    const r = this.rows.findIndex(x => x.rowId === ids[0]);
    if (r >= 0) { this.sel = { r, c: 0, ar: r, ac: 0 }; this.reveal(r, 0); }
    this.schedule();
    this.focusSink();
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private renderNow(): void {
    if (this.dirty) this.refresh();
    this.rowV.setOptions({ ...this.rowV.options, count: this.rows.length });
    this.colV.setOptions({ ...this.colV.options, count: this.cols.length + this.actCols.length });
    this.rowV._willUpdate();
    this.colV._willUpdate();
    render(this.toolbar(), this.host.querySelector<HTMLElement>('[data-toolbar]')!);
    render(this.body(), this.host.querySelector<HTMLElement>('[data-inner]')!);
    render(this.layer(), this.host.querySelector<HTMLElement>('[data-layer]')!);
    this.placeSink();
  }

  private placeSink(): void {
    const cell = this.cellEl(this.sel.r, this.sel.c);
    const hr = this.host.getBoundingClientRect();
    if (cell) {
      const r = cell.getBoundingClientRect();
      this.sink.style.left = `${r.left - hr.left}px`;
      this.sink.style.top = `${r.top - hr.top}px`;
    }
    if (this.edit) {
      const ed = this.host.querySelector<HTMLElement>('[data-editor]');
      if (!cell && ed) { this.commitEdit(); return; }
      if (cell && ed) {
        const r = cell.getBoundingClientRect();
        ed.style.left = `${r.left - hr.left - 1}px`;
        ed.style.top = `${r.top - hr.top - 1}px`;
        ed.style.minWidth = `${r.width + 2}px`;
        if (this.edit.kind === 'input') ed.style.height = `${r.height + 2}px`;
      }
    }
  }

  private toolbar(): TemplateResult {
    const hiddenCount = this.snap?.columns.filter(c => c.hidden).length ?? 0;
    const sortCol = this.view.sort ? this.snap?.columns.find(c => c.id === this.view.sort!.col) : undefined;
    const hits = this.search.hits.length;
    const total = this.snap?.rows.length ?? 0;
    const shown = this.rows.length;
    const planned = this.snap?.tab.binding?.kind === 'shots' ? this.snap.rows.filter(r => !r.shotId && r.rowId).length : 0;
    return html`
      <label class="vsg-search">
        <span class="vsg-search__icon" aria-hidden="true"></span>
        <input data-search type="search" placeholder="Search this tab" .value=${this.search.q}
          @input=${(e: Event) => { this.search.q = (e.target as HTMLInputElement).value; this.search.i = 0; this.recomputeSearch(); this.jumpToHit(); }}
          @keydown=${(e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); this.search.i = (this.search.i + (e.shiftKey ? -1 : 1) + Math.max(1, hits)) % Math.max(1, hits); this.jumpToHit(); }
            if (e.key === 'Escape') { this.search.q = ''; this.recomputeSearch(); this.focusSink(); this.schedule(); }
          }} />
        ${this.search.q ? html`<span class="vsg-search__count">${hits ? `${this.search.i + 1} of ${hits}` : 'No match'}</span>` : nothing}
      </label>
      <button type="button" class="vsg-tool ${this.view.filters.length ? 'is-on' : ''}" @click=${(e: MouseEvent) => this.openAt(e, 'filter')}>
        <span class="vsg-ico vsg-ico--filter"></span>${this.view.filters.length ? `Filtered (${this.view.filters.length})` : 'Filter'}
      </button>
      ${sortCol ? html`<span class="vsg-chip-tool">
          Sorted by ${sortCol.name} ${this.view.sort!.dir === 1 ? '↑' : '↓'}
          <button type="button" title="Stop sorting" aria-label="Stop sorting" @click=${() => this.setView({ sort: null })}>×</button>
        </span>` : nothing}
      ${hiddenCount ? html`<button type="button" class="vsg-tool is-on" @click=${(e: MouseEvent) => this.openAt(e, 'hidden')}>${hiddenCount} hidden</button>` : nothing}
      <span class="vsg-tool-spacer"></span>
      <span class="vsg-count">${shown === total ? `${total.toLocaleString('en')} row${total === 1 ? '' : 's'}` : `${shown.toLocaleString('en')} of ${total.toLocaleString('en')} rows`}</span>
      ${planned && this.opts.onMakeCards && !this.readonly ? html`<button type="button" class="vsg-tool" title="Turn rows with no card into shot cards on the board"
          @click=${() => this.opts.onMakeCards?.(this.snap!.rows.filter(r => !r.shotId && r.rowId).map(r => r.key))}>Make ${planned} card${planned === 1 ? '' : 's'}</button>` : nothing}
      ${!this.readonly && this.kind === 'calendar' ? this.calendarTools() : nothing}
      ${!this.readonly && this.kind === 'episodes' ? this.episodeTools() : nothing}
      ${this.readonly ? html`<span class="vsg-badge">View only</span>` : html`<button type="button" class="vsg-tool vsg-tool--primary" @click=${() => this.addRow()}>+ Row</button>`}`;
  }

  private jumpToHit(): void {
    const hit = this.search.hits[this.search.i];
    if (hit) { this.sel = { r: hit[0], c: hit[1], ar: hit[0], ac: hit[1] }; this.reveal(hit[0], hit[1]); }
    this.schedule();
  }

  private openAt(e: MouseEvent, kind: 'filter' | 'hidden'): void {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const hr = this.host.getBoundingClientRect();
    this.pop = { kind, x: b.left - hr.left, y: b.bottom - hr.top + 4 };
    this.schedule();
  }

  private body(): TemplateResult {
    const cols = this.cols;
    const rows = this.rows;
    const vRows = this.rowV.getVirtualItems();
    const vCols = this.colV.getVirtualItems();
    const totalW = GUTTER_W + cols.reduce((n, c) => n + this.widthOf(c), 0) + this.actCols.reduce((n, a) => n + a.width, 0) + 56;
    const bodyH = rows.length * ROW_H;
    const f = this.frozenCount();
    const frozenLeft: number[] = [];
    let acc = GUTTER_W;
    for (let i = 0; i < f; i++) { frozenLeft.push(acc); acc += this.widthOf(cols[i]); }
    const frozenEdge = acc;
    const scrolledX = this.scroller.scrollLeft > 0;
    const firstFree = vCols.find(v => v.index >= f);
    const spacer = firstFree ? Math.max(0, firstFree.start - frozenEdge) : 0;
    const free = vCols.filter(v => v.index >= f);
    const g = this.range();
    const searchSet = new Set(this.search.hits.map(([r, c]) => `${r}:${c}`));
    const activeHit = this.search.hits[this.search.i];
    const tab = this.snap?.tab;


    const headCell = (c: number) => {
      const col = cols[c]!;
      const frozen = c < f;
      const sorted = this.view.sort?.col === col.id ? (this.view.sort.dir === 1 ? '↑' : '↓') : '';
      const filtered = this.view.filters.some(x => x.col === col.id);
      const selected = c >= g.c0 && c <= g.c1;
      return html`<div class="vsg-hcell ${frozen ? 'is-frozen' : ''} ${frozen && c === f - 1 ? 'is-frozen-edge' : ''} ${selected ? 'is-sel' : ''}"
          role="columnheader" data-head=${col.id}
          style="width:${this.widthOf(col)}px;${frozen ? `left:${frozenLeft[c]}px;` : ''}"
          title=${col.bind ? `${col.name} — this is the shot card's own ${col.bind.slice(5)}. Editing it changes the card.` : `${col.name} (${TYPE_LABEL[col.type]})`}>
        <span class="vsg-hicon" aria-hidden="true">${TYPE_ICON[col.type]}</span>
        <span class="vsg-hname">${col.name}</span>
        ${col.bind ? html`<span class="vsg-hbind" title="Linked to the shot cards">${LINK_ICON}</span>` : nothing}
        ${sorted ? html`<span class="vsg-hmark">${sorted}</span>` : nothing}
        ${filtered ? html`<span class="vsg-hmark">⏷</span>` : nothing}
        <button type="button" class="vsg-hmenu" data-head-menu=${col.id} aria-label="Column options for ${col.name}">▾</button>
        <span class="vsg-resize" data-resize=${col.id}></span>
      </div>`;
    };

    const bodyCell = (row: DisplayRow, r: number, c: number) => {
      const col = cols[c]!;
      const frozen = c < f;
      const inSel = r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
      const active = r === this.sel.r && c === this.sel.c;
      const multi = g.r1 > g.r0 || g.c1 > g.c0;
      const hit = searchSet.has(`${r}:${c}`);
      const isActiveHit = activeHit && activeHit[0] === r && activeHit[1] === c;
      const fillCorner = !this.readonly && multi ? (r === g.r1 && c === g.c1) : active;
      const showFill = fillCorner && !this.edit && !this.drag;
      const disabled = col.bind && row.removed;
      const fillPreview = this.drag?.kind === 'fill' && r > g.r1 && r <= (this.drag.to as number) && c >= g.c0 && c <= g.c1;
      return html`<div class="vsg-cell vsg-t-${col.type} ${frozen ? 'is-frozen' : ''} ${frozen && c === f - 1 ? 'is-frozen-edge' : ''} ${inSel && multi ? 'is-range' : ''} ${active ? 'is-active' : ''} ${hit ? 'is-hit' : ''} ${isActiveHit ? 'is-hit-now' : ''} ${disabled ? 'is-disabled' : ''} ${fillPreview ? 'is-fill' : ''}"
          role="gridcell" aria-selected=${inSel ? 'true' : 'false'} data-r=${r} data-c=${c}
          style="width:${this.widthOf(col)}px;${frozen ? `left:${frozenLeft[c]}px;` : ''}">
        ${this.cellContent(row, col)}
        ${showFill ? html`<span class="vsg-fill" data-fill title="Drag to fill down"></span>` : nothing}
      </div>`;
    };

    const empty = !rows.length;
    const shotsTab = tab?.binding?.kind === 'shots';
    const filteredOut = empty && (this.snap?.rows.length ?? 0) > 0;

    return html`
      <div class="vsg-canvas" role="grid" aria-rowcount=${rows.length + 1} aria-colcount=${cols.length}
           style="width:${totalW}px;height:${HEADER_H + Math.max(bodyH, empty ? 220 : 0) + FOOTER_H}px">
        <div class="vsg-head ${scrolledX ? 'is-scrolled-x' : ''}" role="row" style="width:${totalW}px">
          <div class="vsg-hcell vsg-gutter is-frozen" style="left:0;width:${GUTTER_W}px" title="Select all"
               @click=${() => { this.sel = { r: Math.max(0, rows.length - 1), c: Math.max(0, cols.length - 1), ar: 0, ac: 0 }; this.focusSink(); this.schedule(); }}></div>
          ${Array.from({ length: f }, (_, c) => headCell(c))}
          ${spacer ? html`<div class="vsg-spacer" style="width:${spacer}px"></div>` : nothing}
          ${free.map(v => (v.index < cols.length ? headCell(v.index) : this.actHead(this.actCols[v.index - cols.length]!)))}
          ${this.readonly ? nothing : html`<button type="button" class="vsg-addcol" title="Add a column" aria-label="Add a column"
              @click=${() => { const id = this.run(() => addColumn(this.std.store, this.blockId, this.tabId, { name: `Column ${cols.length + 1}` })); if (id) { this.dirty = true; requestAnimationFrame(() => { const hr = this.host.getBoundingClientRect(); this.pop = { kind: 'rename', col: id, value: `Column ${cols.length + 1}`, x: Math.min(hr.width - 280, 200), y: HEADER_H + 40 }; this.schedule(); }); } }}>+</button>`}
          ${this.dropAt?.kind === 'col' ? html`<div class="vsg-drop vsg-drop--col" style="left:${this.dropX()}px"></div>` : nothing}
        </div>
        <div class="vsg-body" style="height:${Math.max(bodyH, empty ? 220 : 0)}px">
          ${empty ? html`<div class="vsg-empty">
              ${filteredOut
                ? html`<b>No rows match.</b><span>Change the search or filters to see more.</span>
                    <button type="button" class="vsg-tool" @click=${() => { this.search.q = ''; this.setView({ filters: [] }); }}>Clear filters</button>`
                : shotsTab
                  ? html`<b>No shots on this board yet.</b><span>Add rows to plan your shots, then press "Make cards" to put them on the board.</span>
                      ${this.readonly ? nothing : html`<button type="button" class="vsg-tool vsg-tool--primary" @click=${() => this.addRow()}>+ Add a row</button>`}`
                  : html`<b>This tab is empty.</b><span>Add a row, or paste a table from Google Sheets or Excel (Ctrl+V).</span>
                      ${this.readonly ? nothing : html`<button type="button" class="vsg-tool vsg-tool--primary" @click=${() => this.addRow()}>+ Add a row</button>`}`}
            </div>` : nothing}
          ${repeat(vRows, v => rows[v.index]?.key ?? v.index, v => {
            const row = rows[v.index]!;
            const r = v.index;
            const rowSel = r >= g.r0 && r <= g.r1;
            return html`<div class="vsg-row ${row.removed ? 'is-removed' : ''} ${rowSel ? 'is-rowsel' : ''}" role="row" data-row=${r}
                style="transform:translateY(${v.start - HEADER_H}px);width:${totalW}px">
              <div class="vsg-cell vsg-gutter is-frozen ${rowSel ? 'is-sel' : ''}" data-gutter=${r} data-r=${r} style="left:0;width:${GUTTER_W}px"
                   title=${row.removed ? 'This shot was removed from the board' : this.readonly ? '' : 'Drag to move. Right-click for more.'}>
                <span class="vsg-rownum">${row.removed ? '!' : r + 1}</span>
                ${row.rowId && this.activity?.authors[row.rowId] ? html`<span class="vsg-author" title=${`Edited by ${this.activity.authors[row.rowId]!.name}. Episodes made from this row ask before they spend credits.`}>${initials(this.activity.authors[row.rowId]!.name)}</span>` : nothing}
                ${row.rowId && this.notes.get(row.rowId)?.tone === 'warn' ? html`<span class="vsg-rowwarn" title=${this.notes.get(row.rowId)!.text}>!</span>` : nothing}
                ${!row.shotId && shotsTab && row.rowId ? html`<span class="vsg-planned" title="Planned: no card yet">•</span>` : nothing}
                ${this.readonly ? nothing : html`<span class="vsg-grip" aria-hidden="true"></span>`}
              </div>
              ${Array.from({ length: f }, (_, c) => bodyCell(row, r, c))}
              ${spacer ? html`<div class="vsg-spacer" style="width:${spacer}px"></div>` : nothing}
              ${free.map(vc => (vc.index < cols.length ? bodyCell(row, r, vc.index) : this.actCell(row, this.actCols[vc.index - cols.length]!)))}
            </div>`;
          })}
          ${this.dropAt?.kind === 'row' ? html`<div class="vsg-drop vsg-drop--row" style="top:${this.dropAt.index * ROW_H}px;width:${totalW}px"></div>` : nothing}
        </div>
        <div class="vsg-foot" role="row" style="width:${totalW}px">
          <div class="vsg-fcell vsg-gutter is-frozen" style="left:0;width:${GUTTER_W}px"></div>
          ${Array.from({ length: f }, (_, c) => this.footCell(c, frozenLeft[c]!, true, c === f - 1))}
          ${spacer ? html`<div class="vsg-spacer" style="width:${spacer}px"></div>` : nothing}
          ${free.map(vc => (vc.index < cols.length ? this.footCell(vc.index, 0, false, false) : html`<div class="vsg-fcell vsg-act" style="width:${this.actCols[vc.index - cols.length]!.width}px"></div>`))}
        </div>
      </div>`;
  }

  private dropX(): number {
    if (!this.dropAt) return 0;
    let x = GUTTER_W;
    for (let i = 0; i < this.dropAt.index; i++) x += this.widthOf(this.cols[i]);
    const f = this.frozenCount();
    return this.dropAt.index >= f ? x - this.scroller.scrollLeft + this.scroller.scrollLeft : x;
  }

  private footCell(c: number, left: number, frozen: boolean, edge: boolean): TemplateResult {
    const col = this.cols[c]!;
    const kinds = totalsFor(col.type);
    // A numbering column (Episode, #) has nothing worth summing by default.
    const fallback = /^(episode|ep|#|no\.?|number)$/i.test(col.name.trim()) ? 'none' : kinds[0]!;
    const kind = this.view.totals[col.id] ?? fallback;
    const text = computeTotal(col, this.rows.map(r => this.value(r, col)), kind);
    return html`<div class="vsg-fcell ${frozen ? 'is-frozen' : ''} ${edge ? 'is-frozen-edge' : ''}"
        style="width:${this.widthOf(col)}px;${frozen ? `left:${left}px;` : ''}"
        title="${TOTAL_LABEL[kind]} — click to change" @click=${() => this.cycleTotal(col)}>
      ${text ? html`<span>${text}</span>` : html`<span class="vsg-fhint">${TOTAL_LABEL[kind] === 'No total' ? '' : TOTAL_LABEL[kind]}</span>`}
    </div>`;
  }

  // ── from Activity ───────────────────────────────────────────────────────────

  private actHead(a: ActCol): TemplateResult {
    return html`<div class="vsg-hcell vsg-act" role="columnheader" style="width:${a.width}px"
        title="From your Activity board. Read only: it shows what happened to each row.">
      <span class="vsg-hicon" aria-hidden="true">◎</span><span class="vsg-hname">${a.name}</span><span class="vsg-actbadge">Activity</span>
    </div>`;
  }

  private actCell(row: DisplayRow, a: ActCol): TemplateResult {
    const st = row.rowId ? this.activity?.rows[row.rowId] : undefined;
    const note = row.rowId ? this.notes.get(row.rowId) : undefined;
    const top = (href: string, label: string) => html`<a class="vsg-link vsg-actlink" href=${href} target="_top" rel="noopener">${label}</a>`;
    let inner: TemplateResult | typeof nothing = nothing;
    if (a.id === 'post') {
      if (note && note.tone !== 'ok') {
        inner = html`<span class="vsg-note vsg-note--${note.tone}" title=${note.text}>${note.text}</span>`;
      } else if (st?.post) {
        const s = st.post.status;
        const color = /posted/i.test(s) ? 'green' : /fail|reject/i.test(s) ? 'red' : /approved|scheduled/i.test(s) ? 'amber' : /posting/i.test(s) ? 'blue' : 'purple';
        inner = html`<span class="vsg-chip" data-c=${color}>${s}</span>${/waiting/i.test(s) ? top('/approvals', 'Review') : nothing}`;
      } else if (note) {
        inner = html`<span class="vsg-chip" data-c="purple">${note.text}</span>${/waiting/i.test(note.text) ? top('/approvals', 'Review') : nothing}`;
      }
    } else if (a.id === 'episode') {
      const e = st?.episode;
      if (e) {
        const color = e.status === 'Done' ? 'green' : /fail|stopped/i.test(e.status) ? 'red' : e.status === 'Needs you' ? 'amber' : /making|queued|retrying/i.test(e.status) ? 'blue' : 'grey';
        inner = html`<span class="vsg-chip" data-c=${color}>${e.episode ? `Ep ${e.episode} · ` : ''}${e.status}</span>${e.editorUrl ? top(e.editorUrl, 'Open editor') : nothing}`;
      }
    } else if (a.id === 'board' && row.link?.kind === 'board') {
      inner = top(`/ai/board?board=${encodeURIComponent(row.link.boardId)}`, 'Open board');
    }
    return html`<div class="vsg-cell vsg-act" style="width:${a.width}px">${inner}</div>`;
  }

  private rowRef(row: DisplayRow): { boardId: string; sheetId: string; tabId: string; rowId: string } | null {
    const boardId = ownBoardId();
    return boardId && row.rowId ? { boardId, sheetId: this.blockId, tabId: this.tabId, rowId: row.rowId } : null;
  }

  /** Send calendar rows for approval, one draft each. Nothing posts until approved. */
  private async sendRows(rows: DisplayRow[], again = false): Promise<void> {
    if (!this.guard() || this.sending || !this.snap) return;
    const cols = this.snap.columns;
    this.sending = true;
    this.schedule();
    let sent = 0; let needs = 0; let failed = 0;
    try {
      for (const row of rows) {
        const ref = this.rowRef(row);
        if (!ref) continue;
        const res = await sendRowForApproval(ref, rowValues(cols, c => this.value(row, c)), again);
        if (res.kind === 'sent' || res.kind === 'unchanged') {
          sent++;
          this.notes.set(row.rowId!, { tone: 'ok', text: res.kind === 'sent' ? 'Waiting for your approval' : 'Approved, scheduled' });
        } else if (res.kind === 'missing') {
          needs++;
          this.notes.set(row.rowId!, { tone: 'warn', text: `Needs ${res.missing.join(', ')}` });
        } else if (res.kind === 'posted') {
          if (rows.length === 1) this.pop = { kind: 'repost', rowKey: row.key };
          else this.notes.set(row.rowId!, { tone: 'ok', text: 'Already posted' });
        } else {
          failed++;
          this.notes.set(row.rowId!, { tone: 'error', text: res.message });
        }
        this.schedule();
      }
    } finally { this.sending = false; this.schedule(); }
    const bits = [
      sent ? `${sent} sent for your approval` : '',
      needs ? `${needs} need${needs === 1 ? 's' : ''} more (see the Post column)` : '',
      failed ? `${failed} could not be sent` : '',
    ].filter(Boolean);
    if (bits.length) toast(`${bits.join(' · ')}.${sent ? ' Nothing posts until you approve it.' : ''}`, needs || failed ? 'error' : 'info');
    await this.poller?.refresh();
  }

  private sendableReady(): DisplayRow[] {
    if (!this.snap) return [];
    return readyRows(this.snap.rows, this.snap.columns, (r, c) => this.value(r, c)).filter(r => {
      const s = this.activity?.rows[r.rowId!]?.post?.draftStatus ?? '';
      return !s || ['rejected', 'failed', 'failed_permanent', 'error'].includes(s);
    });
  }

  /** One empty board per row that has none, linked from the row. Only adds. */
  private async makeEpisodeBoards(rows: DisplayRow[]): Promise<void> {
    if (!this.guard() || !this.snap) return;
    const todo = this.boardless(rows);
    if (!todo.length) { toast('Give a row a title or logline first. Rows that already have a board are skipped.', 'info'); return; }
    const sheetTitle = String(sheetYBlock(this.std.store, this.blockId)?.get('prop:title') ?? '');
    let made = 0;
    for (const row of todo) {
      const f = episodeFields(this.snap.columns, c => this.value(row, c));
      const title = [sheetTitle || this.snap.tab.name, f.n ? `Ep ${f.n}` : '', f.title].filter(Boolean).join(' · ');
      const boardId = await createEpisodeBoard(title, f.logline);
      if (!boardId) { toast('A board could not be made. Check your connection and try again.', 'error'); break; }
      this.run(() => setRowLink(this.std.store, this.blockId, row.rowId!, { kind: 'board', boardId }));
      made++;
    }
    if (made) toast(`Made ${made} episode board${made === 1 ? '' : 's'}. Each row links to its board.`, 'info');
  }

  /** Rows that would get a board: no board yet, and planned (a title or a logline). Empty
   *  template rows make no board, so "Make episode boards (10)" never means 10 blank boards. */
  private boardless(rows: DisplayRow[]): DisplayRow[] {
    if (!this.snap) return [];
    return rows.filter(r => {
      if (!r.rowId || r.link?.kind === 'board') return false;
      const f = episodeFields(this.snap!.columns, c => this.value(r, c));
      return !!(String(f.title || '').trim() || String(f.logline || '').trim());
    });
  }

  private openSeries(): void {
    this.pop = { kind: 'series', choices: null };
    this.schedule();
    void listSeries().then(choices => { if (this.pop?.kind === 'series') { this.pop = { ...this.pop, choices }; this.schedule(); } });
  }

  private seriesModal(choices: SeriesChoice[] | null, busy: boolean, error?: string): TemplateResult {
    const tab = this.snap?.tab;
    // A season tab inside a bigger sheet ("Content calendar" + "Season 1") is named after the tab.
    const yb = sheetYBlock(this.std.store, this.blockId);
    const sheetName = String(yb?.get('prop:title') ?? '');
    const tabCount = yb ? readTabs(yb).length : 1;
    const sheetTitle = (tabCount > 1 ? tab?.name : sheetName) || sheetName || tab?.name || 'Series';
    const following = this.activity?.series ?? [];
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const q = <T extends HTMLElement>(s: string) => this.host.querySelector<T>(s);
    const submit = async () => {
      const link = q<HTMLSelectElement>('[data-series-link]')?.value ?? '';
      const boardId = ownBoardId();
      if (!boardId || !tab) return;
      const when = q<HTMLInputElement>('[data-series-when]')?.value;
      const input = link
        ? { boardId, sheetId: this.blockId, tabId: tab.id, loopId: link }
        : {
          boardId, sheetId: this.blockId, tabId: tab.id,
          title: q<HTMLInputElement>('[data-series-title]')?.value || sheetTitle,
          repeat: ((q<HTMLSelectElement>('[data-series-repeat]')?.value as 'daily' | 'weekly') || 'weekly'),
          ...(when ? { when: new Date(when).toISOString() } : {}),
        };
      this.pop = { kind: 'series', choices, busy: true }; this.schedule();
      const res = await runAsSeries(input);
      if (!res.ok) { this.pop = { kind: 'series', choices, error: res.message }; this.schedule(); return; }
      this.close();
      toast(res.message, 'info');
      await this.poller?.refresh();
    };
    const linkable = (choices ?? []).filter(c => !(c.plan?.sheetId === this.blockId && c.plan?.tabId === tab?.id));
    return html`<div class="vsg-modal-back"><div class="vsg-modal" role="dialog" aria-label="Run as a series">
      <h3>Run "${tab?.name ?? ''}" as a series</h3>
      <p>Each time it runs, the agent makes one episode from the next row that has no episode yet, on its own board.
        It asks before it spends credits and before anything is posted. It stops when the rows run out.</p>
      ${following.length ? html`<p class="vsg-modal__note">Already following this tab: ${following.map(s => s.title).join(', ')}.</p>` : nothing}
      <label class="vsg-field"><span>Series</span>
        <select data-series-link>
          <option value="">Start a new series</option>
          ${linkable.map(c => html`<option value=${c.loopId}>Use "${c.title}"</option>`)}
        </select>
      </label>
      <label class="vsg-field"><span>Name</span><input data-series-title .value=${sheetTitle} maxlength="120" @keydown=${(e: KeyboardEvent) => e.stopPropagation()} /></label>
      <label class="vsg-field"><span>How often</span>
        <select data-series-repeat><option value="weekly">One episode a week</option><option value="daily">One episode a day</option></select></label>
      <label class="vsg-field"><span>First episode</span><input data-series-when type="datetime-local" .value=${local} @keydown=${(e: KeyboardEvent) => e.stopPropagation()} /></label>
      ${error ? html`<p class="vsg-modal__error" role="alert">${error}</p>` : nothing}
      <div class="vsg-row-actions">
        <button type="button" class="vsg-tool" @click=${() => this.close()}>Cancel</button>
        <button type="button" class="vsg-tool vsg-tool--primary" ?disabled=${busy || choices === null} @click=${() => { void submit(); }}>${busy ? 'Setting up…' : 'Run as a series'}</button>
      </div>
    </div></div>`;
  }

  private repostModal(rowKey: string): TemplateResult {
    const row = this.rows.find(r => r.key === rowKey);
    return html`<div class="vsg-modal-back"><div class="vsg-modal" role="alertdialog" aria-label="Post again">
      <h3>This row was already posted</h3>
      <p>Send it for approval again only if you want a second post.</p>
      <div class="vsg-row-actions">
        <button type="button" class="vsg-tool" @click=${() => this.close()}>Cancel</button>
        <button type="button" class="vsg-tool vsg-tool--primary" @click=${() => { this.close(); if (row) void this.sendRows([row], true); }}>Send again</button>
      </div>
    </div></div>`;
  }

  private rowsFor(keys: string[]): DisplayRow[] {
    return keys.map(k => this.rows.find(r => r.key === k)).filter((r): r is DisplayRow => !!r?.rowId);
  }

  private calendarTools(): TemplateResult {
    const n = this.sendableReady().length;
    return html`<button type="button" class="vsg-tool" ?disabled=${!n || this.sending}
        title="Send every row with Status Ready for your approval. Nothing posts until you approve it."
        @click=${() => { void this.sendRows(this.sendableReady()); }}>${this.sending ? 'Sending…' : n ? `Send ${n} Ready row${n === 1 ? '' : 's'} for approval` : 'No Ready rows to send'}</button>`;
  }

  private episodeTools(): TemplateResult {
    const n = this.snap ? this.boardless(this.snap.rows).length : 0;
    const following = this.activity?.series ?? [];
    return html`${n ? html`<button type="button" class="vsg-tool" title="One empty board per row that has none. Only adds."
        @click=${() => { void this.makeEpisodeBoards(this.snap!.rows); }}>Make episode boards (${n})</button>` : nothing}
      <button type="button" class="vsg-tool ${following.length ? 'is-on' : ''}" @click=${() => this.openSeries()}>${following.length ? `Series: ${following[0]!.title}` : 'Run as a series…'}</button>`;
  }

  private cellContent(row: DisplayRow, col: SheetColumn): TemplateResult | string | typeof nothing {
    const v = this.value(row, col);
    if (v === null || v === '') {
      if (col.type === 'checkbox') return html`<span class="vsg-check" role="checkbox" aria-checked="false"></span>`;
      return nothing;
    }
    switch (col.type) {
      case 'checkbox':
        return v === true || v === false
          ? html`<span class="vsg-check ${v ? 'is-on' : ''}" role="checkbox" aria-checked=${v ? 'true' : 'false'}></span>`
          : html`<span class="vsg-text">${String(v)}</span>`;
      case 'number':
        return typeof v === 'number'
          ? html`<span class="vsg-num">${Number.isInteger(v) ? v.toLocaleString('en') : v.toLocaleString('en', { maximumFractionDigits: 6 })}</span>`
          : html`<span class="vsg-text vsg-bad" title="Not a number">${String(v)}</span>`;
      case 'duration':
        return typeof v === 'number' ? html`<span class="vsg-num">${formatDuration(v)}</span>` : html`<span class="vsg-text vsg-bad">${String(v)}</span>`;
      case 'date':
        return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? html`<span class="vsg-text">${prettyDate(String(v))}</span>` : html`<span class="vsg-text vsg-bad" title="Not a date">${String(v)}</span>`;
      case 'status': {
        const parts = col.multi ? String(v).split(/\s*,\s*/).filter(Boolean) : [String(v)];
        return html`<span class="vsg-chips">${parts.map(p => {
          const o = col.options?.find(x => x.label.toLowerCase() === p.toLowerCase());
          return html`<span class="vsg-chip" data-c=${o?.color ?? 'grey'}>${p}</span>`;
        })}</span>`;
      }
      case 'person':
        return html`<span class="vsg-person"><span class="vsg-avatar">${initials(String(v))}</span><span class="vsg-text">${String(v)}</span></span>`;
      case 'url': {
        const s = String(v);
        const ok = /^https?:\/\//i.test(s);
        return ok ? html`<a class="vsg-link" data-open href=${s} target="_blank" rel="noopener noreferrer" title="Ctrl+click to open">${s.replace(/^https?:\/\/(www\.)?/i, '')}</a>` : html`<span class="vsg-text">${s}</span>`;
      }
      case 'media': {
        const src = mediaSrc(String(v));
        const isImg = src && !/\.(mp4|mov|webm|m4a|mp3|wav)(\?|$)/i.test(src);
        return isImg
          ? html`<img class="vsg-thumb" src=${src} alt="" loading="lazy" @error=${(e: Event) => { (e.target as HTMLElement).replaceWith(Object.assign(document.createElement('span'), { className: 'vsg-file', textContent: '▣' })); }} />`
          : html`<span class="vsg-file" title=${String(v)}>${src ? '▶' : '▣'}</span><span class="vsg-text vsg-dim">${String(v).split('/').pop()?.split('?')[0]}</span>`;
      }
      case 'link':
        return html`<span class="vsg-ref">${this.linkLabel(String(v))}</span>`;
      case 'longtext':
        return html`<span class="vsg-text">${String(v).split('\n')[0]}${String(v).includes('\n') ? ' …' : ''}</span>`;
      default:
        if (col.bind === 'shot.sceneKey') return html`<span class="vsg-ref">${this.sceneLabel(String(v))}</span>`;
        return html`<span class="vsg-text">${String(v)}</span>`;
    }
  }

  private sceneLabel(key: string): string {
    const scene = readParsed(this.std).scenes.find(s => s.key === key);
    return scene ? `${scene.n ?? ''} ${scene.heading}`.trim() : key;
  }

  // ── popovers ───────────────────────────────────────────────────────────────

  private layer(): TemplateResult {
    return html`${this.edit ? this.editor() : nothing}${this.pop ? this.popover() : nothing}`;
  }

  private editor(): TemplateResult {
    const e = this.edit!;
    const col = this.cols[e.c];
    const placeholder = col?.type === 'date' ? 'YYYY-MM-DD, or pick a day'
      : col?.type === 'duration' ? 'm:ss, like 1:30'
      : col?.type === 'time' ? 'HH:MM, like 09:30'
      : col?.type === 'url' ? 'https://'
      : col?.type === 'media' ? 'Paste a picture or clip link'
      : '';
    const onKey = (ev: KeyboardEvent) => this.onEditorKey(ev);
    const onBlur = () => setTimeout(() => {
      if (!this.edit) return;
      const active = document.activeElement;
      if (active && (active.closest?.('.vsg-pop') || active.hasAttribute('data-editor'))) return;
      this.commitEdit();
    }, 0);
    return e.kind === 'textarea'
      ? html`<textarea class="vsg-editor vsg-editor--area" data-editor .value=${e.value} @keydown=${onKey} @blur=${onBlur}
          aria-label=${col?.name ?? 'Cell'}></textarea><span class="vsg-editor-hint" style="display:none"></span>`
      : html`<input class="vsg-editor" data-editor .value=${e.value} placeholder=${placeholder} @keydown=${onKey} @blur=${onBlur}
          aria-label=${col?.name ?? 'Cell'} inputmode=${col?.type === 'number' ? 'decimal' : 'text'} />`;
  }

  private place(x: number, y: number, w = 240): string {
    const hr = this.host.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, hr.width - w - 8));
    const top = Math.max(8, Math.min(y, hr.height - 120));
    return `left:${left}px;top:${top}px;width:${w}px`;
  }

  private popover(): TemplateResult {
    const p = this.pop!;
    switch (p.kind) {
      case 'column': return this.columnMenu(p.col, p.x, p.y);
      case 'type': return this.typeMenu(p.col, p.x, p.y);
      case 'choices': return this.choicesModal(p.col);
      case 'status': return this.statusPicker(p.r, p.c, p.x, p.y, p.query);
      case 'date': return this.datePicker(p.r, p.c, p.x, p.y, p.month);
      case 'link': return this.linkPicker(p.r, p.c, p.x, p.y, p.query);
      case 'row': return this.rowMenu(p.r, p.x, p.y);
      case 'filter': return this.filterPop(p.x, p.y);
      case 'hidden': return this.hiddenPop(p.x, p.y);
      case 'delete-linked': return this.deleteLinkedModal(p.keys);
      case 'rename': return this.renamePop(p.col, p.value, p.x, p.y);
      case 'series': return this.seriesModal(p.choices, !!p.busy, p.error);
      case 'repost': return this.repostModal(p.rowKey);
    }
  }

  private close(): void { this.pop = null; this.schedule(); this.focusSink(); }

  private columnMenu(colId: string, x: number, y: number): TemplateResult {
    const col = this.snap?.columns.find(c => c.id === colId);
    if (!col) return html``;
    const idx = this.cols.findIndex(c => c.id === colId);
    const ro = this.readonly;
    const item = (label: string, fn: () => void, opts: { danger?: boolean; hide?: boolean; hint?: string } = {}) =>
      opts.hide ? nothing : html`<button type="button" role="menuitem" class="${opts.danger ? 'is-danger' : ''}" @click=${() => { fn(); }}>${label}${opts.hint ? html`<em>${opts.hint}</em>` : nothing}</button>`;
    const f = this.frozenCount();
    return html`<div class="vsg-pop vsg-menu" role="menu" style=${this.place(x, y, 236)}>
      <div class="vsg-menu__title">${col.name}<span>${TYPE_LABEL[col.type]}${col.bind ? ' · linked to the cards' : ''}</span></div>
      ${item('Rename', () => { this.pop = { kind: 'rename', col: col.id, value: col.name, x, y }; this.schedule(); }, { hide: ro })}
      ${item('Change type', () => { this.pop = { kind: 'type', col: col.id, x, y }; this.schedule(); }, { hide: ro || !!col.bind })}
      ${item('Edit choices', () => { this.pop = { kind: 'choices', col: col.id }; this.schedule(); }, { hide: ro || col.type !== 'status' })}
      <hr />
      ${item('Sort A to Z', () => { this.setView({ sort: { col: col.id, dir: 1 } }); this.close(); }, { hint: col.type === 'number' || col.type === 'date' ? 'smallest first' : '' })}
      ${item('Sort Z to A', () => { this.setView({ sort: { col: col.id, dir: -1 } }); this.close(); })}
      ${item('Filter by this column', () => {
        this.setView({ filters: [...this.view.filters, { col: col.id, op: col.type === 'status' ? 'any' : 'contains', value: '', values: [] }] });
        this.pop = { kind: 'filter', x, y }; this.schedule();
      })}
      <hr />
      ${item('Insert column left', () => { const before = this.cols[idx - 1]?.id ?? null; this.run(() => addColumn(this.std.store, this.blockId, this.tabId, { name: 'New column' }, before)); this.close(); }, { hide: ro })}
      ${item('Insert column right', () => { this.run(() => addColumn(this.std.store, this.blockId, this.tabId, { name: 'New column' }, col.id)); this.close(); }, { hide: ro })}
      ${item(idx < f ? 'Unfreeze columns' : 'Freeze up to this column', () => { this.run(() => updateTab(this.std.store, this.blockId, this.tabId, { frozen: idx < f ? 0 : idx + 1 })); this.close(); }, { hide: ro })}
      ${item('Hide column', () => { this.run(() => updateColumn(this.std.store, this.blockId, col.id, { hidden: true })); this.close(); }, { hide: ro })}
      ${item('Delete column', () => {
        if (col.bind) { toast('This column is linked to the shot cards. Hiding it keeps the cards as they are.', 'info'); }
        this.run(() => deleteColumn(this.std.store, this.blockId, col.id)); this.close();
      }, { danger: true, hide: ro })}
    </div>`;
  }

  private renamePop(colId: string, value: string, x: number, y: number): TemplateResult {
    const commit = (v: string) => { if (v.trim()) this.run(() => updateColumn(this.std.store, this.blockId, colId, { name: v })); this.close(); };
    requestAnimationFrame(() => { const i = this.host.querySelector<HTMLInputElement>('[data-rename]'); if (i && document.activeElement !== i) { i.focus(); i.select(); } });
    return html`<div class="vsg-pop vsg-menu" style=${this.place(x, y, 260)}>
      <label class="vsg-field"><span>Column name</span>
        <input data-rename .value=${value} maxlength="120"
          @keydown=${(e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); if (e.key === 'Escape') this.close(); }} />
      </label>
      <div class="vsg-row-actions"><button type="button" class="vsg-tool" @click=${() => this.close()}>Cancel</button>
        <button type="button" class="vsg-tool vsg-tool--primary" @click=${() => commit(this.host.querySelector<HTMLInputElement>('[data-rename]')!.value)}>Save</button></div>
    </div>`;
  }

  private typeMenu(colId: string, x: number, y: number): TemplateResult {
    const col = this.snap?.columns.find(c => c.id === colId);
    if (!col) return html``;
    return html`<div class="vsg-pop vsg-menu" role="menu" style=${this.place(x, y, 236)}>
      <div class="vsg-menu__title">Column type<span>Values are kept. What cannot convert stays as text.</span></div>
      ${COLUMN_TYPES.map(t => html`<button type="button" role="menuitemradio" aria-checked=${t === col.type ? 'true' : 'false'} class="${t === col.type ? 'is-current' : ''}"
          @click=${() => { this.run(() => updateColumn(this.std.store, this.blockId, colId, { type: t })); this.close(); }}>
          <span class="vsg-hicon">${TYPE_ICON[t]}</span>${TYPE_LABEL[t]}</button>`)}
      ${col.type === 'status' ? html`<hr /><button type="button" @click=${() => { this.run(() => updateColumn(this.std.store, this.blockId, colId, { multi: !col.multi })); this.close(); }}>
        ${col.multi ? 'Allow only one choice' : 'Allow several choices'}</button>` : nothing}
    </div>`;
  }

  private choicesModal(colId: string): TemplateResult {
    const col = this.snap?.columns.find(c => c.id === colId);
    if (!col) return html``;
    const opts: StatusChoice[] = (col.options ?? []).map(o => ({ ...o }));
    const save = () => {
      const rows = [...this.host.querySelectorAll<HTMLElement>('[data-choice]')].map(el => ({
        id: el.dataset.choice!, label: el.querySelector<HTMLInputElement>('input')!.value, color: el.dataset.color!,
      })).filter(o => o.label.trim());
      this.run(() => updateColumn(this.std.store, this.blockId, colId, { options: rows }));
      this.close();
    };
    return html`<div class="vsg-modal-back"><div class="vsg-modal" role="dialog" aria-label="Edit choices">
      <h3>Choices for ${col.name}</h3>
      <p>Renaming a choice renames it in every row.</p>
      <div class="vsg-choices">
        ${opts.map(o => html`<div class="vsg-choice" data-choice=${o.id} data-color=${o.color}>
          <button type="button" class="vsg-swatch" data-c=${o.color} title="Change colour" aria-label="Change colour"
            @click=${(e: MouseEvent) => {
              const row = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-choice]')!;
              const next = STATUS_COLORS[(STATUS_COLORS.indexOf(row.dataset.color as typeof STATUS_COLORS[number]) + 1) % STATUS_COLORS.length]!;
              row.dataset.color = next; (e.currentTarget as HTMLElement).dataset.c = next;
            }}></button>
          <input .value=${o.label} maxlength="60" @keydown=${(e: KeyboardEvent) => e.stopPropagation()} />
          <button type="button" class="vsg-x" title="Remove" aria-label="Remove ${o.label}" @click=${(e: MouseEvent) => (e.currentTarget as HTMLElement).closest('[data-choice]')!.remove()}>×</button>
        </div>`)}
      </div>
      <button type="button" class="vsg-tool" @click=${() => {
        const list = this.host.querySelector('.vsg-choices')!;
        const color = STATUS_COLORS[list.children.length % STATUS_COLORS.length]!;
        const div = document.createElement('div');
        div.className = 'vsg-choice'; div.dataset.choice = `o${Math.random().toString(36).slice(2, 9)}`; div.dataset.color = color;
        div.innerHTML = `<button type="button" class="vsg-swatch" data-c="${color}" disabled></button><input maxlength="60" placeholder="New choice" /><button type="button" class="vsg-x" aria-label="Remove">×</button>`;
        div.querySelector('.vsg-x')!.addEventListener('click', () => div.remove());
        div.querySelector('input')!.addEventListener('keydown', ev => ev.stopPropagation());
        list.append(div);
        div.querySelector('input')!.focus();
      }}>+ Add a choice</button>
      <div class="vsg-row-actions"><button type="button" class="vsg-tool" @click=${() => this.close()}>Cancel</button>
        <button type="button" class="vsg-tool vsg-tool--primary" @click=${save}>Save</button></div>
    </div></div>`;
  }

  private statusPicker(r: number, c: number, x: number, y: number, query: string): TemplateResult {
    const row = this.rows[r]; const col = this.cols[c];
    if (!row || !col) return html``;
    const current = String(this.value(row, col) ?? '');
    const chosen = new Set(current.split(/\s*,\s*/).filter(Boolean).map(s => s.toLowerCase()));
    const q = query.trim().toLowerCase();
    const opts = (col.options ?? []).filter(o => !q || o.label.toLowerCase().includes(q));
    const exact = (col.options ?? []).some(o => o.label.toLowerCase() === q);
    const pick = (label: string) => {
      if (col.multi) {
        const list = current.split(/\s*,\s*/).filter(Boolean);
        const i = list.findIndex(s => s.toLowerCase() === label.toLowerCase());
        if (i >= 0) list.splice(i, 1); else list.push(label);
        const order = (col.options ?? []).map(o => o.label.toLowerCase());
        list.sort((a, b) => order.indexOf(a.toLowerCase()) - order.indexOf(b.toLowerCase()));
        this.writeCell(r, c, list.join(MULTI_SEPARATOR));
        this.pop = { kind: 'status', r, c, x, y, query: '' };
        this.schedule();
      } else {
        this.writeCell(r, c, chosen.has(label.toLowerCase()) ? null : label);
        this.close();
      }
    };
    requestAnimationFrame(() => { const i = this.host.querySelector<HTMLInputElement>('[data-pick]'); if (i && document.activeElement !== i) i.focus(); });
    return html`<div class="vsg-pop vsg-picker" role="listbox" aria-multiselectable=${col.multi ? 'true' : 'false'} style=${this.place(x, y, 240)}>
      <input data-pick class="vsg-picker__q" placeholder=${col.multi ? 'Find or add choices' : 'Find or add a choice'} .value=${live(query)}
        @input=${(e: Event) => { this.pop = { kind: 'status', r, c, x, y, query: (e.target as HTMLInputElement).value }; this.schedule(); }}
        @keydown=${(e: KeyboardEvent) => {
          e.stopPropagation();
          if (e.key === 'Escape') this.close();
          if (e.key === 'Enter') {
            e.preventDefault();
            // The LIVE text, not this render's: a fast Enter beats the re-render.
            const live = (e.target as HTMLInputElement).value.trim();
            const ql = live.toLowerCase();
            const hit = (col.options ?? []).find(o => o.label.toLowerCase() === ql)
              ?? (col.options ?? []).find(o => o.label.toLowerCase().includes(ql));
            const label = ql ? (hit?.label ?? live) : '';
            if (label) pick(label);
          }
        }} />
      <div class="vsg-picker__list">
        ${opts.map(o => html`<button type="button" role="option" aria-selected=${chosen.has(o.label.toLowerCase()) ? 'true' : 'false'} @click=${() => pick(o.label)}>
          <span class="vsg-tick">${chosen.has(o.label.toLowerCase()) ? '✓' : ''}</span><span class="vsg-chip" data-c=${o.color}>${o.label}</span></button>`)}
        ${q && !exact ? html`<button type="button" @click=${() => pick(query.trim())}><span class="vsg-tick">+</span>Add "${query.trim()}"</button>` : nothing}
        ${!opts.length && !q ? html`<div class="vsg-picker__empty">No choices yet. Type one above.</div>` : nothing}
      </div>
      ${current ? html`<button type="button" class="vsg-picker__clear" @click=${() => { this.writeCell(r, c, null); this.close(); }}>Clear</button>` : nothing}
    </div>`;
  }

  private linkPicker(r: number, c: number, x: number, y: number, query: string): TemplateResult {
    const col = this.cols[c];
    if (!col) return html``;
    const scenes = col.bind === 'shot.sceneKey';
    const q = query.trim().toLowerCase();
    const items = scenes
      ? readParsed(this.std).scenes.map((s, i) => ({ value: s.key, label: `${i + 1}. ${s.heading}` }))
      : readShots(this.std).map((s, i) => ({ value: `shot:${s.id}`, label: `Shot ${i + 1}${s.title ? ` · ${s.title}` : ''}` }));
    const shown = items.filter(it => !q || it.label.toLowerCase().includes(q)).slice(0, 200);
    const pick = (v: string | null) => { this.writeCell(r, c, v); this.close(); };
    requestAnimationFrame(() => { const i = this.host.querySelector<HTMLInputElement>('[data-pick]'); if (i && document.activeElement !== i) i.focus(); });
    return html`<div class="vsg-pop vsg-picker" style=${this.place(x, y, 300)}>
      <input data-pick class="vsg-picker__q" placeholder=${scenes ? 'Find a scene' : 'Find a shot'} .value=${live(query)}
        @input=${(e: Event) => { this.pop = { kind: 'link', r, c, x, y, query: (e.target as HTMLInputElement).value }; this.schedule(); }}
        @keydown=${(e: KeyboardEvent) => {
          e.stopPropagation();
          if (e.key === 'Escape') this.close();
          if (e.key === 'Enter') {
            const ql = (e.target as HTMLInputElement).value.trim().toLowerCase();
            const hit = items.find(it => !ql || it.label.toLowerCase().includes(ql));
            if (hit) pick(hit.value);
          }
        }} />
      <div class="vsg-picker__list">
        ${shown.map(it => html`<button type="button" @click=${() => pick(it.value)}>${it.label}</button>`)}
        ${!shown.length ? html`<div class="vsg-picker__empty">${scenes ? 'No scenes yet. Write the screenplay first.' : 'No shots on this board yet.'}</div>` : nothing}
      </div>
      <button type="button" class="vsg-picker__clear" @click=${() => pick(null)}>Clear</button>
    </div>`;
  }

  private datePicker(r: number, c: number, x: number, y: number, month: string): TemplateResult {
    const row = this.rows[r]; const col = this.cols[c];
    if (!row || !col) return html``;
    const current = String(this.value(row, col) ?? '');
    const [yy, mm] = month.split('-').map(Number) as [number, number];
    const first = new Date(Date.UTC(yy, mm - 1, 1));
    const startDow = (first.getUTCDay() + 6) % 7; // Monday first
    const days = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const today = new Date(); const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const shift = (n: number) => { const d = new Date(Date.UTC(yy, mm - 1 + n, 1)); this.pop = { kind: 'date', r, c, x, y, month: d.toISOString().slice(0, 7) }; this.schedule(); };
    const pick = (iso: string | null) => { this.edit = null; this.writeCell(r, c, iso); this.close(); };
    const cells: TemplateResult[] = [];
    for (let i = 0; i < startDow; i++) cells.push(html`<span></span>`);
    for (let d = 1; d <= days; d++) {
      const iso = `${month}-${String(d).padStart(2, '0')}`;
      cells.push(html`<button type="button" class="${iso === current ? 'is-on' : ''} ${iso === todayIso ? 'is-today' : ''}" @mousedown=${(e: Event) => e.preventDefault()} @click=${() => pick(iso)}>${d}</button>`);
    }
    return html`<div class="vsg-pop vsg-cal" style=${this.place(x, y + 4, 252)} @mousedown=${(e: Event) => e.preventDefault()}>
      <div class="vsg-cal__head">
        <button type="button" aria-label="Previous month" @click=${() => shift(-1)}>‹</button>
        <b>${MONTH[mm - 1]} ${yy}</b>
        <button type="button" aria-label="Next month" @click=${() => shift(1)}>›</button>
      </div>
      <div class="vsg-cal__dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => html`<span>${d}</span>`)}</div>
      <div class="vsg-cal__grid">${cells}</div>
      <div class="vsg-cal__foot">
        <button type="button" @click=${() => pick(todayIso)}>Today</button>
        <button type="button" @click=${() => pick(null)}>Clear</button>
      </div>
    </div>`;
  }

  private rowMenu(r: number, x: number, y: number): TemplateResult {
    const g = this.range();
    const inSel = r >= g.r0 && r <= g.r1;
    const keys = inSel ? this.rows.slice(g.r0, g.r1 + 1).map(x2 => x2.key) : [this.rows[r]?.key].filter(Boolean) as string[];
    const n = keys.length;
    const row = this.rows[r];
    const ro = this.readonly;
    const shotsTab = this.snap?.tab.binding?.kind === 'shots';
    const planned = keys.filter(k => { const d = this.rows.find(x2 => x2.key === k); return d && !d.shotId && d.rowId; });
    const linked = keys.filter(k => { const d = this.rows.find(x2 => x2.key === k); return d?.shotId && !d.removed; });
    const word = n === 1 ? 'row' : `${n} rows`;
    return html`<div class="vsg-pop vsg-menu" role="menu" style=${this.place(x, y, 240)}>
      ${ro ? html`<div class="vsg-menu__title">View only</div>` : html`
        <button type="button" role="menuitem" @click=${() => { this.run(() => addRows(this.std.store, this.blockId, this.tabId, 1, { beforeKey: row?.rowId ?? null })); this.close(); }} ?disabled=${!row?.rowId || !!this.view.sort}>Insert row above</button>
        <button type="button" role="menuitem" @click=${() => { this.run(() => addRows(this.std.store, this.blockId, this.tabId, 1, { afterKey: row?.rowId ?? null })); this.close(); }} ?disabled=${!row?.rowId || !!this.view.sort}>Insert row below</button>
        ${this.opts.onMakeCards && (planned.length || !shotsTab) ? html`<button type="button" role="menuitem" @click=${() => { this.opts.onMakeCards?.(keys); this.close(); }}>
          Make ${n === 1 ? 'a card' : `${n} cards`} from ${n === 1 ? 'this row' : 'these rows'}<em>Adds shot cards. Never removes any.</em></button>` : nothing}
        ${this.kind === 'calendar' ? html`<button type="button" role="menuitem" @click=${() => { const rs = this.rowsFor(keys); this.close(); void this.sendRows(rs); }}>
          Send ${n === 1 ? 'this row' : `${n} rows`} for approval<em>Makes a post you approve on its card. Nothing posts before that.</em></button>` : nothing}
        ${this.kind === 'episodes' ? html`<button type="button" role="menuitem" @click=${() => { const rs = this.rowsFor(keys); this.close(); void this.makeEpisodeBoards(rs); }}>
          Make ${n === 1 ? 'an episode board' : `${n} episode boards`}<em>An empty board for each row that has none. Only adds.</em></button>` : nothing}
        ${row?.link?.kind === 'shot' && !shotsTab ? html`<button type="button" role="menuitem" @click=${() => { this.run(() => setRowLink(this.std.store, this.blockId, row.rowId!, null)); this.close(); }}>Unlink from its card</button>` : nothing}
        <hr />
        <button type="button" role="menuitem" class="is-danger" @click=${() => {
          if (linked.length && shotsTab) { this.pop = { kind: 'delete-linked', keys }; this.schedule(); return; }
          this.run(() => deleteRows(this.std, this.blockId, keys)); this.sel = { ...this.sel, ar: this.sel.r, ac: this.sel.c }; this.close();
        }}>Delete ${word}</button>`}
    </div>`;
  }

  private deleteLinkedModal(keys: string[]): TemplateResult {
    const go = (alsoShots: boolean) => { this.run(() => deleteRows(this.std, this.blockId, keys, { alsoShots })); this.close(); };
    return html`<div class="vsg-modal-back"><div class="vsg-modal" role="alertdialog" aria-label="Delete rows">
      <h3>These rows have shot cards</h3>
      <p>Unlinking keeps the cards on the board and only removes the notes in this sheet. Deleting the cards removes them from the board too.</p>
      <div class="vsg-row-actions">
        <button type="button" class="vsg-tool" @click=${() => this.close()}>Cancel</button>
        <button type="button" class="vsg-tool is-danger" @click=${() => go(true)}>Delete the cards too</button>
        <button type="button" class="vsg-tool vsg-tool--primary" @click=${() => go(false)}>Unlink only</button>
      </div>
    </div></div>`;
  }

  private filterPop(x: number, y: number): TemplateResult {
    const cols = this.snap?.columns ?? [];
    const filters = this.view.filters;
    const set = (i: number, patch: Partial<Filter>) => {
      const next = filters.map((f, j) => (j === i ? { ...f, ...patch } : f));
      this.setView({ filters: next });
    };
    const ops: Array<[Filter['op'], string]> = [['contains', 'contains'], ['is', 'is'], ['not', 'is not'], ['empty', 'is empty'], ['filled', 'is not empty']];
    return html`<div class="vsg-pop vsg-filter" style=${this.place(x, y, 420)}>
      <div class="vsg-menu__title">Filter<span>Only you see this. The rows are not changed.</span></div>
      ${filters.length ? nothing : html`<div class="vsg-picker__empty">No filters. Add one to see only the rows you need.</div>`}
      ${filters.map((f, i) => {
        const col = cols.find(c => c.id === f.col);
        return html`<div class="vsg-filter__row">
          <select @change=${(e: Event) => { const nc = cols.find(c => c.id === (e.target as HTMLSelectElement).value); set(i, { col: nc!.id, op: nc!.type === 'status' ? 'any' : 'contains', value: '', values: [] }); }}>
            ${cols.map(c => html`<option value=${c.id} ?selected=${c.id === f.col}>${c.name}</option>`)}
          </select>
          ${col?.type === 'status'
            ? html`<div class="vsg-filter__choices">${(col.options ?? []).map(o => html`<label class="vsg-filter__choice">
                <input type="checkbox" ?checked=${(f.values ?? []).includes(o.label)} @change=${(e: Event) => {
                  const on = (e.target as HTMLInputElement).checked;
                  const vals = new Set(f.values ?? []); if (on) vals.add(o.label); else vals.delete(o.label);
                  set(i, { op: 'any', values: [...vals] });
                }} /><span class="vsg-chip" data-c=${o.color}>${o.label}</span></label>`)}</div>`
            : html`<select @change=${(e: Event) => set(i, { op: (e.target as HTMLSelectElement).value as Filter['op'] })}>
                ${ops.map(([v, l]) => html`<option value=${v} ?selected=${v === f.op}>${l}</option>`)}</select>
              ${f.op === 'empty' || f.op === 'filled' ? nothing : html`<input placeholder="Value" .value=${f.value}
                @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
                @input=${(e: Event) => set(i, { value: (e.target as HTMLInputElement).value })} />`}`}
          <button type="button" class="vsg-x" aria-label="Remove filter" @click=${() => this.setView({ filters: filters.filter((_, j) => j !== i) })}>×</button>
        </div>`;
      })}
      <div class="vsg-row-actions">
        ${filters.length ? html`<button type="button" class="vsg-tool" @click=${() => this.setView({ filters: [] })}>Clear all</button>` : nothing}
        <button type="button" class="vsg-tool vsg-tool--primary" @click=${() => {
          const col = this.cols[this.sel.c] ?? cols[0];
          if (col) this.setView({ filters: [...filters, { col: col.id, op: col.type === 'status' ? 'any' : 'contains', value: '', values: [] }] });
        }}>+ Add filter</button>
      </div>
    </div>`;
  }

  private hiddenPop(x: number, y: number): TemplateResult {
    const hidden = this.snap?.columns.filter(c => c.hidden) ?? [];
    return html`<div class="vsg-pop vsg-menu" style=${this.place(x, y, 240)}>
      <div class="vsg-menu__title">Hidden columns<span>Hidden for everyone on this board.</span></div>
      ${hidden.map(c => html`<button type="button" @click=${() => { this.run(() => updateColumn(this.std.store, this.blockId, c.id, { hidden: false })); if (hidden.length <= 1) this.close(); }}>Show ${c.name}</button>`)}
      ${hidden.length > 1 ? html`<hr /><button type="button" @click=${() => { for (const c of hidden) this.run(() => updateColumn(this.std.store, this.blockId, c.id, { hidden: false })); this.close(); }}>Show all</button>` : nothing}
    </div>`;
  }
}

/** A "working…" toast that clears itself when the job ends. */
function toastProgress(message: string): () => void {
  toast(message, 'info');
  return () => {};
}

export { coerce, parseDate };
