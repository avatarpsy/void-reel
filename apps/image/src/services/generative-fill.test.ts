/**
 * The auth-header rule for collecting a fill result.
 *
 * ── WHY THIS TEST EXISTS ────────────────────────────────────────────────────
 * This is the guard for a bug that shipped and was invisible to every other kind
 * of test. `fetchAsDataUrl` fetched the result URL with no Authorization header —
 * correct for the cloud paths, whose URLs are public provider links, and wrong for
 * a local one, which is same-origin and behind `requireUserId`.
 *
 * The failure shape is why it needs a permanent guard: the render SUCCEEDS. The
 * GPU spikes, the node saves the file, the job reads `done` — and then the browser
 * gets a 401 collecting it, so the user sees a failure for work that was actually
 * done. Nothing server-side can catch it, because server-side tests set the header
 * by hand on every request.
 *
 * Two rules, and both matter:
 *   • same-origin gets the token, or a local fill 401s after doing the work;
 *   • cross-origin must NOT, or a Voidspace bearer leaks to a third party.
 *
 * `useCreativeSources` documents this same class ("a bare <img :src> cannot send a
 * header, so those requests 401") and CachedThumb solved it once before. It is the
 * third occurrence, so it is a rule now, not an incident.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fillEngine, FILL_MODELS, __fetchResultForTest, __startLocalFillForTest,
} from './generative-fill';

describe('fillEngine', () => {
  it('routes a local model id by SHAPE, not by a catalogue lookup', () => {
    // The picker's list is async; a fill can be triggered before it has loaded
    // (an agent tool, re-running a saved layer), so the id itself must decide.
    expect(fillEngine('local:this-machine/sdxl-inpaint')).toBe('local');
    expect(fillEngine('local:node-abc123/anything-at-all')).toBe('local');
  });

  it('keeps every cloud model on its existing engine', () => {
    for (const m of FILL_MODELS) {
      expect(fillEngine(m.id)).toBe(m.engine);
    }
  });

  it('defaults an unknown id to fal rather than local', () => {
    // A local engine skips the upload entirely, so mistaking a cloud id for a
    // local one would send nothing to the provider and fail confusingly.
    expect(fillEngine('some-model-we-have-never-heard-of')).toBe('fal');
  });
});

describe('collecting a result', () => {
  const TOKEN = 'test-id-token';
  let seen: Array<{ url: string; auth: string | undefined }>;

  beforeEach(() => {
    seen = [];
    vi.stubGlobal('window', { location: { origin: 'https://voidspace.ai' } });
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,AAAA';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { this.onload?.(); }
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      seen.push({
        url,
        auth: init?.headers?.Authorization ?? init?.headers?.authorization,
      });
      return { ok: true, status: 200, blob: async () => new Blob(['x']) } as any;
    }));
  });

  it('sends the token for a same-origin (our own, authed) result URL', async () => {
    await __fetchResultForTest('/api/studio/local-gen-file?f=2026-01-01/x.png', TOKEN);
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  it('sends the token for an absolute same-origin URL too', async () => {
    await __fetchResultForTest('https://voidspace.ai/api/studio/local-gen-file?f=a/b.png', TOKEN);
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  it('NEVER sends the token to a third-party provider URL', async () => {
    // A cloud result is a public link on someone else's host. Attaching our
    // bearer would hand a Voidspace credential to a provider.
    await __fetchResultForTest('https://cdn.some-provider.example/out/123.png', TOKEN);
    expect(seen[0].auth).toBeUndefined();
  });

  it('passes a data URL straight through without fetching', async () => {
    // The mesh path inlines the bytes because no route to a remote node's disk
    // exists; re-fetching it would be a pointless round trip.
    const out = await __fetchResultForTest('data:image/png;base64,ZZZZ', TOKEN);
    expect(out).toBe('data:image/png;base64,ZZZZ');
    expect(seen).toHaveLength(0);
  });

  it('does not invent a header when there is no token', async () => {
    await __fetchResultForTest('/api/studio/local-gen-file?f=a/b.png', undefined);
    expect(seen[0].auth).toBeUndefined();
  });
});

/**
 * THE REFERENCE AND THE STRUCTURE DIAL.
 *
 * Both are optional fields, and optional fields fail quietly: the server drops
 * anything the recipe does not declare (correct — that is how a recipe without an
 * IP-Adapter ignores a reference), so a client that never sent the field and a
 * recipe that cannot accept it look identical from the outside. The end-to-end
 * proof for this lives in `prove_web_reference.py`, which runs the same fill twice
 * changing only the reference weight and asserts the pixels differ. That needs a
 * GPU, so these hold the client half of the contract in CI.
 */
describe('optional fill inputs', () => {
  let form: FormData;

  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'https://voidspace.ai' } });
    vi.stubGlobal('File', class { constructor(public parts: any, public name: string) {} } as any);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: any) => {
      form = init?.body;
      return { ok: true, status: 200, json: async () => ({ jobId: 'j1', via: 'loopback' }) } as any;
    }));
  });

  const start = (extra: Record<string, unknown>) => __startLocalFillForTest({
    imageBlob: new Blob(['i']),
    maskBlob: new Blob(['m']),
    prompt: 'a plant',
    model: 'local:this-machine/edit-pro' as any,
    token: 'tok',
    ...extra,
  });

  it('sends the whole-image reference when one is supplied', async () => {
    await start({ referenceBlob: new Blob(['r']) });
    expect(form.has('reference')).toBe(true);
  });

  it('omits the reference entirely when there is none, rather than sending an empty part', async () => {
    await start({});
    expect(form.has('reference')).toBe(false);
  });

  it('carries referenceWeight and controlStrength through as their own fields', async () => {
    await start({ referenceBlob: new Blob(['r']), referenceWeight: 0.5, controlStrength: 0 });
    expect(form.get('referenceWeight')).toBe('0.5');
    // 0 is meaningful — it is the shipped default and means "replace freely".
    // A truthiness check here would drop it and silently re-enable structure lock.
    expect(form.get('controlStrength')).toBe('0');
  });

  it('leaves both out when the caller did not choose, so recipe defaults win', async () => {
    await start({ referenceBlob: new Blob(['r']) });
    expect(form.has('referenceWeight')).toBe(false);
    expect(form.has('controlStrength')).toBe(false);
  });
});
