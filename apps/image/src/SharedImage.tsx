import { useEffect, useState } from 'react';
import { JsonSession, sharedProjectId, sharedNotice, uploadSharedMedia, installSharedTheme, type SharedRole } from '@openreel/asset-browser';
import { deserializeProject } from '@openreel/image-core/operations';
import { useProjectStore } from './stores/project-store';
import { useHistoryStore } from './stores/history-store';
import { EditorInterface } from './components/editor/EditorInterface';
import { useKeyboardShortcuts } from './services/keyboard-service';
import type { Project } from './types/project';
import { installImageRpc } from './agent/rpc';

function normalized(project: Project): Project {
  const copy = JSON.parse(JSON.stringify(project));
  delete copy.updatedAt; delete copy.activeArtboardId;
  return copy;
}
function Editable() { useKeyboardShortcuts(); useEffect(() => installImageRpc(), []); return <EditorInterface />; }
export default function SharedImage() {
  const [role, setRole] = useState<SharedRole | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const stopTheme = installSharedTheme();
    const original = useProjectStore.getState();
    const session = new JsonSession<Project>(sharedProjectId()!, {
      historyChanged: () => useProjectStore.setState({ canUndo: () => session.canUndo, canRedo: () => session.canRedo }),
      normalize: normalized,
      async prepare() {
        const assets = Object.values(useProjectStore.getState().project?.assets || {});
        for (const asset of assets) {
          const source = asset.dataUrl || asset.blobUrl;
          if (!source || !/^(data:|blob:)/.test(source)) continue;
          const blob = await (await fetch(source)).blob();
          const url = await uploadSharedMedia(sharedProjectId()!, blob);
          const state = useProjectStore.getState(); const current = state.project?.assets[asset.id];
          if (state.project && current && (current.dataUrl || current.blobUrl) === source) {
            useProjectStore.setState({ project: { ...state.project, assets: { ...state.project.assets, [asset.id]: { ...current, dataUrl: url, blobUrl: undefined, thumbnailUrl: /^(data:|blob:)/.test(current.thumbnailUrl) ? url : current.thumbnailUrl } } } });
          }
        }
      },
      read: () => normalized(useProjectStore.getState().project!),
      apply(value, initial) {
        const state = useProjectStore.getState();
        const activeArtboardId = value.artboards.some(page => page.id === state.selectedArtboardId) ? state.selectedArtboardId! : value.artboards[0]?.id;
        const parsed = deserializeProject({ ...value, activeArtboardId, updatedAt: Date.now() });
        if (!parsed.success) throw new Error('This project contains invalid image data.');
        if (initial) state.loadProject(parsed.data);
        else useProjectStore.setState({ project: parsed.data, selectedArtboardId: activeArtboardId, selectedLayerIds: state.selectedLayerIds.filter(id => !!parsed.data.layers[id]), isDirty: false });
      },
      subscribe: listener => useProjectStore.subscribe(state => state.project, listener),
      label: () => useHistoryStore.getState().getUndoDescription() || 'Edited image',
      boundary: () => useHistoryStore.getState().breakCoalescing(),
    });
    const onRole = (event: Event) => { document.documentElement.dataset.collaborationRole = (event as CustomEvent).detail; setRole((event as CustomEvent).detail); };
    window.addEventListener('collaboration-role', onRole);
    void session.start().then(metadata => {
      if (disposed) { session.stop(); return; }
      useProjectStore.setState({ undo: () => { void session.undo(); }, redo: () => { void session.undo(true); }, canUndo: () => session.canUndo, canRedo: () => session.canRedo });
      document.documentElement.dataset.collaborationRole = metadata.role;
      document.documentElement.dataset.collaborationSignedIn = String(!!metadata.userId);
      setRole(metadata.role);
    }).catch(e => { if (!disposed) { setError(e.message); sharedNotice('conflict', e.message); } });
    return () => { disposed = true; session.stop(); stopTheme(); window.removeEventListener('collaboration-role', onRole); useProjectStore.setState({ undo: original.undo, redo: original.redo, canUndo: original.canUndo, canRedo: original.canRedo }); };
  }, []);
  if (error) return <p role="alert" style={{ padding: 24 }}>{error}</p>;
  if (!role) return <p role="status" style={{ padding: 24 }}>Opening project…</p>;
  return role === 'viewer' ? <EditorInterface readOnly /> : <Editable />;
}
