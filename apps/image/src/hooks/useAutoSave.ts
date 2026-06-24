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

export function useAutoSave() {
  const { project, isDirty, markClean } = useProjectStore();
  const lastSavedRef = useRef<string>('');
  const timeoutRef = useRef<number>();

  useEffect(() => {
    if (!project || !isDirty) return;

    const projectJson = JSON.stringify(project);
    if (projectJson === lastSavedRef.current) return;

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    timeoutRef.current = window.setTimeout(() => {
      tx('readwrite', (s) =>
        s.put({ id: project.id, project, updatedAt: Date.now() } as SavedRecord),
      )
        .then(() => {
          lastSavedRef.current = projectJson;
          markClean();
        })
        .catch((error) => console.error('Failed to auto-save:', error));
    }, AUTO_SAVE_DELAY);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [project, isDirty, markClean]);
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
