import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore, cacheCompositionRender, getProjectRev } from './project-store';
import { compositionHash } from '../services/composition/hash';
import { useHistoryStore } from './history-store';

const DEFAULT_SIZE = { width: 1080, height: 1080 };
const DEFAULT_BG = { type: 'color' as const, color: '#ffffff' };

/**
 * Reset the store to a pristine state before each test so tests are isolated.
 */
function resetStore() {
  useProjectStore.setState({
    project: null,
    selectedLayerIds: [],
    selectedArtboardId: null,
    copiedLayers: [],
    copiedStyle: null,
    isDirty: false,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createProject(name = 'Test') {
  useProjectStore.getState().createProject(name, DEFAULT_SIZE, DEFAULT_BG);
  return useProjectStore.getState();
}

it('render completion keeps the edit revision and undo history stable; real edits still invalidate it', () => {
  resetStore();
  createProject();
  const id = useProjectStore.getState().addImageLayer('', { x: 0, y: 0, width: 1080, height: 1080 });
  const composition = { block: 'hero', slots: { headline: 'Accepted' }, fillMode: 'render' as const,
    poseTime: 'end' as const, frameWidth: 1080, frameHeight: 1080, renderHash: '' };
  useProjectStore.getState().updateLayer(id, { composition } as any);
  const rev = getProjectRev();
  const undo = useHistoryStore.getState().getUndoDepth();
  const asset = { id: 'render-1', type: 'image', name: 'Cover', mimeType: 'image/png', width: 1080, height: 1080, dataUrl: 'data:image/png;base64,a', size: 1 } as any;
  expect(cacheCompositionRender(id, compositionHash(composition), asset)).toBe(true);
  expect(getProjectRev()).toBe(rev);
  expect(useHistoryStore.getState().getUndoDepth()).toBe(undo);
  useProjectStore.getState().updateLayer(id, { composition: { ...composition, slots: { headline: 'User revision' } } } as any);
  expect(getProjectRev()).toBeGreaterThan(rev);
  expect(cacheCompositionRender(id, compositionHash(composition), { ...asset, id: 'late-render' })).toBe(false);
  expect(useProjectStore.getState().project?.assets['late-render']).toBeUndefined();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('project-store', () => {
  beforeEach(resetStore);

  // ── Project lifecycle ───────────────────────────────────────────────────

  describe('createProject', () => {
    it('creates a project with the given name', () => {
      createProject('My Design');
      const { project } = useProjectStore.getState();
      expect(project).not.toBeNull();
      expect(project?.name).toBe('My Design');
    });

    it('initialises project with version 1', () => {
      createProject();
      expect(useProjectStore.getState().project?.version).toBe(1);
    });

    it('creates one default artboard', () => {
      createProject();
      const { project } = useProjectStore.getState();
      expect(project?.artboards).toHaveLength(1);
    });

    it('sets the active artboard to the initial artboard', () => {
      createProject();
      const { project, selectedArtboardId } = useProjectStore.getState();
      expect(project?.activeArtboardId).toBe(selectedArtboardId);
    });

    it('starts with an empty layers map', () => {
      createProject();
      expect(useProjectStore.getState().project?.layers).toEqual({});
    });

    it('marks the project as dirty', () => {
      createProject();
      expect(useProjectStore.getState().isDirty).toBe(true);
    });

    it('applies a custom background colour', () => {
      useProjectStore.getState().createProject('bg-test', DEFAULT_SIZE, {
        type: 'color',
        color: '#ff0000',
      });
      const artboard = useProjectStore.getState().project?.artboards[0];
      expect(artboard?.background).toEqual({ type: 'color', color: '#ff0000' });
    });
  });

  describe('loadProject', () => {
    it('recovers saved agent text with CSS font weights and preserves editable layers', () => {
      createProject('Carousel');
      const id = useProjectStore.getState().addTextLayer('Pause the autopilot');
      const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project));
      saved.layers[id].style.fontWeight = '700';
      resetStore();
      useProjectStore.getState().loadProject(saved);
      const layer = useProjectStore.getState().project?.layers[id];
      expect(layer?.type).toBe('text');
      if (layer?.type !== 'text') throw new Error('Editable text was lost');
      expect(layer.content).toBe('Pause the autopilot');
      expect(layer.style.fontWeight).toBe(700);
    });
    it('loads a valid project', () => {
      createProject('Original');
      const snapshot = useProjectStore.getState().project!;

      resetStore();
      useProjectStore.getState().loadProject(snapshot);

      expect(useProjectStore.getState().project?.name).toBe('Original');
      expect(useProjectStore.getState().isDirty).toBe(false);
    });

    it('rejects a project with missing required fields and keeps state null', () => {
      resetStore();
      // Supply an invalid/incomplete object – loadProject should reject it.
      useProjectStore
        .getState()
        .loadProject({ id: 'bad', name: 'broken' } as never);
      expect(useProjectStore.getState().project).toBeNull();
    });
  });

  describe('closeProject', () => {
    it('clears the project', () => {
      createProject();
      useProjectStore.getState().closeProject();
      expect(useProjectStore.getState().project).toBeNull();
      expect(useProjectStore.getState().isDirty).toBe(false);
    });
  });

  describe('setProjectName', () => {
    it('updates the project name', () => {
      createProject('Old');
      useProjectStore.getState().setProjectName('New');
      expect(useProjectStore.getState().project?.name).toBe('New');
      expect(useProjectStore.getState().isDirty).toBe(true);
    });
  });

  // ── Artboard operations ──────────────────────────────────────────────────

  describe('addArtboard', () => {
    it('adds a second artboard', () => {
      createProject();
      useProjectStore.getState().addArtboard('Page 2', DEFAULT_SIZE);
      expect(useProjectStore.getState().project?.artboards).toHaveLength(2);
    });

    it('returns the new artboard id', () => {
      createProject();
      const id = useProjectStore.getState().addArtboard('Page 2', DEFAULT_SIZE);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('uses the provided position', () => {
      createProject();
      const id = useProjectStore
        .getState()
        .addArtboard('Pos', DEFAULT_SIZE, { x: 200, y: 300 });
      const artboard = useProjectStore
        .getState()
        .project?.artboards.find((a) => a.id === id);
      expect(artboard?.position).toEqual({ x: 200, y: 300 });
    });
  });

  describe('removeArtboard', () => {
    it('removes an artboard when more than one exists', () => {
      createProject();
      const id = useProjectStore.getState().addArtboard('Extra', DEFAULT_SIZE);
      useProjectStore.getState().removeArtboard(id);
      expect(
        useProjectStore.getState().project?.artboards.find((a) => a.id === id),
      ).toBeUndefined();
    });

    it('does not remove the last artboard', () => {
      createProject();
      const { project } = useProjectStore.getState();
      const onlyId = project!.artboards[0].id;
      useProjectStore.getState().removeArtboard(onlyId);
      expect(useProjectStore.getState().project?.artboards).toHaveLength(1);
    });
  });

  describe('updateArtboard', () => {
    it('updates the artboard name', () => {
      createProject();
      const { selectedArtboardId } = useProjectStore.getState();
      useProjectStore
        .getState()
        .updateArtboard(selectedArtboardId!, { name: 'Renamed' });
      const updated = useProjectStore
        .getState()
        .project?.artboards.find((a) => a.id === selectedArtboardId);
      expect(updated?.name).toBe('Renamed');
    });

    it('updates the artboard size', () => {
      createProject();
      const { selectedArtboardId } = useProjectStore.getState();
      const newSize = { width: 800, height: 600 };
      useProjectStore
        .getState()
        .updateArtboard(selectedArtboardId!, { size: newSize });
      const updated = useProjectStore
        .getState()
        .project?.artboards.find((a) => a.id === selectedArtboardId);
      expect(updated?.size).toEqual(newSize);
    });
  });

  // ── Layer operations ──────────────────────────────────────────────────────

  describe('addTextLayer', () => {
    it('adds a text layer to the active artboard', () => {
      createProject();
      useProjectStore.getState().addTextLayer('Hello');
      const { project, selectedArtboardId } = useProjectStore.getState();
      const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);
      expect(artboard?.layerIds).toHaveLength(1);
    });

    it('returns the new layer id', () => {
      createProject();
      const id = useProjectStore.getState().addTextLayer('Hi');
      expect(typeof id).toBe('string');
    });

    it('stores the layer in the layers map', () => {
      createProject();
      const id = useProjectStore.getState().addTextLayer('World');
      const layer = useProjectStore.getState().project?.layers[id];
      expect(layer?.type).toBe('text');
      expect((layer as { content: string })?.content).toBe('World');
    });
  });

  describe('addShapeLayer', () => {
    it('adds a shape layer with the given shape type', () => {
      createProject();
      const id = useProjectStore.getState().addShapeLayer('rectangle');
      const layer = useProjectStore.getState().project?.layers[id];
      expect(layer?.type).toBe('shape');
    });
  });

  describe('removeLayer', () => {
    it('removes the layer from the artboard', () => {
      createProject();
      const id = useProjectStore.getState().addTextLayer('Delete me');
      useProjectStore.getState().removeLayer(id);
      const { project, selectedArtboardId } = useProjectStore.getState();
      const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);
      expect(artboard?.layerIds).not.toContain(id);
      expect(project?.layers[id]).toBeUndefined();
    });

    it('deselects the removed layer', () => {
      createProject();
      const id = useProjectStore.getState().addTextLayer('Remove select');
      useProjectStore.getState().selectLayer(id);
      useProjectStore.getState().removeLayer(id);
      expect(useProjectStore.getState().selectedLayerIds).not.toContain(id);
    });
  });

  describe('duplicateLayer', () => {
    it('creates a copy of the layer', () => {
      createProject();
      const id = useProjectStore.getState().addTextLayer('Original');
      const newId = useProjectStore.getState().duplicateLayer(id);
      expect(newId).not.toBeNull();
      expect(newId).not.toBe(id);
      const copy = useProjectStore.getState().project?.layers[newId!];
      expect(copy?.type).toBe('text');
    });

    it('names the copy with " copy" suffix', () => {
      createProject();
      const id = useProjectStore.getState().addTextLayer('Layer');
      const newId = useProjectStore.getState().duplicateLayer(id);
      const copy = useProjectStore.getState().project?.layers[newId!];
      expect(copy?.name.endsWith('copy')).toBe(true);
    });

    // Photoshop Ctrl+J duplicates IN PLACE, stacked directly on top. The store
    // passes offset {0,0} for exactly that reason (an offset made the copy jump).
    // This test used to assert the old +20 offset and had been failing since the
    // behaviour changed.
    it('duplicates in place — no position offset', () => {
      createProject();
      const id = useProjectStore.getState().addTextLayer('Offset');
      const orig = useProjectStore.getState().project?.layers[id];
      const origX = orig!.transform.x;
      const origY = orig!.transform.y;
      const newId = useProjectStore.getState().duplicateLayer(id);
      const copy = useProjectStore.getState().project?.layers[newId!];
      expect(copy?.transform.x).toBe(origX);
      expect(copy?.transform.y).toBe(origY);
    });

    it('adds the duplicate to the artboard layer list', () => {
      createProject();
      const id = useProjectStore.getState().addTextLayer('Dup');
      const newId = useProjectStore.getState().duplicateLayer(id);
      const { project, selectedArtboardId } = useProjectStore.getState();
      const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);
      expect(artboard?.layerIds).toContain(newId!);
    });
  });

  describe('reorder layers', () => {
    it('moveLayerDown moves the layer one position down in the list', () => {
      createProject();
      const id1 = useProjectStore.getState().addTextLayer('A');
      const id2 = useProjectStore.getState().addTextLayer('B');

      // After adding, order is [id2, id1] (newest on top).
      const { project, selectedArtboardId } = useProjectStore.getState();
      const artboard = project!.artboards.find((a) => a.id === selectedArtboardId)!;
      expect(artboard.layerIds[0]).toBe(id2);

      useProjectStore.getState().moveLayerDown(id2);
      const updated = useProjectStore
        .getState()
        .project!.artboards.find((a) => a.id === selectedArtboardId)!;
      expect(updated.layerIds[0]).toBe(id1);
      expect(updated.layerIds[1]).toBe(id2);
    });

    it('moveLayerUp moves the layer one position up in the list', () => {
      createProject();
      const id1 = useProjectStore.getState().addTextLayer('A');
      const id2 = useProjectStore.getState().addTextLayer('B');

      // order: [id2, id1]
      useProjectStore.getState().moveLayerUp(id1);
      const updated = useProjectStore
        .getState()
        .project!.artboards.find(
          (a) => a.id === useProjectStore.getState().selectedArtboardId,
        )!;
      expect(updated.layerIds[0]).toBe(id1);
      expect(updated.layerIds[1]).toBe(id2);
    });

    it('moveLayerToTop moves the layer to position 0', () => {
      createProject();
      const id1 = useProjectStore.getState().addTextLayer('A');
      useProjectStore.getState().addTextLayer('B');
      useProjectStore.getState().addTextLayer('C');

      useProjectStore.getState().moveLayerToTop(id1);
      const artboard = useProjectStore
        .getState()
        .project!.artboards.find(
          (a) => a.id === useProjectStore.getState().selectedArtboardId,
        )!;
      expect(artboard.layerIds[0]).toBe(id1);
    });

    it('moveLayerToBottom moves the layer to the last position', () => {
      createProject();
      useProjectStore.getState().addTextLayer('A');
      useProjectStore.getState().addTextLayer('B');
      const id3 = useProjectStore.getState().addTextLayer('C');

      useProjectStore.getState().moveLayerToBottom(id3);
      const artboard = useProjectStore
        .getState()
        .project!.artboards.find(
          (a) => a.id === useProjectStore.getState().selectedArtboardId,
        )!;
      expect(artboard.layerIds[artboard.layerIds.length - 1]).toBe(id3);
    });

    it('reorderLayers replaces the full layer order', () => {
      createProject();
      const id1 = useProjectStore.getState().addTextLayer('A');
      const id2 = useProjectStore.getState().addTextLayer('B');

      useProjectStore.getState().reorderLayers([id1, id2]);
      const artboard = useProjectStore
        .getState()
        .project!.artboards.find(
          (a) => a.id === useProjectStore.getState().selectedArtboardId,
        )!;
      expect(artboard.layerIds).toEqual([id1, id2]);
    });
  });

  describe('groupLayers / ungroupLayers', () => {
    it('groups two layers into a group layer', () => {
      createProject();
      const id1 = useProjectStore.getState().addShapeLayer('rectangle');
      const id2 = useProjectStore.getState().addShapeLayer('ellipse');
      const groupId = useProjectStore.getState().groupLayers([id1, id2]);
      expect(groupId).not.toBeNull();
      const group = useProjectStore.getState().project?.layers[groupId!];
      expect(group?.type).toBe('group');
    });

    it('ungroups a group layer and restores children to the artboard', () => {
      createProject();
      const id1 = useProjectStore.getState().addShapeLayer('rectangle');
      const id2 = useProjectStore.getState().addShapeLayer('ellipse');
      const groupId = useProjectStore.getState().groupLayers([id1, id2])!;
      useProjectStore.getState().ungroupLayers(groupId);

      const { project, selectedArtboardId } = useProjectStore.getState();
      const artboard = project!.artboards.find((a) => a.id === selectedArtboardId)!;
      expect(artboard.layerIds).toContain(id1);
      expect(artboard.layerIds).toContain(id2);
      expect(project?.layers[groupId]).toBeUndefined();
    });
  });
});

// ── Transactions + undoable assets ────────────────────────────────────────────
//
// The contract the agent depends on: one requested action is one undo step, and
// undo never leaves half of it behind. Every case here was broken before.

describe('runTransaction', () => {
  const asset = (id: string) => ({
    id, name: `Asset ${id}`, type: 'image' as const, mimeType: 'image/png',
    size: 10, width: 100, height: 100,
    thumbnailUrl: 'data:image/png;base64,AA', dataUrl: 'data:image/png;base64,AA',
  });

  it('collapses several mutations into ONE undo step', () => {
    createProject();
    const store = useProjectStore.getState();
    const depth = () => useHistoryStore.getState().getUndoDepth();
    const before = depth();

    let layerId = '';
    store.runTransaction('Place image', () => {
      useProjectStore.getState().addAsset(asset('a-1'));
      layerId = useProjectStore.getState().addImageLayer('a-1');
    });

    expect(depth()).toBe(before + 1);
    expect(useProjectStore.getState().project!.assets['a-1']).toBeDefined();
    expect(useProjectStore.getState().project!.layers[layerId]).toBeDefined();
  });

  it('one undo reverses the WHOLE action — no orphaned asset', () => {
    createProject();
    const store = useProjectStore.getState();
    let layerId = '';
    store.runTransaction('Place image', () => {
      useProjectStore.getState().addAsset(asset('a-1'));
      layerId = useProjectStore.getState().addImageLayer('a-1');
    });

    useProjectStore.getState().undo();
    const p = useProjectStore.getState().project!;
    expect(p.layers[layerId]).toBeUndefined();
    expect(p.assets['a-1']).toBeUndefined();
  });

  it('redo re-applies the whole action', () => {
    createProject();
    let layerId = '';
    useProjectStore.getState().runTransaction('Place image', () => {
      useProjectStore.getState().addAsset(asset('a-1'));
      layerId = useProjectStore.getState().addImageLayer('a-1');
    });
    useProjectStore.getState().undo();
    useProjectStore.getState().redo();
    const p = useProjectStore.getState().project!;
    expect(p.assets['a-1']).toBeDefined();
    expect(p.layers[layerId]).toBeDefined();
  });

  it('is all-or-nothing: a throw restores the document and records nothing', () => {
    createProject();
    const depthBefore = useHistoryStore.getState().getUndoDepth();
    const layersBefore = Object.keys(useProjectStore.getState().project!.layers).length;

    expect(() => {
      useProjectStore.getState().runTransaction('Broken macro', () => {
        useProjectStore.getState().addAsset(asset('a-1'));
        useProjectStore.getState().addImageLayer('a-1');
        throw new Error('provider failed halfway');
      });
    }).toThrow('provider failed halfway');

    const p = useProjectStore.getState().project!;
    expect(Object.keys(p.layers).length).toBe(layersBefore);
    expect(p.assets['a-1']).toBeUndefined();
    expect(useHistoryStore.getState().getUndoDepth()).toBe(depthBefore);
  });

  it('nests — an inner transaction joins the outer one', () => {
    createProject();
    const before = useHistoryStore.getState().getUndoDepth();
    useProjectStore.getState().runTransaction('Outer', () => {
      useProjectStore.getState().addTextLayer('One');
      useProjectStore.getState().runTransaction('Inner', () => {
        useProjectStore.getState().addTextLayer('Two');
        useProjectStore.getState().addTextLayer('Three');
      });
    });
    expect(useHistoryStore.getState().getUndoDepth()).toBe(before + 1);
    useProjectStore.getState().undo();
    expect(Object.keys(useProjectStore.getState().project!.layers)).toHaveLength(0);
  });

  it('returns the callback value, so callers get new ids back', () => {
    createProject();
    const id = useProjectStore.getState().runTransaction('Add', () =>
      useProjectStore.getState().addTextLayer('Headline'));
    expect(typeof id).toBe('string');
    expect(useProjectStore.getState().project!.layers[id]).toBeDefined();
  });

  it('records nothing when the callback mutates nothing', () => {
    createProject();
    const before = useHistoryStore.getState().getUndoDepth();
    useProjectStore.getState().runTransaction('No-op', () => 42);
    expect(useHistoryStore.getState().getUndoDepth()).toBe(before);
  });
});

describe('asset registration is undoable', () => {
  const asset = {
    id: 'a-9', name: 'Photo', type: 'image' as const, mimeType: 'image/png',
    size: 10, width: 10, height: 10,
    thumbnailUrl: 'data:image/png;base64,AA', dataUrl: 'data:image/png;base64,AA',
  };

  it('addAsset can be undone and redone', () => {
    createProject();
    useProjectStore.getState().addAsset(asset);
    expect(useProjectStore.getState().project!.assets['a-9']).toBeDefined();
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project!.assets['a-9']).toBeUndefined();
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project!.assets['a-9']).toBeDefined();
  });

  it('no longer destroys the redo stack (the old invalidateRedo behaviour)', () => {
    createProject();
    useProjectStore.getState().addTextLayer('One');
    useProjectStore.getState().undo();
    expect(useHistoryStore.getState().canRedo()).toBe(true);
    // Registering an asset used to wipe this pending redo.
    useProjectStore.getState().addAsset(asset);
    expect(useProjectStore.getState().project!.assets['a-9']).toBeDefined();
  });

  it('removeAsset restores the bytes on undo', () => {
    createProject();
    useProjectStore.getState().addAsset(asset);
    useProjectStore.getState().removeAsset('a-9');
    expect(useProjectStore.getState().project!.assets['a-9']).toBeUndefined();
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project!.assets['a-9'].dataUrl).toBe('data:image/png;base64,AA');
  });
});
