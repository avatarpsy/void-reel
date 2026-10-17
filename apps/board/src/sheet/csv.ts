/**
 * CSV and TSV, both ways — RFC 4180, no dependency.
 *
 * Pasting from Google Sheets or Excel puts TSV on the clipboard (quoted when a
 * cell holds a tab, a newline or a quote), so one parser serves files and the
 * clipboard alike.
 */

/** Guess the delimiter from the first line: tab, then semicolon, then comma. */
export function sniffDelimiter(text: string): '\t' | ',' | ';' {
  const first = text.slice(0, 4096).split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => first.split(ch).length - 1;
  const tabs = count('\t'); const semis = count(';'); const commas = count(',');
  if (tabs > 0 && tabs >= commas) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/** Rows of fields. Quoted fields may hold the delimiter, newlines and "" quotes. */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const d = delimiter ?? sniffDelimiter(text);
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let fieldStart = true;
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && fieldStart) { quoted = true; fieldStart = false; i++; continue; }
    if (ch === d) { row.push(field); field = ''; fieldStart = true; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; fieldStart = true;
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; fieldStart = false; i++;
  }
  if (field !== '' || row.length || !fieldStart) { row.push(field); rows.push(row); }
  // A trailing newline is not an empty last row.
  while (rows.length && rows.at(-1)!.every(f => f === '')) rows.pop();
  return rows;
}

function quote(field: string, d: string): string {
  return /["\r\n]/.test(field) || field.includes(d) || /^\s|\s$/.test(field)
    ? `"${field.replace(/"/g, '""')}"`
    : field;
}

/** Rows as CSV (or TSV with `delimiter: '\t'`). CRLF line ends, as RFC 4180 says. */
export function toDelimited(rows: string[][], delimiter = ','): string {
  return rows.map(r => r.map(f => quote(f, delimiter)).join(delimiter)).join('\r\n');
}

/** A markdown table as rows (header first). Null when there is no table. */
export function parseMarkdownTable(md: string): string[][] | null {
  const lines = md.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('|') || /\|/.test(l));
  const rows: string[][] = [];
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const inner = line.replace(/^\|/, '').replace(/\|$/, '');
    const cells = inner.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue; // the separator row
    rows.push(cells);
  }
  return rows.length >= 1 ? rows : null;
}
