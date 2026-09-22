/**
 * Focus mode for a document.
 *
 * What is worth pinning is the part that is DIFFERENT from the other two focus
 * modes: this one does not replace the canvas, it frames it. So the assertions
 * are about the overlay staying out of the way — of the pointer, and of the
 * editor's own Escape — because both failures produce a document that renders
 * perfectly and cannot be typed into.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@openreel/asset-browser', () => ({ defaultApiBase: () => 'https://api.test' }));
vi.mock('../board/parent-auth', () => ({ getParentToken: async () => 'tok' }));
vi.mock('../document/images', () => ({ loadImages: async () => new Map() }));

const focusOnBounds = vi.fn();
vi.mock('./viewport', () => ({ focusOnBounds: (...a: any[]) => focusOnBounds(...a) }));

const toasts: Array<[string, string]> = [];
vi.mock('./toast', () => ({ toast: (m: string, k: string) => { toasts.push([m, k]); } }));

import { makeTestBoard } from '../blocksuite/test-board';
import { placeMarkdownDocument, documentTitle } from '../document/note-io';
import { isCanvasFramed } from './focus-lock';
import { installDocumentFocus } from './document-focus';

const MD = '# Field Notes\n\nA paragraph.\n\n- one\n- two\n';

let container: HTMLElement;
beforeEach(() => {
  focusOnBounds.mockReset();
  toasts.length = 0;
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => container.remove());

async function boardWithDocument() {
  const board = makeTestBoard();
  const { noteId } = await placeMarkdownDocument(board as any, MD, { x: 10, y: 20 });
  return { board, noteId };
}

describe('opening', () => {
  it('flies the viewport to the document and puts the chrome up', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);

    expect(focus.isOpen()).toBe(false);
    focus.open(noteId);

    expect(focus.isOpen()).toBe(true);
    expect(focus.current()).toBe(noteId);
    expect(focusOnBounds).toHaveBeenCalledWith({ x: 10, y: 20, w: 800, h: 1120 });
    /**
     * On the ROOT, which is the one host all three focus modes now share.
     * It used to be written here on the chrome host and on `documentElement`
     * by the other two — which is how `document-view.css` came to carry a
     * `body[data-focus-mode]` rule that matched nothing at all.
     */
    expect(document.documentElement.dataset.focusMode).toBe('document');
    expect(container.hasAttribute('data-focus-mode')).toBe(false);
    // And board gestures are refused while it is up — see `focus-lock.ts`.
    expect(isCanvasFramed()).toBe(true);
    focus.destroy();
    expect(isCanvasFramed()).toBe(false);
    expect(document.documentElement.dataset.focusMode).toBeUndefined();
  }, 60_000);

  /**
   * THE ONE THAT MAKES IT USABLE. Inheriting the full-pane shell would put a
   * surface over the live editor: the document would render and refuse every
   * click. The modifier class is what the CSS hangs `pointer-events: none` on.
   */
  it('marks itself as the LIVE variant, so it does not swallow the editor\'s clicks', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);

    const overlay = container.querySelector('.vs-focus')!;
    expect(overlay.classList.contains('vs-focus--live')).toBe(true);
    expect(overlay.classList.contains('vs-focus--doc')).toBe(true);
    focus.destroy();
  }, 60_000);

  it('titles itself from the document\'s first heading', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);
    expect(container.querySelector<HTMLInputElement>('[data-name]')!.value).toBe('Field Notes');
    focus.destroy();
  }, 60_000);

  it('says so rather than opening empty when the note has been deleted', async () => {
    const { board } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open('gone');
    expect(focus.isOpen()).toBe(false);
    expect(toasts.at(-1)?.[0]).toMatch(/not on the board/i);
    focus.destroy();
  }, 60_000);

  it('opens on the bar\'s request, without the bar reaching into it', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    container.dispatchEvent(new CustomEvent('voidspace-open-note-document', {
      bubbles: true, detail: { noteId },
    }));
    expect(focus.isOpen()).toBe(true);
    focus.destroy();
  }, 60_000);
});

describe('closing', () => {
  it('gives the board its chrome back', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);
    focus.close();
    expect(focus.isOpen()).toBe(false);
    expect(focus.current()).toBeNull();
    expect(container.hasAttribute('data-focus-mode')).toBe(false);
    focus.destroy();
  }, 60_000);

  /**
   * Escape belongs to the EDITOR first — it closes the slash menu, clears a
   * selection, leaves a table cell. Closing the mode on an Escape somebody else
   * already handled yanks the user out of their document mid-edit.
   */
  it('ignores an Escape the editor has already claimed', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);

    const claimed = new KeyboardEvent('keyup', { key: 'Escape', cancelable: true });
    claimed.preventDefault();
    document.dispatchEvent(claimed);
    expect(focus.isOpen(), 'a handled Escape closed the mode').toBe(true);

    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', cancelable: true }));
    expect(focus.isOpen()).toBe(false);
    focus.destroy();
  }, 60_000);

  it('leaves nothing behind when destroyed', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);
    focus.destroy();
    expect(container.querySelector('.vs-focus')).toBeNull();
    expect(container.hasAttribute('data-focus-mode')).toBe(false);
  }, 60_000);
});

describe('exporting', () => {
  it('refuses when nothing is open, rather than making an empty file', async () => {
    const { board } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    await expect(focus.exportAs('pdf')).rejects.toThrow(/no document is open/i);
    focus.destroy();
  }, 60_000);


/**
 * ── "NO REQUEST" MEANS NO DOCUMENT SERVICE, NOT NO FETCH ─────────────────────
 *
 * These used to assert `fetch` was never called, which said the right thing
 * until the renderer began embedding real fonts: it now loads its own bundled
 * woff2 files, and that is still the document being typeset ON THIS DEVICE.
 *
 * What the test is actually protecting is that no CONTENT leaves — nothing is
 * posted anywhere, nothing is rendered by a server. So it checks what was asked
 * for rather than whether anything was asked for at all.
 */
function assertOnlyLocalAssets(spy: any): void {
  for (const call of (spy?.mock?.calls ?? [])) {
    const url = String(call?.[0] ?? '');
    const init = call?.[1] ?? {};
    expect(String(init.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(url, `unexpected request to ${url}`).toMatch(/\.woff2?($|\?)|^blob:|^data:/);
  }
}

  it('makes a real PDF from the live note, on this device', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // Patch the two STATICS rather than stubbing the global: replacing `URL`
    // with a plain object takes the constructor with it, and happy-dom needs
    // it the moment the download anchor is clicked.
    (URL as any).createObjectURL = () => 'blob:x';
    (URL as any).revokeObjectURL = () => {};

    const out = await focus.exportAs('pdf');
    expect(out.fileName).toBe('Field Notes.pdf');
    const head = new Uint8Array(await out.blob.arrayBuffer()).subarray(0, 5);
    expect(String.fromCharCode(...head)).toBe('%PDF-');
    // The user's own export never touches the network.
    assertOnlyLocalAssets(fetchSpy);

    vi.unstubAllGlobals();
    focus.destroy();
  }, 60_000);
});

/**
 * FINDING IT IN THE FIRST PLACE.
 *
 * The export buttons are excellent and unreachable if a user cannot reopen a
 * document they closed. These pin the two things a browser had to teach me:
 * the affordance must be selection-gated, and the bar it lives on autohides —
 * so selecting a document has to REVEAL it, or the button is present and
 * invisible at the one moment it is wanted.
 */
describe('finding the way back in', () => {
  /**
   * ONE control in the bar. Three buttons named `.md`, `Word` and `PDF` named
   * FORMATS and left the verb to a caption beside them; every office suite puts
   * a single Download where the eye goes and the formats one click inside it.
   */
  it('leads with one Download control, not three format names', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);

    const buttons = [...container.querySelectorAll('.vs-focus__actions .vs-focus__btn')];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toMatch(/Download/);
    // Closed until asked for, and marked closed for a screen reader too.
    expect(container.querySelector('[data-menu]')!.hasAttribute('hidden')).toBe(true);
    expect(buttons[0]!.getAttribute('aria-expanded')).toBe('false');
    focus.destroy();
  }, 60_000);

  it('opens the menu with every format and a reason to pick it', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);

    container.querySelector<HTMLElement>('[data-act="menu"]')!.click();
    const menu = container.querySelector('[data-menu]')!;
    expect(menu.hasAttribute('hidden')).toBe(false);

    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(items.map(i => i.querySelector('strong')!.textContent))
      .toEqual(['PDF document', 'Microsoft Word', 'Markdown']);
    // A format with no explanation is a format nobody can choose between.
    for (const item of items) expect(item.querySelector('em')!.textContent!.length).toBeGreaterThan(20);
    for (const act of ['pdf', 'docx', 'md']) {
      expect(menu.querySelector(`[data-act="${act}"]`), `no ${act} item`).toBeTruthy();
    }
    focus.destroy();
  }, 60_000);

  /** Escape belongs to the innermost thing open. */
  it('closes the menu on Escape without closing the document', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);
    container.querySelector<HTMLElement>('[data-act="menu"]')!.click();

    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', cancelable: true }));
    expect(container.querySelector('[data-menu]')!.hasAttribute('hidden')).toBe(true);
    expect(focus.isOpen(), 'the document closed too').toBe(true);

    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', cancelable: true }));
    expect(focus.isOpen()).toBe(false);
    focus.destroy();
  }, 60_000);

  it('offers the export formats in the focus bar, not buried in a menu', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);
    for (const act of ['md', 'docx', 'pdf']) {
      expect(
        container.querySelector(`.vs-focus__actions [data-act="${act}"]`),
        `no ${act} button — a format a user cannot see is one they do not have`,
      ).toBeTruthy();
    }
    focus.destroy();
  }, 60_000);

  it('tells the user they can type, since nothing else says so', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);
    expect(container.querySelector('.vs-focus__title span')!.textContent)
      .toMatch(/type anywhere/i);
    focus.destroy();
  }, 60_000);
});

/**
 * NAMING THE DOCUMENT.
 *
 * The name was read-only text taken from the first heading, so "rename this"
 * had no answer and the exported file inherited whatever the heading said. The
 * name IS the first line — as in Notion and Docs — so renaming edits the
 * document itself, which is also what stops the page, the bar and the file ever
 * disagreeing.
 */
describe('naming the document', () => {
  async function openWith(md: string) {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, md, { x: 0, y: 0 });
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);
    return { board, noteId, focus, input: container.querySelector<HTMLInputElement>('[data-name]')! };
  }

  it('commits a new name on Enter, and it reaches the document', async () => {
    const { board, noteId, focus, input } = await openWith('# Old Name\n\nBody.');
    input.value = 'Q3 Board Review';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(documentTitle(board as any, noteId)).toBe('Q3 Board Review');
    // The heading on the page is the same object, so the page renamed too.
    const first: any = (board.store.getBlock(noteId)!.model as any).children[0];
    expect(String(first.text)).toBe('Q3 Board Review');
    focus.destroy();
  }, 60_000);

  it('commits on blur, because people click away instead of pressing Enter', async () => {
    const { board, noteId, focus, input } = await openWith('# Old Name\n\nBody.');
    input.value = 'Renamed By Blur';
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(documentTitle(board as any, noteId)).toBe('Renamed By Blur');
    focus.destroy();
  }, 60_000);

  /** Cancelling a rename must not also throw you out of the document. */
  it('reverts on Escape and stays open', async () => {
    const { board, noteId, focus, input } = await openWith('# Keep Me\n\nBody.');
    input.value = 'Typed then abandoned';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(input.value).toBe('Keep Me');
    expect(documentTitle(board as any, noteId)).toBe('Keep Me');
    expect(focus.isOpen()).toBe(true);
    focus.destroy();
  }, 60_000);

  it('ignores an empty name rather than leaving the document nameless', async () => {
    const { board, noteId, focus, input } = await openWith('# Has A Name\n\nBody.');
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(documentTitle(board as any, noteId)).toBe('Has A Name');
    focus.destroy();
  }, 60_000);

  /** The name is what the file is called — that is the whole point of it. */
  it('names the exported file after the rename', async () => {
    const { focus, input } = await openWith('# Before\n\nBody.');
    input.value = 'After';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    (URL as any).createObjectURL = () => 'blob:x';
    (URL as any).revokeObjectURL = () => {};
    const out = await focus.exportAs('md');
    expect(out.fileName).toBe('After.md');
    focus.destroy();
  }, 60_000);
});

/**
 * A NEW document opens with its NAME selected.
 *
 * The first thing anybody does with a blank page is call it something, and one
 * that opens with the caret in the body sends them hunting for where the name
 * lives. Selected rather than merely focused, so typing replaces the
 * placeholder instead of appending to it.
 */
describe('opening a brand new document', () => {
  it('focuses and selects the name when asked', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);

    container.dispatchEvent(new CustomEvent('voidspace-open-note-document', {
      bubbles: true, detail: { noteId, focusName: true },
    }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 30));

    const input = container.querySelector<HTMLInputElement>('[data-name]')!;
    expect(document.activeElement).toBe(input);
    expect(input.selectionEnd! - input.selectionStart!).toBe(input.value.length);
    focus.destroy();
  }, 60_000);

  /** Opening an EXISTING document must not steal the caret from the page. */
  it('leaves the name alone when not asked', async () => {
    const { board, noteId } = await boardWithDocument();
    const focus = installDocumentFocus(board as any, container);
    focus.open(noteId);
    await new Promise((r) => setTimeout(r, 50));

    expect(document.activeElement).not.toBe(container.querySelector('[data-name]'));
    focus.destroy();
  }, 60_000);
});
