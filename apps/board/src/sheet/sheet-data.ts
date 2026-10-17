/**
 * THE SHEET'S DATA, AS PLAIN JSON — the shared contract.
 *
 * A `voidspace:sheet` block keeps its cells inside the board's own Yjs
 * document. This file is the ONE reader of that layout, and it is pure: it
 * imports nothing but `yjs`, so the board (in the browser) and the website
 * server (which turns a saved board into the `sheet_text` copy the series
 * schedule reads) use the same code. `scripts/build-board.mjs` copies it to
 * `Voidspace-Website/main/server/utils/board-sheet-data.generated.ts`.
 *
 * ── THE LAYOUT IN THE Y.DOC (see SHEETS_PLAN.md in Voidspace-Website/main) ──
 *   doc.getMap('blocks').get(blockId)            Y.Map, sys:flavour = 'voidspace:sheet'
 *     prop:title    string
 *     prop:tabs     Y.Map  tabId  -> Y.Map { name, order, binding?, frozen? }
 *     prop:columns  Y.Map  colId  -> Y.Map { tabId, name, type, order, width,
 *                                           options?, multi?, bind?, hidden? }
 *     prop:rows     Y.Map  rowId  -> Y.Map { tabId, order, link? }
 *     prop:cells    Y.Map  `${rowId}:${colId}` -> string | number | boolean | null
 *
 * `binding`, `link` and `options` are plain JSON values (or, when BlockSuite
 * itself created them, the equivalent Y types — `plain()` reads both).
 * `order` is a fractional-indexing key: sort by plain string comparison.
 *
 * ── BOUND COLUMNS STORE NOTHING ─────────────────────────────────────────────
 * On a tab with `binding.kind === 'shots'`, a column with `bind: 'shot.title'`
 * (etc.) has no cells (a planned row with no card yet keeps them in its own
 * cells until "Make cards from rows" moves them onto the new card). Its value IS the linked shot's own field, read from the
 * shot block in the same document. The shot list tab shows every shot in
 * filmstrip order (top to bottom, then left to right), using the row whose
 * `link` points at it when there is one.
 */
import * as Y from 'yjs';

export const SHEET_FLAVOUR = 'voidspace:sheet';

export type ColumnType =
  | 'text' | 'longtext' | 'number' | 'duration' | 'date' | 'time'
  | 'status' | 'person' | 'checkbox' | 'url' | 'media' | 'link';

export const COLUMN_TYPES: readonly ColumnType[] = [
  'text', 'longtext', 'number', 'duration', 'date', 'time',
  'status', 'person', 'checkbox', 'url', 'media', 'link',
];

/** Shot fields a column on a shot list tab can stand for. */
export type ShotField =
  | 'shot.title' | 'shot.action' | 'shot.voiceover'
  | 'shot.durationSec' | 'shot.model' | 'shot.sceneKey';

export const SHOT_FIELDS: readonly ShotField[] = [
  'shot.title', 'shot.action', 'shot.voiceover', 'shot.durationSec', 'shot.model', 'shot.sceneKey',
];

export type CellValue = string | number | boolean | null;

export interface StatusChoice { id: string; label: string; color: string }

export type TabBinding = { kind: 'shots' } | { kind: 'episodes'; seriesLoopId?: string };
export type RowLink = { kind: 'shot'; id: string } | { kind: 'board'; boardId: string };

export interface SheetTab {
  id: string;
  name: string;
  order: string;
  binding?: TabBinding;
  /** How many columns stay put when the grid scrolls sideways. Default 1. */
  frozen?: number;
}

export interface SheetColumn {
  id: string;
  tabId: string;
  name: string;
  type: ColumnType;
  order: string;
  width: number;
  /** Status choices, in menu order. */
  options?: StatusChoice[];
  /** A status column that takes several choices ("Instagram, TikTok"). */
  multi?: boolean;
  bind?: ShotField;
  hidden?: boolean;
}

export interface SheetRow {
  id: string;
  tabId: string;
  order: string;
  link?: RowLink;
}

/** The hard caps. Past these, writes are refused in plain words. */
export const SHEET_LIMITS = {
  tabs: 20,
  rowsPerTab: 5000,
  columns: 100,
  cells: 50_000,
  cellChars: 10_000,
} as const;

/** A multi-choice status cell joins its labels with this. */
export const MULTI_SEPARATOR = ', ';

// ── reading the raw maps ─────────────────────────────────────────────────────

/** A Y type or a plain value, as plain JSON. */
export function plain(v: unknown): unknown {
  if (v instanceof Y.AbstractType) return (v as Y.Map<unknown>).toJSON();
  return v;
}

function field(map: unknown, key: string): unknown {
  if (map instanceof Y.Map) return plain(map.get(key));
  if (map && typeof map === 'object') return (map as Record<string, unknown>)[key];
  return undefined;
}

function str(v: unknown, d = ''): string { return typeof v === 'string' ? v : d; }
function num(v: unknown, d: number): number { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

function entries(map: unknown): Array<[string, unknown]> {
  if (map instanceof Y.Map) return [...map.entries()];
  if (map && typeof map === 'object') return Object.entries(map as Record<string, unknown>);
  return [];
}

const byOrder = <T extends { order: string; id: string }>(a: T, b: T) =>
  a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function normType(v: unknown): ColumnType {
  return (COLUMN_TYPES as readonly string[]).includes(String(v)) ? (v as ColumnType) : 'text';
}

export function readTabs(yBlock: Y.Map<unknown>): SheetTab[] {
  return entries(yBlock.get('prop:tabs')).map(([id, t]) => {
    const binding = field(t, 'binding') as TabBinding | undefined;
    const frozen = field(t, 'frozen');
    return {
      id,
      name: str(field(t, 'name'), 'Sheet'),
      order: str(field(t, 'order'), 'a0'),
      ...(binding && typeof binding === 'object' && (binding as TabBinding).kind ? { binding } : {}),
      ...(typeof frozen === 'number' ? { frozen } : {}),
    };
  }).sort(byOrder);
}

export function readColumns(yBlock: Y.Map<unknown>, tabId?: string): SheetColumn[] {
  return entries(yBlock.get('prop:columns')).map(([id, c]) => {
    const options = field(c, 'options');
    const bind = field(c, 'bind');
    return {
      id,
      tabId: str(field(c, 'tabId')),
      name: str(field(c, 'name'), 'Column'),
      type: normType(field(c, 'type')),
      order: str(field(c, 'order'), 'a0'),
      width: num(field(c, 'width'), 160),
      ...(Array.isArray(options) ? { options: options as StatusChoice[] } : {}),
      ...(field(c, 'multi') === true ? { multi: true } : {}),
      ...(typeof bind === 'string' && (SHOT_FIELDS as readonly string[]).includes(bind) ? { bind: bind as ShotField } : {}),
      ...(field(c, 'hidden') === true ? { hidden: true } : {}),
    };
  }).filter(c => !tabId || c.tabId === tabId).sort(byOrder);
}

export function readRows(yBlock: Y.Map<unknown>, tabId?: string): SheetRow[] {
  return entries(yBlock.get('prop:rows')).map(([id, r]) => {
    const link = field(r, 'link') as RowLink | undefined;
    return {
      id,
      tabId: str(field(r, 'tabId')),
      order: str(field(r, 'order'), 'a0'),
      ...(link && typeof link === 'object' && (link as RowLink).kind ? { link } : {}),
    };
  }).filter(r => !tabId || r.tabId === tabId).sort(byOrder);
}

export function cellKey(rowId: string, colId: string): string { return `${rowId}:${colId}`; }

export function readCell(yBlock: Y.Map<unknown>, rowId: string, colId: string): CellValue {
  const cells = yBlock.get('prop:cells');
  const v = cells instanceof Y.Map ? cells.get(cellKey(rowId, colId))
    : cells && typeof cells === 'object' ? (cells as Record<string, unknown>)[cellKey(rowId, colId)]
    : undefined;
  return v === undefined ? null : (v as CellValue);
}

// ── shots, for bound tabs ────────────────────────────────────────────────────

export interface ShotRecord {
  id: string;
  title: string;
  action: string;
  voiceover: string;
  durationSec: number;
  model: string;
  sceneKey: string;
  x: number;
  y: number;
}

/** Half a shot card: the row tolerance `shot/shots.ts` sorts the filmstrip by. */
const ROW_TOLERANCE = 1020 / 2;

/** Every shot on the board, in filmstrip order, read straight from the Y.Doc. */
export function readShotsFromDoc(doc: Y.Doc): ShotRecord[] {
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const out: ShotRecord[] = [];
  blocks.forEach((b, id) => {
    if (!(b instanceof Y.Map) || b.get('sys:flavour') !== 'voidspace:shot') return;
    let x = 0; let y = 0;
    try {
      const box = JSON.parse(String(b.get('prop:xywh') ?? '[0,0,0,0]')) as number[];
      x = Number(box[0]) || 0; y = Number(box[1]) || 0;
    } catch { /* origin */ }
    out.push({
      id,
      title: str(plain(b.get('prop:title'))),
      action: str(plain(b.get('prop:action'))),
      voiceover: str(plain(b.get('prop:voiceover'))),
      durationSec: num(b.get('prop:durationSec'), 0),
      model: str(b.get('prop:model')),
      sceneKey: str(b.get('prop:sceneKey')),
      x, y,
    });
  });
  return out.sort((a, b) => (Math.abs(a.y - b.y) > ROW_TOLERANCE ? a.y - b.y : 0) || a.x - b.x);
}

/** A shot's value for a bound column. */
export function shotFieldValue(shot: Omit<ShotRecord, 'x' | 'y'>, bind: ShotField): CellValue {
  switch (bind) {
    case 'shot.title': return shot.title;
    case 'shot.action': return shot.action;
    case 'shot.voiceover': return shot.voiceover;
    case 'shot.durationSec': return shot.durationSec || null;
    case 'shot.model': return shot.model;
    case 'shot.sceneKey': return shot.sceneKey;
  }
}

// ── the rows a tab SHOWS ─────────────────────────────────────────────────────

/**
 * One row as the grid draws it. On a shot list tab a shot with no row record
 * yet is a VIRTUAL row: its id is `~<shotId>` and writing an unbound cell
 * creates the real row.
 */
export interface DisplayRow {
  /** The row id, or `~<shotId>` for a shot with no row yet. */
  key: string;
  /** The stored row, when there is one. */
  rowId?: string;
  shotId?: string;
  /** The linked shot is gone from the board. Shown, never cleaned up silently. */
  removed?: boolean;
  link?: RowLink;
}

export function displayRows(
  tab: SheetTab,
  rows: readonly SheetRow[],
  shots: readonly { id: string }[] | null,
): DisplayRow[] {
  if (tab.binding?.kind !== 'shots' || !shots) {
    return rows.map(r => ({
      key: r.id, rowId: r.id, ...(r.link ? { link: r.link } : {}),
      ...(r.link?.kind === 'shot' ? { shotId: r.link.id } : {}),
    }));
  }
  const byShot = new Map<string, SheetRow>();
  for (const r of rows) if (r.link?.kind === 'shot' && !byShot.has(r.link.id)) byShot.set(r.link.id, r);
  const live = new Set(shots.map(s => s.id));
  const out: DisplayRow[] = shots.map(s => {
    const r = byShot.get(s.id);
    return r
      ? { key: r.id, rowId: r.id, shotId: s.id, link: r.link }
      : { key: `~${s.id}`, shotId: s.id, link: { kind: 'shot', id: s.id } as RowLink };
  });
  const used = new Set(out.map(d => d.rowId).filter(Boolean));
  for (const r of rows) {
    if (used.has(r.id)) continue;
    if (r.link?.kind === 'shot' && !live.has(r.link.id)) {
      out.push({ key: r.id, rowId: r.id, shotId: r.link.id, link: r.link, removed: true });
    } else {
      // A planned shot: a row with no card yet. "Make cards from rows" turns it into one.
      out.push({ key: r.id, rowId: r.id, ...(r.link ? { link: r.link } : {}) });
    }
  }
  return out;
}

// ── the whole sheet, as plain JSON ───────────────────────────────────────────

export interface SheetJsonColumn {
  id: string;
  name: string;
  type: ColumnType;
  width: number;
  hidden?: boolean;
  bind?: ShotField;
  multi?: boolean;
  options?: StatusChoice[];
}

export interface SheetJsonRow {
  /** Row id, or `~<shotId>` for a shot that has no row record yet. */
  id: string;
  link?: RowLink;
  removed?: true;
  /** Column id -> value. Empty cells are left out. */
  values: Record<string, CellValue>;
}

export interface SheetJsonTab {
  id: string;
  name: string;
  binding?: TabBinding;
  frozen?: number;
  columns: SheetJsonColumn[];
  rows: SheetJsonRow[];
}

export interface SheetJson {
  id: string;
  title: string;
  tabs: SheetJsonTab[];
}

/**
 * One sheet block, as tabs -> columns -> rows of plain values.
 *
 * `doc` is the board's Y.Doc; it is needed only to resolve shot-bound columns.
 */
export function readSheet(doc: Y.Doc, blockId: string): SheetJson | null {
  const yBlock = doc.getMap<Y.Map<unknown>>('blocks').get(blockId);
  if (!(yBlock instanceof Y.Map) || yBlock.get('sys:flavour') !== SHEET_FLAVOUR) return null;
  const shots = readShotsFromDoc(doc);
  const shotById = new Map(shots.map(s => [s.id, s] as const));
  const allCols = readColumns(yBlock);
  const allRows = readRows(yBlock);
  const tabs = readTabs(yBlock).map((tab): SheetJsonTab => {
    const columns = allCols.filter(c => c.tabId === tab.id);
    const rows = displayRows(tab, allRows.filter(r => r.tabId === tab.id), tab.binding?.kind === 'shots' ? shots : null);
    return {
      id: tab.id,
      name: tab.name,
      ...(tab.binding ? { binding: tab.binding } : {}),
      ...(tab.frozen !== undefined ? { frozen: tab.frozen } : {}),
      columns: columns.map(c => ({
        id: c.id, name: c.name, type: c.type, width: c.width,
        ...(c.hidden ? { hidden: true } : {}),
        ...(c.bind ? { bind: c.bind } : {}),
        ...(c.multi ? { multi: true } : {}),
        ...(c.options ? { options: c.options } : {}),
      })),
      rows: rows.map(d => {
        const values: Record<string, CellValue> = {};
        for (const c of columns) {
          const shot = d.shotId ? shotById.get(d.shotId) : undefined;
          // A planned row (no card yet) keeps its bound values in its own cells.
          const v = c.bind && tab.binding?.kind === 'shots' && d.shotId
            ? (shot ? shotFieldValue(shot, c.bind) : null)
            : d.rowId ? readCell(yBlock, d.rowId, c.id) : null;
          if (v !== null && v !== '') values[c.id] = v;
        }
        return {
          id: d.key,
          ...(d.link ? { link: d.link } : {}),
          ...(d.removed ? { removed: true as const } : {}),
          values,
        };
      }),
    };
  });
  return { id: blockId, title: str(plain(yBlock.get('prop:title')), 'Untitled sheet'), tabs };
}

/** Every sheet on the board, in no particular order. */
export function readSheets(doc: Y.Doc): SheetJson[] {
  const out: SheetJson[] = [];
  doc.getMap<Y.Map<unknown>>('blocks').forEach((b, id) => {
    if (b instanceof Y.Map && b.get('sys:flavour') === SHEET_FLAVOUR) {
      const s = readSheet(doc, id);
      if (s) out.push(s);
    }
  });
  return out;
}

/** A cell as text — what a TSV, a CSV or the agent sees. */
export function cellText(v: CellValue, type: ColumnType = 'text'): string {
  if (v === null || v === undefined) return '';
  if (type === 'checkbox') return v === true ? 'TRUE' : v === false ? 'FALSE' : String(v);
  if (type === 'duration' && typeof v === 'number') return formatDuration(v);
  return String(v);
}

/** Seconds as m:ss (or h:mm:ss). */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '';
  const neg = sec < 0; const s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  return neg ? `-${body}` : body;
}

/** A tab as tab-separated text: a header row, then one line per row. */
export function tabToTsv(tab: SheetJsonTab, opts: { withIds?: boolean } = {}): string {
  const cols = tab.columns.filter(c => !c.hidden);
  const esc = (s: string) => s.replace(/[\t\r\n]+/g, ' ');
  const head = [...(opts.withIds ? ['id'] : []), ...cols.map(c => esc(c.name))].join('\t');
  const lines = tab.rows.map(r =>
    [...(opts.withIds ? [r.id] : []), ...cols.map(c => esc(cellText(r.values[c.id] ?? null, c.type)))].join('\t'));
  return [head, ...lines].join('\n');
}
