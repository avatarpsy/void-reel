import { useEffect, useRef } from 'react';
import { useUIStore } from '../stores/ui-store';
import { useProjectStore } from '../stores/project-store';
import { useSelectionStore } from '../stores/selection-store';
import type { Tool } from '../stores/ui-store';

// Photoshop-style single-key tool shortcuts. Where Photoshop groups several
// tools under one letter (M = marquees, L = lassos, …), Shift+<letter> cycles
// within the group — see SHIFT_CYCLES below.
const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  m: 'marquee-rect',
  l: 'lasso',
  w: 'magic-wand',
  c: 'crop',
  b: 'brush',
  e: 'eraser',
  g: 'gradient',
  s: 'clone-stamp',   // PS-correct (shape moves to U)
  j: 'spot-healing',
  o: 'dodge',
  u: 'shape',
  t: 'text',
  p: 'pen',
  i: 'eyedropper',
  h: 'hand',
  z: 'zoom',
};

// Shift+<letter> cycles within a Photoshop tool group.
const SHIFT_CYCLES: Record<string, Tool[]> = {
  m: ['marquee-rect', 'marquee-ellipse'],
  l: ['lasso', 'lasso-polygon'],
  j: ['spot-healing', 'healing-brush'],
  g: ['gradient', 'paint-bucket'],
  o: ['dodge', 'burn', 'sponge'],
  e: ['eraser'],
};

// Tools for which [ and ] adjust the brush size (Photoshop convention).
const BRUSH_LIKE: Tool[] = [
  'brush', 'eraser', 'clone-stamp', 'healing-brush', 'spot-healing',
  'dodge', 'burn', 'sponge', 'smudge', 'blur', 'sharpen',
];

export function useKeyboardShortcuts() {
  const {
    setActiveTool, activeTool, zoomIn, zoomOut, zoomToFit, setZoom,
    toggleGrid, toggleGuides, toggleShortcutsPanel, openSettingsDialog,
    brushSettings, setBrushSettings, toggleAllPanels,
  } = useUIStore();
  const {
    selectedLayerIds, removeLayer, copyLayers, cutLayers, pasteLayers,
    duplicateLayer, selectAllLayers, deselectAllLayers,
    moveLayerUp, moveLayerDown, moveLayerToTop, moveLayerToBottom,
    groupLayers, ungroupLayers, mergeDown, project, undo, redo, canUndo, canRedo,
    updateLayer,
  } = useProjectStore();

  // Spacebar-pan: hold Space to temporarily switch to the Hand tool, restoring
  // the previous tool on release — exactly like Photoshop.
  const spacePanRef = useRef<{ active: boolean; prevTool: Tool | null }>({ active: false, prevTool: null });

  useEffect(() => {
    const isEditable = (t: HTMLElement) =>
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;

      // A bare Alt press/release makes Chrome focus its "Customize and control"
      // app menu, which steals keyboard focus — so the next spacebar-pan (and
      // other shortcuts) silently fail. Alt is a TOOL modifier here (Alt-zoom,
      // Alt to set the clone/heal source), so suppress the browser default and
      // keep focus on the canvas. Doesn't affect Alt+<key> shortcuts.
      if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
        e.preventDefault();
        return;
      }

      if (isEditable(target)) return;

      const isMod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();

      // Spacebar → temporary Hand tool (pan); Ctrl/Cmd+Space → temporary Zoom
      // tool (Photoshop). Released back to the previous tool on key-up. Ignore
      // auto-repeat.
      if (e.code === 'Space') {
        e.preventDefault();
        if (!spacePanRef.current.active && !e.repeat) {
          const want: Tool = isMod ? 'zoom' : 'hand';
          spacePanRef.current = { active: true, prevTool: activeTool };
          if (activeTool !== want) setActiveTool(want);
        }
        return;
      }

      // Tab toggles the side panels (Photoshop hides all panels with Tab).
      // It used to flip each column INDEPENDENTLY, so once you had closed one
      // panel by hand every Tab just swapped which one was showing and the
      // clean full-screen canvas became unreachable. `toggleAllPanels` closes
      // everything while anything is open and only then restores — the same
      // rule the video editor's Tab and both toolbar buttons follow.
      if (e.key === 'Tab' && !isMod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        toggleAllPanels();
        return;
      }

      // [ and ] resize the brush for brush-like tools (no modifier).
      if (!isMod && !e.altKey && (k === '[' || k === ']') && BRUSH_LIKE.includes(activeTool)) {
        e.preventDefault();
        const step = brushSettings.size < 20 ? 1 : brushSettings.size < 100 ? 5 : 20;
        const next = k === ']'
          ? Math.min(1000, brushSettings.size + step)
          : Math.max(1, brushSettings.size - step);
        setBrushSettings({ size: next });
        return;
      }

      // Shift+<letter> cycles a Photoshop tool group.
      if (!isMod && e.shiftKey && !e.altKey && SHIFT_CYCLES[k]) {
        e.preventDefault();
        const group = SHIFT_CYCLES[k];
        const idx = group.indexOf(activeTool);
        setActiveTool(group[(idx + 1) % group.length] ?? group[0]);
        return;
      }

      // Plain single-key tool selection.
      if (!isMod && !e.shiftKey && !e.altKey && TOOL_KEYS[k]) {
        e.preventDefault();
        setActiveTool(TOOL_KEYS[k]);
        return;
      }

      if (!isMod && !e.shiftKey && !e.altKey && (k === 'delete' || k === 'backspace')) {
        if (selectedLayerIds.length > 0) {
          e.preventDefault();
          selectedLayerIds.forEach((id) => removeLayer(id));
        }
        return;
      }

      if (isMod) {
        switch (k) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) { if (canRedo()) redo(); } else { if (canUndo()) undo(); }
            break;
          case 'y': e.preventDefault(); if (canRedo()) redo(); break; // PS/Windows redo
          case 'e': // PS: Cmd/Ctrl+E = Merge Down
            e.preventDefault();
            if (selectedLayerIds.length === 1) void mergeDown(selectedLayerIds[0]);
            break;
          case 'j': // PS "Layer via Copy" — duplicate the selected layer(s)
            e.preventDefault();
            if (selectedLayerIds.length > 0) selectedLayerIds.forEach((id) => duplicateLayer(id));
            break;
          case 'c': e.preventDefault(); copyLayers(); break;
          case 'x': e.preventDefault(); cutLayers(); break;
          case 'v': e.preventDefault(); pasteLayers(); break;
          case 'd':
            // PS: Cmd/Ctrl+D = Deselect (duplicate layer is Cmd/Ctrl+J).
            e.preventDefault();
            useSelectionStore.getState().clearSelection();
            break;
          case 'i':
            // PS: Cmd/Ctrl+Shift+I = Invert selection — across the active artboard.
            if (e.shiftKey) {
              e.preventDefault();
              const ps = useProjectStore.getState();
              const ab = ps.project?.artboards.find((a) => a.id === ps.selectedArtboardId)
                ?? ps.project?.artboards[0];
              if (ab) {
                useSelectionStore.getState().invertSelection({
                  x: 0, y: 0, width: ab.size.width, height: ab.size.height,
                });
              }
            }
            break;
          case 'a': e.preventDefault(); selectAllLayers(); break;
          case 'g':
            e.preventDefault();
            if (e.altKey) {
              // PS: Cmd/Ctrl+Alt+G = toggle clipping mask on the selected layer.
              if (selectedLayerIds.length === 1) {
                const layer = project?.layers[selectedLayerIds[0]];
                if (layer) updateLayer(selectedLayerIds[0], { clippingMask: !layer.clippingMask });
              }
            } else if (e.shiftKey) {
              if (selectedLayerIds.length === 1) {
                const layer = project?.layers[selectedLayerIds[0]];
                if (layer?.type === 'group') ungroupLayers(selectedLayerIds[0]);
              }
            } else if (selectedLayerIds.length > 1) {
              groupLayers(selectedLayerIds);
            }
            break;
          case ']':
            e.preventDefault();
            if (selectedLayerIds.length === 1) {
              if (e.shiftKey) moveLayerToTop(selectedLayerIds[0]); else moveLayerUp(selectedLayerIds[0]);
            }
            break;
          case '[':
            e.preventDefault();
            if (selectedLayerIds.length === 1) {
              if (e.shiftKey) moveLayerToBottom(selectedLayerIds[0]); else moveLayerDown(selectedLayerIds[0]);
            }
            break;
          case '=':
          case '+': e.preventDefault(); zoomIn(); break;
          case '-': e.preventDefault(); zoomOut(); break;
          case '0': e.preventDefault(); zoomToFit(); break;
          case '1': e.preventDefault(); setZoom(1); break; // 100% (actual pixels)
          case "'": e.preventDefault(); toggleGrid(); break;
          case ';': e.preventDefault(); toggleGuides(); break;
          case ',': e.preventDefault(); openSettingsDialog(); break;
          case 's':
            e.preventDefault();
            if (project) {
              const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}.orimg`;
              a.click();
              URL.revokeObjectURL(url);
            }
            break;
        }
        return;
      }

      if (e.key === 'Escape') { useSelectionStore.getState().clearSelection(); deselectAllLayers(); return; }
      if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); toggleShortcutsPanel(); }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // See handleKeyDown — keep Chrome from grabbing its menu on Alt release.
      if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
        e.preventDefault();
      }
      if (e.code === 'Space' && spacePanRef.current.active) {
        const prev = spacePanRef.current.prevTool;
        spacePanRef.current = { active: false, prevTool: null };
        if (prev) setActiveTool(prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [
    activeTool, selectedLayerIds, setActiveTool, removeLayer, copyLayers, cutLayers,
    pasteLayers, duplicateLayer, selectAllLayers, deselectAllLayers, moveLayerUp,
    moveLayerDown, moveLayerToTop, moveLayerToBottom, groupLayers, ungroupLayers, mergeDown, updateLayer,
    zoomIn, zoomOut, zoomToFit, setZoom, toggleGrid, toggleGuides, toggleShortcutsPanel,
    openSettingsDialog, undo, redo, canUndo, canRedo, project, brushSettings, setBrushSettings,
    toggleAllPanels,
  ]);
}
