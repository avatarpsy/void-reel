/**
 * A picture DROPPED onto the board must be usable as a generation reference.
 *
 * Live failure (6 Oct): two PNG character sheets dragged onto a board, then
 * `board_generate_media { referenceIds: [both] }` → "None of those ids are media
 * on the canvas". They were content keys in the board's blob store, and the
 * selection channel only knew how to answer for blocks that already had a url.
 *
 * Driven through the real RPC, the way the page asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./parent-auth', () => ({ getParentToken: async () => null }));

const upload = vi.hoisted(() => ({
  calls: 0,
  fail: '' as string,
}));
vi.mock('./document-export', async (orig) => ({
  ...(await orig<typeof import('./document-export')>()),
  uploadBlob: vi.fn(async (_blob: Blob, name: string) => {
    upload.calls++;
    if (upload.fail) throw new Error(upload.fail);
    return `https://storage.test/studio-mirrors/u/by-hash/${upload.calls}-${name}`;
  }),
}));

import { makeTestBoard, placeTestImage, type TestBoard } from '../blocksuite/test-board';
import { readBlockMeta, writeBlockMeta } from './board-meta';
import { encodeMediaRef } from './media-ref';
import { installBoardRpc } from '../agent/rpc';

let board: TestBoard;
let dispose: (() => void) | undefined;

function call(type: string, args: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = `t${Math.random()}`;
    const timer = setTimeout(() => reject(new Error(`${type} never replied`)), 4000);
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { requestId?: string; type?: string };
      if (d?.requestId !== requestId || d.type === type) return;
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      resolve(e.data);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ type, requestId, ...args }, '*');
  });
}

/** A PNG dropped the way `media-storage` drops one: bytes into the native
 *  store under a content key, an image block whose sourceId IS that key, and
 *  meta holding only `{ name, kind, createdBy }`. */
async function dropPng(name: string, x = 0): Promise<{ id: string; key: string }> {
  const key = `sha-${name}`;
  const native = board.workspace.blobSource.native!;
  await native.set(key, new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' }));
  // The person answered the board's question with Upload (the upload itself
  // is left to the request below, as when the drop-time upload is still pending).
  native.records.set(key, { ...native.records.get(key)!, upload: 'cloud' });
  const id = placeTestImage(board, `[${x},1200,320,180]`, { sourceId: key });
  writeBlockMeta(board.doc, id, { name, kind: 'image', createdBy: 'user' });
  return { id, key };
}

beforeEach(() => {
  upload.calls = 0;
  upload.fail = '';
  board = makeTestBoard();
  dispose = installBoardRpc({
    workspace: board.workspace,
    store: board.store,
    std: board.std,
    doc: board.doc,
    host: board.std.host as unknown as HTMLElement,
    surfaceId: board.surfaceId,
    pageId: board.pageId,
    destroy: () => {},
  }, {});
});

afterEach(() => { dispose?.(); dispose = undefined; });

describe('dropped pictures as generation references', () => {
  it('returns the durable https backup for a dropped PNG and records it as originalUrl', async () => {
    const { id } = await dropPng('sheet-a.png');
    const r = await call('voidspace:board-selection', { ids: [id] });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.mediaUrls).toHaveLength(1);
    expect(r.mediaUrls[0]).toMatch(/^https:\/\//);
    expect(r.mediaIds).toEqual([id]);
    expect(readBlockMeta(board.doc, id)?.originalUrl).toBe(r.mediaUrls[0]);
    // The drop's own backup and this request are ONE upload, not two.
    expect(upload.calls).toBe(1);
  });

  it('does not upload again on the second call', async () => {
    const a = await dropPng('sheet-a.png');
    const b = await dropPng('sheet-b.png', 400);
    const first = await call('voidspace:board-selection', { ids: [b.id, a.id] });
    const calls = upload.calls;
    const second = await call('voidspace:board-selection', { ids: [b.id, a.id] });
    expect(upload.calls).toBe(calls);
    expect(second.mediaUrls).toEqual(first.mediaUrls);
    // Order follows the caller.
    expect(second.mediaIds).toEqual([b.id, a.id]);
  });

  it('backs up once on demand when the drop-time backup failed, then reuses it', async () => {
    upload.fail = 'Cloud backup is unavailable. The original stays on this device.';
    const { id } = await dropPng('sheet-a.png');
    await new Promise(r => setTimeout(r, 0));
    upload.fail = '';
    const before = upload.calls;
    const r = await call('voidspace:board-selection', { ids: [id] });
    expect(r.mediaUrls[0]).toMatch(/^https:\/\//);
    expect(upload.calls).toBe(before + 1);
    await call('voidspace:board-selection', { ids: [id] });
    expect(upload.calls).toBe(before + 1);
  });

  it('reports storage full per id instead of "not media", and never returns a local address', async () => {
    upload.fail = 'There is not enough space in your account for this.';
    const { id } = await dropPng('sheet-a.png');
    const r = await call('voidspace:board-selection', { ids: [id] });
    expect(r.mediaUrls).toEqual([]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ id, reason: 'storage_full' });
    expect(r.problems[0].message).toContain('not enough space');
    expect(readBlockMeta(board.doc, id)?.originalUrl).toBeUndefined();
  });

  it('does not upload a drop nobody said yes to; the agent is told it is not uploaded yet', async () => {
    const key = 'sha-unanswered.png';
    await board.workspace.blobSource.native!.set(key, new File([new Uint8Array([137, 80, 78, 71])], 'unanswered.png', { type: 'image/png' }));
    const id = placeTestImage(board, '[0,1200,320,180]', { sourceId: key });
    writeBlockMeta(board.doc, id, { name: 'unanswered.png', kind: 'image', createdBy: 'user' });
    const r = await call('voidspace:board-selection', { ids: [id] });
    expect(r.mediaUrls).toEqual([]);
    expect(r.problems[0]).toMatchObject({ id, reason: 'unavailable' });
    expect(r.problems[0].message).toContain('has not been uploaded to Voidspace yet');
    expect(upload.calls).toBe(0);
  });

  it('never hands a vs-local: original to the server', async () => {
    const { id, key } = await dropPng('sheet-a.png');
    writeBlockMeta(board.doc, id, { originalUrl: `vs-local:${encodeURIComponent(key)}` });
    const r = await call('voidspace:board-selection', { ids: [id] });
    expect(r.mediaUrls).toHaveLength(1);
    expect(r.mediaUrls[0]).toMatch(/^https:\/\//);
  });

  it('still resolves Library media without uploading', async () => {
    const id = placeTestImage(board, '[0,1200,320,180]', {
      sourceId: encodeMediaRef({ src: 'https://cdn.test/lib.png', kind: 'image', mime: 'image/png' }),
    });
    const r = await call('voidspace:board-selection', { ids: [id] });
    expect(r.mediaUrls).toEqual(['https://cdn.test/lib.png']);
    expect(upload.calls).toBe(0);
  });

  it('rejects non-media as not_media and unknown ids as not_found', async () => {
    const drawn = await call('voidspace:board-draw', {
      elements: [{ kind: 'note', text: 'not media', x: 0, y: 2000 }],
    });
    const r = await call('voidspace:board-selection', { ids: [drawn.ids[0], 'nope'] });
    expect(r.mediaUrls).toEqual([]);
    expect(r.problems.map((p: any) => p.reason)).toEqual(['not_media', 'not_found']);
    expect(upload.calls).toBe(0);
  });
});
