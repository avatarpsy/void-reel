/**
 * Sheet links on a live board: what a link cell SAYS, where it GOES, and what
 * a pasted link or a typed title BECOMES. The value format is in doc-link.ts.
 *
 * Titles of documents on OTHER boards come from the Boards list
 * (`GET /api/board`, which carries each board's document catalogue) and, for a
 * shared board, from its project (`GET /api/collaboration/<id>`). Both are
 * fetched once and kept for the life of the tab; a cell shows a plain fallback
 * ("Document on Launch film") until they arrive, then redraws.
 */
import type { BlockStdScope } from '@blocksuite/std';

import { type DocRef, docPath, docValue, isDocValue, parseDocValue, parseVoidspaceLink } from './doc-link';
import { api, ownBoardId } from './activity';
import { plain, readTabs, SHEET_FLAVOUR } from './sheet-data';
import { sheetYBlock } from './ops';
import { readShots } from '../shot/shots';
import { toast } from '../ui/toast';

// ── where we are ─────────────────────────────────────────────────────────────

function here(): { board: string | null; project: string | null } {
  const q = new URLSearchParams(location.search);
  return { board: ownBoardId(), project: q.get('shared') };
}

/** True when the ref points at THIS board (by any of its names). */
export function isHere(ref: DocRef): boolean {
  if (!ref.board && !ref.project) return true;
  const h = here();
  return (!!ref.board && ref.board === h.board) || (!!ref.project && ref.project === h.project);
}

/** A same-board ref loses its board id, so it keeps working if the board is copied or shared. */
function local(ref: DocRef): DocRef {
  return isHere(ref) ? { block: ref.block, ...(ref.tab ? { tab: ref.tab } : {}) } : ref;
}

// ── things on this board a cell can link to ──────────────────────────────────

export type TargetKind = 'Document' | 'Sheet' | 'Script';
export interface LinkTarget { value: string; label: string; kind: TargetKind }

function noteTitle(model: any): string {
  for (const child of model?.children ?? []) {
    const text = String(child?.text?.toString?.() ?? '').replace(/[\u2060\u2028]/g, ' ').trim();
    if (text) return text.slice(0, 120);
  }
  return '';
}

function sheetTitle(std: BlockStdScope, id: string): string {
  const y = sheetYBlock(std.store, id);
  const t = y ? plain(y.get('prop:title')) : '';
  return (typeof t === 'string' ? t : '').trim() || 'Untitled sheet';
}

function sheetTabs(std: BlockStdScope, id: string): Array<{ id: string; name: string }> {
  const y = sheetYBlock(std.store, id);
  return y ? readTabs(y) : [];
}

async function scriptTitle(std: BlockStdScope): Promise<string> {
  try {
    const { screenplayView } = await import('../shot/screenplay-view');
    return screenplayView(std).script.title || 'Screenplay';
  } catch { return 'Screenplay'; }
}
let scriptTitleCache = 'Screenplay';

/** What a block on this board is, by its id. Null when it is gone. */
export function blockInfo(std: BlockStdScope, id: string, tab?: string): { kind: TargetKind; title: string } | null {
  const block = std.store.getBlock(id);
  if (!block) return null;
  if (block.flavour === 'affine:note') return { kind: 'Document', title: noteTitle(block.model) || 'Untitled document' };
  if (block.flavour === SHEET_FLAVOUR) {
    const tabs = sheetTabs(std, id);
    const t = tab ? tabs.find(x => x.id === tab) : undefined;
    return { kind: 'Sheet', title: t && tabs.length > 1 ? `${sheetTitle(std, id)} · ${t.name}` : sheetTitle(std, id) };
  }
  if (block.flavour === 'voidspace:screenplay') {
    void scriptTitle(std).then(t => { scriptTitleCache = t; });
    return { kind: 'Script', title: scriptTitleCache };
  }
  return null;
}

/**
 * Every document, sheet tab and script on this board, for the link picker and
 * for matching a title the agent typed. `exclude` is the cell's own place
 * (a sheet tab does not link to itself).
 */
export function boardTargets(std: BlockStdScope, exclude?: { sheet: string; tab: string }): LinkTarget[] {
  const out: LinkTarget[] = [];
  const root: any = std.store.root;
  for (const child of root?.children ?? []) {
    if (child.flavour !== 'affine:note') continue;
    const title = noteTitle(child);
    if (title) out.push({ value: docValue({ block: String(child.id) }), label: title, kind: 'Document' });
  }
  for (const b of std.store.getBlocksByFlavour(SHEET_FLAVOUR)) {
    const tabs = sheetTabs(std, b.id);
    const title = sheetTitle(std, b.id);
    for (const t of tabs) {
      if (exclude && exclude.sheet === b.id && exclude.tab === t.id) continue;
      out.push({ value: docValue({ block: b.id, ...(tabs.length > 1 ? { tab: t.id } : {}) }), label: tabs.length > 1 ? `${title} · ${t.name}` : title, kind: 'Sheet' });
    }
  }
  const script = std.store.getBlocksByFlavour('voidspace:screenplay')[0];
  if (script) {
    void scriptTitle(std).then(t => { scriptTitleCache = t; });
    out.push({ value: docValue({ block: script.id }), label: scriptTitleCache, kind: 'Script' });
  }
  return out;
}

// ── other boards' titles ─────────────────────────────────────────────────────

interface BoardInfo { title: string; items: Map<string, string> }
let boards: Map<string, BoardInfo> | null = null;
let boardsLoading: Promise<void> | null = null;
const projects = new Map<string, string | null>();
const projectsLoading = new Set<string>();
const listeners = new Set<() => void>();

/** Called when a title arrives, so a grid can redraw its cells. */
export function onLinkTitles(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* one view */ } } };

function loadBoards(): void {
  if (boards || boardsLoading) return;
  boardsLoading = (async () => {
    const r = await api('/api/board?limit=100');
    const next = new Map<string, BoardInfo>();
    for (const b of (r.status === 200 && Array.isArray(r.body?.boards) ? r.body.boards : [])) {
      const items = new Map<string, string>();
      for (const d of Array.isArray(b.documents) ? b.documents : []) if (d?.noteId) items.set(String(d.noteId), String(d.title ?? ''));
      for (const s of Array.isArray(b.sheets) ? b.sheets : []) if (s?.id) items.set(String(s.id), String(s.title ?? ''));
      next.set(String(b.id), { title: String(b.title ?? ''), items });
    }
    boards = next;
    notify();
  })().catch(() => { boards = new Map(); }).finally(() => { boardsLoading = null; });
}

function loadProject(id: string): void {
  if (projects.has(id) || projectsLoading.has(id)) return;
  projectsLoading.add(id);
  void api(`/api/collaboration/${encodeURIComponent(id)}`)
    .then(r => { projects.set(id, r.status === 200 && typeof r.body?.title === 'string' ? r.body.title : null); notify(); })
    .catch(() => projects.set(id, null))
    .finally(() => projectsLoading.delete(id));
}

// ── what a cell says ─────────────────────────────────────────────────────────

export interface LinkLabel { text: string; gone?: boolean; kind?: TargetKind }

/** The words a link cell shows (and copies, and the agent reads). */
export function linkLabel(std: BlockStdScope, v: string): LinkLabel {
  if (v.startsWith('shot:')) {
    const id = v.slice(5);
    const shots = readShots(std);
    const i = shots.findIndex(s => s.id === id);
    return i < 0 ? { text: 'Shot removed', gone: true } : { text: `Shot ${i + 1}${shots[i]!.title ? ` · ${shots[i]!.title}` : ''}` };
  }
  if (v.startsWith('board:')) {
    const id = v.slice(6);
    loadBoards();
    const t = boards?.get(id)?.title;
    return { text: t ? `Board · ${t}` : 'Board' };
  }
  if (!isDocValue(v)) return { text: v };
  const ref = parseDocValue(v);
  if (!ref) return { text: 'Link no longer opens', gone: true };
  if (isHere(ref)) {
    const info = blockInfo(std, ref.block, ref.tab);
    return info ? { text: info.title, kind: info.kind } : { text: 'Document removed', gone: true };
  }
  if (ref.project) {
    loadProject(ref.project);
    const t = projects.get(ref.project);
    return { text: t ? `Document on ${t}` : 'Document on a shared board', kind: 'Document' };
  }
  loadBoards();
  const info = boards?.get(ref.board!);
  const title = info?.items.get(ref.block);
  if (title) return { text: title, kind: 'Document' };
  return { text: info?.title ? `Document on ${info.title}` : 'Document on another board', kind: 'Document' };
}

// ── what a typed or pasted value becomes ─────────────────────────────────────

/**
 * A link cell's input, as the value to store — or null when it is not a link
 * this board understands.
 *
 * Accepts a stored value (`doc:`, `shot:`, `board:`), a pasted Voidspace link
 * (any of the user's boards, or a shared one), the exact title of a document,
 * sheet or script on this board, or "Shot 3".
 */
export function resolveLinkInput(std: BlockStdScope, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('shot:') || s.startsWith('board:')) return s;
  if (isDocValue(s)) { const ref = parseDocValue(s); return ref ? docValue(local(ref)) : null; }
  const link = parseVoidspaceLink(s, location.host);
  if (link?.kind === 'doc') return docValue(local(link.ref));
  if (link?.kind === 'board') return link.boardId === here().board ? null : `board:${link.boardId}`;
  const want = s.toLowerCase();
  const targets = boardTargets(std);
  const hit = targets.find(t => t.label.toLowerCase() === want)
    ?? targets.find(t => t.label.toLowerCase().replace(/^#+\s*/, '') === want.replace(/^#+\s*/, ''));
  if (hit) return hit.value;
  const shot = /^shot\s*(\d+)\b/i.exec(s);
  if (shot) {
    const list = readShots(std);
    const one = list[Number(shot[1]) - 1];
    if (one) return `shot:${one.id}`;
  }
  return null;
}

// ── where a click goes ───────────────────────────────────────────────────────

/** The event main.ts answers by opening a block full size (closing a sheet first). */
export const OPEN_BLOCK_EVENT = 'voidspace-open-block';

/**
 * Open what a link cell points at. Same board: focus mode on it. Another
 * board: that board, landing in it. `newTab` (Ctrl/Cmd+click) keeps this one open.
 */
export function openLinkValue(std: BlockStdScope, v: string, opts: { newTab?: boolean } = {}): void {
  let path: string | null = null;
  if (v.startsWith('board:')) path = `/ai/board?board=${encodeURIComponent(v.slice(6))}`;
  else if (isDocValue(v)) {
    const ref = parseDocValue(v);
    if (!ref) { toast('This link no longer opens.', 'info'); return; }
    if (isHere(ref)) {
      if (!blockInfo(std, ref.block)) { toast('That document was removed from this board.', 'info'); return; }
      document.dispatchEvent(new CustomEvent(OPEN_BLOCK_EVENT, { detail: { blockId: ref.block, ...(ref.tab ? { tab: ref.tab } : {}) } }));
      return;
    }
    path = docPath(ref);
  }
  if (!path) return;
  if (opts.newTab) { window.open(path, '_blank', 'noopener'); return; }
  try { (window.top ?? window).location.href = path; } catch { window.open(path, '_top'); }
}
