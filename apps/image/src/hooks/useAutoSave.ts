import { useEffect, useRef } from 'react';
import { useProjectStore } from '../stores/project-store';

// -----------------------------------------------------------------------------
// Seamless local persistence for Voidspace Image.
//
// Projects are autosaved to IndexedDB (not localStorage). localStorage has a
// ~5MB per-origin quota, and image projects embed their bitmaps as base64
// `dataUrl`s — so a couple of photos silently blew the quota and the save was
// lost. IndexedDB has no such practical ceiling, so autosave "just works".
//
// The public helpers keep the same shape as before but are now async (IndexedDB
// is async). A one-time migration copies any legacy localStorage projects in.
// -----------------------------------------------------------------------------

const AUTO_SAVE_DELAY = 2000;
/**
 * The longest a dirty project may go unsaved, however busy the editor is.
 *
 * A trailing debounce alone STARVES. Its cleanup clears the pending timer on
 * every change, so while edits keep arriving closer together than the delay, the
 * save is rescheduled forever and never runs. That is fine for a human typing
 * and catastrophic for an agent, which mutates the document continuously for
 * minutes at a time.
 *
 * Measured, not theorised: 17 edits 700ms apart over 12 seconds wrote NOTHING —
 * the last save was 17 seconds old when the burst ended. A five-slide deck built
 * this way came back from a reload with its pages intact and every layer gone,
 * because the last quiet moment had been before the slides existed.
 */
const MAX_SAVE_INTERVAL = 10_000;
const LEGACY_PREFIX = 'openreel-image-project-';
const DB_NAME = 'voidspace-image';
const STORE = 'projects';
const DB_VERSION = 1;

interface SavedRecord {
  id: string;
  project: unknown;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

// One-time: pull any legacy localStorage projects into IndexedDB so existing
// users don't lose their recent work, then clear the localStorage copies.
let migrated = false;
async function migrateLegacy(): Promise<void> {
  if (migrated) return;
  migrated = true;
  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
    }
    for (const key of legacyKeys) {
      const json = localStorage.getItem(key);
      if (!json) continue;
      try {
        const project = JSON.parse(json) as { id?: string; updatedAt?: number };
        if (project?.id) {
          await tx('readwrite', (s) =>
            s.put({ id: project.id, project, updatedAt: project.updatedAt ?? Date.now() } as SavedRecord),
          );
        }
      } catch {
        /* skip corrupt legacy entry */
      }
      localStorage.removeItem(key);
    }
  } catch (e) {
    console.warn('[autosave] legacy migration skipped:', e);
  }
}

/**
 * How long to wait before writing, given how long it has already been.
 *
 * Pure so the starvation rule can be tested without a browser: the whole point
 * is what happens when edits never stop, which a timer-based test can only
 * approximate.
 *
 * Normally the trailing debounce wins — batch a burst of typing into one write.
 * But once the project has been dirty for close to [maxWaitMs], the wait
 * collapses to zero and the very next edit is written, so a continuously-edited
 * document is never more than that far from disk.
 */
export function saveDelay(opts: {
  now: number;
  lastSaveAt: number;
  debounceMs?: number;
  maxWaitMs?: number;
}): number {
  const debounce = opts.debounceMs ?? AUTO_SAVE_DELAY;
  const maxWait = opts.maxWaitMs ?? MAX_SAVE_INTERVAL;
  const since = Math.max(0, opts.now - opts.lastSaveAt);
  return Math.max(0, Math.min(debounce, maxWait - since));
}

export function useAutoSave() {
  const { project, isDirty, markClean } = useProjectStore();
  const lastSavedRef = useRef<string>('');
  const lastSaveAtRef = useRef<number>(Date.now());
  const timeoutRef = useRef<number>();
  /** The newest unsaved document, for the flush below to reach. */
  const pendingRef = useRef<{ project: unknown; id: string; json: string } | null>(null);

  useEffect(() => {
    if (!project || !isDirty) return;

    const projectJson = JSON.stringify(project);
    if (projectJson === lastSavedRef.current) return;
    pendingRef.current = { project, id: project.id, json: projectJson };

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    timeoutRef.current = window.setTimeout(() => {
      tx('readwrite', (s) =>
        s.put({ id: project.id, project, updatedAt: Date.now() } as SavedRecord),
      )
        .then(() => {
          lastSavedRef.current = projectJson;
          lastSaveAtRef.current = Date.now();
          pendingRef.current = null;
          markClean();
        })
        .catch((error) => console.error('Failed to auto-save:', error));
    }, saveDelay({ now: Date.now(), lastSaveAt: lastSaveAtRef.current }));

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [project, isDirty, markClean]);

  /**
   * Write whatever is still pending before the page goes away.
   *
   * Navigating, closing the tab or switching away can happen inside the debounce
   * window, and without this that window is simply lost work. `pagehide` and a
   * hidden `visibilitychange` are the two the browser actually guarantees —
   * `beforeunload` is not fired for a backgrounded mobile tab.
   */
  useEffect(() => {
    const flush = () => {
      const p = pendingRef.current;
      if (!p) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      // Not awaited: the page is leaving. Starting the transaction is what
      // matters — IndexedDB completes an in-flight write during unload.
      void tx('readwrite', (s) =>
        s.put({ id: p.id, project: p.project, updatedAt: Date.now() } as SavedRecord),
      ).catch(() => {});
      pendingRef.current = null;
    };
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);
}

export async function loadSavedProject(projectId: string): Promise<any | null> {
  try {
    await migrateLegacy();
    const rec = await tx<SavedRecord | undefined>('readonly', (s) => s.get(projectId));
    return rec?.project ?? null;
  } catch (error) {
    console.error('Failed to load saved project:', error);
    return null;
  }
}

export async function getSavedProjectIds(): Promise<string[]> {
  try {
    await migrateLegacy();
    const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    return keys.map(String);
  } catch (error) {
    console.error('Failed to list saved projects:', error);
    return [];
  }
}

export async function deleteSavedProject(projectId: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(projectId));
  } catch (error) {
    console.error('Failed to delete saved project:', error);
  }
}
