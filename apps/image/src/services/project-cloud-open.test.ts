import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ load: vi.fn(), flattened: vi.fn(), view: vi.fn(), status: vi.fn() }));
vi.mock('./voidspace-storage', () => ({ getVoidspaceIdToken: async () => 'test-token' }));
vi.mock('../stores/project-store', () => ({ useProjectStore: { getState: () => ({ loadProject: m.load }) } }));
vi.mock('../stores/ui-store', () => ({ useUIStore: { getState: () => ({ setFlattenedProjectId: m.flattened, setCurrentView: m.view }) } }));
vi.mock('./image-generation', () => ({ aspectRatioToSize: vi.fn() }));
vi.mock('./project-cloud-status', () => ({ setCloudSaveStatus: m.status }));
import { loadProjectDocument, openImageProjectWithCache } from './project-cloud-open';
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });
const doc = (updatedAt: number) => ({ id: 'p', updatedAt, artboards: [{ id: 'a' }], layers: {}, assets: {} }) as any;

it('opens newer edits from another device instead of an older local cache', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => doc(20) }));
  await openImageProjectWithCache('p', doc(10));
  expect(m.load).toHaveBeenCalledWith(doc(20));
});
it('preserves a newer local draft while its backup catches up', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => doc(10) }));
  await openImageProjectWithCache('p', doc(20));
  expect(m.load).toHaveBeenCalledWith(doc(20));
});
it('does not flatten after an authorization or connection failure', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 403 });
  vi.stubGlobal('fetch', fetcher);
  await expect(openImageProjectWithCache('p', null)).rejects.toThrow('could not be loaded');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(m.load).not.toHaveBeenCalled();
  await openImageProjectWithCache('p', doc(10));
  expect(m.load).toHaveBeenCalledWith(doc(10));
  expect(m.status).toHaveBeenCalledWith('p', expect.objectContaining({ state: 'error' }));
});
it('only treats a missing stored document as eligible for the legacy fallback', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
  expect(await loadProjectDocument('p')).toBeNull();
});
