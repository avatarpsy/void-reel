import { afterEach, expect, it, vi } from 'vitest';
import { bakeComposition } from './bake';
import { prepareFromSource } from './document';

const fixture = vi.hoisted(() => ({
  html: '<!DOCTYPE html><html><body><div data-composition-id="hero" data-width="1080" data-height="1920"><h1>Sample</h1><img src="sample.jpg"></div></body></html>',
  manifest: { headline: { kind: 'text' as const, sel: 'h1' }, image: { kind: 'image' as const, sel: 'img' } },
  source: { block: 'hero', slots: { headline: 'My actual headline', image: 'https://media/accepted.jpg' },
    frameWidth: 1080, frameHeight: 1350, fillMode: 'render' as const, poseTime: 'end' as const, renderHash: '' },
}));
vi.mock('./block-source', () => ({ resolveComposition: async () => ({ html: fixture.html, manifest: fixture.manifest, warnings: [] }) }));
vi.mock('../voidspace-storage', () => ({ getVoidspaceIdToken: async () => 'test-token', libraryImageToAsset: vi.fn() }));
vi.mock('../../stores/project-store', () => ({ useProjectStore: { getState: () => ({ project: { layers: {
  hero: { id: 'hero', type: 'image', name: 'Cover', transform: { width: 1080, height: 1350 }, composition: fixture.source },
} } }) } }));
afterEach(() => { vi.unstubAllGlobals(); });

it('dispatches the exact preview layout and slot values to the native still renderer', async () => {
  const fetcher = vi.fn(async (_url: unknown, _init: any) => Response.json({ error: 'test stops after dispatch' }));
  vi.stubGlobal('fetch', fetcher);
  await bakeComposition('hero');
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  const rendered = new DOMParser().parseFromString(body.html, 'text/html');
  const preview = new DOMParser().parseFromString(prepareFromSource(fixture.html, fixture.source, fixture.manifest).html, 'text/html');
  expect(rendered.querySelector('[data-composition-id]')?.outerHTML).toBe(preview.querySelector('[data-composition-id]')?.outerHTML);
  expect(rendered.querySelector('[data-composition-id]')?.getAttribute('data-height')).toBe('1350');
  expect(rendered.querySelector('h1')?.textContent).toBe('My actual headline');
  expect(rendered.querySelector('img')?.getAttribute('src')).toBe('https://media/accepted.jpg');
  expect(rendered.querySelectorAll('script')).toHaveLength(0);
  expect(body).toMatchObject({ format: 'png', width: 1080, height: 1350 });
  expect(body).not.toHaveProperty('block');
});
