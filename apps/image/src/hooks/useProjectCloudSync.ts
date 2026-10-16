import { useEffect, useRef } from 'react';
import { useProjectStore } from '../stores/project-store';
import { syncProjectToCloud } from '../services/project-cloud-sync';
import { saveDelay } from './useAutoSave';

// Mirror the project to the cloud listing (Studio "Images" tab) a few seconds
// after edits settle, and again when the tab is hidden/closed so the latest
// state is captured on leave. This is intentionally lazy — rendering + a
// Firestore write is much heavier than the local IndexedDB autosave, so we let
// changes settle first. syncProjectToCloud dedupes on (id, updatedAt) and is a
// no-op when signed out, so extra calls are cheap.

const SYNC_DELAY = 5000;
/**
 * The longest the cloud copy may lag a project that keeps changing.
 *
 * Same starvation as the local autosave had (see `saveDelay`): a pure trailing
 * debounce is reset by every edit, and an agent building a deck edits every
 * second or two for minutes. Without a ceiling the cloud document was written
 * only when the agent paused, so a tab closed mid-build reopened elsewhere with
 * none of that work.
 */
const MAX_SYNC_INTERVAL = 20_000;

export function useProjectCloudSync() {
  const project = useProjectStore((s) => s.project);
  const timeoutRef = useRef<number>();
  const lastSyncAtRef = useRef<number>(Date.now());
  // Always-current project for the flush-on-hide listener (bound once).
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    if (!project) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      lastSyncAtRef.current = Date.now();
      void syncProjectToCloud(projectRef.current);
    }, saveDelay({ now: Date.now(), lastSaveAt: lastSyncAtRef.current, debounceMs: SYNC_DELAY, maxWaitMs: MAX_SYNC_INTERVAL }));
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [project?.updatedAt, project?.id]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') void syncProjectToCloud(projectRef.current, { leaving: true });
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);
}
