/**
 * "Make cards from rows" — rows become shot cards on the board.
 *
 * Through the existing add-shots path (`createShots`), so placement follows
 * the board's own layout (the filmstrip grid, `shot/layout.ts`). It ONLY ADDS:
 * a row that already has a card is skipped, nothing is removed or reordered —
 * the same promise as "Send to editor".
 *
 * Which column fills which field: on a shot list tab, the bound columns; on any
 * other tab, the column names say (Title / Hook / Shot -> title, Action /
 * Description / Caption -> action, Voiceover / Narration -> voiceover,
 * a duration column -> length, Scene -> scene when it names a real scene).
 */
import type { BlockStdScope } from '@blocksuite/std';

import { type CellValue, type DisplayRow, type SheetColumn, cellText } from './sheet-data';
import { SheetError, readTab, sheetYBlock, transactSheet, valueOf } from './ops';
import { createShots, readShots, relayoutShots } from '../shot/shots';
import { readParsed } from '../shot/screenplay-doc';
import * as Y from 'yjs';

type Field = 'title' | 'action' | 'voiceover' | 'durationSec' | 'sceneKey' | 'model';

const BY_NAME: Array<[Field, RegExp]> = [
  ['title', /^(title|shot|shot title|name|hook|headline|episode title|post|idea)$/i],
  ['action', /^(action|description|visual|visuals|what happens|caption|logline|beats|prompt|summary)$/i],
  ['voiceover', /^(voice ?over|narration|vo|script|dialogue|words)$/i],
  ['durationSec', /^(length|duration|seconds|runtime|time \(s\))$/i],
  ['sceneKey', /^(scene|slugline)$/i],
  ['model', /^(model|video model)$/i],
];

export function columnMap(cols: SheetColumn[], shotsTab: boolean): Partial<Record<Field, SheetColumn>> {
  const out: Partial<Record<Field, SheetColumn>> = {};
  if (shotsTab) {
    for (const c of cols) if (c.bind) out[c.bind.slice(5) as Field] = c;
  }
  for (const [field, re] of BY_NAME) {
    if (out[field]) continue;
    const c = cols.find(x => !x.bind && re.test(x.name.trim()));
    if (c) out[field] = c;
  }
  if (!out.durationSec) { const d = cols.find(c => !c.bind && c.type === 'duration'); if (d) out.durationSec = d; }
  if (!out.title) { const t = cols.find(c => !c.bind && (c.type === 'text' || c.type === 'longtext')); if (t) out.title = t; }
  return out;
}

export interface CardsResult { made: number; skipped: number; shotIds: string[]; note: string }

/**
 * @param rowKeys the rows to turn into cards; omitted = every row with no card.
 */
export function makeCardsFromRows(
  std: BlockStdScope,
  surfaceId: string,
  blockId: string,
  tabId: string,
  rowKeys?: string[],
): CardsResult {
  if (std.store.readonly) throw new SheetError('read_only', 'This board is open to view only.');
  const snap = readTab(std, blockId, tabId);
  const y = sheetYBlock(std.store, blockId);
  if (!snap || !y) throw new SheetError('not_found', 'That tab is not in this sheet.');
  const shotsTab = snap.tab.binding?.kind === 'shots';
  const want = rowKeys?.length ? new Set(rowKeys) : null;
  const candidates = snap.rows.filter(r => !want || want.has(r.key));
  const todo: DisplayRow[] = candidates.filter(r => r.rowId && !r.link);
  const skipped = candidates.length - todo.length;
  if (!todo.length) {
    return { made: 0, skipped, shotIds: [], note: skipped ? 'Every one of those rows already has a card.' : 'There are no rows to make cards from.' };
  }
  const map = columnMap(snap.columns, shotsTab);
  const read = (row: DisplayRow, c: SheetColumn | undefined): CellValue => (c ? valueOf(std, y as Y.Map<unknown>, snap.tab, row, c) : null);
  // A planned row keeps its bound values in its own cells until now.
  const text = (row: DisplayRow, f: Field): string => {
    const c = map[f];
    const v = read(row, c);
    return v === null ? '' : cellText(v, c!.type);
  };
  const scenes = readParsed(std).scenes;
  const sceneOf = (raw: string): string => {
    const s = raw.trim().toLowerCase();
    if (!s) return '';
    const hit = scenes.find(x => x.key.toLowerCase() === s || x.heading.toLowerCase() === s || String(x.n) === s);
    return hit?.key ?? '';
  };

  const start = readShots(std).length;
  const titles = todo.map((r, i) => (text(r, 'title') || `Shot ${start + i + 1}`).slice(0, 200));
  const ids = createShots(std, surfaceId, titles);
  let movedScene = false;
  // Same undo step as the cards themselves.
  transactSheet(std.store, () => {
    todo.forEach((row, i) => {
      const id = ids[i];
      const block = id ? std.store.getBlock(id) : null;
      if (!block) return;
      const patch: Record<string, unknown> = {};
      const action = text(row, 'action'); if (action) patch.action = action.slice(0, 4000);
      const vo = text(row, 'voiceover'); if (vo) patch.voiceover = vo.slice(0, 4000);
      const model = text(row, 'model'); if (model) patch.model = model;
      const dur = map.durationSec ? read(row, map.durationSec) : null;
      if (typeof dur === 'number' && dur > 0) patch.durationSec = Math.min(600, dur);
      const scene = sceneOf(text(row, 'sceneKey'));
      if (scene) { patch.sceneKey = scene; movedScene = true; }
      if (Object.keys(patch).length) std.store.updateBlock(block.model, patch);
      const rec = (y.get('prop:rows') as Y.Map<unknown> | undefined)?.get(row.rowId!);
      if (rec instanceof Y.Map && id) rec.set('link', { kind: 'shot', id });
      // Those values live on the card now; the row's copies would only go stale.
      const cells = y.get('prop:cells');
      if (cells instanceof Y.Map) for (const c of snap.columns) if (c.bind) cells.delete(`${row.rowId}:${c.id}`);
    });
  }, { merge: true });
  if (movedScene) relayoutShots(std, readShots(std).map(s => s.id));
  const n = ids.length;
  return {
    made: n,
    skipped,
    shotIds: ids,
    note: `Made ${n} shot card${n === 1 ? '' : 's'}${skipped ? `; ${skipped} row${skipped === 1 ? '' : 's'} already had one` : ''}.`,
  };
}
