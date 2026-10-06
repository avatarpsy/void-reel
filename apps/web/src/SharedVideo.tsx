import { useEffect, useState } from 'react';
import { TooltipProvider } from '@openreel/ui';
import { ToastContainer } from './components/Toast';
import { ScriptViewDialog } from './components/editor/ScriptViewDialog';
import { SearchModal } from './components/editor/SearchModal';
import { useUIStore } from './stores/ui-store';
import { JsonSession, sharedProjectId, sharedNotice, uploadSharedMedia, installSharedTheme, type SharedRole } from '@openreel/asset-browser';
import { getSpeedEngine, type Project } from '@openreel/core';
import { useProjectStore, projectSnapshotForSave } from './stores/project-store';
import { useEngineStore } from './stores/engine-store';
import { useThemeStore } from './stores/theme-store';
import { useTimelineStore } from './stores/timeline-store';
import { getEffectsBridge } from './bridges/effects-bridge';
import { getBeatSyncBridge } from './bridges/beat-sync-bridge';
import { EditorInterface, useEngineInitialization } from './components/editor/EditorInterface';
import { Preview } from './components/editor/Preview';
import { hydrateLibraryMediaBlobs, useVideoRpc } from './App';

const optionalClipFields = ['textClips', 'shapeClips', 'svgClips', 'stickerClips'] as const;
function normalized(project: Project, storedClipFields?: ReadonlySet<string>): Project {
  const value = JSON.parse(JSON.stringify(project, (key, item) => {
    if (['blob', 'file', 'fileHandle', 'waveformData', 'filmstripThumbnails'].includes(key)) return undefined;
    if (typeof item === 'string' && item.startsWith('blob:')) return undefined;
    return item;
  }));
  delete value.modifiedAt;
  // Engines materialize absent collections as empty arrays after applying a
  // snapshot. Preserve the server's representation so that this bookkeeping
  // never becomes a separate edit (or clears Redo). Nonempty collections still
  // enter the ordinary conditional save pipeline, and stored empty arrays stay.
  if (storedClipFields) for (const key of optionalClipFields) {
    if (!storedClipFields.has(key) && Array.isArray(value[key]) && !value[key].length) delete value[key];
  }
  return value;
}
function applyProject(value: Project, initial: boolean) {
  const current = useProjectStore.getState();
  if (!value.timeline?.tracks || !value.mediaLibrary?.items || !value.settings) throw new Error('Invalid video document.');
  const items = value.mediaLibrary.items.map(item => {
    const local = current.project.mediaLibrary.items.find(candidate => candidate.id === item.id && candidate.originalUrl === item.originalUrl);
    return local ? { ...item, blob: local.blob, waveformData: local.waveformData, filmstripThumbnails: local.filmstripThumbnails, thumbnailUrl: local.thumbnailUrl || item.thumbnailUrl } : item;
  });
  const project = { ...value, modifiedAt: Date.now(), mediaLibrary: { ...value.mediaLibrary, items } };
  if (initial) current.loadProject(project);
  else {
    const engines = useEngineStore.getState();
    engines.getTitleEngine()?.loadTextClips(project.textClips || []);
    const graphics = engines.getGraphicsEngine();
    graphics?.loadShapeClips(project.shapeClips || []); graphics?.loadSVGClips(project.svgClips || []); graphics?.loadStickerClips(project.stickerClips || []);
    const effects = getEffectsBridge(); const speed = getSpeedEngine();
    effects.restoreAllEffects((project.effectsState || {}) as Parameters<typeof effects.restoreAllEffects>[0]);
    speed.restoreAll((project.speedState || {}) as Parameters<typeof speed.restoreAll>[0]);
    getBeatSyncBridge().setBeatMarkers(project.timeline.beatMarkers || [], project.timeline.beatAnalysis || { bpm: 0, confidence: 0, analyzedAt: 0 });
    useProjectStore.setState({ project });
  }
  void hydrateLibraryMediaBlobs();
}
function EditableVideo() { useVideoRpc(); return <EditorInterface />; }
function VideoViewer() {
  const { initialized, initError } = useEngineInitialization();
  const { playheadPosition, seekTo } = useTimelineStore();
  const duration = useProjectStore(state => state.project.timeline.duration);
  if (!initialized) return <p role="status">{initError || 'Opening preview…'}</p>;
  return <main className="h-full flex flex-col bg-background" aria-label="Video preview">
    <Preview readOnly />
    <div className="px-6 pb-4"><input aria-label="Playback position" type="range" min={0} max={Math.max(duration, 0.1)} step={0.04} value={playheadPosition} onChange={event => seekTo(Number(event.target.value))} className="w-full accent-primary"/></div>
  </main>;
}
export default function SharedVideo() {
  const activeModal = useUIStore(state => state.activeModal);
  const closeModal = useUIStore(state => state.closeModal);
  const [role, setRole] = useState<SharedRole | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false; const original = useProjectStore.getState();
    const stopTheme = installSharedTheme(mode => useThemeStore.getState().setMode(mode));
    const storedClipFields = new Set<string>();
    const session = new JsonSession<Project>(sharedProjectId()!, {
      historyChanged: () => useProjectStore.setState({ canUndo: () => session.canUndo, canRedo: () => session.canRedo }),
      normalize: value => {
        storedClipFields.clear();
        for (const key of optionalClipFields) if (Object.prototype.hasOwnProperty.call(value, key)) storedClipFields.add(key);
        return normalized(value);
      },
      read: () => normalized(projectSnapshotForSave(), storedClipFields), apply: applyProject,
      async prepare() {
        for (const item of useProjectStore.getState().project.mediaLibrary.items) {
          if (item.originalUrl && !item.originalUrl.startsWith('blob:') || !(item.blob instanceof Blob)) continue;
          const url = await uploadSharedMedia(sharedProjectId()!, item.blob);
          useProjectStore.setState(state => ({ project: { ...state.project, mediaLibrary: { ...state.project.mediaLibrary, items: state.project.mediaLibrary.items.map(current => current.id === item.id && current.blob === item.blob ? { ...current, originalUrl: url } : current) } } }));
        }
      },
      subscribe: listener => useProjectStore.subscribe(state => state.project, listener),
      label: () => useProjectStore.getState().actionHistory.peekUndo()?.action?.type || 'Edited video',
    });
    const onRole = (event: Event) => { document.documentElement.dataset.collaborationRole = (event as CustomEvent).detail; setRole((event as CustomEvent).detail); };
    window.addEventListener('collaboration-role', onRole);
    void (async () => {
      await useEngineStore.getState().initialize();
      if (disposed) return;
      const metadata = await session.start();
      if (disposed) { session.stop(); return; }
      useProjectStore.setState({ undo: async () => { await session.undo(); return { success: true }; }, redo: async () => { await session.undo(true); return { success: true }; }, canUndo: () => session.canUndo, canRedo: () => session.canRedo, forceSave: () => session.flush() });
      document.documentElement.dataset.collaborationRole = metadata.role; setRole(metadata.role);
    })().catch(e => { if (!disposed) { setError(e.message); sharedNotice('conflict', e.message); } });
    return () => { disposed = true; session.stop(); stopTheme(); window.removeEventListener('collaboration-role', onRole); useProjectStore.setState({ undo: original.undo, redo: original.redo, canUndo: original.canUndo, canRedo: original.canRedo, forceSave: original.forceSave }); };
  }, []);
  if (error) return <p role="alert" className="p-6">{error}</p>;
  if (!role) return <p role="status" className="p-6">Opening project…</p>;
  return <TooltipProvider><div className="h-screen w-screen bg-background text-text-primary overflow-hidden">{role === 'viewer' ? <VideoViewer /> : <><EditableVideo /><ScriptViewDialog isOpen={activeModal === 'scriptView'} onClose={closeModal}/><SearchModal isOpen={activeModal === 'search'} onClose={closeModal}/></>}<ToastContainer /></div></TooltipProvider>;
}
