/**
 * The upload question as a dialog (BU3) and as state that follows the board:
 * focus moves in and is kept there, Escape keeps the file in this browser, an
 * unanswered question is asked again after a reload, and an undone drop is
 * taken out of the question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../board/parent-auth', () => ({ getParentToken: async () => null }));
const upload = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../board/document-export', async (orig) => ({
  ...(await orig<typeof import('../board/document-export')>()),
  uploadBlob: vi.fn(async (_b: Blob, name: string) => { upload.calls++; return `https://storage.test/${name}`; }),
}));

import { makeTestBoard, placeTestImage, type TestBoard } from '../blocksuite/test-board';
import type { MountedBoard } from '../blocksuite/editor';
import { installMediaStorage } from './media-storage';

let board: TestBoard;
let root: HTMLElement;
let chrome: HTMLElement;
const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const dialog = () => chrome.querySelector<HTMLElement>('.vs-upload-ask');
const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

function install(): void {
  installMediaStorage({
    workspace: board.workspace, store: board.store, std: board.std, doc: board.doc,
    host: board.std.host as unknown as HTMLElement, surfaceId: board.surfaceId, pageId: board.pageId, destroy: () => {},
  } as unknown as MountedBoard, root, chrome);
}

async function drop(name: string): Promise<{ key: string; id: string }> {
  const key = `sha-${name}`;
  await board.workspace.blobSource.native!.set(key, png(name));
  const id = placeTestImage(board, '[0,0,320,180]', { sourceId: key });
  await frame();
  return { key, id };
}

beforeEach(() => {
  upload.calls = 0;
  board = makeTestBoard();
  // A browser store that works (the test DOM has no IndexedDB).
  const mem = new Map<string, Blob>();
  (board.workspace.blobSource as unknown as { _local: unknown })._local = {
    get: async (k: string) => mem.get(k) ?? null, set: async (k: string, v: Blob) => { mem.set(k, v); return k; },
  };
  root = document.createElement('div'); chrome = document.createElement('div');
  chrome.innerHTML = '<div class="vs-board-bar"><button id="before">x</button></div>';
  document.body.append(root, chrome);
});
afterEach(() => { root.remove(); chrome.remove(); });

describe('the upload question dialog', () => {
  it('is a modal dialog that takes focus, keeps it, and gives it back', async () => {
    install();
    const before = chrome.querySelector<HTMLButtonElement>('#before')!;
    before.focus();
    await drop('a.png');
    const q = dialog()!;
    expect(q.getAttribute('role')).toBe('dialog');
    expect(q.getAttribute('aria-modal')).toBe('true');
    const [yes, no] = [...q.querySelectorAll('button')];
    expect(document.activeElement).toBe(yes);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(no);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(yes);
    // Focus wandering out is brought back.
    before.focus();
    expect(q.contains(document.activeElement)).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it('Escape keeps the file in this browser only, and nothing uploads', async () => {
    install();
    const { key } = await drop('a.png');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(board.workspace.blobSource.native!.records.get(key)?.upload).toBe('local');
    expect(upload.calls).toBe(0);
  });

  it('asks again after a reload when the question was never answered', async () => {
    const native = board.workspace.blobSource.native!;
    await native.set('sha-a.png', png('a.png'));
    placeTestImage(board, '[0,0,320,180]', { sourceId: 'sha-a.png' });
    expect(native.records.get('sha-a.png')?.upload).toBe('ask');
    // The question was on screen when the tab closed; this is the next open.
    install();
    await frame();
    expect(dialog()).not.toBeNull();
  });

  it('an undone drop is taken out of the open question', async () => {
    install();
    const a = await drop('a.png');
    const b = await drop('b.png');
    expect(dialog()!.textContent).toContain('these 2 files');
    board.store.deleteBlock(board.store.getBlock(b.id)!.model);
    await frame();
    expect(dialog()!.textContent).not.toContain('these 2 files');
    board.store.deleteBlock(board.store.getBlock(a.id)!.model);
    await frame();
    expect(dialog()).toBeNull();
    expect(upload.calls).toBe(0);
  });
});
