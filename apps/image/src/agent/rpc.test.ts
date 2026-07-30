import { describe, it, expect, beforeEach } from 'vitest';
import { handleImageRpc, isImageRpc, registerImageMutation } from './rpc';
import { useProjectStore, getProjectRev } from '../stores/project-store';
import { useHistoryStore } from '../stores/history-store';
import { useUIStore } from '../stores/ui-store';

const SIZE = { width: 1080, height: 1080 };

function reset() {
  useHistoryStore.setState({
    undoStack: [], redoStack: [], baseProject: null, maxSize: 50,
    snapshots: [], mergeBarrierAt: 0, evictedCount: 0,
  });
  useProjectStore.setState({
    project: null, selectedLayerIds: [], selectedArtboardId: null,
    copiedLayers: [], copiedStyle: null, isDirty: false,
  });
  useUIStore.setState({ flattenedProjectId: null, editSource: null });
}

function createProject() {
  useProjectStore.getState().createProject('Poster', SIZE, { type: 'color', color: '#fff' });
}

/** Call an RPC and return the single reply payload. */
async function rpc(msg: Record<string, unknown>): Promise<any> {
  let reply: any = null;
  const handled = await handleImageRpc({ requestId: 'r1', ...msg }, (p) => { reply = p; });
  expect(handled).toBe(true);
  return reply;
}

describe('image RPC namespace', () => {
  beforeEach(reset);

  it('only claims voidspace:img-* messages', () => {
    expect(isImageRpc('voidspace:img-get-state')).toBe(true);
    // The VIDEO editor answers these. If both editors are ever mounted together,
    // answering a bare voidspace:get-state would hand the chat a picture digest
    // where it asked for a timeline.
    expect(isImageRpc('voidspace:get-state')).toBe(false);
    expect(isImageRpc('something-else')).toBe(false);
  });

  it('ignores foreign messages entirely', async () => {
    let called = false;
    const handled = await handleImageRpc({ type: 'voidspace:get-state' }, () => { called = true; });
    expect(handled).toBe(false);
    expect(called).toBe(false);
  });

  it('replies with a matching requestId', async () => {
    createProject();
    const r = await rpc({ type: 'voidspace:img-get-state' });
    expect(r.requestId).toBe('r1');
    expect(r.type).toBe('voidspace:img-get-state:result');
  });

  it('reports an unknown RPC instead of hanging the caller', async () => {
    const r = await rpc({ type: 'voidspace:img-nonexistent' });
    expect(r.type).toBe('voidspace:error');
    expect(String(r.error)).toMatch(/unknown image RPC/i);
  });
});

describe('img-get-state digest', () => {
  beforeEach(reset);

  it('says plainly when no project is open', async () => {
    const r = await rpc({ type: 'voidspace:img-get-state' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_project');
  });

  it('describes pages, layers and text content', async () => {
    createProject();
    useProjectStore.getState().addTextLayer('Summer Sale');
    const r = await rpc({ type: 'voidspace:img-get-state' });
    expect(r.ok).toBe(true);
    expect(r.pageCount).toBe(1);
    expect(r.pages[0].width).toBe(1080);
    const text = r.pages[0].layers.find((l: any) => l.type === 'text');
    expect(text.text.content).toBe('Summer Sale');
    expect(text.bounds).toHaveProperty('x');
  });

  it('NEVER ships pixel data — a digest must stay small', async () => {
    createProject();
    const bigDataUrl = `data:image/png;base64,${'A'.repeat(200_000)}`;
    useProjectStore.getState().addAsset({
      id: 'a-1', name: 'Photo', type: 'image', mimeType: 'image/png',
      size: bigDataUrl.length, width: 2000, height: 2000,
      thumbnailUrl: bigDataUrl, dataUrl: bigDataUrl,
    });
    useProjectStore.getState().addImageLayer('a-1');
    const r = await rpc({ type: 'voidspace:img-get-state' });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('data:image');
    expect(serialized.length).toBeLessThan(20_000);
    // …but the agent still learns the asset exists and how big it is.
    expect(r.assets.find((a: any) => a.id === 'a-1').width).toBe(2000);
  });

  it('includeLayers:false returns page headers only', async () => {
    createProject();
    useProjectStore.getState().addTextLayer('One');
    const r = await rpc({ type: 'voidspace:img-get-state', includeLayers: false });
    expect(r.pages[0].layerCount).toBe(1);
    expect(r.pages[0].layers).toBeUndefined();
  });

  it('reports layered:true for a normal local project', async () => {
    createProject();
    const r = await rpc({ type: 'voidspace:img-get-state' });
    expect(r.layered).toBe(true);
  });

  it('reports layered:false for a flattened cross-device rebuild', async () => {
    createProject();
    const id = useProjectStore.getState().project!.id;
    useUIStore.getState().setFlattenedProjectId(id);
    const r = await rpc({ type: 'voidspace:img-get-state' });
    expect(r.layered).toBe(false);
  });

  it('the flattened flag cannot leak onto the next project', async () => {
    createProject();
    useUIStore.getState().setFlattenedProjectId(useProjectStore.getState().project!.id);
    // User starts something new; the old flag must not mislabel it.
    createProject();
    const r = await rpc({ type: 'voidspace:img-get-state' });
    expect(r.layered).toBe(true);
  });
});

describe('mutations: one undo step, user outranks agent', () => {
  registerImageMutation('voidspace:img-test-add-two', 'Add two layers', () => {
    const a = useProjectStore.getState().addTextLayer('A');
    const b = useProjectStore.getState().addTextLayer('B');
    return { layerIds: [a, b] };
  });

  beforeEach(reset);

  it('a multi-part agent action is ONE undo step', async () => {
    createProject();
    const before = useHistoryStore.getState().getUndoDepth();
    const r = await rpc({ type: 'voidspace:img-test-add-two' });
    expect(r.ok).toBe(true);
    expect(useHistoryStore.getState().getUndoDepth()).toBe(before + 1);

    useProjectStore.getState().undo();
    expect(Object.keys(useProjectStore.getState().project!.layers)).toHaveLength(0);
  });

  it('returns a fresh rev so the next call is not stale by construction', async () => {
    createProject();
    const r = await rpc({ type: 'voidspace:img-test-add-two' });
    expect(r.rev).toBe(getProjectRev());
  });

  it('rev is monotonic, not a timestamp — two edits in the same millisecond differ', async () => {
    createProject();
    // This is the bug the guard originally had: project.updatedAt is Date.now(),
    // so a user edit and an agent edit inside one millisecond shared a rev and a
    // stale write sailed straight through.
    const a = getProjectRev();
    useProjectStore.getState().addTextLayer('One');
    useProjectStore.getState().addTextLayer('Two');
    const b = getProjectRev();
    expect(b).toBeGreaterThan(a + 1);
  });

  it('REFUSES an edit computed from a stale read', async () => {
    createProject();
    const read = await rpc({ type: 'voidspace:img-get-state' });
    // The user edits by hand while the agent is thinking.
    useProjectStore.getState().addTextLayer('User typed this');

    const r = await rpc({ type: 'voidspace:img-test-add-two', expectRev: read.rev });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('canvas_changed');
    // And the user's work is untouched.
    const names = Object.values(useProjectStore.getState().project!.layers).map((l: any) => l.name);
    expect(names).toContain('User typed this');
    expect(names).not.toContain('A');
  });

  it('allows an edit whose expectRev is current', async () => {
    createProject();
    const read = await rpc({ type: 'voidspace:img-get-state' });
    const r = await rpc({ type: 'voidspace:img-test-add-two', expectRev: read.rev });
    expect(r.ok).toBe(true);
  });

  it('allows an edit with no expectRev (nothing to be stale against)', async () => {
    createProject();
    const r = await rpc({ type: 'voidspace:img-test-add-two' });
    expect(r.ok).toBe(true);
  });

  it('refuses to mutate when no project is open', async () => {
    const r = await rpc({ type: 'voidspace:img-test-add-two' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_project');
  });

  it('two agent actions stay two separate undo steps', async () => {
    createProject();
    const before = useHistoryStore.getState().getUndoDepth();
    await rpc({ type: 'voidspace:img-test-add-two' });
    await rpc({ type: 'voidspace:img-test-add-two' });
    expect(useHistoryStore.getState().getUndoDepth()).toBe(before + 2);
  });
});

describe('checkpoints drive per-turn rewind', () => {
  beforeEach(reset);

  it('rewinds exactly the work done since the checkpoint', async () => {
    createProject();
    useProjectStore.getState().addTextLayer('Kept');
    const { checkpoint } = await rpc({ type: 'voidspace:img-checkpoint', label: 'turn 1' });

    useHistoryStore.getState().breakCoalescing();
    useProjectStore.getState().addTextLayer('Agent A');
    useHistoryStore.getState().breakCoalescing();
    useProjectStore.getState().addTextLayer('Agent B');

    const r = await rpc({ type: 'voidspace:img-restore-checkpoint', checkpoint });
    expect(r.ok).toBe(true);
    expect(r.undone).toBe(2);
    const names = Object.values(useProjectStore.getState().project!.layers).map((l: any) => l.name);
    expect(names).toEqual(['Kept']);
  });

  it('says so honestly when the checkpoint is too old to reach', async () => {
    createProject();
    useHistoryStore.setState({ maxSize: 3 });
    useProjectStore.getState().addTextLayer('A');
    const { checkpoint } = await rpc({ type: 'voidspace:img-checkpoint' });
    for (const n of ['B', 'C', 'D', 'E']) {
      useHistoryStore.getState().breakCoalescing();
      useProjectStore.getState().addTextLayer(n);
    }
    const r = await rpc({ type: 'voidspace:img-restore-checkpoint', checkpoint });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('checkpoint_evicted');
    expect(String(r.message)).toMatch(/50-step|older/i);
  });

  it('undo/redo through chat match the toolbar buttons', async () => {
    createProject();
    useProjectStore.getState().addTextLayer('One');
    const u = await rpc({ type: 'voidspace:img-undo' });
    expect(u.ok).toBe(true);
    expect(Object.keys(useProjectStore.getState().project!.layers)).toHaveLength(0);
    const r = await rpc({ type: 'voidspace:img-redo' });
    expect(r.ok).toBe(true);
    expect(Object.keys(useProjectStore.getState().project!.layers)).toHaveLength(1);
  });

  it('reports nothing-to-undo rather than pretending it worked', async () => {
    createProject();
    const r = await rpc({ type: 'voidspace:img-undo' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nothing_to_undo');
  });
});

// ── Agent edits are first-class history ───────────────────────────────────────
//
// The user's requirement: anything the agent does must be visible and reversible
// through the SAME History panel, undo/redo and snapshots as hand edits. The
// panel renders `getEntries()`, so these assert on exactly what it shows.

describe('agent edits appear in the History panel', () => {
  registerImageMutation('voidspace:img-test-place', 'Place image', () => {
    useProjectStore.getState().addAsset({
      id: 'a-hist', name: 'Photo', type: 'image', mimeType: 'image/png',
      size: 10, width: 10, height: 10,
      thumbnailUrl: 'data:image/png;base64,AA', dataUrl: 'data:image/png;base64,AA',
    });
    return { layerId: useProjectStore.getState().addImageLayer('a-hist') };
  });

  beforeEach(reset);

  it('shows ONE entry carrying the action label the user would recognise', async () => {
    createProject();
    const before = useHistoryStore.getState().getEntries().length;
    await rpc({ type: 'voidspace:img-test-place' });

    const entries = useHistoryStore.getState().getEntries();
    expect(entries.length).toBe(before + 1);
    // Not "Add layer" / "Add asset" — the label of the ACTION that was asked for.
    expect(entries[entries.length - 1].description).toBe('Place image');
  });

  it('is what the undo button would reverse next', async () => {
    createProject();
    await rpc({ type: 'voidspace:img-test-place' });
    expect(useHistoryStore.getState().getUndoDescription()).toBe('Place image');
  });

  it('undo then redo round-trips the whole agent action', async () => {
    createProject();
    const r: any = await rpc({ type: 'voidspace:img-test-place' });
    const layerId = r.layerId;

    useProjectStore.getState().undo();
    let p = useProjectStore.getState().project!;
    expect(p.layers[layerId]).toBeUndefined();
    expect(p.assets['a-hist']).toBeUndefined();   // no orphan left behind

    useProjectStore.getState().redo();
    p = useProjectStore.getState().project!;
    expect(p.layers[layerId]).toBeDefined();
    expect(p.assets['a-hist']).toBeDefined();
  });

  it('interleaves correctly with the user\'s own edits, newest last', async () => {
    createProject();
    useProjectStore.getState().addTextLayer('User headline');
    useHistoryStore.getState().breakCoalescing();
    await rpc({ type: 'voidspace:img-test-place' });

    const descriptions = useHistoryStore.getState().getEntries().map((e) => e.description);
    expect(descriptions[descriptions.length - 1]).toBe('Place image');
    expect(descriptions.length).toBeGreaterThanOrEqual(2);
  });

  it('named snapshots still capture state around agent work', async () => {
    createProject();
    await rpc({ type: 'voidspace:img-test-place' });
    const project = useProjectStore.getState().project!;
    useHistoryStore.getState().createSnapshot('after agent edit', project);

    const snaps = useHistoryStore.getState().getSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].name).toBe('after agent edit');
    const restored = useHistoryStore.getState().restoreSnapshot(snaps[0].id);
    expect(restored?.assets['a-hist']).toBeDefined();
  });
});
