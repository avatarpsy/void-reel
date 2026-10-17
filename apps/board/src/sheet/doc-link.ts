/**
 * LINKS TO DOCUMENTS, SHEETS AND SCRIPTS — the value a sheet's link cell keeps,
 * and the board links people copy and paste.
 *
 * Pure: no DOM, no store. The board (grid, agent tools, export) and the tests
 * share it.
 *
 * ── THE STORED VALUE ────────────────────────────────────────────────────────
 *   doc:<blockId>                     a document, sheet or script on THIS board
 *   doc:<blockId>#<tabId>             a sheet, opened on that tab
 *   doc:<boardId>/<blockId>[#tab]     one on another of the user's boards
 *   doc:project:<projectId>/<blockId> one on a shared board (a /project link)
 *
 * Same-board links carry no board id on purpose: a board that is duplicated or
 * shared keeps working links, because "this board" travels with the board.
 *
 * The older values `shot:<id>` and `board:<id>` are unchanged.
 */

export interface DocRef {
  /** Another of the user's boards. Absent = this board. */
  board?: string;
  /** A shared board, by its project id. Absent = this board. */
  project?: string;
  block: string;
  tab?: string;
}

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export function isDocValue(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('doc:');
}

export function parseDocValue(v: unknown): DocRef | null {
  if (typeof v !== 'string' || !isDocValue(v)) return null;
  let rest = v.slice(4);
  let tab: string | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) { tab = rest.slice(hash + 1); rest = rest.slice(0, hash); }
  const slash = rest.lastIndexOf('/');
  const block = slash >= 0 ? rest.slice(slash + 1) : rest;
  const where = slash >= 0 ? rest.slice(0, slash) : '';
  if (!ID.test(block)) return null;
  if (tab !== undefined && !ID.test(tab)) tab = undefined;
  const out: DocRef = { block, ...(tab ? { tab } : {}) };
  if (!where) return out;
  if (where.startsWith('project:')) {
    const project = where.slice(8);
    return ID.test(project) ? { ...out, project } : null;
  }
  return ID.test(where) ? { ...out, board: where } : null;
}

export function docValue(ref: DocRef): string {
  const where = ref.project ? `project:${ref.project}/` : ref.board ? `${ref.board}/` : '';
  return `doc:${where}${ref.block}${ref.tab ? `#${ref.tab}` : ''}`;
}

/** The site path that opens it (relative). Null for a same-board ref. */
export function docPath(ref: DocRef): string | null {
  const q = new URLSearchParams();
  if (ref.project) {
    q.set('open', ref.block);
    if (ref.tab) q.set('tab', ref.tab);
    return `/project/${encodeURIComponent(ref.project)}?${q}`;
  }
  if (!ref.board) return null;
  q.set('board', ref.board);
  q.set('open', ref.block);
  if (ref.tab) q.set('tab', ref.tab);
  return `/ai/board?${q}`;
}

/** Hosts a pasted link may name. The page's own host is accepted too (local builds). */
const HOSTS = new Set(['voidspace.ai', 'www.voidspace.ai']);

/**
 * A pasted Voidspace link, as a ref or a board.
 *
 *   https://voidspace.ai/ai/board?board=B&open=X[&tab=T]   → doc B/X
 *   https://voidspace.ai/project/P/slug?open=X              → doc project:P/X
 *   https://voidspace.ai/ai/board?board=B                   → board B
 *
 * Anything else — another site, a link with no board — is null.
 */
export function parseVoidspaceLink(
  text: string,
  ownHost?: string,
): { kind: 'doc'; ref: DocRef } | { kind: 'board'; boardId: string } | null {
  const raw = text.trim();
  if (!raw || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : raw.startsWith('/') ? `https://voidspace.ai${raw}` : `https://${raw}`);
  } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host) && !(ownHost && url.host.toLowerCase() === ownHost.toLowerCase())) return null;
  const open = url.searchParams.get('open') ?? '';
  const tab = url.searchParams.get('tab') ?? '';
  const withTab = (ref: DocRef): DocRef => (tab && ID.test(tab) ? { ...ref, tab } : ref);
  const project = /^\/project\/([A-Za-z0-9_-]{1,200})(?:\/|$)/.exec(url.pathname)?.[1];
  if (project) return ID.test(open) ? { kind: 'doc', ref: withTab({ project, block: open }) } : null;
  // The board page, or the editor frame inside it.
  if (/^\/(ai\/board|board)(\/(index\.html)?)?$/.test(url.pathname)) {
    const shared = url.searchParams.get('shared') ?? '';
    if (shared && ID.test(shared)) return ID.test(open) ? { kind: 'doc', ref: withTab({ project: shared, block: open }) } : null;
    const board = url.searchParams.get('board') || url.searchParams.get('doc') || '';
    if (!ID.test(board) || board === 'scratch') return null;
    return ID.test(open) ? { kind: 'doc', ref: withTab({ board, block: open }) } : { kind: 'board', boardId: board };
  }
  return null;
}
