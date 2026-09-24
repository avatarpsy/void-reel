import { beforeEach, expect, it, vi } from 'vitest';
import { settledPage } from './settled-page';
import { compositionHash } from './hash';

const state = vi.hoisted(() => ({ project: null as any, settle: vi.fn() }));
vi.mock('../../stores/project-store', () => ({ useProjectStore: { getState: () => state } }));
vi.mock('./bake', () => ({ settleCompositions: state.settle, lastBakeFailure: () => null }));
beforeEach(() => {
  state.settle.mockReset();
  const composition = { block: 'hero', slots: { headline: 'Pause' }, fillMode: 'render', poseTime: 'end', frameWidth: 1080, frameHeight: 1350, renderHash: '' };
  state.project = { id: 'draft', artboards: [{ id: 'cover', layerIds: ['hero'] }], assets: {}, layers: {
    hero: { id: 'hero', name: 'Cover', type: 'image', visible: true, transform: { opacity: 1 }, sourceId: '', composition },
  } };
});

function finishRender() {
  const old = state.project;
  state.project = { ...old, assets: { pixels: { id: 'pixels' } }, layers: {
    hero: { ...old.layers.hero, sourceId: 'pixels', composition: {
      ...old.layers.hero.composition, renderHash: compositionHash(old.layers.hero.composition),
    } },
  } };
}

it('waits for pending pixels and returns the new document, not the blank snapshot', async () => {
  const blank = state.project;
  let release!: () => void;
  state.settle.mockImplementation(() => new Promise<void>(resolve => { release = () => { finishRender(); resolve(); }; }));
  const complete = vi.fn();
  const pending = settledPage('draft', 'cover').then(complete);
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  release();
  await pending;
  expect(complete.mock.calls[0][0].project).not.toBe(blank);
  expect(complete.mock.calls[0][0].project.layers.hero.sourceId).toBe('pixels');
});

it('refuses a blank or stale render instead of returning an inspectable success', async () => {
  await expect(settledPage('draft', 'cover')).rejects.toThrow('do not rebuild');
  finishRender();
  state.project.layers.hero.composition.slots.headline = 'New copy';
  await expect(settledPage('draft', 'cover')).rejects.toThrow('render');
});

it('refuses a different project opened while rendering', async () => {
  state.settle.mockImplementation(() => { state.project = { ...state.project, id: 'other' }; });
  await expect(settledPage('draft', 'cover')).rejects.toThrow('project changed');
});

it('checks visible compositions inside groups, allowing hidden drafts', async () => {
  state.project.artboards[0].layerIds = ['group'];
  state.project.layers.group = { type: 'group', childIds: ['hero'], visible: true, transform: { opacity: 1 } };
  await expect(settledPage('draft', 'cover')).rejects.toThrow('Cover');
  state.project.layers.group.visible = false;
  await expect(settledPage('draft', 'cover')).resolves.toHaveProperty('page.id', 'cover');
});
