/**
 * How a block preview gets a token — decided by the HOST, not by this package.
 *
 * ── WHY THIS INDIRECTION EXISTS ─────────────────────────────────────────────
 * Reading a block is an authenticated call (`POST /api/studio/blocks`), and the
 * three surfaces that need one hold their credentials in three different
 * places. The board is an iframe with no Firebase of its own and asks its parent
 * over postMessage. The video editor has Firebase directly. The image editor has
 * its own Voidspace store. Baking any one of those into the renderer is what
 * kept this code stuck in the board — the only reason there were two block
 * renderers in this repo was a single import.
 *
 * So the renderer states what it needs — "give me a bearer token, or null" — and
 * each app answers in its own way at boot.
 *
 * ── WHY NULL IS A NORMAL ANSWER ─────────────────────────────────────────────
 * A signed-out visitor, a board served standalone, a parent that has not
 * finished registering its handler yet. The fetch goes out unauthenticated and
 * the caller renders the 401 as "no preview", which is honest. It must never
 * throw or hang: a preview is a nicety and cannot be allowed to take a panel
 * down with it.
 */

export type BlockTokenProvider = () => Promise<string | null>;

let provider: BlockTokenProvider = async () => null;

/**
 * Register how this app gets a token. Call once, at boot, before any preview
 * mounts — a preview that starts before this is set simply goes out without a
 * header and retries on its next mount.
 */
export function setBlockTokenProvider(fn: BlockTokenProvider): void {
  provider = fn;
}

/** The token, or null. Never throws — see the note above. */
export async function blockToken(): Promise<string | null> {
  try {
    return await provider();
  } catch {
    return null;
  }
}

/**
 * Where `/api/studio/blocks` lives, seen from this document.
 *
 * Same origin in every host today (the board is served from `/board/`, the
 * editor from `/studio/`), so the default is a relative path. The override
 * exists for a host embedded across origins, which the editor can be when it is
 * opened standalone against a different API.
 */
let base = '';

export function setBlockApiBase(origin: string): void {
  base = String(origin || '').replace(/\/$/, '');
}

export function blockApiUrl(): string {
  return `${base}/api/studio/blocks`;
}

/**
 * THE CATALOGUE — every block this user can reach, normalised.
 *
 * ── WHY IT LIVES BESIDE THE AUTH AND NOT IN A HOST ──────────────────────────
 * Three surfaces browse the library (board, video editor, image editor) and each
 * one used to own its own "POST /api/studio/blocks {action:'list'}" plus its own
 * cache. They agreed on the happy path and diverged everywhere else: whether an
 * empty answer is cached, whether a 401 is an error or a "not signed in yet",
 * whether the two declaration styles are both parsed. Now there is one.
 *
 * The board is the exception and still receives its copy from the parent page —
 * it is handed one on mount, before it could have asked for itself, and taking
 * that away would put a fetch in front of a list it already has.
 *
 * ── AN EMPTY RESULT IS NOT CACHED ───────────────────────────────────────────
 * Empty almost always means the desktop app is not running (or the user is not
 * signed in yet). Caching that would leave the panel empty until a reload, long
 * after the reason went away.
 */
import { normalizeBlocks, type BlockInfo } from '../blocks';

let catalogue: BlockInfo[] | null = null;
let inFlight: Promise<BlockInfo[]> | null = null;
let lastError = '';
/**
 * WHERE THE LAST LISTING CAME FROM — 'device', 'disk', 'shipped', or
 * 'device+shipped'. The route reports it, and it is the only signal a browser
 * gets about whether the user's own machine is answering.
 *
 * That matters because the two halves of this feature have different
 * requirements: BROWSING works for everybody now (the starters ship with the
 * server), but RENDERING a block into a video happens on the user's computer.
 * Without this the library looks complete to someone who cannot place anything
 * from it, and the first thing they learn is a failed drop.
 */
let lastSource = '';

/** Why the catalogue is empty, in a sentence a user can act on. */
export function blockCatalogueError(): string {
  return lastError;
}

/** What was last fetched — synchronous, so reopening a panel does not flash. */
export function cachedBlockCatalogue(): BlockInfo[] {
  return catalogue ?? [];
}

async function fetchCatalogue(): Promise<BlockInfo[]> {
  lastError = '';
  const token = await blockToken();
  const res = await fetch(blockApiUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: 'list' }),
  }).catch(() => null);

  if (!res) { lastError = 'Could not reach the block library.'; return []; }
  if (res.status === 401) { lastError = 'Sign in to browse your block library.'; return []; }
  if (!res.ok) { lastError = `Could not read the block library (${res.status}).`; return []; }

  const json = await res.json().catch(() => null);
  lastSource = String(json?.source ?? '');
  const blocks = normalizeBlocks(Array.isArray(json?.blocks) ? json.blocks : []);
  if (!blocks.length) {
    lastError = 'No blocks found — open the Voidspace desktop app to reach your library.';
  }
  return blocks;
}

/** The catalogue. Concurrent callers share one request. */
export function loadBlockCatalogue(): Promise<BlockInfo[]> {
  if (catalogue?.length) return Promise.resolve(catalogue);
  if (inFlight) return inFlight;
  inFlight = fetchCatalogue()
    .then((b) => { if (b.length) catalogue = b; return b; })
    .catch((e) => { lastError = String(e?.message ?? e).slice(0, 160); return []; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Force a re-read — the user saved a block in the desktop app and came back. */
export function refreshBlockCatalogue(): Promise<BlockInfo[]> {
  catalogue = null;
  inFlight = null;
  return loadBlockCatalogue();
}

/**
 * Is the user's desktop app answering?
 *
 * Read off the last listing's `source` rather than probed separately: the route
 * asks the device first and says so, and one signal that is already arriving
 * cannot disagree with itself. `false` before anything has been listed, which is
 * the safe direction — it under-promises rather than claiming a machine is there.
 */
export function desktopRendersBlocks(): boolean {
  return lastSource.includes('device');
}

/** Diagnostics: 'device' | 'disk' | 'shipped' | 'device+shipped' | ''. */
export function blockLibrarySource(): string {
  return lastSource;
}
