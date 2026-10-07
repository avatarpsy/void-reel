/**
 * Carousel pages must outlive the draft, and the draft must name an avatar.
 * Pages went to 3-day temp storage and drafts published as avatarId "".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableUploadRefusedError, resolvePublishAvatar, uploadDurablePage } from './carousel-publish';
import { NotSignedInError } from './voidspace-storage';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const page = () => new File([new Uint8Array([1, 2, 3])], 'slide-1.jpg', { type: 'image/jpeg' });
// header.payload.sig with aud = the Firebase project.
const token = `x.${btoa(JSON.stringify({ aud: 'proj-1', user_id: 'u1' }))}.y`;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('uploadDurablePage', () => {
  it('uses the durable door and returns its url', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, placement: 'durable', url: 'https://cdn.test/p1.jpg' }));
    expect(await uploadDurablePage(page(), token)).toBe('https://cdn.test/p1.jpg');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/studio/upload-attachment');
    expect(init.headers['x-voidspace-durable-only']).toBe('1');
    expect(init.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('storage full is a clear refusal, never a temp link', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: false, placement: 'local', reason: 'temp_quota', note: 'full' }));
    const e = await uploadDurablePage(page(), token).catch(x => x);
    expect(e).toBeInstanceOf(DurableUploadRefusedError);
    expect(e.message).toMatch(/storage is full/i);
  });

  it('a server storage hiccup is a retryable error, not a refusal', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: false, placement: 'local', reason: 'temp_failed' }));
    const e = await uploadDurablePage(page(), token).catch(x => x);
    expect(e).not.toBeInstanceOf(DurableUploadRefusedError);
  });

  it('401 means signed out', async () => {
    fetchMock.mockResolvedValue(json(401, {}));
    expect(await uploadDurablePage(page(), token).catch(x => x)).toBeInstanceOf(NotSignedInError);
  });
});

describe('resolvePublishAvatar', () => {
  const doc = (avatars: unknown[]) => json(200, { fields: { automationAvatars: { arrayValue: { values: avatars } } } });
  const avatar = (id: string, name: string, connected: string[] = []) => ({ mapValue: { fields: {
    avatarId: { stringValue: id }, avatarName: { stringValue: name },
    socialAccountsConnected: { arrayValue: { values: connected.map(c => ({ stringValue: c })) } },
  } } });

  it('reads the user\'s own subscription doc and picks the avatar with connected accounts', async () => {
    fetchMock.mockResolvedValue(doc([avatar('a1', 'First'), avatar('a2', 'Social', ['instagram'])]));
    expect(await resolvePublishAvatar(token, 'u1')).toEqual({ avatarId: 'a2', avatarName: 'Social' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://firestore.googleapis.com/v1/projects/proj-1/databases/(default)/documents/avatar_automation_subscriptions/u1');
  });

  it('falls back to the first avatar, and to null when there is none or it cannot be read', async () => {
    fetchMock.mockResolvedValue(doc([avatar('a1', 'First')]));
    expect((await resolvePublishAvatar(token, 'u1'))?.avatarId).toBe('a1');
    fetchMock.mockResolvedValue(doc([]));
    expect(await resolvePublishAvatar(token, 'u1')).toBeNull();
    fetchMock.mockResolvedValue(json(403, {}));
    expect(await resolvePublishAvatar(token, 'u1')).toBeNull();
  });
});
