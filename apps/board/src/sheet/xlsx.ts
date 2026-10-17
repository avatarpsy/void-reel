/**
 * .xlsx — our own reader and writer, on our own zip code.
 *
 * Same pattern as `document/docx-import.ts`: a workbook is a zip of XML, and we
 * need its values, types, tab names, column widths and dropdown lists — not a
 * styling engine. SheetJS and ExcelJS are each around a megabyte for that.
 *
 * What survives: values and their types (number, date, time, true/false,
 * text), tab names, column order and widths, the header row, status choices
 * (as dropdown lists), links. What does not, and the importer says so:
 * formulas (their last values are kept), merged cells (the value stays in the
 * top-left cell), colours and fonts, charts, pictures, comments, pivot tables.
 */
import type { CellValue, ColumnType, SheetJsonTab } from './sheet-data';
import { readZipMap } from '../document/zip';
import { writeZip } from './zip-write';

// ══ READING ══════════════════════════════════════════════════════════════════

export interface ImportedTable {
  name: string;
  /** Every row including the header row, as typed values. */
  rows: CellValue[][];
  /** Per column: the type the cells' own formats say (date/time), else undefined. */
  formats: Array<'date' | 'time' | 'duration' | undefined>;
  /** Per column width in pixels, when the file says. */
  widths: number[];
  /** Per column dropdown choices from data validation, when the file has them. */
  choices: Array<string[] | undefined>;
}

export interface ImportedWorkbook { tables: ImportedTable[]; notes: string[] }

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function parseXml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  return doc;
}

/** Elements by local name, whatever prefix the file used. */
function all(root: Document | Element, local: string): Element[] {
  const byNs = root.getElementsByTagNameNS(NS_MAIN, local);
  if (byNs.length) return [...byNs];
  return [...root.getElementsByTagName(local)].concat(
    [...root.getElementsByTagName(`x:${local}`)],
  );
}

function kids(el: Element, local: string): Element[] {
  return [...el.children].filter(c => c.localName === local);
}

function textOf(el: Element | undefined): string {
  if (!el) return '';
  // <si>/<is>: plain <t>, or rich runs <r><t>; phonetic <rPh> is not text.
  const ts = [...el.getElementsByTagName('*')].filter(e => e.localName === 't' && e.parentElement?.localName !== 'rPh');
  if (!ts.length) return el.textContent ?? '';
  return ts.map(t => t.textContent ?? '').join('');
}

/** "C12" -> [col 2, row 11], zero-based. */
export function parseRef(ref: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.replace(/\$/g, ''));
  if (!m) return [0, 0];
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [col - 1, Number(m[2]) - 1];
}

export function colName(i: number): string {
  let s = ''; let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 47]);
const BUILTIN_DURATION = new Set([46]);

function formatKind(code: string): 'date' | 'time' | 'duration' | undefined {
  const s = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, '').toLowerCase();
  if (/\[h+\]|\[m+\]|\[s+\]/.test(s)) return 'duration';
  const hasDate = /[dy]/.test(s) || /m{3,}/.test(s);
  const hasTime = /h/.test(s) || /s/.test(s.replace(/am\/pm|a\/p/g, ''));
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return undefined;
}

export async function readXlsx(bytes: Uint8Array): Promise<ImportedWorkbook> {
  const files = await readZipMap(bytes, n => n.endsWith('.xml') || n.endsWith('.rels'));
  const notes = new Set<string>();
  const wb = parseXml(files.get('xl/workbook.xml'));
  if (!wb) throw new Error('That file is not an Excel workbook (.xlsx).');

  const rels = new Map<string, string>();
  const relDoc = parseXml(files.get('xl/_rels/workbook.xml.rels'));
  for (const r of relDoc ? [...relDoc.getElementsByTagName('Relationship')] : []) {
    rels.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '');
  }

  const shared: string[] = [];
  const ss = parseXml(files.get('xl/sharedStrings.xml'));
  if (ss) for (const si of all(ss, 'si')) shared.push(textOf(si));

  // Which style index is a date, a time or a duration.
  const styleKind: Array<'date' | 'time' | 'duration' | undefined> = [];
  const styles = parseXml(files.get('xl/styles.xml'));
  if (styles) {
    const custom = new Map<number, string>();
    for (const nf of all(styles, 'numFmt')) custom.set(Number(nf.getAttribute('numFmtId')), nf.getAttribute('formatCode') ?? '');
    const xfsRoot = all(styles, 'cellXfs')[0];
    for (const xf of xfsRoot ? kids(xfsRoot, 'xf') : []) {
      const id = Number(xf.getAttribute('numFmtId') ?? 0);
      styleKind.push(
        BUILTIN_DATE.has(id) ? 'date' : BUILTIN_TIME.has(id) ? 'time' : BUILTIN_DURATION.has(id) ? 'duration'
          : custom.has(id) ? formatKind(custom.get(id)!) : undefined,
      );
    }
  }

  if ([...files.keys()].some(n => n.startsWith('xl/charts/'))) notes.add('charts');
  if ([...files.keys()].some(n => n.startsWith('xl/drawings/'))) notes.add('pictures and drawings');
  if ([...files.keys()].some(n => /xl\/comments\d*\.xml|threadedComments/.test(n))) notes.add('comments');
  if ([...files.keys()].some(n => n.startsWith('xl/pivotTables/'))) notes.add('pivot tables');

  const tables: ImportedTable[] = [];
  for (const sheet of all(wb, 'sheet')) {
    const name = sheet.getAttribute('name') ?? `Sheet ${tables.length + 1}`;
    const rid = sheet.getAttribute('r:id') ?? sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? '';
    let target = rels.get(rid) ?? '';
    if (!target) continue;
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const ws = parseXml(files.get(target));
    if (!ws) continue;

    const rows: CellValue[][] = [];
    const formats: ImportedTable['formats'] = [];
    let formulas = 0;
    for (const row of all(ws, 'row')) {
      const rIdx = Number(row.getAttribute('r') ?? rows.length + 1) - 1;
      let cIdx = 0;
      for (const c of kids(row, 'c')) {
        const ref = c.getAttribute('r');
        if (ref) cIdx = parseRef(ref)[0];
        const t = c.getAttribute('t') ?? 'n';
        const s = Number(c.getAttribute('s') ?? 0);
        const v = kids(c, 'v')[0]?.textContent ?? '';
        if (kids(c, 'f').length) formulas++;
        let value: CellValue = null;
        if (t === 's') value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = textOf(kids(c, 'is')[0]);
        else if (t === 'str') value = v;
        else if (t === 'b') value = v === '1';
        else if (t === 'e') value = null;
        else if (v !== '') {
          const n = Number(v);
          const kind = styleKind[s];
          if (Number.isFinite(n) && kind) {
            if (rIdx > 0) formats[cIdx] = formats[cIdx] ?? kind;
            value = kind === 'date' ? serialToDate(n) : kind === 'time' ? fractionToTime(n) : Math.round(n * 86400);
          } else value = Number.isFinite(n) ? n : v;
        }
        if (value !== null && value !== '') {
          (rows[rIdx] ??= [])[cIdx] = value;
        }
        cIdx++;
      }
    }
    // Holes as nulls, so every row is a plain array.
    const width = rows.reduce((n, r) => Math.max(n, r?.length ?? 0), 0);
    const dense = Array.from({ length: rows.length }, (_, i) => Array.from({ length: width }, (_, j) => rows[i]?.[j] ?? null));
    while (dense.length && dense.at(-1)!.every(v => v === null)) dense.pop();
    if (formulas) notes.add('formulas (their last values were kept)');

    const widths: number[] = [];
    for (const col of all(ws, 'col')) {
      const min = Number(col.getAttribute('min') ?? 1); const max = Math.min(Number(col.getAttribute('max') ?? min), min + 200);
      const w = Number(col.getAttribute('width') ?? 0);
      if (w > 0) for (let i = min; i <= max; i++) widths[i - 1] = Math.round(w * 7 + 5);
    }
    if (all(ws, 'mergeCell').length) notes.add('merged cells (each value stays in its top-left cell)');
    if (all(ws, 'conditionalFormatting').length) notes.add('colours and fonts');

    const choices: ImportedTable['choices'] = [];
    for (const dv of all(ws, 'dataValidation')) {
      if (dv.getAttribute('type') !== 'list') continue;
      const f = kids(dv, 'formula1')[0]?.textContent ?? '';
      const m = /^"(.*)"$/.exec(f.trim());
      if (!m) continue;
      const list = m[1]!.split(',').map(x => x.trim()).filter(Boolean);
      for (const range of (dv.getAttribute('sqref') ?? '').split(/\s+/)) {
        const [from] = range.split(':');
        if (from) choices[parseRef(from)[0]] = list;
      }
    }
    tables.push({ name, rows: dense, formats, widths, choices });
  }
  // Colours: a fill beyond the two every file has and our own header fill, or
  // a coloured font. (Our own export uses exactly that one fill and no colour.)
  if (styles && (all(styles, 'fill').length > 3 || all(styles, 'font').some(f => kids(f, 'color').some(c => (c.getAttribute('rgb') ?? '').toUpperCase() !== 'FF000000' && !c.hasAttribute('theme'))))) notes.add('colours and fonts');
  return { tables, notes: [...notes] };
}

const pad = (n: number) => String(n).padStart(2, '0');

function serialToDate(n: number): string {
  // 1900 system. 25569 = days from 1899-12-30 to 1970-01-01.
  const d = new Date(Math.round((n - 25569) * 86400000));
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const frac = n - Math.floor(n);
  return frac > 1e-6 ? `${day} ${fractionToTime(frac)}` : day;
}

function fractionToTime(n: number): string {
  const mins = Math.round((n - Math.floor(n)) * 1440);
  return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
}

// ══ WRITING ══════════════════════════════════════════════════════════════════

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 cannot carry most control characters at all.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** Excel's sheet-name rules: 31 characters, none of []:*?/\, unique. */
function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let base = (raw || `Sheet ${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet ${i + 1}`;
    let name = base; let n = 2;
    while (used.has(name.toLowerCase())) { const suffix = ` (${n++})`; name = base.slice(0, 31 - suffix.length) + suffix; }
    used.add(name.toLowerCase());
    base = name;
    return base;
  });
}

function dateSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0));
  return ms / 86400000 + 25569;
}

function timeFraction(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? (+m[1]! * 60 + +m[2]!) / 1440 : null;
}

/** Styles: 0 normal, 1 header, 2 date, 3 time, 4 duration, 5 wrapped text. */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS_MAIN}">
<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="hh:mm"/><numFmt numFmtId="166" formatCode="[h]:mm:ss"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** A link cell as a title and (when it opens somewhere) a web address. */
export type LinkResolver = (value: string) => { text: string; url?: string } | null;

function sheetXml(tab: SheetJsonTab, resolveLink?: LinkResolver): { xml: string; links: string[] } {
  const cols = tab.columns.filter(c => !c.hidden);
  const lines: string[] = [];
  const links: Array<{ ref: string; url: string }> = [];
  const lastCol = colName(Math.max(0, cols.length - 1));
  const lastRow = tab.rows.length + 1;
  const frozen = Math.min(tab.frozen ?? 1, cols.length - 1);

  const cell = (ref: string, v: CellValue, type: ColumnType): string => {
    if (v === null || v === '') return '';
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    if (type === 'date' && typeof v === 'string') {
      const n = dateSerial(v);
      if (n !== null) return `<c r="${ref}" s="2"><v>${n}</v></c>`;
    }
    if (type === 'time' && typeof v === 'string') {
      const n = timeFraction(v);
      if (n !== null) return `<c r="${ref}" s="3"><v>${n}</v></c>`;
    }
    if (type === 'duration' && typeof v === 'number') return `<c r="${ref}" s="4"><v>${v / 86400}</v></c>`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    let s = String(v);
    if (type === 'url' && /^https?:\/\//i.test(s)) links.push({ ref, url: s });
    if (type === 'link' && resolveLink) {
      // A document link: its title, clickable in Excel.
      const r = resolveLink(s);
      if (r) { s = r.text; if (r.url) links.push({ ref, url: r.url }); }
    }
    const style = type === 'longtext' ? ' s="5"' : '';
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
  };

  lines.push(`<row r="1">${cols.map((c, j) => `<c r="${colName(j)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${esc(c.name)}</t></is></c>`).join('')}</row>`);
  tab.rows.forEach((r, i) => {
    const n = i + 2;
    lines.push(`<row r="${n}">${cols.map((c, j) => cell(`${colName(j)}${n}`, r.values[c.id] ?? null, c.type)).join('')}</row>`);
  });

  const pane = frozen > 0
    ? `<pane xSplit="${frozen}" ySplit="1" topLeftCell="${colName(frozen)}2" activePane="bottomRight" state="frozen"/><selection pane="bottomRight"/>`
    : `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>`;
  const widths = cols.map((c, j) => `<col min="${j + 1}" max="${j + 1}" width="${Math.max(6, Math.round(((c.width - 5) / 7) * 10) / 10)}" customWidth="1"/>`).join('');
  const validations = cols.flatMap((c, j) => {
    if (c.type === 'status' && c.options?.length && !c.multi) {
      const list = c.options.map(o => o.label.replace(/[",]/g, ' ')).join(',');
      if (list.length > 250) return [];
      return [`<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${colName(j)}2:${colName(j)}${Math.max(lastRow, 1000)}"><formula1>"${esc(list)}"</formula1></dataValidation>`];
    }
    if (c.type === 'checkbox') {
      return [`<dataValidation type="list" allowBlank="1" sqref="${colName(j)}2:${colName(j)}${Math.max(lastRow, 1000)}"><formula1>"TRUE,FALSE"</formula1></dataValidation>`];
    }
    return [];
  });

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS_MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${widths ? `<cols>${widths}</cols>` : ''}
<sheetData>${lines.join('')}</sheetData>
<autoFilter ref="A1:${lastCol}${lastRow}"/>
${validations.length ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>` : ''}
${links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>` : ''}
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
  return { xml, links: links.map(l => l.url) };
}

/** A workbook from the sheet's tabs. Returns the file's bytes. */
export async function writeXlsx(tabs: SheetJsonTab[], title = 'Sheet', resolveLink?: LinkResolver): Promise<Uint8Array> {
  const names = sheetNames(tabs.map(t => t.name));
  const files: Array<{ name: string; data: string }> = [];
  const sheetEntries: string[] = [];
  tabs.forEach((tab, i) => {
    const { xml, links } = sheetXml(tab, resolveLink);
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml });
    if (links.length) {
      files.push({
        name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((u, j) => `<Relationship Id="rId${j + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(u)}" TargetMode="External"/>`).join('')}</Relationships>`,
      });
    }
    sheetEntries.push(`<sheet name="${esc(names[i]!)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`);
  });
  const definedNames = tabs.map((t, i) => {
    const cols = t.columns.filter(c => !c.hidden).length;
    return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i]!.replace(/'/g, "''"))}'!$A$1:$${colName(Math.max(0, cols - 1))}$${t.rows.length + 1}</definedName>`;
  }).join('');

  const head = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
${tabs.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Voidspace</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS_MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${sheetEntries.join('')}</sheets>
<definedNames>${definedNames}</definedNames>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${tabs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${tabs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ];
  return writeZip([...head, ...files]);
}
