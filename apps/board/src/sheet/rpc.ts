/**
 * The agent's sheet tools, board side: `voidspace:board-sheet-*`.
 *
 *   sheet-read      list sheets, or read one tab as compact TSV (bounded)
 *   sheet-write     a batch of operations, one undo step
 *   sheet-create    from a template, columns and rows, CSV, markdown, a file URL or a document table
 *   sheet-to-cards  rows become shot cards (only ever adds)
 *   sheet-export    .xlsx or .csv, downloaded and (on request) uploaded for a link
 *
 * Every name starts with `voidspace:board-` — the board's dispatcher drops
 * anything else (`agent/rpc.ts`), which once made a document tool hang.
 */
import type { MountedBoard } from '../blocksuite/editor';
import {
  type CellValue, type ColumnType, type SheetJson, type SheetJsonTab, COLUMN_TYPES, SHOT_FIELDS,
  cellText, readSheet, readTabs,
} from './sheet-data';
import {
  type CellWrite, type ColumnSpec, type TabSpec, SheetError, addColumn, addTabPaced, appendRowsPaced,
  createSheetPaced, deleteColumn, deleteRows, deleteTab, listSheetIds, moveRows, setCellsPaced,
  setTitle, sheetYBlock, updateColumn, updateTab, readTab, batchSheet, valueOf,
} from './ops';
import { columnFor, postIssues, splitPlatforms } from './post-rules';
import { tabKind } from './activity';
import { TEMPLATES, templateTab, type TemplateId } from './templates';
import { computeTotal, totalsFor } from './totals';
import type { SheetFocus } from './focus';

/**
 * On a content-calendar tab, the rows whose caption is too long for one of its
 * platforms (or whose format a platform cannot post) — the same warnings the
 * person sees on the caption cell, so the agent can fix them in its next write.
 */
function calendarWarnings(std: MountedBoard['std'], blockId: string, tabId: string): Array<{ row: string; warnings: string[] }> {
  const snap = readTab(std, blockId, tabId);
  const y = sheetYBlock(std.store, blockId);
  if (!snap || !y || tabKind(snap.tab, snap.columns) !== 'calendar') return [];
  const names = snap.columns.map(c => c.name);
  const col = (f: 'caption' | 'title' | 'format' | 'platforms') => { const i = columnFor(f, names); return i >= 0 ? snap.columns[i] : undefined; };
  const plat = col('platforms');
  if (!plat) return [];
  const cap = col('caption'); const title = col('title'); const fmt = col('format');
  const out: Array<{ row: string; warnings: string[] }> = [];
  for (const r of snap.rows) {
    if (!r.rowId) continue;
    const text = (c?: typeof plat) => (c ? cellText(valueOf(std, y, snap.tab, r, c), c.type) : '');
    const issues = postIssues({ platforms: splitPlatforms(text(plat)), format: text(fmt), caption: text(cap), title: text(title) });
    if (issues.length) out.push({ row: r.rowId, warnings: issues.map(i => i.text) });
    if (out.length >= 40) break;
  }
  return out;
}

type Fail = { ok: false; reason: string; message: string };
const fail = (reason: string, message: string): Fail => ({ ok: false, reason, message });

export const SHEET_READ_BUDGET = 20_000;
const CELL_CAP = 300;

export interface SheetRpcContext {
  board: MountedBoard;
  rev: () => number;
  sheets: () => SheetFocus | null;
}

function sheetIdOf(args: Record<string, unknown>): string {
  return String(args.sheetId ?? args.id ?? args.blockId ?? '').trim();
}

function findTab(sheet: SheetJson, want: unknown): SheetJsonTab | null {
  const w = String(want ?? '').trim();
  if (!w) return sheet.tabs[0] ?? null;
  return sheet.tabs.find(t => t.id === w)
    ?? sheet.tabs.find(t => t.name.toLowerCase() === w.toLowerCase())
    ?? null;
}

function findColumn(tab: SheetJsonTab, want: unknown) {
  const w = String(want ?? '').trim().toLowerCase();
  return tab.columns.find(c => c.id === want) ?? tab.columns.find(c => c.name.toLowerCase() === w) ?? null;
}

/** One line per sheet, for the per-turn digest and the meta catalogue. */
export function sheetCatalogue(board: MountedBoard): Array<{ id: string; title: string; tabs: Array<{ id: string; name: string; rows: number; columns: number; binding?: string }>; rows: number; linked: number }> {
  return listSheetIds(board.std).map(id => {
    const s = readSheet(board.store.doc.spaceDoc, id);
    if (!s) return null;
    const rows = s.tabs.reduce((n, t) => n + t.rows.length, 0);
    const linked = s.tabs.reduce((n, t) => n + t.rows.filter(r => r.link).length, 0);
    return {
      id, title: s.title, rows, linked,
      tabs: s.tabs.map(t => ({ id: t.id, name: t.name, rows: t.rows.length, columns: t.columns.length, ...(t.binding ? { binding: t.binding.kind } : {}) })),
    };
  }).filter((x): x is NonNullable<typeof x> => !!x);
}

function columnBrief(tab: SheetJsonTab) {
  return tab.columns.map(c => ({
    id: c.id, name: c.name, type: c.type,
    ...(c.options?.length ? { choices: c.options.map(o => o.label) } : {}),
    ...(c.multi ? { multi: true } : {}),
    ...(c.bind ? { bind: c.bind } : {}),
    ...(c.hidden ? { hidden: true } : {}),
  }));
}

function totalsOf(tab: SheetJsonTab): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of tab.columns) {
    if (c.hidden || c.type === 'text' || c.type === 'longtext' || c.type === 'url' || c.type === 'media') continue;
    const kind = totalsFor(c.type)[0]!;
    const t = computeTotal(c as never, tab.rows.map(r => r.values[c.id] ?? null), kind);
    if (t) out[c.name] = t;
  }
  return out;
}

function columnSpecs(raw: unknown): ColumnSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c): ColumnSpec | null => {
    if (typeof c === 'string') return { name: c };
    if (!c || typeof c !== 'object') return null;
    const o = c as Record<string, unknown>;
    const type = (COLUMN_TYPES as readonly string[]).includes(String(o.type)) ? (o.type as ColumnType) : 'text';
    return {
      name: String(o.name ?? 'Column'),
      type,
      ...(Array.isArray(o.options) ? { options: o.options as string[] } : Array.isArray(o.choices) ? { options: o.choices as string[] } : {}),
      ...(o.multi === true ? { multi: true } : {}),
      ...(typeof o.width === 'number' ? { width: o.width } : {}),
      ...((SHOT_FIELDS as readonly string[]).includes(String(o.bind)) ? { bind: o.bind as never } : {}),
    };
  }).filter((c): c is ColumnSpec => !!c);
}

function rowsArg(raw: unknown): Array<CellValue[] | Record<string, unknown>> {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return []; } }
  return Array.isArray(raw) ? raw.filter(r => r && typeof r === 'object') as Array<CellValue[] | Record<string, unknown>> : [];
}

/** What a read could not fit, said in a sentence the agent cannot miss. */
function omittedNote(o: { rowsShown: number; from: number; total: number; matched: number; cut: number; cols: string[] }): string {
  const bits: string[] = [];
  const end = o.from + o.rowsShown;
  if (o.rowsShown < o.matched) bits.push(`rows ${o.from + 1}-${end} of ${o.matched}${o.matched !== o.total ? ` matching (of ${o.total})` : ''} — ask again with from=${end} for the next ones`);
  if (o.cols.length) bits.push(`columns not asked for: ${o.cols.slice(0, 12).join(', ')}${o.cols.length > 12 ? ` and ${o.cols.length - 12} more` : ''}`);
  if (o.cut) bits.push(`${o.cut} cell(s) cut at ${CELL_CAP} characters — pass full: true to see them whole`);
  return bits.length ? `YOU HAVE NOT SEEN ALL OF IT: ${bits.join('; ')}. Do not describe the sheet as complete.` : 'The whole tab.';
}

export function sheetHandlers(ctx: SheetRpcContext): Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> {
  const { board } = ctx;
  const doc = () => board.store.doc.spaceDoc;

  const readHandler = (args: Record<string, unknown>) => {
    const id = sheetIdOf(args);
    if (!id) {
      const list = sheetCatalogue(board);
      return {
        ok: true as const, rev: ctx.rev(), sheets: list,
        templates: TEMPLATES.map(t => ({ id: t.id, label: t.label })),
        note: list.length ? `${list.length} sheet(s) on this board. Pass an id (and a tab) to read one.` : 'No sheets on this board yet. sheet_create makes one.',
      };
    }
    const sheet = readSheet(doc(), id);
    if (!sheet) return fail('not_found', 'No sheet with that id is on this board. Call sheet_read with no id for the list.');
    const tab = findTab(sheet, args.tab ?? args.tabId);
    if (!tab) return fail('not_found', `No tab "${String(args.tab ?? args.tabId)}" in this sheet. Tabs: ${sheet.tabs.map(t => t.name).join(', ')}.`);

    if (args.open === true) {
      try { ctx.sheets()?.open(id, tab.id); } catch { /* opening is a courtesy */ }
    }

    // Which columns.
    const askedCols = Array.isArray(args.columns) ? (args.columns as unknown[]).map(c => findColumn(tab, c)).filter(Boolean) as SheetJsonTab['columns'] : null;
    const cols = askedCols?.length ? askedCols : tab.columns.filter(c => !c.hidden);
    const notAsked = tab.columns.filter(c => !c.hidden && !cols.includes(c)).map(c => c.name);

    // Which rows: where (column = value), search, then from/count.
    let rows = tab.rows;
    const where = args.where;
    const conds: Array<[SheetJsonTab['columns'][number], string]> = [];
    if (where && typeof where === 'object' && !Array.isArray(where)) {
      for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
        const c = findColumn(tab, k); if (c) conds.push([c, String(v ?? '').toLowerCase()]);
      }
    } else if (typeof where === 'string' && where.includes('=')) {
      const [k, ...rest] = where.split('=');
      const c = findColumn(tab, k!.trim()); if (c) conds.push([c, rest.join('=').trim().toLowerCase()]);
    }
    if (conds.length) {
      rows = rows.filter(r => conds.every(([c, v]) => {
        const text = cellText(r.values[c.id] ?? null, c.type).toLowerCase();
        return c.multi ? text.split(/\s*,\s*/).includes(v) : text === v;
      }));
    }
    const search = String(args.search ?? '').trim().toLowerCase();
    if (search) rows = rows.filter(r => tab.columns.some(c => cellText(r.values[c.id] ?? null, c.type).toLowerCase().includes(search)));
    const matched = rows.length;
    const from = Math.max(0, Math.floor(Number(args.from) || 0));
    const count = Math.max(1, Math.min(5000, Math.floor(Number(args.count) || 5000)));
    rows = rows.slice(from, from + count);

    const budget = Math.max(2000, Math.min(200_000, Number(args.budget) || SHEET_READ_BUDGET));
    const full = args.full === true;
    let cut = 0;
    const clip = (s: string) => {
      if (full || s.length <= CELL_CAP) return s;
      cut++;
      return `${s.slice(0, CELL_CAP)}…`;
    };
    const header = ['id', ...cols.map(c => c.name.replace(/[\t\n]+/g, ' '))].join('\t');
    const lines = [header];
    let used = header.length;
    let shown = 0;
    for (const r of rows) {
      const line = [r.id + (r.removed ? ' (shot removed)' : ''), ...cols.map(c => clip(cellText(r.values[c.id] ?? null, c.type)).replace(/\t/g, ' ').replace(/\r?\n/g, ' ⏎ '))].join('\t');
      if (used + line.length + 1 > budget && shown > 0) break;
      lines.push(line); used += line.length + 1; shown++;
    }
    const omitted = shown < matched || notAsked.length > 0 || cut > 0;
    return {
      ok: true as const,
      rev: ctx.rev(),
      sheetId: id,
      title: sheet.title,
      tabs: sheet.tabs.map(t => ({ id: t.id, name: t.name, rows: t.rows.length, ...(t.binding ? { binding: t.binding.kind } : {}) })),
      tab: { id: tab.id, name: tab.name, ...(tab.binding ? { binding: tab.binding.kind } : {}) },
      columns: columnBrief(tab),
      totals: totalsOf(tab),
      rows: { from, shown, matched, total: tab.rows.length },
      tsv: lines.join('\n'),
      ...(omitted ? { omitted: { rows: matched - shown, columns: notAsked, cellsCut: cut } } : {}),
      note: `${omittedNote({ rowsShown: shown, from, total: tab.rows.length, matched, cut, cols: notAsked })}`
        + (tab.binding?.kind === 'shots' ? ' This tab IS the shot cards: bound columns (bind) are the cards\' own fields, and a row id starting "~" is a card with no notes yet.' : '')
        + ' Row ids go in sheet_write.',
    };
  };

  const resolveRow = (snapRows: Array<{ key: string }>, raw: unknown): string | null => {
    if (typeof raw === 'number' && Number.isFinite(raw)) return snapRows[Math.floor(raw) - 1]?.key ?? null;
    const s = String(raw ?? '').trim();
    if (/^\d+$/.test(s)) return snapRows[Number(s) - 1]?.key ?? null;
    return snapRows.find(r => r.key === s) ? s : (s.startsWith('~') ? s : null);
  };

  const writeHandler = async (args: Record<string, unknown>) => {
    const id = sheetIdOf(args);
    const y = id ? sheetYBlock(board.store, id) : null;
    if (!y) return fail('not_found', 'No sheet with that id is on this board. Call sheet_read with no id for the list.');
    if (board.store.readonly) return fail('board_readonly', 'This board is open read-only, so the sheet cannot be changed.');
    let ops = args.ops;
    if (typeof ops === 'string') { try { ops = JSON.parse(ops); } catch { ops = []; } }
    if (!Array.isArray(ops) || !ops.length) return fail('empty', 'Send `ops`: a list of operations (set, set_row, add_rows, delete_rows, add_column, update_column, delete_column, add_tab, rename_tab, delete_tab, rename_sheet, move_rows).');
    if (ops.length > 2000) return fail('too_many', 'Send at most 2,000 operations at a time.');

    const problems: string[] = [];
    const conflicts: Array<{ row: string; column: string; now: CellValue }> = [];
    const createdRows: string[] = [];
    const createdColumns: Record<string, string> = {};
    const createdTabs: Record<string, string> = {};
    let applied = 0;
    let tabId = '';
    const pickTab = (want: unknown): string | null => {
      const tabs = readTabs(y);
      const w = String(want ?? '').trim();
      if (!w) return tabId || tabs[0]?.id || null;
      return tabs.find(t => t.id === w)?.id ?? tabs.find(t => t.name.toLowerCase() === w.toLowerCase())?.id ?? createdTabs[w] ?? null;
    };
    tabId = pickTab(args.tab ?? args.tabId) ?? '';
    if (!tabId) return fail('not_found', `No tab "${String(args.tab)}" in this sheet.`);

    let pending: Array<CellWrite & { expect?: unknown }> = [];
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending; pending = [];
      const r = await setCellsPaced(board.std, id, batch);
      applied += r.written;
      const snapCols = readTab(board.std, id, tabId)?.columns ?? [];
      for (const c of r.conflicts) conflicts.push({ row: c.row, column: snapCols.find(x => x.id === c.col)?.name ?? c.col, now: c.now });
    };

    await batchSheet(board.store, async () => {
      for (const raw of ops as Array<Record<string, unknown>>) {
        const op = String(raw?.op ?? raw?.type ?? '').toLowerCase();
        try {
          if (raw?.tab !== undefined && op !== 'add_tab' && op !== 'delete_tab' && op !== 'rename_tab') {
            const t = pickTab(raw.tab); if (!t) { problems.push(`No tab "${String(raw.tab)}".`); continue; }
            if (t !== tabId) { await flush(); tabId = t; }
          }
          const snap = () => readTab(board.std, id, tabId);
          const col = (want: unknown) => {
            const s = snap(); const w = String(want ?? '').trim().toLowerCase();
            return s?.columns.find(c => c.id === want) ?? s?.columns.find(c => c.name.toLowerCase() === w) ?? (createdColumns[String(want)] ? s?.columns.find(c => c.id === createdColumns[String(want)]) : undefined);
          };
          switch (op) {
            case 'set': {
              const s = snap(); const c = col(raw.column ?? raw.col);
              const row = s ? resolveRow(s.rows, raw.row) : null;
              if (!c) { problems.push(`No column "${String(raw.column ?? raw.col)}".`); break; }
              if (!row) { problems.push(`No row "${String(raw.row)}".`); break; }
              pending.push({ row, col: c.id, value: raw.value, ...(raw.expect !== undefined ? { expect: raw.expect } : {}) });
              break;
            }
            case 'set_row': {
              const s = snap(); const row = s ? resolveRow(s.rows, raw.row) : null;
              if (!row) { problems.push(`No row "${String(raw.row)}".`); break; }
              const values = (raw.values && typeof raw.values === 'object') ? raw.values as Record<string, unknown> : {};
              const expect = (raw.expect && typeof raw.expect === 'object') ? raw.expect as Record<string, unknown> : {};
              for (const [k, v] of Object.entries(values)) {
                const c = col(k); if (!c) { problems.push(`No column "${k}".`); continue; }
                pending.push({ row, col: c.id, value: v, ...(k in expect ? { expect: expect[k] } : {}) });
              }
              break;
            }
            case 'add_rows': case 'add_row': {
              await flush();
              const rows = op === 'add_row' ? rowsArg([raw.values ?? raw.row ?? {}]) : rowsArg(raw.rows);
              if (!rows.length) { problems.push('add_rows needs `rows`: a list of {column: value}.'); break; }
              const s = snap();
              const unknown = new Set<string>();
              for (const r of rows) if (!Array.isArray(r)) for (const k of Object.keys(r)) if (!s?.columns.some(c => c.name.toLowerCase() === k.toLowerCase() || c.id === k)) unknown.add(k);
              if (unknown.size) problems.push(`Ignored unknown column(s): ${[...unknown].join(', ')}. Add them with add_column first.`);
              const ids = await appendRowsPaced(board.store, id, tabId, rows, { merge: true });
              if (raw.after) {
                const after = s ? resolveRow(s.rows, raw.after) : null;
                const list = s?.rows ?? [];
                const at = after ? list.findIndex(r => r.key === after) : -1;
                const before = at >= 0 ? list[at + 1]?.key ?? null : null;
                if (after && before !== undefined) moveRows(board.std, id, tabId, ids, before);
              }
              createdRows.push(...ids); applied += ids.length;
              break;
            }
            case 'delete_rows': case 'delete_row': {
              await flush();
              const s = snap();
              const list = (Array.isArray(raw.rows) ? raw.rows : [raw.row]).map(r => (s ? resolveRow(s.rows, r) : null)).filter((r): r is string => !!r);
              if (!list.length) { problems.push('delete_rows: none of those rows exist.'); break; }
              applied += deleteRows(board.std, id, list, { alsoShots: raw.alsoShots === true || raw.deleteShots === true });
              break;
            }
            case 'move_rows': {
              await flush();
              const s = snap();
              const list = (Array.isArray(raw.rows) ? raw.rows : []).map(r => (s ? resolveRow(s.rows, r) : null)).filter((r): r is string => !!r);
              const before = raw.before == null ? null : (s ? resolveRow(s.rows, raw.before) : null);
              moveRows(board.std, id, tabId, list, before);
              applied += list.length;
              break;
            }
            case 'add_column': case 'add_columns': {
              await flush();
              const specs = op === 'add_columns' ? columnSpecs(raw.columns) : columnSpecs([raw]);
              let after = raw.after ? col(raw.after)?.id ?? null : null;
              for (const spec of specs) {
                const cid = addColumn(board.store, id, tabId, spec, after);
                createdColumns[spec.name] = cid; after = cid; applied++;
              }
              break;
            }
            case 'update_column': {
              await flush();
              const c = col(raw.column ?? raw.col ?? raw.name);
              if (!c) { problems.push(`No column "${String(raw.column ?? raw.col)}".`); break; }
              const type = (COLUMN_TYPES as readonly string[]).includes(String(raw.type)) ? raw.type as ColumnType : undefined;
              updateColumn(board.store, id, c.id, {
                ...(typeof raw.rename === 'string' ? { name: raw.rename } : typeof raw.newName === 'string' ? { name: raw.newName } : {}),
                ...(type ? { type } : {}),
                ...(Array.isArray(raw.options) ? { options: raw.options as string[] } : Array.isArray(raw.choices) ? { options: raw.choices as string[] } : {}),
                ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
                ...(typeof raw.hidden === 'boolean' ? { hidden: raw.hidden } : {}),
                ...(typeof raw.multi === 'boolean' ? { multi: raw.multi } : {}),
              });
              applied++;
              break;
            }
            case 'delete_column': {
              await flush();
              const c = col(raw.column ?? raw.col);
              if (!c) { problems.push(`No column "${String(raw.column ?? raw.col)}".`); break; }
              deleteColumn(board.store, id, c.id); applied++;
              break;
            }
            case 'add_tab': {
              await flush();
              const tpl = String(raw.template ?? '') as TemplateId;
              const base: TabSpec = TEMPLATES.some(t => t.id === tpl) ? templateTab(tpl, { rows: Array.isArray(raw.rows) ? 0 : undefined }).tab : { name: 'Sheet', columns: [{ name: 'Name' }] };
              const cols = columnSpecs(raw.columns);
              const spec: TabSpec = { ...base, name: String(raw.name ?? base.name), ...(cols.length ? { columns: cols } : {}), ...(Array.isArray(raw.rows) ? { rows: rowsArg(raw.rows) } : {}) };
              const t = await addTabPaced(board.store, id, spec);
              createdTabs[spec.name] = t; tabId = t; applied++;
              break;
            }
            case 'rename_tab': {
              const t = pickTab(raw.tab); if (!t) { problems.push(`No tab "${String(raw.tab)}".`); break; }
              updateTab(board.store, id, t, { name: String(raw.name ?? '') }); applied++;
              break;
            }
            case 'delete_tab': {
              await flush();
              const t = pickTab(raw.tab); if (!t) { problems.push(`No tab "${String(raw.tab)}".`); break; }
              deleteTab(board.store, id, t); applied++;
              if (t === tabId) tabId = readTabs(y)[0]?.id ?? '';
              break;
            }
            case 'rename_sheet': {
              setTitle(board.store, id, String(raw.title ?? raw.name ?? '')); applied++;
              break;
            }
            default:
              problems.push(`Unknown op "${op}".`);
          }
        } catch (e) {
          problems.push(e instanceof SheetError ? e.message : (e as Error)?.message ?? String(e));
          if (e instanceof SheetError && (e.reason === 'read_only')) break;
        }
      }
      await flush();
    });

    const after = readSheet(doc(), id);
    const tab = after?.tabs.find(t => t.id === tabId) ?? after?.tabs[0];
    const warnings = tab ? calendarWarnings(board.std, id, tab.id) : [];
    return {
      ok: problems.length === 0 || applied > 0,
      rev: ctx.rev(),
      sheetId: id,
      applied,
      ...(createdRows.length ? { createdRows: createdRows.slice(0, 500) } : {}),
      ...(Object.keys(createdColumns).length ? { createdColumns } : {}),
      ...(Object.keys(createdTabs).length ? { createdTabs } : {}),
      ...(conflicts.length ? { conflicts } : {}),
      ...(problems.length ? { problems: problems.slice(0, 40) } : {}),
      ...(warnings.length ? { warnings } : {}),
      tab: tab ? { id: tab.id, name: tab.name, rows: tab.rows.length, columns: columnBrief(tab) } : null,
      note: `${applied} change(s) applied as one undo step.`
        + (warnings.length ? ` ${warnings.length} row(s) have a caption too long for a platform or a format it cannot post (see warnings).` : '')
        + (conflicts.length ? ` ${conflicts.length} cell(s) were NOT written because they changed since you read them — re-read those rows and decide again.` : '')
        + (problems.length ? ` ${problems.length} problem(s) listed in problems.` : ''),
    };
  };

  const createHandler = async (args: Record<string, unknown>) => {
    if (board.store.readonly) return fail('board_readonly', 'This board is open read-only.');
    const { importSheetText, importSheetFile, tableToTab } = await import('./import');
    let title = String(args.title ?? '').trim();
    let tabs: TabSpec[] = [];
    let notes: string[] = [];
    const template = String(args.template ?? '') as TemplateId;

    try {
      if (typeof args.url === 'string' && args.url.trim()) {
        const url = args.url.trim();
        const { fetchMediaBlob } = await import('../board/media-fetch');
        const blob = await fetchMediaBlob(url);
        if (!blob) return fail('fetch_failed', 'That file could not be fetched. Check the link (a Library URL or an https link).');
        if (blob.size > 12 * 1024 * 1024) return fail('too_large', 'That file is over 12 MB, too large to import here.');
        const name = String(args.name ?? '') || decodeURIComponent(url.split('?')[0]!.split('/').pop() || 'sheet.xlsx');
        const res = await importSheetFile(name, new Uint8Array(await blob.arrayBuffer()));
        tabs = res.tabs; notes = res.notes; title ||= res.title;
      } else if (typeof args.csv === 'string' && args.csv.trim()) {
        const res = importSheetText(args.csv, title || 'Imported sheet');
        tabs = res.tabs; notes = res.notes;
      } else if (typeof args.markdown === 'string' && args.markdown.trim()) {
        const res = importSheetText(args.markdown, title || 'Imported sheet');
        tabs = res.tabs; notes = res.notes;
      } else if (args.fromTableId || args.tableId) {
        const tableId = String(args.fromTableId ?? args.tableId);
        const rows = readDocumentTable(board, tableId);
        if (!rows) return fail('not_found', 'No table with that id. Tables live inside documents; document_read shows where.');
        tabs = [tableToTab(title || 'Table', rows)];
      } else if (TEMPLATES.some(t => t.id === template)) {
        const given = rowsArg(args.rows);
        const tpl = templateTab(template, { rows: given.length ? 0 : (typeof args.rows === 'number' ? args.rows : undefined) });
        title ||= tpl.title;
        const cols = columnSpecs(args.columns);
        tabs = [{ ...tpl.tab, ...(args.tabName ? { name: String(args.tabName) } : {}), ...(cols.length ? { columns: [...tpl.tab.columns, ...cols.filter(c => !tpl.tab.columns.some(t => t.name.toLowerCase() === c.name.toLowerCase()))] } : {}), ...(given.length ? { rows: given } : {}) }];
      } else {
        const cols = columnSpecs(args.columns);
        if (!cols.length) return fail('bad_request', `Pass a template (${TEMPLATES.map(t => t.id).join(', ')}), columns (and rows), csv, markdown, url or fromTableId.`);
        tabs = [{ name: String(args.tabName ?? 'Sheet 1'), columns: cols, rows: rowsArg(args.rows) }];
      }
    } catch (e) {
      return fail('failed', (e as Error)?.message ?? 'That could not be read.');
    }
    if (!tabs.length) return fail('empty', 'There was nothing to put in the sheet.');

    // Add as tabs to an existing sheet, or make a new one.
    const into = String(args.intoSheetId ?? args.addToSheetId ?? '').trim();
    let sheetId = into;
    let tabIds: string[] = [];
    try {
      if (into) {
        if (!sheetYBlock(board.store, into)) return fail('not_found', 'No sheet with that id to add tabs to.');
        for (const t of tabs) tabIds.push(await addTabPaced(board.store, into, t));
      } else {
        const made = await createSheetPaced(board.std, board.surfaceId, { title: title || 'Untitled sheet', tabs });
        sheetId = made.blockId; tabIds = made.tabIds;
      }
    } catch (e) {
      return fail(e instanceof SheetError ? e.reason : 'failed', (e as Error)?.message ?? 'The sheet could not be made.');
    }
    if (args.open !== false) { try { ctx.sheets()?.open(sheetId, tabIds[0]); } catch { /* courtesy */ } }
    const sheet = readSheet(doc(), sheetId);
    return {
      ok: true as const,
      rev: ctx.rev(),
      sheetId,
      title: sheet?.title,
      tabs: sheet?.tabs.filter(t => tabIds.includes(t.id)).map(t => ({ id: t.id, name: t.name, rows: t.rows.length, columns: columnBrief(t) })),
      ...(notes.length ? { notKept: notes } : {}),
      note: `${into ? 'Added to the sheet' : 'Sheet made'}${args.open !== false ? ' and opened for the person' : ''}.`
        + (notes.length ? ` Tell the person what was not kept: ${notes.join(', ')}.` : '')
        + ' Use sheet_write with these column names to fill it, and sheet_read to check it.',
    };
  };

  const toCardsHandler = async (args: Record<string, unknown>) => {
    const id = sheetIdOf(args);
    const sheet = id ? readSheet(doc(), id) : null;
    if (!sheet) return fail('not_found', 'No sheet with that id is on this board.');
    const tab = findTab(sheet, args.tab ?? args.tabId);
    if (!tab) return fail('not_found', 'No such tab.');
    const target = String(args.target ?? 'shots');
    if (target !== 'shots') return fail('not_yet', 'Only shot cards can be made from rows on this board for now. Episode boards come with the series plan.');
    const rows = Array.isArray(args.rows) ? (args.rows as unknown[]).map(r => {
      const s = String(r);
      return /^\d+$/.test(s) ? tab.rows[Number(s) - 1]?.id : s;
    }).filter((r): r is string => !!r) : undefined;
    const { makeCardsFromRows } = await import('./to-cards');
    try {
      const r = makeCardsFromRows(board.std, board.surfaceId, id, tab.id, rows);
      return { ok: true as const, rev: ctx.rev(), ...r };
    } catch (e) {
      return fail(e instanceof SheetError ? e.reason : 'failed', (e as Error)?.message ?? String(e));
    }
  };

  const exportHandler = async (args: Record<string, unknown>) => {
    const id = sheetIdOf(args);
    if (!id || !sheetYBlock(board.store, id)) return fail('not_found', 'No sheet with that id is on this board.');
    const format = String(args.format ?? 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
    const sheet = readSheet(doc(), id)!;
    const tab = args.tab || args.tabId || format === 'csv' ? findTab(sheet, args.tab ?? args.tabId) : null;
    if ((args.tab || args.tabId) && !tab) return fail('not_found', 'No such tab.');
    const { buildSheetFile, saveBlob } = await import('./focus');
    let made;
    try { made = await buildSheetFile(board, id, format, tab?.id); } catch (e) { return fail('failed', (e as Error)?.message ?? 'The file could not be made.'); }
    if (args.download !== false) saveBlob(made.blob, made.fileName);
    let url: string | undefined;
    let shareNote = '';
    if (args.upload === true) {
      try {
        const { uploadDocument } = await import('../board/document-export');
        ({ url } = await uploadDocument({ blob: made.blob, fileName: made.fileName, format: 'md', bytes: made.bytes } as never));
      } catch (e) {
        shareNote = ` It could not be uploaded, so there is no link — ${(e as Error)?.message ?? 'unknown error'}.`;
      }
    }
    return {
      ok: true as const, rev: ctx.rev(), fileName: made.fileName, format, bytes: made.bytes, tabs: made.tabs, rows: made.rows,
      ...(url ? { url } : {}),
      note: `${args.download !== false ? `Saved as ${made.fileName} in their Downloads.` : `Made ${made.fileName}.`}${url ? ' Uploaded; the link is in url.' : ''}${shareNote}`,
    };
  };

  return {
    'voidspace:board-sheet-read': readHandler,
    'voidspace:board-sheet-write': writeHandler,
    'voidspace:board-sheet-create': createHandler,
    'voidspace:board-sheet-to-cards': toCardsHandler,
    'voidspace:board-sheet-export': exportHandler,
  };
}

/** An `affine:table` inside a document, as rows of text (header first). */
export function readDocumentTable(board: MountedBoard, tableId: string): CellValue[][] | null {
  const block = board.store.getBlock(tableId);
  if (!block || block.flavour !== 'affine:table') return null;
  const p = block.model.props as unknown as {
    rows: Record<string, { rowId: string; order: string }>;
    columns: Record<string, { columnId: string; order: string }>;
    cells: Record<string, { text?: { toString(): string } }>;
  };
  const byOrder = <T extends { order: string }>(a: T, b: T) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
  const rows = Object.values(p.rows ?? {}).sort(byOrder);
  const cols = Object.values(p.columns ?? {}).sort(byOrder);
  return rows.map(r => cols.map(c => {
    const t = p.cells?.[`${r.rowId}:${c.columnId}`]?.text;
    const s = t ? String(t.toString()) : '';
    return s === '[object Object]' ? '' : s;
  }));
}

/** Every table inside the documents on this board (for "Convert table to sheet"). */
export function documentTables(board: MountedBoard, noteId?: string): Array<{ tableId: string; noteId: string; rows: number; columns: number }> {
  const out: Array<{ tableId: string; noteId: string; rows: number; columns: number }> = [];
  for (const b of board.store.getBlocksByFlavour('affine:table')) {
    let parent = board.store.getParent(b.id);
    while (parent && parent.flavour !== 'affine:note') parent = board.store.getParent(parent.id);
    if (!parent || (noteId && parent.id !== noteId)) continue;
    const p = b.model.props as unknown as { rows?: object; columns?: object };
    out.push({ tableId: b.id, noteId: parent.id, rows: Object.keys(p.rows ?? {}).length, columns: Object.keys(p.columns ?? {}).length });
  }
  return out;
}
