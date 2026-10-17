/**
 * What happened to a sheet's rows ELSEWHERE — the read-only "from Activity"
 * columns, sending calendar rows for approval, episode boards and the series.
 *
 * The sheet owns the plan; Activity owns production (SHEETS_PLAN.md, conflict
 * rule 2). So nothing here writes production state into the sheet: the status
 * is fetched from `/api/board/sheet-status` and drawn beside the rows, never
 * stored in them. The only sheet write is a row's `link` to the episode board
 * "Make episode boards" created, which is plan, not production.
 *
 * All of it is the OWNER's: those endpoints read the signed-in person's own
 * board, so on a shared board (opened through a project link) none of it runs.
 */
import { defaultApiBase, parentToken } from '@openreel/asset-browser';

import { getParentToken } from '../board/parent-auth';
import type { CellValue, DisplayRow, SheetColumn, SheetTab } from './sheet-data';
import { cellText } from './sheet-data';

export type TabKind = 'calendar' | 'episodes' | null;

export interface EpisodeStatus {
  loopId: string; seriesLoopId: string; episode: number | null; status: string; runStatus: string;
  settled: boolean; projectId: string | null; editorUrl: string | null; updatedAt: string | null; title: string;
}
export interface PostStatus {
  draftId: string; status: string; draftStatus: string; scheduledTime: string | null; platforms: string[]; updatedAt: string | null;
}
export interface SheetActivity {
  series: Array<{ loopId: string; title: string; state: string; nextFireAt: string | null; lastSkippedReason: string | null }>;
  rows: Record<string, { episode?: EpisodeStatus; post?: PostStatus }>;
  authors: Record<string, { by: string; name: string }>;
  fetchedAt: string;
}

const has = (cols: SheetColumn[], re: RegExp) => cols.some(c => re.test(c.name.trim()));

/** Which of the two production kinds a tab is, by its binding or its columns. */
export function tabKind(tab: SheetTab, cols: SheetColumn[]): TabKind {
  if (tab.binding?.kind === 'episodes') return 'episodes';
  if (tab.binding?.kind === 'shots') return null;
  if (has(cols, /^(caption|captions)$/i) && (has(cols, /^platforms?$/i) || has(cols, /^date$/i))) return 'calendar';
  if (has(cols, /^(logline|summary|synopsis)$/i) && has(cols, /^(episode|ep|#|episode #)$/i)) return 'episodes';
  return null;
}

/**
 * On a SHARED board, the owner's own id for it (the project's source), set by
 * main.ts from the project metadata. Null for collaborators and viewers: the
 * endpoints read the signed-in person's own board, which is not theirs.
 */
let sharedOwnerBoard: string | null = null;
export function setSharedOwnerBoard(id: string | null): void { sharedOwnerBoard = id; }

/** The board this tab can talk to the server about, or null (not the owner, signed out). */
export function ownBoardId(): string | null {
  const q = new URLSearchParams(location.search);
  if (q.get('shared')) return sharedOwnerBoard;
  const id = q.get('board');
  return id && id !== 'scratch' ? id : null;
}

/** A signed-in call to the site's API from inside the board. Also used by sheet links. */
export async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  // A shared board's page hands out tokens through the collaboration channel.
  const token = new URLSearchParams(location.search).get('shared')
    ? await parentToken().catch(() => null)
    : await getParentToken();
  if (!token) return { status: 401, body: { message: 'Sign in to Voidspace to do this.' } };
  try {
    const res = await fetch(`${defaultApiBase()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch {
    return { status: 0, body: { message: "Couldn't reach Voidspace. Check your connection and try again." } };
  }
}

export async function fetchActivity(boardId: string, sheetId: string, tab: SheetTab): Promise<SheetActivity | null> {
  const series = tab.binding?.kind === 'episodes' && tab.binding.seriesLoopId ? `&series=${encodeURIComponent(tab.binding.seriesLoopId)}` : '';
  const r = await api(`/api/board/sheet-status?board=${encodeURIComponent(boardId)}&sheet=${encodeURIComponent(sheetId)}&tab=${encodeURIComponent(tab.id)}${series}`);
  if (r.status !== 200 || !r.body?.ok) return null;
  return { series: r.body.series ?? [], rows: r.body.rows ?? {}, authors: r.body.authors ?? {}, fetchedAt: r.body.fetchedAt ?? '' };
}

/** A row as {column name: what the grid shows}, which is what the server reads. */
export function rowValues(cols: SheetColumn[], value: (c: SheetColumn) => CellValue): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const c of cols) {
    const v = value(c);
    out[c.name] = v === null ? null : typeof v === 'boolean' || typeof v === 'number' ? v : cellText(v, c.type);
  }
  return out;
}

export type SendResult =
  | { kind: 'sent'; draftId: string; message: string; warnings: string[] }
  | { kind: 'unchanged'; draftId: string; message: string }
  | { kind: 'missing'; missing: string[]; message: string }
  | { kind: 'posted'; draftId: string; message: string }
  | { kind: 'error'; message: string };

/** Send one calendar row for approval. Nothing posts until they approve its card. */
export async function sendRowForApproval(
  ref: { boardId: string; sheetId: string; tabId: string; rowId: string },
  row: Record<string, CellValue>,
  again = false,
): Promise<SendResult> {
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* the account's zone */ }
  const r = await api('/api/board/sheet-post', {
    method: 'POST',
    body: JSON.stringify({ ...ref, row, ...(zone ? { timezone: zone } : {}), ...(again ? { again: true } : {}) }),
  });
  const b = r.body ?? {};
  if (r.status === 200 && b.unchanged) return { kind: 'unchanged', draftId: String(b.draftId ?? ''), message: String(b.message ?? 'Already approved and scheduled.') };
  if (r.status === 200 && b.ok) return { kind: 'sent', draftId: String(b.draftId ?? ''), message: String(b.message ?? 'Sent for your approval.'), warnings: Array.isArray(b.warnings) ? b.warnings.map(String) : [] };
  if (r.status === 422) return { kind: 'missing', missing: Array.isArray(b.missing) ? b.missing.map(String) : [], message: String(b.message ?? 'This row is not ready yet.') };
  if (r.status === 409 && b.posted) return { kind: 'posted', draftId: String(b.draftId ?? ''), message: String(b.message ?? 'This row was already posted.') };
  return { kind: 'error', message: String(b.message ?? b.statusMessage ?? 'That could not be sent. Try again.') };
}

/** A new, empty episode board (its index row; the canvas is made when it opens). */
export async function createEpisodeBoard(title: string, goal: string): Promise<string | null> {
  const boardId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const r = await api('/api/board/meta', {
    method: 'POST',
    body: JSON.stringify({ boardId, title: title.slice(0, 160), ...(goal ? { goal: goal.slice(0, 2000) } : {}) }),
  });
  return r.status === 200 && r.body?.ok ? boardId : null;
}

export interface SeriesChoice { loopId: string; title: string; state: string; plan: { boardId?: string; sheetId?: string; tabId?: string } | null }

export async function listSeries(): Promise<SeriesChoice[]> {
  const r = await api('/api/board/sheet-series');
  return r.status === 200 && Array.isArray(r.body?.series) ? r.body.series : [];
}

export async function runAsSeries(input: {
  boardId: string; sheetId: string; tabId: string;
  loopId?: string; title?: string; repeat?: 'daily' | 'weekly'; when?: string;
}): Promise<{ ok: boolean; loopId?: string; message: string }> {
  const r = await api('/api/board/sheet-series', { method: 'POST', body: JSON.stringify(input) });
  return r.status === 200 && r.body?.ok
    ? { ok: true, loopId: String(r.body.loopId ?? ''), message: String(r.body.message ?? 'The series follows this tab now.') }
    : { ok: false, message: String(r.body?.message ?? r.body?.statusMessage ?? 'The series could not be set up. Try again.') };
}

/** The episode number, title and logline of a row, by column meaning. */
export function episodeFields(cols: SheetColumn[], value: (c: SheetColumn) => CellValue): { n: string; title: string; logline: string } {
  const pick = (re: RegExp) => { const c = cols.find(x => re.test(x.name.trim())); return c ? cellText(value(c), c.type) : ''; };
  return { n: pick(/^(episode|ep|#|episode #)$/i), title: pick(/^title$/i), logline: pick(/^(logline|summary|synopsis)$/i) };
}

/** Rows a status column says are Ready. */
export function readyRows(rows: DisplayRow[], cols: SheetColumn[], value: (r: DisplayRow, c: SheetColumn) => CellValue): DisplayRow[] {
  const status = cols.find(c => /^status$/i.test(c.name.trim()));
  if (!status) return [];
  return rows.filter(r => r.rowId && String(value(r, status) ?? '').trim().toLowerCase() === 'ready');
}

/**
 * Polite polling for the "from Activity" columns: once when a tab opens, again
 * when the window gets focus back, and every 45 s while the sheet is open and
 * the page is visible. Only focus mode runs one — never the canvas preview.
 */
export class ActivityPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private target: { sheetId: string; tab: SheetTab } | null = null;
  private busy = false;
  private retried = false;
  private readonly onFocus = () => { void this.refresh(); };
  constructor(private readonly onData: (data: SheetActivity | null) => void, private readonly everyMs = 45_000) {
    window.addEventListener('focus', this.onFocus);
    document.addEventListener('visibilitychange', this.onFocus);
  }

  setTarget(sheetId: string, tab: SheetTab | null): void {
    const same = this.target && tab && this.target.sheetId === sheetId && this.target.tab.id === tab.id;
    this.target = tab ? { sheetId, tab } : null;
    if (same) return;
    this.retried = false;
    this.onData(null);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!this.target || !ownBoardId()) return;
    void this.refresh();
    this.timer = setInterval(() => { if (!document.hidden) void this.refresh(); }, this.everyMs);
  }

  async refresh(): Promise<void> {
    const t = this.target; const board = ownBoardId();
    if (!t || !board || this.busy || document.hidden) return;
    this.busy = true;
    try {
      const data = await fetchActivity(board, t.sheetId, t.tab);
      if (this.target === t) this.onData(data);
      // The page's token often arrives a moment after the sheet opens: try
      // again shortly rather than waiting for the next 45 s tick.
      if (!data && this.target === t && !this.retried) { this.retried = true; setTimeout(() => { void this.refresh(); }, 3000); }
    } finally { this.busy = false; }
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('visibilitychange', this.onFocus);
  }
}
