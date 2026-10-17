/**
 * Every change to a sheet goes through here.
 *
 * ── WRITES GO STRAIGHT TO THE Y.MAPS ─────────────────────────────────────────
 * The sheet's props are nested Y.Maps (see `model.ts` for why it is not flat
 * data). BlockSuite's prop proxy turns every cell write into a full copy of the
 * cell map, so this module writes the Y.Maps itself, one key per cell, inside a
 * transaction with `SHEET_ORIGIN`:
 *
 *   • `force: true` makes BlockSuite's own proxies take the change, so anything
 *     reading `model.props` (a copy on the canvas, the snapshot) stays right.
 *   • the origin is added to the board's UndoManager's tracked origins, so a
 *     sheet edit is undone and redone by the board's own Ctrl+Z.
 *
 * `store.readonly` is checked here, because a direct Y write would otherwise
 * slip past it — a viewer must never be able to change a cell.
 */
import type { BlockStdScope } from '@blocksuite/std';
import type { Store } from '@blocksuite/store';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import * as Y from 'yjs';

import {
  type CellValue, type ColumnType, type DisplayRow, type RowLink, type SheetColumn,
  type SheetRow, type SheetTab, type ShotField, type StatusChoice, type TabBinding,
  MULTI_SEPARATOR, SHEET_FLAVOUR, SHEET_LIMITS, cellKey, displayRows, readCell, readColumns,
  readRows, readTabs,
} from './sheet-data';
import { SHEET_H, SHEET_W } from '../board/metrics';
import { reserveFlow } from '../board/space';
import { readShots, relayoutShots, setShotFields } from '../shot/shots';

export class SheetError extends Error {
  constructor(readonly reason: string, message: string) { super(message); }
}

/** One origin object for every sheet transaction — see the header. */
export const SHEET_ORIGIN = { force: true, proxy: true, sheet: true } as const;

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** 8 characters, so no id is ever a prefix of another (and never a `.` or `:`). */
export function newId(prefix: 't' | 'c' | 'r' | 'o'): string {
  let s = prefix;
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  for (const b of bytes) s += ID_CHARS[b % ID_CHARS.length];
  return s;
}

/** Status chip colours — soft tints that read in light and dark. */
export const STATUS_COLORS = ['grey', 'blue', 'purple', 'pink', 'green', 'amber', 'red', 'teal'] as const;

// ── finding the block ────────────────────────────────────────────────────────

export function blocksMap(store: Store): Y.Map<Y.Map<unknown>> {
  return store.doc.spaceDoc.getMap<Y.Map<unknown>>('blocks');
}

export function sheetYBlock(store: Store, blockId: string): Y.Map<unknown> | null {
  const b = blocksMap(store).get(blockId);
  return b instanceof Y.Map && b.get('sys:flavour') === SHEET_FLAVOUR ? b : null;
}

export function needSheet(store: Store, blockId: string): Y.Map<unknown> {
  const y = sheetYBlock(store, blockId);
  if (!y) throw new SheetError('not_found', 'That sheet is not on this board any more.');
  return y;
}

/** Every sheet on the board, top to bottom. */
export function listSheetIds(std: BlockStdScope): string[] {
  return std.store.getBlocksByFlavour(SHEET_FLAVOUR)
    .map(b => {
      let y = 0; let x = 0;
      try { const box = JSON.parse(String((b.model.props as { xywh?: string }).xywh ?? '[0,0]')); x = box[0]; y = box[1]; } catch { /* origin */ }
      return { id: b.id, x, y };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(b => b.id);
}

function sub(yBlock: Y.Map<unknown>, prop: 'tabs' | 'columns' | 'rows' | 'cells'): Y.Map<unknown> {
  let m = yBlock.get(`prop:${prop}`);
  if (!(m instanceof Y.Map)) {
    m = new Y.Map();
    yBlock.set(`prop:${prop}`, m);
  }
  return m as Y.Map<unknown>;
}

function record(map: Y.Map<unknown>, id: string): Y.Map<unknown> | null {
  const r = map.get(id);
  return r instanceof Y.Map ? r : null;
}

/** A plain object as a Y.Map, one key per field. */
function toYMap(obj: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) m.set(k, v);
  return m;
}

// ── transactions ─────────────────────────────────────────────────────────────

function track(store: Store): void {
  const um = (store.history as unknown as { undoManager?: Y.UndoManager }).undoManager;
  if (um && !um.trackedOrigins.has(SHEET_ORIGIN)) um.trackedOrigins.add(SHEET_ORIGIN);
}

export function canEdit(store: Store): boolean {
  return !store.readonly;
}

/**
 * Run `fn` as one sheet transaction: one undo step (unless `merge` asks to
 * join the previous one), refused on a read-only board.
 */
export function transactSheet<T>(store: Store, fn: () => T, opts: { merge?: boolean } = {}): T {
  if (store.readonly) throw new SheetError('read_only', 'This board is open to view only, so the sheet cannot be changed.');
  track(store);
  if (!opts.merge && batchDepth === 0) store.captureSync();
  let out!: T;
  store.doc.spaceDoc.transact(() => { out = fn(); }, SHEET_ORIGIN);
  return out;
}

let batchDepth = 0;

/**
 * Several sheet operations as ONE undo step — an agent's batch. On a shared
 * board the steps stay separate on purpose: redoing one giant step would be
 * one giant save, over the cap the chunks exist to respect.
 */
export async function batchSheet<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  store.captureSync();
  if (pacer.shared) return fn();
  batchDepth++;
  try { return await fn(); } finally { batchDepth--; store.captureSync(); }
}

// ── the commit pacer (shared boards) ─────────────────────────────────────────

/**
 * A shared board saves through `/changes`, which refuses anything over 700 KB
 * with a 413 — and `shared-sync.ts` treats a 413 as fatal and stops syncing.
 * So on a shared board a big write is committed in chunks, each followed by a
 * save. Private boards save the whole document to Storage and need none of it.
 */
interface Pacer { shared: boolean; flush(): Promise<void> }
let pacer: Pacer = { shared: false, flush: async () => {} };
export function setSheetPacer(next: Pacer): void { pacer = next; }
export function isSharedBoard(): boolean { return pacer.shared; }

/** About how many bytes of Yjs one chunk may carry. Far under the 700 KB cap. */
export const CHUNK_BYTES = 120_000;

async function settle(): Promise<void> {
  // The first waits out a save already in flight; the second sends ours.
  await pacer.flush().catch(() => {});
  await pacer.flush().catch(() => {});
}

// ── values ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Text as YYYY-MM-DD, or null when it is not a date. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    let a = +m[1]; let b = +m[2]; let y = +m[3];
    if (y < 100) y += 2000;
    // Day first unless that cannot be (13/05 is day first, 05/13 month first).
    if (a > 12) return valid(y, b, a);
    if (b > 12) return valid(y, a, b);
    return valid(y, b, a);
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return valid(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()]!, +m[1]);
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return valid(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  return null;
  function valid(y: number, mo: number, d: number): string | null {
    if (!(y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
}

/** Text as HH:MM (24 hour), or null. */
export function parseTime(raw: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap]\.?m\.?)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = +m[1]; const min = m[2] ? +m[2] : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, '');
  if (!m[2] && !ap) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** Text as seconds, or null. Takes 1:30, 1:02:03, 90, 90s, 1m 30s, 2 min. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  let m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (m) return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  m = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?|s)?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?|s)?)?)?$/.exec(s);
  if (m && (m[1] || m[2] || m[3])) return Math.round((+(m[1] ?? 0) * 3600 + +(m[2] ?? 0) * 60 + +(m[3] ?? 0)) * 100) / 100;
  return null;
}

/** Text as a number (1,234.5 / $12 / 45%), or null. */
export function parseNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const pct = s.endsWith('%');
  const clean = s.replace(/^[\s$€£₹¥]+|[\s$€£₹¥%]+$/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(clean)) return null;
  const n = Number(clean);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

export function parseBool(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const s = String(raw ?? '').trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'x', '✓', '✔', 'done', 'checked', 'on'].includes(s)) return true;
  if (['false', 'no', 'n', '0', '', 'off', 'unchecked'].includes(s)) return false;
  return null;
}

/**
 * A value as this column stores it. Never throws: text that is not a valid
 * date in a date column stays as the text (like Excel), so nothing typed is lost.
 */
export function coerce(value: unknown, type: ColumnType): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim() && type !== 'longtext' && type !== 'text') return null;
  if (value === '') return null;
  switch (type) {
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      const n = parseNumber(String(value));
      return n === null ? String(value) : n;
    }
    case 'duration': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const n = parseDuration(String(value));
      return n === null ? String(value) : n;
    }
    case 'checkbox': {
      const b = parseBool(value);
      return b === null ? String(value) : b;
    }
    case 'date': {
      if (typeof value === 'number') return excelSerialToDate(value) ?? String(value);
      return parseDate(String(value)) ?? String(value);
    }
    case 'time': {
      if (typeof value === 'number' && value >= 0 && value < 1) {
        const mins = Math.round(value * 1440);
        return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
      }
      return parseTime(String(value)) ?? String(value);
    }
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/** Excel's day number (1900 system) as YYYY-MM-DD. */
export function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 120000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ── reading through the store (live) ─────────────────────────────────────────

export interface TabSnapshot {
  tab: SheetTab;
  columns: SheetColumn[];
  rows: DisplayRow[];
}

/** One tab as the grid draws it: its columns and its rows, in order. */
export function readTab(std: BlockStdScope, blockId: string, tabId: string): TabSnapshot | null {
  const y = sheetYBlock(std.store, blockId);
  if (!y) return null;
  const tab = readTabs(y).find(t => t.id === tabId);
  if (!tab) return null;
  const shots = tab.binding?.kind === 'shots' ? readShots(std).map(s => ({ id: s.id })) : null;
  return { tab, columns: readColumns(y, tabId), rows: displayRows(tab, readRows(y, tabId), shots) };
}

const SHOT_PROP: Record<ShotField, string> = {
  'shot.title': 'title', 'shot.action': 'action', 'shot.voiceover': 'voiceover',
  'shot.durationSec': 'durationSec', 'shot.model': 'model', 'shot.sceneKey': 'sceneKey',
};

/** The value one cell shows — a bound column reads the shot itself. */
export function valueOf(std: BlockStdScope, yBlock: Y.Map<unknown>, tab: SheetTab, row: DisplayRow, col: SheetColumn): CellValue {
  if (col.bind && tab.binding?.kind === 'shots' && row.shotId) {
    if (row.removed) return null;
    const p = std.store.getBlock(row.shotId)?.model.props as Record<string, unknown> | undefined;
    const v = p?.[SHOT_PROP[col.bind]];
    if (col.bind === 'shot.durationSec') return typeof v === 'number' && v > 0 ? v : null;
    return typeof v === 'string' ? v : v == null ? null : String(v);
  }
  return row.rowId ? readCell(yBlock, row.rowId, col.id) : null;
}

// ── creating ─────────────────────────────────────────────────────────────────

export interface ColumnSpec {
  name: string;
  type?: ColumnType;
  width?: number;
  options?: Array<string | Partial<StatusChoice>>;
  multi?: boolean;
  bind?: ShotField;
  hidden?: boolean;
}

export interface TabSpec {
  name: string;
  binding?: TabBinding;
  frozen?: number;
  columns: ColumnSpec[];
  /** Rows as arrays aligned to `columns`, or objects keyed by column name. */
  rows?: Array<CellValue[] | Record<string, unknown>>;
}

export const DEFAULT_WIDTH: Record<ColumnType, number> = {
  text: 180, longtext: 300, number: 110, duration: 110, date: 150, time: 100,
  status: 150, person: 160, checkbox: 90, url: 200, media: 120, link: 170,
};

export function normaliseChoices(options: ColumnSpec['options'] | StatusChoice[] | undefined): StatusChoice[] {
  const out: StatusChoice[] = [];
  const seen = new Set<string>();
  for (const o of options ?? []) {
    const label = String(typeof o === 'string' ? o : o?.label ?? '').replace(/,/g, ' ').trim().slice(0, 60);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const color = typeof o === 'object' && o?.color && (STATUS_COLORS as readonly string[]).includes(o.color)
      ? o.color : STATUS_COLORS[(out.length + 1) % STATUS_COLORS.length];
    out.push({ id: typeof o === 'object' && o?.id ? String(o.id) : newId('o'), label, color });
  }
  return out;
}

function columnRecord(tabId: string, order: string, spec: ColumnSpec): Record<string, unknown> {
  const type = spec.type ?? 'text';
  return {
    tabId,
    name: (spec.name || 'Column').slice(0, 120),
    type,
    order,
    width: Math.max(60, Math.min(800, Math.round(spec.width ?? DEFAULT_WIDTH[type]))),
    ...(type === 'status' ? { options: normaliseChoices(spec.options) } : {}),
    ...(type === 'status' && spec.multi ? { multi: true } : {}),
    ...(spec.bind ? { bind: spec.bind } : {}),
    ...(spec.hidden ? { hidden: true } : {}),
  };
}

function countCells(y: Y.Map<unknown>): number {
  const c = y.get('prop:cells');
  return c instanceof Y.Map ? c.size : 0;
}

/** Write one tab's records (and its rows' cells) into the block. */
function writeTab(y: Y.Map<unknown>, order: string, spec: TabSpec): { tabId: string; rowIds: string[]; colIds: string[] } {
  const tabs = sub(y, 'tabs');
  if (tabs.size >= SHEET_LIMITS.tabs) throw new SheetError('too_many_tabs', `A sheet can have up to ${SHEET_LIMITS.tabs} tabs.`);
  if (spec.columns.length > SHEET_LIMITS.columns) throw new SheetError('too_many_columns', `A tab can have up to ${SHEET_LIMITS.columns} columns.`);
  const tabId = newId('t');
  tabs.set(tabId, toYMap({
    name: (spec.name || 'Sheet').slice(0, 80), order,
    ...(spec.binding ? { binding: spec.binding } : {}),
    ...(spec.frozen !== undefined ? { frozen: spec.frozen } : {}),
  }));
  const cols = sub(y, 'columns');
  const colKeys = generateNKeysBetween(null, null, spec.columns.length);
  const colIds: string[] = [];
  const colDefs: SheetColumn[] = [];
  spec.columns.forEach((c, i) => {
    const id = newId('c');
    const rec = columnRecord(tabId, colKeys[i]!, c);
    cols.set(id, toYMap(rec));
    colIds.push(id);
    colDefs.push({ id, ...(rec as Omit<SheetColumn, 'id'>) });
  });
  const rowIds = spec.rows?.length ? insertRows(y, tabId, colDefs, spec.rows, null) : [];
  return { tabId, rowIds, colIds };
}

/** Rows (arrays or name-keyed objects) appended after `afterOrder`. Returns ids. */
function insertRows(
  y: Y.Map<unknown>,
  tabId: string,
  columns: SheetColumn[],
  rows: Array<CellValue[] | Record<string, unknown>>,
  between: [string | null, string | null] | null,
): string[] {
  const existing = readRows(y, tabId);
  if (existing.length + rows.length > SHEET_LIMITS.rowsPerTab) {
    throw new SheetError('too_many_rows', `A tab can have up to ${SHEET_LIMITS.rowsPerTab.toLocaleString('en')} rows. This would make ${(existing.length + rows.length).toLocaleString('en')}.`);
  }
  const [lo, hi] = between ?? [existing.at(-1)?.order ?? null, null];
  const keys = generateNKeysBetween(lo, hi, rows.length);
  const rowMap = sub(y, 'rows');
  const cells = sub(y, 'cells');
  let added = 0;
  const byName = new Map(columns.map(c => [c.name.trim().toLowerCase(), c] as const));
  const ids: string[] = [];
  rows.forEach((r, i) => {
    const id = newId('r');
    ids.push(id);
    rowMap.set(id, toYMap({ tabId, order: keys[i]! }));
    const pairs: Array<[SheetColumn, unknown]> = Array.isArray(r)
      ? r.map((v, j) => [columns[j]!, v] as [SheetColumn, unknown]).filter(([c]) => !!c)
      : Object.entries(r).flatMap(([k, v]) => {
        const c = byName.get(k.trim().toLowerCase()) ?? columns.find(x => x.id === k);
        return c ? [[c, v] as [SheetColumn, unknown]] : [];
      });
    for (const [c, raw] of pairs) {
      const v = coerce(raw, c.type);
      if (v === null) continue;
      checkChars(v);
      if (c.type === 'status') learnChoices(y, c, v);
      cells.set(cellKey(id, c.id), v);
      added++;
    }
  });
  if (countCells(y) > SHEET_LIMITS.cells) {
    throw new SheetError('too_many_cells', `A sheet can hold up to ${SHEET_LIMITS.cells.toLocaleString('en')} filled cells.`);
  }
  void added;
  return ids;
}

function checkChars(v: CellValue): void {
  if (typeof v === 'string' && v.length > SHEET_LIMITS.cellChars) {
    throw new SheetError('cell_too_long', `A cell can hold up to ${SHEET_LIMITS.cellChars.toLocaleString('en')} characters.`);
  }
}

/** A status value with a choice the column does not have yet adds it. */
function learnChoices(y: Y.Map<unknown>, col: SheetColumn, v: CellValue): void {
  if (typeof v !== 'string' || !v.trim()) return;
  const rec = record(sub(y, 'columns'), col.id);
  if (!rec) return;
  const current = (normaliseChoicesFromStore(rec.get('options')));
  // A pasted column of free text must not become hundreds of "choices".
  if (current.length >= 40) return;
  const labels = col.multi ? v.split(/\s*,\s*/) : [v];
  let changed = false;
  for (const label of labels) {
    const clean = label.replace(/,/g, ' ').trim();
    if (!clean || current.some(o => o.label.toLowerCase() === clean.toLowerCase())) continue;
    current.push({ id: newId('o'), label: clean.slice(0, 60), color: STATUS_COLORS[(current.length + 1) % STATUS_COLORS.length] });
    changed = true;
  }
  if (changed) { rec.set('options', current); col.options = current; }
}

function normaliseChoicesFromStore(v: unknown): StatusChoice[] {
  const raw = v instanceof Y.AbstractType ? (v as Y.Array<unknown>).toJSON() : v;
  return Array.isArray(raw) ? (raw as StatusChoice[]).map(o => ({ ...o })) : [];
}

/**
 * A new sheet on the board, placed by the layout allocator (`space.ts`) in the
 * thinking region unless `at` says where. One undo step.
 */
export function createSheet(
  std: BlockStdScope,
  surfaceId: string,
  spec: { title?: string; tabs: TabSpec[]; at?: { x: number; y: number } },
): { blockId: string; tabIds: string[] } {
  const store = std.store;
  if (!spec.tabs.length) spec.tabs = [{ name: 'Sheet 1', columns: [{ name: 'Name' }, { name: 'Notes', type: 'longtext' }] }];
  // The one allocator (layout contract): at the asked spot, or the thinking
  // region, and pushed down until it stands on nothing.
  const box = reserveFlow(std, [{ w: SHEET_W, h: SHEET_H }], spec.at ? { at: spec.at } : {})[0]!;
  return transactSheet(store, () => {
    const blockId = store.addBlock(
      SHEET_FLAVOUR,
      { title: (spec.title || 'Untitled sheet').slice(0, 120), xywh: `[${box.x},${box.y},${box.w},${box.h}]` },
      surfaceId,
    );
    const y = sheetYBlock(store, blockId);
    if (!y) throw new SheetError('failed', 'The sheet could not be made.');
    const keys = generateNKeysBetween(null, null, spec.tabs.length);
    const tabIds = spec.tabs.map((t, i) => writeTab(y, keys[i]!, t).tabId);
    return { blockId, tabIds };
  });
}

export function addTab(store: Store, blockId: string, spec: TabSpec): string {
  return transactSheet(store, () => {
    const y = needSheet(store, blockId);
    const last = readTabs(y).at(-1)?.order ?? null;
    return writeTab(y, generateKeyBetween(last, null), spec).tabId;
  });
}

export function updateTab(store: Store, blockId: string, tabId: string, patch: { name?: string; frozen?: number; binding?: TabBinding | null }): void {
  transactSheet(store, () => {
    const rec = record(sub(needSheet(store, blockId), 'tabs'), tabId);
    if (!rec) throw new SheetError('not_found', 'That tab is not in this sheet.');
    if (typeof patch.name === 'string' && patch.name.trim()) rec.set('name', patch.name.trim().slice(0, 80));
    if (typeof patch.frozen === 'number') rec.set('frozen', Math.max(0, Math.min(5, Math.round(patch.frozen))));
    if (patch.binding === null) rec.delete('binding');
    else if (patch.binding) rec.set('binding', patch.binding);
  });
}

export function moveTab(store: Store, blockId: string, tabId: string, beforeTabId: string | null): void {
  transactSheet(store, () => {
    const y = needSheet(store, blockId);
    const tabs = readTabs(y).filter(t => t.id !== tabId);
    const at = beforeTabId ? tabs.findIndex(t => t.id === beforeTabId) : tabs.length;
    const lo = at > 0 ? tabs[at - 1]!.order : null;
    const hi = at >= 0 && at < tabs.length ? tabs[at]!.order : null;
    record(sub(y, 'tabs'), tabId)?.set('order', generateKeyBetween(lo, hi));
  });
}

export function deleteTab(store: Store, blockId: string, tabId: string): void {
  transactSheet(store, () => {
    const y = needSheet(store, blockId);
    if (readTabs(y).length <= 1) throw new SheetError('last_tab', 'A sheet needs at least one tab.');
    const cols = readColumns(y, tabId);
    const rows = readRows(y, tabId);
    const cells = sub(y, 'cells');
    for (const r of rows) for (const c of cols) cells.delete(cellKey(r.id, c.id));
    for (const r of rows) sub(y, 'rows').delete(r.id);
    for (const c of cols) sub(y, 'columns').delete(c.id);
    sub(y, 'tabs').delete(tabId);
  });
}

export function setTitle(store: Store, blockId: string, title: string): void {
  const clean = title.trim().slice(0, 120);
  if (!clean) return;
  transactSheet(store, () => { needSheet(store, blockId).set('prop:title', clean); });
}

// ── columns ──────────────────────────────────────────────────────────────────

export function addColumn(store: Store, blockId: string, tabId: string, spec: ColumnSpec, afterColId?: string | null): string {
  return transactSheet(store, () => {
    const y = needSheet(store, blockId);
    const cols = readColumns(y, tabId);
    if (cols.length >= SHEET_LIMITS.columns) throw new SheetError('too_many_columns', `A tab can have up to ${SHEET_LIMITS.columns} columns.`);
    const at = afterColId ? cols.findIndex(c => c.id === afterColId) : cols.length - 1;
    const lo = at >= 0 ? cols[at]!.order : null;
    const hi = cols[at + 1]?.order ?? null;
    const id = newId('c');
    sub(y, 'columns').set(id, toYMap(columnRecord(tabId, generateKeyBetween(lo, hi), spec)));
    return id;
  });
}

export interface ColumnPatch {
  name?: string;
  type?: ColumnType;
  width?: number;
  options?: Array<string | Partial<StatusChoice>>;
  multi?: boolean;
  hidden?: boolean;
}

/**
 * Change a column. A new TYPE converts the stored values where it can (text
 * "1:30" becomes 90 seconds in a duration column) and keeps the rest as text,
 * so a type change never throws anything away. Renaming a status choice
 * renames it in every cell.
 */
export function updateColumn(store: Store, blockId: string, colId: string, patch: ColumnPatch): void {
  transactSheet(store, () => {
    const y = needSheet(store, blockId);
    const rec = record(sub(y, 'columns'), colId);
    if (!rec) throw new SheetError('not_found', 'That column is not in this sheet.');
    const col = readColumns(y).find(c => c.id === colId)!;
    if (typeof patch.name === 'string' && patch.name.trim()) rec.set('name', patch.name.trim().slice(0, 120));
    if (typeof patch.width === 'number') rec.set('width', Math.max(60, Math.min(800, Math.round(patch.width))));
    if (typeof patch.hidden === 'boolean') { if (patch.hidden) rec.set('hidden', true); else rec.delete('hidden'); }
    if (typeof patch.multi === 'boolean') { if (patch.multi) rec.set('multi', true); else rec.delete('multi'); }
    const cells = sub(y, 'cells');
    const rows = readRows(y, col.tabId);
    if (patch.type && patch.type !== col.type && !col.bind) {
      rec.set('type', patch.type);
      if (patch.type === 'status' && !rec.get('options')) {
        const seen = new Set<string>();
        for (const r of rows) {
          const v = cells.get(cellKey(r.id, colId));
          if (typeof v === 'string' && v.trim()) for (const part of (col.multi ? v.split(/\s*,\s*/) : [v])) seen.add(part.trim());
          if (seen.size > 30) break;
        }
        rec.set('options', normaliseChoices([...seen]));
      }
      for (const r of rows) {
        const k = cellKey(r.id, colId);
        const v = cells.get(k) as CellValue | undefined;
        if (v === undefined || v === null) continue;
        const next = coerce(typeof v === 'string' ? v : patch.type === 'text' || patch.type === 'longtext' ? displayText(v, col.type) : v, patch.type);
        if (next === null) cells.delete(k); else if (next !== v) cells.set(k, next);
      }
    }
    if (patch.options) {
      const before = normaliseChoicesFromStore(rec.get('options'));
      const next = normaliseChoices(patch.options);
      rec.set('options', next);
      // Same id, new label: rename it in every cell.
      const renamed = new Map<string, string>();
      for (const o of next) {
        const old = before.find(b => b.id === o.id);
        if (old && old.label !== o.label) renamed.set(old.label, o.label);
      }
      if (renamed.size) {
        for (const r of rows) {
          const k = cellKey(r.id, colId);
          const v = cells.get(k);
          if (typeof v !== 'string') continue;
          const parts = v.split(/\s*,\s*/).map(p => renamed.get(p) ?? p);
          const nv = parts.join(MULTI_SEPARATOR);
          if (nv !== v) cells.set(k, nv);
        }
      }
    }
  });
}

/** A value as plain text, for a column turning into text. */
function displayText(v: CellValue, type: ColumnType): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (type === 'duration' && typeof v === 'number') {
    const m = Math.floor(v / 60); const s = Math.round(v % 60);
    return `${m}:${pad(s)}`;
  }
  return String(v ?? '');
}

export function moveColumn(store: Store, blockId: string, colId: string, beforeColId: string | null): void {
  transactSheet(store, () => {
    const y = needSheet(store, blockId);
    const col = readColumns(y).find(c => c.id === colId);
    if (!col) throw new SheetError('not_found', 'That column is not in this sheet.');
    const cols = readColumns(y, col.tabId).filter(c => c.id !== colId);
    const at = beforeColId ? cols.findIndex(c => c.id === beforeColId) : cols.length;
    const lo = at > 0 ? cols[at - 1]!.order : null;
    const hi = at >= 0 && at < cols.length ? cols[at]!.order : null;
    record(sub(y, 'columns'), colId)?.set('order', generateKeyBetween(lo, hi));
  });
}

export function deleteColumn(store: Store, blockId: string, colId: string): void {
  transactSheet(store, () => {
    const y = needSheet(store, blockId);
    const col = readColumns(y).find(c => c.id === colId);
    if (!col) return;
    if (readColumns(y, col.tabId).length <= 1) throw new SheetError('last_column', 'A tab needs at least one column.');
    const cells = sub(y, 'cells');
    for (const r of readRows(y, col.tabId)) cells.delete(cellKey(r.id, colId));
    sub(y, 'columns').delete(colId);
  });
}

// ── rows ─────────────────────────────────────────────────────────────────────

/** Blank rows (or rows of values) after `afterKey` (a row key), or at the end. */
export function addRows(
  store: Store,
  blockId: string,
  tabId: string,
  rows: Array<CellValue[] | Record<string, unknown>> | number,
  opts: { afterKey?: string | null; beforeKey?: string | null; merge?: boolean } = {},
): string[] {
  return transactSheet(store, () => {
    const y = needSheet(store, blockId);
    const list = readRows(y, tabId);
    let lo: string | null = list.at(-1)?.order ?? null; let hi: string | null = null;
    const anchor = opts.afterKey ?? opts.beforeKey;
    if (anchor) {
      const i = list.findIndex(r => r.id === anchor);
      if (i >= 0) {
        if (opts.afterKey) { lo = list[i]!.order; hi = list[i + 1]?.order ?? null; }
        else { lo = list[i - 1]?.order ?? null; hi = list[i]!.order; }
      }
    }
    const values = typeof rows === 'number' ? Array.from({ length: rows }, () => [] as CellValue[]) : rows;
    return insertRows(y, tabId, readColumns(y, tabId), values, [lo, hi]);
  }, { merge: opts.merge });
}

/** Delete stored rows (virtual shot rows have nothing to delete). Optionally the shots too. */
export function deleteRows(std: BlockStdScope, blockId: string, rowKeys: string[], opts: { alsoShots?: boolean } = {}): number {
  const store = std.store;
  let n = 0;
  const shotIds: string[] = [];
  transactSheet(store, () => {
    const y = needSheet(store, blockId);
    const rowMap = sub(y, 'rows');
    const cells = sub(y, 'cells');
    for (const key of rowKeys) {
      if (key.startsWith('~')) { if (opts.alsoShots) shotIds.push(key.slice(1)); continue; }
      const rec = record(rowMap, key);
      if (!rec) continue;
      const tabId = String(rec.get('tabId') ?? '');
      const link = rec.get('link') as RowLink | undefined;
      if (opts.alsoShots && link?.kind === 'shot') shotIds.push(link.id);
      for (const c of readColumns(y, tabId)) cells.delete(cellKey(key, c.id));
      rowMap.delete(key);
      n++;
    }
    for (const id of shotIds) {
      const b = store.getBlock(id);
      if (b?.flavour === 'voidspace:shot') { store.deleteBlock(b.model); n++; }
    }
  });
  if (shotIds.length) relayoutShots(std, readShots(std).map(s => s.id));
  return n;
}

/**
 * Move rows to sit before `beforeKey` (or at the end). On a shot list tab the
 * order IS the filmstrip, so this reorders the shots through the existing
 * reorder path and the rows follow.
 */
export function moveRows(std: BlockStdScope, blockId: string, tabId: string, keys: string[], beforeKey: string | null): void {
  const snap = readTab(std, blockId, tabId);
  if (!snap) throw new SheetError('not_found', 'That tab is not in this sheet.');
  const moving = new Set(keys);
  if (snap.tab.binding?.kind === 'shots') {
    const order = snap.rows.filter(r => r.shotId && !r.removed);
    const rest = order.filter(r => !moving.has(r.key));
    const moved = order.filter(r => moving.has(r.key));
    let at = beforeKey ? rest.findIndex(r => r.key === beforeKey) : rest.length;
    if (at < 0) at = rest.length;
    const next = [...rest.slice(0, at), ...moved, ...rest.slice(at)].map(r => r.shotId!);
    if (std.store.readonly) throw new SheetError('read_only', 'This board is open to view only.');
    relayoutShots(std, next);
    return;
  }
  transactSheet(std.store, () => {
    const y = needSheet(std.store, blockId);
    const list = readRows(y, tabId);
    const rest = list.filter(r => !moving.has(r.id));
    const moved = list.filter(r => moving.has(r.id));
    let at = beforeKey ? rest.findIndex(r => r.id === beforeKey) : rest.length;
    if (at < 0) at = rest.length;
    const lo = at > 0 ? rest[at - 1]!.order : null;
    const hi = at < rest.length ? rest[at]!.order : null;
    const newKeys = generateNKeysBetween(lo, hi, moved.length);
    const rowMap = sub(y, 'rows');
    moved.forEach((r, i) => record(rowMap, r.id)?.set('order', newKeys[i]!));
  });
}

/** Link a stored row to a shot or a board (or clear it with null). */
export function setRowLink(store: Store, blockId: string, rowId: string, link: RowLink | null): void {
  transactSheet(store, () => {
    const rec = record(sub(needSheet(store, blockId), 'rows'), rowId);
    if (!rec) return;
    if (link) rec.set('link', link); else rec.delete('link');
  });
}

// ── cells ────────────────────────────────────────────────────────────────────

export interface CellWrite {
  /** A row id, or `~<shotId>` for a shot that has no row yet. */
  row: string;
  col: string;
  value: unknown;
}

export interface WriteResult {
  written: number;
  /** Cells refused because they changed since the caller read them. */
  conflicts: Array<{ row: string; col: string; now: CellValue }>;
  /** New row ids for virtual rows that got a real one. */
  created: Record<string, string>;
}

/**
 * Write cells. Bound columns write the shot's own field in the same step.
 * `expect` (optional, per cell) refuses only the cells that really changed.
 */
function applyWrites(
  std: BlockStdScope,
  y: Y.Map<unknown>,
  writes: Array<CellWrite & { expect?: unknown }>,
  sceneMoves: Map<string, string>,
): WriteResult {
  const store = std.store;
  const cols = new Map(readColumns(y).map(c => [c.id, c] as const));
  const tabs = new Map(readTabs(y).map(t => [t.id, t] as const));
  const cells = sub(y, 'cells');
  const rowMap = sub(y, 'rows');
  const created: Record<string, string> = {};
  const conflicts: WriteResult['conflicts'] = [];
  let written = 0;
  const lastOrder = new Map<string, string | null>();

  for (const w of writes) {
    const col = cols.get(w.col);
    if (!col) continue;
    const tab = tabs.get(col.tabId);
    if (!tab) continue;
    const value = coerce(w.value, col.type);
    checkChars(value);

    // Bound to a shot: the shot's own field, nothing stored here. A planned
    // row (no card yet) keeps the value in its own cell instead.
    const linkedShot = col.bind && tab.binding?.kind === 'shots'
      ? (w.row.startsWith('~') ? w.row.slice(1)
        : ((record(rowMap, w.row)?.get('link') as RowLink | undefined)?.kind === 'shot'
          ? ((record(rowMap, w.row)!.get('link') as { id: string }).id) : ''))
      : '';
    if (col.bind && linkedShot) {
      const shotId = linkedShot;
      const block = store.getBlock(shotId);
      if (!block || block.flavour !== 'voidspace:shot') continue;
      const prop = SHOT_PROP[col.bind];
      const props = block.model.props as Record<string, unknown>;
      if (w.expect !== undefined && String(props[prop] ?? '') !== String(w.expect ?? '')) {
        conflicts.push({ row: w.row, col: w.col, now: (props[prop] as CellValue) ?? null });
        continue;
      }
      if (prop === 'sceneKey') { sceneMoves.set(shotId, String(value ?? '')); written++; continue; }
      const next = prop === 'durationSec'
        ? (typeof value === 'number' ? Math.max(0, value) : 0)
        : String(value ?? '');
      if (props[prop] !== next) store.updateBlock(block.model, { [prop]: next });
      written++;
      continue;
    }

    let rowId = w.row;
    if (rowId.startsWith('~')) {
      // A shot with no row yet: make its row now, linked, at the end of the tab.
      const shotId = rowId.slice(1);
      rowId = created[w.row] ?? '';
      if (!rowId) {
        if (!lastOrder.has(tab.id)) lastOrder.set(tab.id, readRows(y, tab.id).at(-1)?.order ?? null);
        const order = generateKeyBetween(lastOrder.get(tab.id) ?? null, null);
        lastOrder.set(tab.id, order);
        rowId = newId('r');
        rowMap.set(rowId, toYMap({ tabId: tab.id, order, link: { kind: 'shot', id: shotId } }));
        created[w.row] = rowId;
      }
    } else if (!record(rowMap, rowId)) {
      continue;
    }
    const k = cellKey(rowId, col.id);
    const now = (cells.get(k) as CellValue | undefined) ?? null;
    if (w.expect !== undefined && String(now ?? '') !== String(w.expect ?? '')) {
      conflicts.push({ row: w.row, col: w.col, now });
      continue;
    }
    if (col.type === 'status') learnChoices(y, col, value);
    if (value === null) { if (now !== null) cells.delete(k); }
    else if (now !== value) cells.set(k, value);
    written++;
  }
  if (cells.size > SHEET_LIMITS.cells) {
    throw new SheetError('too_many_cells', `A sheet can hold up to ${SHEET_LIMITS.cells.toLocaleString('en')} filled cells.`);
  }
  return { written, conflicts, created };
}

function applySceneMoves(std: BlockStdScope, moves: Map<string, string>): void {
  for (const [shotId, sceneKey] of moves) setShotFields(std, shotId, { sceneKey } as never);
}

/** Write cells as one undo step. Small, synchronous: typing, a fill, the agent. */
export function setCells(std: BlockStdScope, blockId: string, writes: Array<CellWrite & { expect?: unknown }>, opts: { merge?: boolean } = {}): WriteResult {
  const moves = new Map<string, string>();
  const out = transactSheet(std.store, () => applyWrites(std, needSheet(std.store, blockId), writes, moves), opts);
  if (moves.size) applySceneMoves(std, moves);
  return out;
}

/** Roughly what a write costs in Yjs bytes, for chunking. */
function weigh(w: CellWrite): number {
  const v = w.value;
  return 48 + (typeof v === 'string' ? v.length * 1.2 : 8);
}

/**
 * A BIG write — a paste, an import. On a private board this is still one
 * transaction (one undo step). On a shared board it goes in chunks under the
 * save cap, each saved before the next, so the save never hits a 413.
 */
export async function setCellsPaced(
  std: BlockStdScope,
  blockId: string,
  writes: CellWrite[],
  onProgress?: (done: number, total: number) => void,
): Promise<WriteResult> {
  const total: WriteResult = { written: 0, conflicts: [], created: {} };
  const chunks: CellWrite[][] = [];
  if (!pacer.shared) chunks.push(writes);
  else {
    let cur: CellWrite[] = []; let bytes = 0;
    for (const w of writes) {
      const b = weigh(w);
      if (cur.length && bytes + b > CHUNK_BYTES) { chunks.push(cur); cur = []; bytes = 0; }
      cur.push(w); bytes += b;
    }
    if (cur.length) chunks.push(cur);
  }
  let done = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!.map(w => (w.row.startsWith('~') && total.created[w.row] ? { ...w, row: total.created[w.row]! } : w));
    const r = setCells(std, blockId, chunk);
    total.written += r.written; total.conflicts.push(...r.conflicts); Object.assign(total.created, r.created);
    done += chunk.length;
    onProgress?.(done, writes.length);
    if (pacer.shared && i < chunks.length - 1) await settle();
  }
  if (pacer.shared && chunks.length > 1) await settle();
  return total;
}

/** Rows needed for a big paste, made in paced steps on a shared board. */
export async function addRowsPaced(store: Store, blockId: string, tabId: string, count: number, afterKey: string | null): Promise<string[]> {
  const ids: string[] = [];
  const step = pacer.shared ? 1000 : count;
  let after = afterKey;
  for (let made = 0; made < count; made += step) {
    const n = Math.min(step, count - made);
    const got = addRows(store, blockId, tabId, n, { afterKey: after });
    ids.push(...got);
    after = got.at(-1) ?? after;
    if (pacer.shared && made + n < count) await settle();
  }
  return ids;
}

function rowBytes(r: CellValue[] | Record<string, unknown>): number {
  const vals = Array.isArray(r) ? r : Object.values(r);
  let n = 80;
  for (const v of vals) n += 48 + (typeof v === 'string' ? v.length * 1.2 : 8);
  return n;
}

/**
 * Append many rows of values — an import, an agent's batch. One undo step on a
 * private board (the chunks merge); on a shared board each chunk stays under
 * the save cap and is saved before the next.
 */
export async function appendRowsPaced(
  store: Store,
  blockId: string,
  tabId: string,
  rows: Array<CellValue[] | Record<string, unknown>>,
  opts: { merge?: boolean } = {},
): Promise<string[]> {
  const ids: string[] = [];
  let chunk: typeof rows = []; let bytes = 0;
  let first = !opts.merge;
  const flushChunk = async (last: boolean) => {
    if (!chunk.length) return;
    ids.push(...addRows(store, blockId, tabId, chunk, { merge: !first && !pacer.shared }));
    first = false;
    chunk = []; bytes = 0;
    if (pacer.shared && !last) await settle();
  };
  for (const r of rows) {
    const b = rowBytes(r);
    if (chunk.length && (pacer.shared ? bytes + b > CHUNK_BYTES : chunk.length >= 2000)) await flushChunk(false);
    chunk.push(r); bytes += b;
  }
  await flushChunk(true);
  if (pacer.shared && rows.length) await settle();
  return ids;
}

/** A new sheet from tab specs with any number of rows, paced on a shared board. */
export async function createSheetPaced(
  std: BlockStdScope,
  surfaceId: string,
  spec: { title?: string; tabs: TabSpec[]; at?: { x: number; y: number } },
): Promise<{ blockId: string; tabIds: string[] }> {
  const rows = spec.tabs.map(t => t.rows ?? []);
  const made = createSheet(std, surfaceId, { ...spec, tabs: spec.tabs.map(t => ({ ...t, rows: [] })) });
  for (let i = 0; i < made.tabIds.length; i++) {
    if (rows[i]!.length) await appendRowsPaced(std.store, made.blockId, made.tabIds[i]!, rows[i]!, { merge: true });
  }
  return made;
}

/** A new tab with any number of rows, paced on a shared board. */
export async function addTabPaced(store: Store, blockId: string, spec: TabSpec): Promise<string> {
  const tabId = addTab(store, blockId, { ...spec, rows: [] });
  if (spec.rows?.length) await appendRowsPaced(store, blockId, tabId, spec.rows, { merge: true });
  return tabId;
}

/** The order key a new row at the end of a tab would get (exported for tests). */
export function nextRowOrder(store: Store, blockId: string, tabId: string): string {
  return generateKeyBetween(readRows(needSheet(store, blockId), tabId).at(-1)?.order ?? null, null);
}

export type { SheetRow };
