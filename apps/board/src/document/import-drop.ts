/**
 * Drop a document on the board and get a DOCUMENT, not a file card.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED BEFORE
 * ══════════════════════════════════════════════════════════════════════════
 * AFFiNE's file-drop manager turns any dropped file into an `affine:attachment`
 * — a card with a filename on it. Correct for a zip or a spreadsheet, and wrong
 * for writing: dropping a `.md` gave you an icon you could not read, edit or
 * export, when the board can hold that text as a real editable page.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FOUR FORMATS, TWO ROUTES, ONE PARSER
 * ══════════════════════════════════════════════════════════════════════════
 * `.md` and `.txt` ARE the interchange format already, so they are a decode and
 * a placement — no library, nothing added to the bundle.
 *
 * `.docx` and `.pdf` need a parser, and there is exactly one of those in this
 * product, in the web app (`utils/document-reader.ts`). Rather than copy it —
 * which is how two answers to "what does this file say" begin to disagree — the
 * board sends the BYTES UP to the parent and gets markdown back. It is still
 * entirely on the user's machine; nothing reaches our server.
 *
 * A PDF converts to TEXT and says so. The format has no headings, lists or
 * tables to recover — only lines on a page — and a user who is told that knows
 * what they got, where one who is not thinks we mangled their document.
 *
 * Everything else falls through untouched, so nothing that worked stops.
 */
import { toast } from '../ui/toast';
import { placeMarkdownDocument } from './note-io';
import { requestOpenDocument } from './toolbar';

import type { MountedBoard } from '../blocksuite/editor';

/**
 * ── .docx AND .pdf: CONVERTED BY THE PARENT, NOT BY US ──────────────────────
 *
 * They need a parser, and there is exactly one of those in this product — in
 * the web app (`utils/document-reader.ts`). Copying it into the board is how
 * two answers to "what does this file say" start to disagree, so the board
 * hands the bytes UP and gets markdown back.
 *
 * The request/response shape is the one `parent-auth` already uses for tokens:
 * a `requestId` out, the same `requestId` back. Bytes travel as an ArrayBuffer,
 * which postMessage clones natively.
 *
 * If the parent does not answer — an older shell, a slow tab — the file simply
 * becomes an attachment, which is what it did before any of this existed.
 */
const RICH_FILE = /\.(docx|pdf)$/i;
const CONVERT_TIMEOUT_MS = 30_000;

interface Converted {
  markdown: string;
  /** Layout the format simply has no equivalent for — a PDF, always. */
  lossy: boolean;
  /** Pictures the parent uploaded and referenced. */
  images: number;
  /** Pictures that were in the file and did not make it. */
  imagesDropped: number;
}

function convertViaParent(file: File): Promise<Converted | null> {
  if (!window.parent || window.parent === window) return Promise.resolve(null);
  return new Promise(async (resolve) => {
    const requestId = `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { cleanup(); resolve(null); }, CONVERT_TIMEOUT_MS);
    const onMsg = (e: MessageEvent) => {
      const d = e.data as any;
      if (d?.type !== 'voidspace:board-doc-converted' || d?.requestId !== requestId) return;
      cleanup();
      resolve(d.markdown
        ? {
          markdown: String(d.markdown),
          lossy: !!d.lossy,
          images: Number(d.images) || 0,
          imagesDropped: Number(d.imagesDropped) || 0,
        }
        : null);
    };
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMsg); };
    window.addEventListener('message', onMsg);
    try {
      const bytes = await file.arrayBuffer();
      window.parent.postMessage(
        { type: 'voidspace:board-convert-doc', requestId, name: file.name, bytes },
        '*',
        [bytes],
      );
    } catch {
      cleanup();
      resolve(null);
    }
  });
}

/**
 * ONE SENTENCE saying what arrived and what did not.
 *
 * Three separate things can go partly wrong in an import — a construct the
 * canvas has no block for, a format with no layout to recover, and a picture
 * that would not upload — and each used to get its own phrasing at its own call
 * site. Said together they read as one honest result; said separately they read
 * as a pile of warnings about a document that is, in fact, fine.
 *
 * Pictures that DID come through are named too. "with 6 pictures" is the
 * difference between trusting the import and scrolling the whole document to
 * check.
 */
function importMessage(
  name: string,
  dropped: string[],
  placed: number,
  conv: Partial<Converted>,
  verb = 'Imported',
): string {
  const lost = [...dropped];
  // A PDF's "layout" is not a loss worth naming twice; it is what the format is.
  if (conv.lossy) lost.push('layout');
  const missing = Number(conv.imagesDropped) || 0;
  if (missing) lost.push(`${missing} picture${missing === 1 ? '' : 's'}`);

  const got = placed ? ` with ${placed} picture${placed === 1 ? '' : 's'}` : '';
  return lost.length
    ? `${verb} ${name}${got} — ${lost.join(' and ')} could not be kept.`
    : `${verb} ${name}${got}`;
}

/** Whether that message is a warning or a receipt. */
function problem(dropped: string[], conv: Partial<Converted>): boolean {
  return dropped.length > 0 || !!conv.lossy || (Number(conv.imagesDropped) || 0) > 0;
}

/** The tag this file earns on the canvas — its origin, not its content. */
function kindOf(name: string): 'pdf' | 'docx' | 'text' {
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.docx$/i.test(name)) return 'docx';
  return 'text';
}

/** Text formats a browser can already read with no help. */
const TEXT_FILE = /\.(md|markdown|txt|text)$/i;
/** Past this, a "document" is a data file and belongs as an attachment. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Where to put it, and what to call it.
 *
 * A file dropped with no heading gets one made from its NAME — "Q3 notes.md"
 * becomes a document called "Q3 notes". Without that the page opens untitled
 * and the export inherits "document.pdf", when the user just told us the name.
 */
function withTitle(markdown: string, fileName: string): string {
  if (/^\s*#\s+\S/.test(markdown)) return markdown;
  // EVERY extension we accept, not just the text ones. A PDF has no heading to
  // inherit, so it always takes this path — and it was arriving titled
  // "The Long Way Round.pdf", extension and all, which is nobody's document
  // name and becomes "The Long Way Round.pdf.pdf" the moment they export it.
  const base = fileName
    .replace(TEXT_FILE, '')
    .replace(RICH_FILE, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return base ? `# ${base}\n\n${markdown}` : markdown;
}

export function installDocumentDrop(board: MountedBoard, container: HTMLElement): () => void {
  /**
   * CAPTURE, and only stop the event for files we are taking.
   *
   * AFFiNE's own drop handling is registered on the editor host inside this
   * container. Listening in the capture phase is what lets us claim a markdown
   * file before it becomes an attachment — and NOT calling `preventDefault` for
   * anything else is what keeps images, video and every other drop working
   * exactly as they did.
   */
  const onDrop = async (e: DragEvent) => {
    const all = [...(e.dataTransfer?.files ?? [])].filter((f) => f.size <= MAX_BYTES);
    const text = all.filter((f) => TEXT_FILE.test(f.name));
    const rich = all.filter((f) => RICH_FILE.test(f.name));
    if (!text.length && !rich.length) return;

    e.preventDefault();
    e.stopPropagation();

    let first = true;
    const place = async (markdown: string, file: File, conv: Partial<Converted> = {}) => {
      const { noteId, dropped, images } = await placeMarkdownDocument(
        board,
        withTitle(markdown, file.name),
        // Dropped AT the pointer, because that is where the user aimed.
        { ...dropPoint(e), kind: kindOf(file.name) },
      );
      toast(importMessage(file.name, dropped, images, conv), problem(dropped, conv) ? 'error' : 'info');
      // Open the first one only: three documents opening in turn is a fight.
      if (first) { requestOpenDocument(noteId); first = false; }
    };

    for (const file of text) {
      try {
        const body = await file.text();
        if (!body.trim()) { toast(`${file.name} is empty.`, 'error'); continue; }
        await place(body, file);
      } catch (err) {
        console.error('[import-drop] failed:', err);
        toast(`${file.name} could not be imported.`, 'error');
      }
    }

    /**
     * ── .docx AND .pdf GO UP TO THE PARENT ────────────────────────────────
     *
     * A PDF becomes TEXT, not a facsimile: the format has no headings, lists
     * or tables to recover, only lines on a page. Saying so is the difference
     * between a user who knows what they got and one who thinks we mangled
     * their document — so `lossy` is carried back and named in the toast.
     *
     * If the parent cannot convert (older shell, timeout), the file falls back
     * to being an attachment, exactly as it was before.
     */
    for (const file of rich) {
      try {
        toast(`Reading ${file.name}…`, 'info');
        const out = await convertViaParent(file);
        if (!out?.markdown.trim()) {
          toast(
            `${file.name} could not be converted here — it is on the board as a file. `
            + 'Ask the agent to read it.',
            'error',
          );
          continue;
        }
        await place(out.markdown, file, out);
      } catch (err) {
        console.error('[import-drop] convert failed:', err);
        toast(`${file.name} could not be imported.`, 'error');
      }
    }
  };

  /**
   * `dragover` must be prevented too, or the browser refuses the drop and
   * navigates to the file instead — which loses the board.
   */
  const onDragOver = (e: DragEvent) => {
    const items = [...(e.dataTransfer?.items ?? [])];
    const looksText = items.some((i) => i.kind === 'file');
    if (looksText) e.preventDefault();
  };

  container.addEventListener('drop', onDrop, true);
  container.addEventListener('dragover', onDragOver, true);
  return () => {
    container.removeEventListener('drop', onDrop, true);
    container.removeEventListener('dragover', onDragOver, true);
  };
}

/** Model coordinates under the pointer, or the middle of the view. */
function dropPoint(e: DragEvent): { x?: number; y?: number } {
  try {
    const root: any = document.querySelector('affine-edgeless-root');
    const vp = root?.gfx?.viewport;
    if (!vp?.toModelCoord) return {};
    const [x, y] = vp.toModelCoord(e.clientX, e.clientY);
    return { x, y };
  } catch {
    return {};
  }
}

/**
 * Import a document that already has a URL — a Library row, in practice.
 *
 * Shares the drop path's conversion deliberately: the bytes go up to the parent
 * which owns the only parser, and markdown comes back. A second import route
 * with its own rules is how "the same file behaves differently depending where
 * you clicked" starts.
 *
 * Fetched through the media proxy when a direct request is refused — Library
 * URLs are cross-origin, and the board learned that rule the hard way.
 */
export async function importDocumentFromUrl(
  board: MountedBoard,
  url: string,
  label = '',
): Promise<string | null> {
  const name = label || url.split('/').pop() || 'document';
  try {
    let res = await fetch(url).catch(() => null);
    if (!res?.ok) {
      const { defaultApiBase } = await import('@openreel/asset-browser');
      res = await fetch(`${defaultApiBase()}/api/studio/media-proxy?url=${encodeURIComponent(url)}`);
    }
    if (!res.ok) throw new Error('could not be fetched');

    const blob = await res.blob();
    if (blob.size > MAX_BYTES) {
      toast(`${name} is too large to open here.`, 'error');
      return null;
    }
    const file = new File([blob], name, { type: blob.type });

    let markdown = '';
    let conv: Partial<Converted> = {};
    if (TEXT_FILE.test(name)) {
      markdown = await file.text();
    } else {
      const out = await convertViaParent(file);
      markdown = out?.markdown ?? '';
      conv = out ?? {};
    }
    if (!markdown.trim()) {
      toast(`${name} could not be opened as a document.`, 'error');
      return null;
    }

    const { noteId, dropped, images } = await placeMarkdownDocument(
      board,
      withTitle(markdown, name),
      { kind: kindOf(name) },
    );
    toast(
      importMessage(name, dropped, images, conv, 'Opened'),
      problem(dropped, conv) ? 'error' : 'info',
    );
    requestOpenDocument(noteId);
    return noteId;
  } catch (err) {
    console.error('[import-drop] url import failed:', err);
    toast(`${name} could not be opened.`, 'error');
    return null;
  }
}
