import { beforeEach, expect, it, vi } from 'vitest';
const saves = vi.hoisted(() => ({ local: vi.fn(), cloud: vi.fn(), settle: vi.fn() }));
vi.mock('../hooks/useAutoSave', () => ({ saveProjectLocally: saves.local }));
vi.mock('../services/project-cloud-sync', () => ({ saveProjectDocument: saves.cloud }));
vi.mock('../services/composition/bake', () => ({ settleCompositions: saves.settle }));
import './output-rpc';
import { handleImageRpc } from './rpc';
import { useProjectStore } from '../stores/project-store';

beforeEach(() => {
  vi.clearAllMocks();
  saves.local.mockResolvedValue(undefined);
  saves.cloud.mockResolvedValue(true);
  saves.settle.mockResolvedValue(undefined);
  useProjectStore.getState().createProject('Draft', { width: 1080, height: 1350 });
  useProjectStore.getState().addTextLayer('Editable title');
});

async function save(): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = {};
  await handleImageRpc({ type: 'voidspace:img-save', requestId: 'save', mode: 'project', name: 'Psy carousel' }, r => { result = r; });
  return result;
}

it('saves the full editable document and reports both destinations', async () => {
  const result = await save();
  expect(result).toMatchObject({ ok: true, editable: true, localSaved: true, cloudSaved: true, name: 'Psy carousel' });
  const document = saves.local.mock.calls[0][0];
  expect(Object.values(document.layers)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', content: 'Editable title' })]));
  expect(saves.cloud).toHaveBeenCalledWith(document);
});

it('reports local-only success when the cloud backup fails', async () => {
  saves.cloud.mockResolvedValue(false);
  const result = await save();
  expect(result).toMatchObject({ ok: true, localSaved: true, cloudSaved: false });
  expect(result.warning).toContain('Cloud backup is unavailable');
});

it('does not claim success when the local save fails', async () => {
  saves.local.mockRejectedValue(new Error('Storage full'));
  expect(await save()).toMatchObject({ ok: false, reason: 'save_failed' });
  expect(saves.cloud).not.toHaveBeenCalled();
});
