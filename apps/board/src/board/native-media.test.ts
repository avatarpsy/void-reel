/**
 * The board's one upload question, and what may upload without a yes.
 *
 * Certification (7 Oct 2026) found three ways a dropped file reached the
 * server without the person's yes (an agent's durable reference, a provider
 * temp copy, share preparation), and a storage-full refusal that re-sent up to
 * 200 MB per file on every board open. These pin the states that fix that.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('./parent-auth', () => ({ getParentToken: async () => null }));

const upload = vi.hoisted(() => ({ calls: [] as string[], fail: null as null | (() => Error) }));
vi.mock('./document-export', async (orig) => ({
  ...(await orig<typeof import('./document-export')>()),
  uploadBlob: vi.fn(async (_blob: Blob, name: string, purpose = 'durable') => {
    upload.calls.push(`${purpose}:${name}`);
    if (upload.fail) throw upload.fail();
    return `https://storage.test/${purpose}/${upload.calls.length}-${name}`;
  }),
}));

import { SharedError } from '@openreel/asset-browser';
import { UploadRefusedError, uploadWaitMs } from './document-export';
import {
  BROWSER_ONLY_MESSAGE, NEEDS_UPLOAD_CHOICE, NOT_UPLOADED_MESSAGE, NativeMediaStore,
  isUploadRefusal, retryDelayMs,
} from './native-media';

type Local = { get(k: string): Promise<Blob | null>; set(k: string, b: Blob): Promise<string> };
let doc: Y.Doc;
let bytes: Map<string, Blob>;
const local = (): Local => ({
  get: async k => bytes.get(k) ?? null,
  set: async (k, b) => { bytes.set(k, b); return k; },
});
const open = () => new NativeMediaStore('b1', doc, local as never);
const png = (name = 'a.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
const settle = () => new Promise(r => setTimeout(r, 0));
const STORAGE_FULL = 'There is not enough space in your account for this.';

beforeEach(() => {
  doc = new Y.Doc();
  bytes = new Map();
  upload.calls = [];
  upload.fail = null;
});

describe('the question', () => {
  it('a drop asks, remembers the question is open, and uploads nothing', async () => {
    const store = open();
    const asked: string[] = [];
    store.addEventListener(NEEDS_UPLOAD_CHOICE, e => asked.push((e as CustomEvent<string>).detail));
    await store.set('k1', png());
    await settle();
    expect(asked).toEqual(['k1']);
    expect(store.records.get('k1')?.upload).toBe('ask');
    // A reload finds it still waiting, so the board asks again.
    expect(open().awaitingAnswer('k1')).toBe(true);
    expect(upload.calls).toEqual([]);
  });

  it('a yes uploads and clears the question; a keep-local is never uploaded', async () => {
    const store = open();
    await store.set('yes', png('yes.png'));
    await store.set('no', png('no.png'));
    expect(await store.upload('yes')).toMatch(/^https:/);
    store.keepLocal('no');
    expect(store.awaitingAnswer('yes')).toBe(false);
    expect(store.records.get('no')?.upload).toBe('local');
    expect(upload.calls).toEqual(['durable:yes.png']);
  });
});

describe('nothing uploads without a yes (BU2)', () => {
  it('durableUrl on an unanswered file asks the person and tells the agent "not uploaded yet"', async () => {
    const store = open();
    await store.set('k1', png());
    const asked: string[] = [];
    store.addEventListener(NEEDS_UPLOAD_CHOICE, e => asked.push((e as CustomEvent<string>).detail));
    await expect(store.durableUrl('k1')).rejects.toThrow(NOT_UPLOADED_MESSAGE);
    expect(asked).toEqual(['k1']);
    expect(upload.calls).toEqual([]);
  });

  it('durableUrl on a legacy file (no answer recorded) does not upload either', async () => {
    const store = open();
    bytes.set('old', png());
    store.records.set('old', { name: 'old.png', mime: 'image/png', bytes: 4 });
    await expect(store.durableUrl('old')).rejects.toThrow(NOT_UPLOADED_MESSAGE);
    expect(store.records.get('old')?.upload).toBe('ask');
    expect(upload.calls).toEqual([]);
  });

  it('a kept-local file is refused to durableUrl and to providerReference', async () => {
    const store = open();
    await store.set('k1', png());
    store.keepLocal('k1');
    await expect(store.durableUrl('k1')).rejects.toThrow(BROWSER_ONLY_MESSAGE);
    await expect(store.providerReference('k1')).rejects.toThrow(BROWSER_ONLY_MESSAGE);
    expect(store.browserOnlyMessage('k1')).toBe(BROWSER_ONLY_MESSAGE);
    expect(upload.calls).toEqual([]);
  });

  it('providerReference on an unanswered file says "not uploaded yet", not "chose not to"', async () => {
    const store = open();
    await store.set('k1', png());
    await expect(store.providerReference('k1')).rejects.toThrow(NOT_UPLOADED_MESSAGE);
    expect(store.browserOnlyMessage('k1')).toBe(NOT_UPLOADED_MESSAGE);
    expect(NOT_UPLOADED_MESSAGE).not.toContain('chose not to');
    expect(upload.calls).toEqual([]);
  });

  it('providerReference after a yes makes a temporary copy', async () => {
    const store = open();
    await store.set('k1', png());
    store.records.set('k1', { ...store.records.get('k1')!, upload: 'cloud' });
    expect(await store.providerReference('k1')).toMatch(/\/provider\//);
  });

  it('share preparation uploads the yes files and skips kept-local and unanswered ones', async () => {
    const store = open();
    await store.set('yes', png('yes.png'));
    await store.set('local', png('local.png'));
    await store.set('unanswered', png('unanswered.png'));
    store.records.set('yes', { ...store.records.get('yes')!, upload: 'cloud' });
    store.keepLocal('local');
    const { skipped } = await store.prepareForSharing();
    expect(skipped.sort()).toEqual(['local', 'unanswered']);
    expect(upload.calls).toEqual(['durable:yes.png']);
    expect(store.cloudUrl('yes')).toMatch(/^https:/);
  });
});

describe('a refused upload is not retried by itself (BU1)', () => {
  it('storage full marks the file refused; reopening the board sends nothing', async () => {
    const store = open();
    await store.set('k1', png());
    upload.fail = () => new UploadRefusedError(STORAGE_FULL, 507);
    expect(await store.upload('k1')).toBeUndefined();
    expect(store.records.get('k1')).toMatchObject({ upload: 'refused', refusal: STORAGE_FULL });
    expect(upload.calls).toHaveLength(1);

    const reopened = open();
    expect(await reopened.get('k1')).not.toBeNull();
    await settle();
    expect(upload.calls).toHaveLength(1);
    // An agent is told why, without another upload.
    await expect(reopened.durableUrl('k1')).rejects.toThrow(STORAGE_FULL);
    expect(upload.calls).toHaveLength(1);
  });

  it('"Open Files to retry" uploads again and clears the refusal', async () => {
    const store = open();
    await store.set('k1', png());
    upload.fail = () => new UploadRefusedError(STORAGE_FULL, 507);
    await store.upload('k1');
    upload.fail = null;
    expect(await store.upload('k1')).toMatch(/^https:/);
    const record = store.records.get('k1')!;
    expect(record.upload).toBe('cloud');
    expect(record.refusal).toBeUndefined();
  });

  it('a network failure backs off instead of retrying on every open', async () => {
    const store = open();
    await store.set('k1', png());
    upload.fail = () => new Error('That could not be uploaded. Check your connection.');
    const before = Date.now();
    await store.upload('k1');
    const record = store.records.get('k1')!;
    expect(record.upload).toBe('cloud');
    expect(record.attempts).toBe(1);
    expect(record.retryAt).toBeGreaterThanOrEqual(before + retryDelayMs(1));

    upload.fail = null;
    await open().get('k1');
    await settle();
    expect(upload.calls).toHaveLength(1);

    // Once the back-off has passed, an open finishes the upload they said yes to.
    store.records.set('k1', { ...store.records.get('k1')!, retryAt: Date.now() - 1 });
    const later = open();
    await later.get('k1');
    await vi.waitFor(() => expect(later.cloudUrl('k1')).toMatch(/^https:/));
    expect(store.records.get('k1')?.attempts).toBeUndefined();
  });
});

describe('helpers', () => {
  it('classifies server refusals apart from network failures', () => {
    expect(isUploadRefusal(new UploadRefusedError('full', 507))).toBe(true);
    expect(isUploadRefusal(new SharedError('full', 507))).toBe(true);
    expect(isUploadRefusal(new SharedError('down', 502))).toBe(false);
    expect(isUploadRefusal(new SharedError('rejected', 413))).toBe(true);
    expect(isUploadRefusal(new SharedError('sign in', 401))).toBe(false);
    expect(isUploadRefusal(new SharedError('busy', 429))).toBe(false);
    expect(isUploadRefusal(new Error('offline'))).toBe(false);
  });

  it('backs off 1 min, doubling, capped at 6 h', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(240_000);
    expect(retryDelayMs(50)).toBe(6 * 60 * 60_000);
  });

  it('gives a large upload time for its bytes', () => {
    expect(uploadWaitMs(0)).toBe(60_000);
    expect(uploadWaitMs(200 * 1024 * 1024)).toBeGreaterThan(13 * 60_000);
  });
});
