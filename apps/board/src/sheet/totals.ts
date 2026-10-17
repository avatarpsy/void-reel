/**
 * Footer totals — v1's answer to "where are the formulas".
 *
 * Planning a season or a month of posts needs a handful of numbers: how many,
 * how long altogether, how many are posted, when it starts and ends. Each
 * column type gets the totals that make sense for it; the footer shows one and
 * a click picks another. Formulas come later (SHEETS_PLAN.md).
 */
import type { CellValue, ColumnType, SheetColumn } from './sheet-data';
import { formatDuration } from './sheet-data';
import { prettyDateShort } from './format';

export type TotalKind = 'none' | 'filled' | 'count' | 'sum' | 'average' | 'min' | 'max' | 'range' | 'checked' | 'byChoice';

export const TOTAL_LABEL: Record<TotalKind, string> = {
  none: 'No total', filled: 'Filled', count: 'Rows', sum: 'Sum', average: 'Average',
  min: 'Smallest', max: 'Largest', range: 'Earliest to latest', checked: 'Checked', byChoice: 'Count each',
};

export function totalsFor(type: ColumnType): TotalKind[] {
  switch (type) {
    case 'number': return ['sum', 'average', 'min', 'max', 'filled', 'none'];
    case 'duration': return ['sum', 'average', 'max', 'filled', 'none'];
    case 'date': case 'time': return ['range', 'filled', 'none'];
    case 'status': return ['byChoice', 'filled', 'none'];
    case 'checkbox': return ['checked', 'none'];
    default: return ['filled', 'count', 'none'];
  }
}

function fmtNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en') : n.toLocaleString('en', { maximumFractionDigits: 2 });
}

/** The footer text for one column. */
export function computeTotal(col: SheetColumn, values: CellValue[], kind: TotalKind): string {
  const filled = values.filter(v => v !== null && v !== '');
  const nums = filled.filter((v): v is number => typeof v === 'number');
  const show = (n: number) => (col.type === 'duration' ? formatDuration(n) : fmtNumber(n));
  switch (kind) {
    case 'none': return '';
    case 'count': return `${values.length} rows`;
    case 'filled': return `${filled.length} of ${values.length} filled`;
    case 'sum': return nums.length ? `Sum ${show(nums.reduce((a, b) => a + b, 0))}` : '';
    case 'average': return nums.length ? `Avg ${show(nums.reduce((a, b) => a + b, 0) / nums.length)}` : '';
    case 'min': return nums.length ? `Min ${show(Math.min(...nums))}` : '';
    case 'max': return nums.length ? `Max ${show(Math.max(...nums))}` : '';
    case 'checked': return `${values.filter(v => v === true).length} of ${values.length} checked`;
    case 'range': {
      const s = filled.map(String).filter(v => /^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}$/.test(v)).sort();
      if (!s.length) return '';
      const show = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? prettyDateShort(v).replace(/^\w+ /, '') : v);
      return s[0] === s.at(-1) ? show(s[0]!) : `${show(s[0]!)} – ${show(s.at(-1)!)}`;
    }
    case 'byChoice': {
      const counts = new Map<string, number>();
      for (const v of filled) for (const part of String(v).split(/\s*,\s*/)) if (part) counts.set(part, (counts.get(part) ?? 0) + 1);
      const order = col.options?.map(o => o.label) ?? [];
      return [...counts].sort((a, b) => {
        const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0]);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || b[1] - a[1];
      }).map(([k, n]) => `${k} ${n}`).join(' · ');
    }
  }
}
