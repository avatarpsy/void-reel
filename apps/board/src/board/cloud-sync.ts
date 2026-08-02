/**
 * Cloud persistence for a board.
 *
 * WHAT IT IS FOR
 * IndexedDB alone makes a board a per-browser artefact: open Voidspace on
 * another machine and the canvas you spent an afternoon on is simply not there,
 * with nothing to say it ever existed. That is not a synced product, and it is
 * the difference between "a feature of Voidspace" and "a page that happens to
 * remember things on this laptop".
 *
 * HOW IT MERGES, AND WHY THAT IS SAFE
 * A Yjs document is a CRDT: `applyUpdate` of a remote state onto a local one
 * converges regardless of order, so pulling the cloud snapshot INTO the
 * already-hydrated local doc is a merge, never an overwrite. Edits made offline
 * on this device and edits made on another survive together. The alternative —
 * "whichever save was last wins" — would silently destroy work, and it is
 * exactly what a naive `if (cloud) replace(local)` does.
 *
 * WHEN IT SAVES
 * 2 s after the user stops, 30 s at the latest while they keep going, and always
 * on the way out (`pagehide`, not `unload` — Safari and mobile Chrome never fire
 * `unload`, so a board closed on a phone would lose its last edits). The same
 * cadence the timeline auto-save uses.
 */
import * as Y from 'yjs';

import { getParentToken } from './parent-auth';

const IDLE_MS = 2_000;
const MAX_MS = 30_000;

export interface CloudSyncOptions {
  boardId: string;
  doc: Y.Doc;
  /** Read at save time so the index row's shot count is never stale. */
  shotCount: () => number;
  /** Voidspace origin — these apps are iframed, so a relative URL is wrong. */
  apiBase: string;
  /** Told when a save is refused because the board is locked, so the UI can say
   *  so once rather than retrying into a wall. */
  onLocked?: () => void;
}

/**
 * Fetch with the parent's token, refreshing ONCE on a 401.
 *
 * The retry is for a session left open past the token's ~1 h life. It is
 * deliberately skipped when there was no token to begin with: asking again
 * cannot produce one for a signed-out user, and each ask costs the full startup
 * backoff — so the naive loop doubled the wait on exactly the path that was
 * already the slowest.
 */
async function authFetch(url: string, init: RequestInit): Promise<Response | null> {
  let last: Response | null = null;
  for (const force of [false, true]) {
    const token = await getParentToken(force).catch(() => null);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      last = res;
      if (res.status !== 401 && res.status !== 403) return res;
      if (!token) return res;
    } catch {
      // NULL MEANS "the request never happened" — a network error. Everything
      // else, including a rejected credential, comes back as a response so the
      // caller can tell "no access" apart from "no answer". Collapsing the two
      // made a rejected token look like an outage, and the board refused to
      // open rather than running locally.
      return null;
    }
  }
  return last;
}

/**
 * `signedOut` is separate from `failed` ON PURPOSE, and the distinction is the
 * difference between a usable board and a broken one.
 *
 *   merged / empty — we know what the cloud holds. Safe to open, safe to save.
 *   signedOut      — there IS no cloud board for this user. Safe to open; the
 *                    canvas works from IndexedDB alone, and saving stays off so
 *                    a later sign-in cannot push a blank doc over a real one.
 *   failed         — the board may exist and we could not read it. Opening would
 *                    show an empty canvas that looks legitimate, and the next
 *                    autosave would destroy the real one. Refuse.
 *
 * Collapsing the first two into `failed` was the original bug: a signed-out
 * visitor, or the board served standalone, could not open a board at all.
 */
export type PullResult = 'merged' | 'empty' | 'signedOut' | 'failed';

export interface CloudSync {
  /** Merge the cloud snapshot into the local document. Safe to call once, at boot. */
  pull(): Promise<PullResult>;
  /** Save now, ignoring the debounce. Used by compile, which must not race it. */
  flush(): Promise<void>;
  stop(): void;
}

export function installCloudSync(opts: CloudSyncOptions): CloudSync {
  const { boardId, doc, apiBase } = opts;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;
  let dirty = false;
  let locked = false;
  let stopped = false;
  /** True once we have read the cloud state — the licence to write it. */
  let pulled = false;

  async function save(): Promise<void> {
    // NEVER WRITE TO A BOARD WE FAILED TO READ. Without this a signed-out
    // session (or one whose pull errored) would seed a blank canvas locally and
    // then push it over whatever is really in Storage the moment auth returned.
    if (!pulled) return;
    if (stopped || locked || !dirty) return;
    // Coalesce: a save triggered while one is in flight waits for it rather than
    // racing, so the newest state is always the last thing written.
    if (saving) { await saving; if (!dirty) return; }
    dirty = false;
    const bytes = Y.encodeStateAsUpdate(doc);
    const url = `${apiBase}/api/board/doc?board=${encodeURIComponent(boardId)}`
      + `&shots=${encodeURIComponent(String(opts.shotCount()))}`;
    saving = (async () => {
      const res = await authFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes as unknown as BodyInit,
      });
      if (res?.status === 409) {
        // Compiled elsewhere. Stop trying — the local copy is now a read-only
        // record and hammering the endpoint would only produce noise.
        locked = true;
        opts.onLocked?.();
        return;
      }
      // Any other failure leaves the board marked dirty again, so the next tick
      // retries. Losing a snapshot to a flaky network must not lose the work:
      // IndexedDB still holds it, and the next successful save carries it up.
      if (!res || !res.ok) dirty = true;
    })().finally(() => { saving = null; });
    await saving;
  }

  function schedule(): void {
    if (stopped || locked) return;
    dirty = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void save(); }, IDLE_MS);
    // The ceiling matters for the person who never pauses: without it a long
    // uninterrupted working session would never reach the idle branch at all.
    if (!maxTimer) {
      maxTimer = setTimeout(() => { maxTimer = null; void save(); }, MAX_MS);
    }
  }

  const onUpdate = () => schedule();
  doc.on('update', onUpdate);

  // `pagehide`, NOT `unload`. Safari and mobile Chrome do not fire `unload` at
  // all, so a board closed there would lose everything since the last autosave.
  const onHide = () => { void save(); };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void save();
  });

  return {
    async pull(): Promise<PullResult> {
      const res = await authFetch(
        `${apiBase}/api/board/doc?board=${encodeURIComponent(boardId)}`,
        { method: 'GET' },
      );
      if (!res) return 'failed';
      // `authFetch` already retried with a fresh token, so a 401 here means
      // genuinely signed out — not a stale credential.
      if (res.status === 401 || res.status === 403) return 'signedOut';
      if (res.status === 204) { pulled = true; return 'empty'; }
      if (!res.ok) return 'failed';
      try {
        const buf = new Uint8Array(await res.arrayBuffer());
        pulled = true;
        if (!buf.length) return 'empty';
        // MERGE. See the header — this is what makes two devices safe.
        Y.applyUpdate(doc, buf, 'cloud');
        return 'merged';
      } catch {
        return 'failed';
      }
    },
    async flush() {
      if (idleTimer) clearTimeout(idleTimer);
      dirty = true;
      await save();
    },
    stop() {
      stopped = true;
      doc.off('update', onUpdate);
      window.removeEventListener('pagehide', onHide);
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
    },
  };
}
