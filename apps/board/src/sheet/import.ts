/**
 * A file (or a table of text) becomes sheet tabs.
 *
 * One door for .xlsx, .csv, .tsv and markdown tables: each is turned into rows
 * of values with a header row, and `tableToTab` decides each column's type
 * from what is actually in it. What could not be kept is collected as plain
 * words for the "what was not kept" note, the same promise `document/import.ts`
 * makes for Word files.
 */
import type { CellValue, ColumnType } from './sheet-data';
import { SHEET_LIMITS } from './sheet-data';
import type { ColumnSpec, TabSpec } from './ops';
import { DEFAULT_WIDTH, parseBool, parseDate, parseDuration, parseNumber, parseTime } from './ops';
import { parseDelimited, parseMarkdownTable } from './csv';

export interface ImportResult {
  title: string;
  tabs: TabSpec[];
  /** Plain words: what did not survive the trip. Empty when everything did. */
  notes: string[];
  rows: number;
}

interface Hints {
  formats?: Array<'date' | 'time' | 'duration' | undefined>;
  widths?: number[];
  choices?: Array<string[] | undefined>;
}

const URL_RE = /^https?:\/\/\S+$/i;

function inferType(values: CellValue[], hint: Hints, j: number): { type: ColumnType; options?: string[]; multi?: boolean } {
  const vals = values.filter(v => v !== null && v !== '');
  const fmt = hint.formats?.[j];
  const listed = hint.choices?.[j];
  // A TRUE/FALSE dropdown is a checkbox (it is how we export one).
  if (listed?.length && listed.every(c => /^(true|false)$/i.test(c))) return { type: 'checkbox' };
  if (listed?.length) return { type: 'status', options: listed };
  if (!vals.length) return { type: fmt ?? 'text' };
  if (fmt) return { type: fmt };
  const every = (fn: (v: CellValue) => boolean) => vals.every(fn);
  const s = (v: CellValue) => String(v).trim();
  if (every(v => typeof v === 'boolean' || /^(true|false)$/i.test(s(v)))) return { type: 'checkbox' };
  if (every(v => typeof v === 'number' || parseNumber(s(v)) !== null)) return { type: 'number' };
  if (every(v => typeof v === 'string' && /[-/.\s]/.test(v) && parseDate(v) !== null)) return { type: 'date' };
  if (every(v => typeof v === 'string' && parseTime(v) !== null)) return { type: 'time' };
  if (every(v => typeof v === 'string' && /^\d+:\d{2}(:\d{2})?$/.test(v.trim()) && parseDuration(v) !== null)) return { type: 'duration' };
  if (every(v => URL_RE.test(s(v)))) return { type: 'url' };
  if (vals.some(v => typeof v === 'string' && (v.length > 80 || v.includes('\n')))) return { type: 'longtext' };
  const distinct = new Set(vals.map(v => s(v)));
  if (vals.length >= 6 && distinct.size <= 8 && distinct.size <= vals.length / 2 && [...distinct].every(d => d.length <= 24 && !d.includes(','))) {
    return { type: 'status', options: [...distinct] };
  }
  return { type: 'text' };
}

function widthFor(type: ColumnType, name: string, values: CellValue[], hinted?: number): number {
  if (hinted && hinted > 20) return Math.max(70, Math.min(480, hinted));
  const longest = values.slice(0, 200).reduce((n: number, v) => Math.max(n, String(v ?? '').split('\n')[0]!.length), name.length);
  const est = Math.round(longest * 7.2 + 28);
  return Math.max(Math.min(DEFAULT_WIDTH[type], 120), Math.min(type === 'longtext' ? 360 : 300, est));
}

/**
 * Rows (header first) as a tab. Cuts at the caps and says so in `notes`.
 */
export function tableToTab(name: string, table: CellValue[][], hints: Hints = {}, notes: string[] = []): TabSpec {
  const header = table[0] ?? [];
  let body = table.slice(1);
  let width = Math.max(header.length, ...body.slice(0, 2000).map(r => r.length), 1);
  if (width > SHEET_LIMITS.columns) {
    notes.push(`only the first ${SHEET_LIMITS.columns} columns of "${name}"`);
    width = SHEET_LIMITS.columns;
  }
  if (body.length > SHEET_LIMITS.rowsPerTab) {
    notes.push(`rows after ${SHEET_LIMITS.rowsPerTab.toLocaleString('en')} in "${name}"`);
    body = body.slice(0, SHEET_LIMITS.rowsPerTab);
  }
  const used = new Set<string>();
  const columns: ColumnSpec[] = [];
  for (let j = 0; j < width; j++) {
    let colName = String(header[j] ?? '').replace(/\s+/g, ' ').trim() || `Column ${j + 1}`;
    let k = 2;
    while (used.has(colName.toLowerCase())) colName = `${String(header[j] ?? '').trim() || 'Column'} ${k++}`;
    used.add(colName.toLowerCase());
    const values = body.map(r => r[j] ?? null);
    const t = inferType(values, hints, j);
    columns.push({
      name: colName.slice(0, 120),
      type: t.type,
      width: widthFor(t.type, colName, values, hints.widths?.[j]),
      ...(t.options ? { options: t.options } : {}),
    });
  }
  const rows = body.map(r => {
    const out: CellValue[] = [];
    for (let j = 0; j < width; j++) {
      const v = r[j] ?? null;
      out.push(columns[j]!.type === 'checkbox' ? (v === null ? null : parseBool(v)) : v);
    }
    return out;
  }).filter(r => r.some(v => v !== null && v !== ''));
  return { name: name.slice(0, 80) || 'Sheet 1', columns, rows };
}

function baseName(fileName: string): string {
  return fileName.replace(/\.(xlsx|xlsm|csv|tsv|txt)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Imported sheet';
}

/** A file's bytes as sheet tabs. Throws plain-English errors. */
export async function importSheetFile(fileName: string, bytes: Uint8Array): Promise<ImportResult> {
  const notes: string[] = [];
  if (/\.xls$/i.test(fileName)) throw new Error('Old .xls files cannot be read. Save it as .xlsx in Excel (File, Save As) and try again.');
  if (/\.(xlsx|xlsm)$/i.test(fileName) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const { readXlsx } = await import('./xlsx');
    const wb = await readXlsx(bytes);
    notes.push(...wb.notes);
    let tables = wb.tables.filter(t => t.rows.length);
    if (!tables.length) throw new Error('That workbook has no cells with anything in them.');
    if (tables.length > SHEET_LIMITS.tabs) { notes.push(`tabs after the first ${SHEET_LIMITS.tabs}`); tables = tables.slice(0, SHEET_LIMITS.tabs); }
    const tabs = tables.map(t => tableToTab(t.name, t.rows, { formats: t.formats, widths: t.widths, choices: t.choices }, notes));
    return { title: baseName(fileName), tabs, notes, rows: tabs.reduce((n, t) => n + (t.rows?.length ?? 0), 0) };
  }
  const text = new TextDecoder().decode(bytes);
  return importSheetText(text, baseName(fileName), /\.tsv$/i.test(fileName) ? '\t' : undefined);
}

/** CSV, TSV or a markdown table, as one tab. */
export function importSheetText(text: string, title = 'Imported sheet', delimiter?: string): ImportResult {
  const notes: string[] = [];
  const md = /^\s*\|.*\|\s*$/m.test(text) ? parseMarkdownTable(text) : null;
  const rows = md ?? parseDelimited(text, delimiter);
  if (!rows.length) throw new Error('There is nothing to import: the table is empty.');
  const tab = tableToTab(title.slice(0, 80) || 'Sheet 1', rows, {}, notes);
  return { title, tabs: [tab], notes, rows: tab.rows?.length ?? 0 };
}

/** The note shown after an import, in one plain sentence. */
export function importNote(name: string, result: ImportResult): string {
  const got = `${result.rows.toLocaleString('en')} row${result.rows === 1 ? '' : 's'}`;
  return result.notes.length
    ? `Imported ${name} (${got}). Not kept: ${result.notes.join(', ')}.`
    : `Imported ${name} (${got}).`;
}
