import { useEffect, useRef } from 'react';
import { useProjectStore } from '../stores/project-store';
import { syncProjectToCloud } from '../services/project-cloud-sync';

// Mirror the project to the cloud listing (Studio "Images" tab) a few seconds
// after edits settle, and again when the tab is hidden/closed so the latest
// state is captured on leave. This is intentionally lazy — rendering + a
// Firestore write is much heavier than the local IndexedDB autosave, so we let
// changes settle first. syncProjectToCloud dedupes on (id, updatedAt) and is a
// no-op when signed out, so extra calls are cheap.

const SYNC_DELAY = 5000;

export function useProjectCloudSync() {
  const project = useProjectStore((s) => s.project);
  const timeoutRef = useRef<number>();
  // Always-current project for the flush-on-hide listener (bound once).
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    if (!project) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      void syncProjectToCloud(projectRef.current);
    }, SYNC_DELAY);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [project?.updatedAt, project?.id]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') void syncProjectToCloud(projectRef.current);
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);
}
