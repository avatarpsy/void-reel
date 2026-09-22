/**
 * Dropping a document on the board.
 *
 * The behaviour that matters is what it does NOT take. Claiming every drop
 * would break images, video and attachments — everything the board already
 * handles — so these pin the boundary as hard as the happy path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toasts: Array<[string, string]> = [];
vi.mock('../ui/toast', () => ({ toast: (m: string, k: string) => { toasts.push([m, k]); } }));

const opened: string[] = [];
vi.mock('./toolbar', () => ({
  OPEN_DOCUMENT_EVENT: 'voidspace-open-note-document',
  requestOpenDocument: (id: string) => { opened.push(id); },
}));

import { makeTestBoard } from '../blocksuite/test-board';
import { installDocumentDrop } from './import-drop';
import { listDocuments } from './sections';

function drop(el: HTMLElement, files: File[]): DragEvent {
  const e = new Event('drop', { bubbles: true, cancelable: true }) as any;
  e.dataTransfer = { files, items: files.map(() => ({ kind: 'file' })) };
  e.clientX = 100;
  e.clientY = 100;
  el.dispatchEvent(e);
  return e;
}

const file = (name: string, body: string, type = 'text/plain') =>
  new File([body], name, { type });

let host: HTMLElement;
let board: any;
let dispose: () => void;

beforeEach(() => {
  toasts.length = 0;
  opened.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  board = makeTestBoard();
  dispose = installDocumentDrop(board, host);
});
afterEach(() => { dispose?.(); host.remove(); });

const settle = () => new Promise((r) => setTimeout(r, 250));

describe('what it takes', () => {
  it('turns a dropped .md into a real editable document', async () => {
    drop(host, [file('notes.md', '# Field Notes\n\nA paragraph.\n\n- one\n- two')]);
    await settle();

    const docs = listDocuments(board);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe('Field Notes');
    // Real blocks, not a file card.
    const model: any = board.store.getBlock(docs[0]!.noteId)!.model;
    expect(model.flavour).toBe('affine:note');
    expect(model.children.length).toBeGreaterThan(1);
  }, 60_000);

  /** An import the user cannot see reads as nothing having happened. */
  it('opens what it imported', async () => {
    drop(host, [file('notes.md', '# Seen\n\nBody.')]);
    await settle();
    expect(opened).toHaveLength(1);
    expect(toasts.at(-1)?.[0]).toMatch(/Imported notes\.md/);
  }, 60_000);

  /**
   * A file with no heading gets one from its NAME — the user just told us what
   * it is called, and without this the page opens untitled and the export
   * inherits "document.pdf".
   */
  it('titles an untitled file from its filename', async () => {
    drop(host, [file('Q3_planning notes.txt', 'Just some prose with no heading.')]);
    await settle();
    expect(listDocuments(board)[0]!.title).toBe('Q3 planning notes');
  }, 60_000);

  /**
   * A PDF has no heading to inherit, so it ALWAYS takes the filename path — and
   * it was arriving called "The Long Way Round.pdf", extension and all, which
   * becomes "The Long Way Round.pdf.pdf" the moment they export it. Caught by
   * dropping a real PDF, not by a test.
   */
  it('strips the extension from a rich filename too', async () => {
    const { installDocumentDrop } = await import('./import-drop');
    // withTitle is internal; exercise it through the text path, which shares it.
    drop(host, [file('The Long Way Round.txt', 'Lines on a page with no heading.')]);
    await settle();
    expect(listDocuments(board)[0]!.title).toBe('The Long Way Round');
    expect(typeof installDocumentDrop).toBe('function');
  }, 60_000);

  it('keeps a heading the file already has', async () => {
    drop(host, [file('whatever.md', '# Real Title\n\nBody.')]);
    await settle();
    expect(listDocuments(board)[0]!.title).toBe('Real Title');
  }, 60_000);

  it('imports several at once', async () => {
    drop(host, [file('a.md', '# A\n\nBody.'), file('b.md', '# B\n\nBody.')]);
    await settle();
    expect(listDocuments(board).map((d) => d.title).sort()).toEqual(['A', 'B']);
    // Only the first is opened — three documents opening in turn is a fight.
    expect(opened).toHaveLength(1);
  }, 60_000);
});

describe('what it leaves alone', () => {
  /**
   * THE ONE THAT WOULD BREAK THE BOARD. Claiming every drop would stop images,
   * clips and attachments working — everything AFFiNE's own handler does.
   */
  it('does not touch an image drop', async () => {
    const e = drop(host, [file('photo.png', 'x', 'image/png')]);
    await settle();
    expect(e.defaultPrevented, 'it claimed a drop that is not its own').toBe(false);
    expect(listDocuments(board)).toHaveLength(0);
  }, 60_000);

  /**
   * A .docx or .pdf IS claimed now — the bytes go UP to the parent, which owns
   * the only parser in the product, and markdown comes back. There is no parent
   * in a test, so this exercises the fallback: it must say plainly that the file
   * is on the board and the agent can read it, never fail silently.
   */
  it('claims .pdf and .docx, and says so when it cannot convert them here', async () => {
    const e = drop(host, [file('contract.pdf', 'x', 'application/pdf')]);
    await settle();
    expect(e.defaultPrevented, 'it should take the drop and convert it').toBe(true);
    expect(listDocuments(board)).toHaveLength(0);
    expect(toasts.at(-1)?.[0]).toMatch(/could not be (read|converted) here/i);
    expect(toasts.at(-1)?.[0]).toMatch(/Ask the agent to read it/i);
  }, 60_000);

  it('leaves a huge text file alone — that is a data file, not a document', async () => {
    const big = file('dump.txt', 'x'.repeat(5 * 1024 * 1024));
    const e = drop(host, [big]);
    await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(listDocuments(board)).toHaveLength(0);
  }, 60_000);

  it('says so rather than making a blank page from an empty file', async () => {
    drop(host, [file('empty.md', '   ')]);
    await settle();
    expect(listDocuments(board)).toHaveLength(0);
    expect(toasts.at(-1)?.[0]).toMatch(/empty/i);
  }, 60_000);

  it('stops listening once disposed', async () => {
    dispose();
    const e = drop(host, [file('notes.md', '# X\n\nY.')]);
    await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(listDocuments(board)).toHaveLength(0);
  }, 60_000);
});
