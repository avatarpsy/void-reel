/**
 * The board's document leaving as a REAL FILE — typeset here, on this device.
 *
 * ── WHAT WAS HERE BEFORE, AND WHY IT WAS NOT ENOUGH ─────────────────────────
 * The document view could do two things with a finished document: call
 * `window.print()`, so the user could pick "Save as PDF" themselves, and
 * download the markdown source. Both are honest and both are real — and
 * neither produces a file this system made. The print dialog belongs to the
 * browser, so there is nothing to hand back to an agent, nothing to attach to
 * a message, and nothing at all if the window is not in front of somebody. And
 * a `.md` is the source, not the document.
 *
 * ── AND WHY THE SERVER DOES NOT DO IT EITHER ────────────────────────────────
 * The first version of this posted the markdown to a server renderer. That
 * worked and was wrong: typesetting is heavy, its cost scales with how many
 * people export at once, and Voidspace's server manages state rather than
 * taking workloads. The browser already has the fonts, the arithmetic, a canvas
 * for converting pictures, and nothing else to do.
 *
 * So `../document` renders, here. The server is involved on exactly one path —
 * an agent asking for a document, which needs a URL — and even then it only
 * STORES the finished bytes through the same `upload-attachment` door the image
 * editor's exports already use. It never sees the markdown and never lays
 * anything out.
 */
import { getParentToken } from './parent-auth';
import { defaultApiBase } from '@openreel/asset-browser';

/**
 * TYPE-ONLY, so nothing about documents is in the entry bundle.
 *
 * `import type` is erased at build time. The module itself — the block model,
 * `marked`, and behind them the two typesetters — is pulled in at the moment
 * somebody actually exports, below. A session that never makes a document
 * downloads none of it.
 */
import type { DocFormat, RenderedDocument } from '../document';

export type { DocFormat, RenderedDocument };

/** Big enough for a very long board; past this the tab, not the server, suffers. */
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;

export interface DocumentOptions {
  pageSize?: 'a4' | 'letter';
  typeface?: 'serif' | 'sans';
}

/**
 * Make the document. Nothing leaves this machine.
 *
 * Throws with a message fit to show a person — the callers are a button and a
 * tool result, and both need words rather than a status code.
 */
export async function makeDocument(
  markdown: string,
  title: string,
  format: DocFormat,
  opts: DocumentOptions = {},
): Promise<RenderedDocument> {
  const text = String(markdown ?? '');
  if (!text.trim()) throw new Error('There is nothing on this board to put in a document yet.');
  if (new Blob([text]).size > MAX_MARKDOWN_BYTES) {
    throw new Error('This board is too large to export in one document. Split it across boards.');
  }
  // OUTSIDE the try below, deliberately. Fetching this chunk fails for its own
  // reasons — offline, or a deploy that moved it while the tab stayed open —
  // and reporting that as "could not be laid out" sends the user looking at
  // their document for a problem that is not in it.
  let renderDocument: typeof import('../document').renderDocument;
  try {
    ({ renderDocument } = await import('../document'));
  } catch {
    throw new Error('Could not load the document tools. Reload the page and try again.');
  }

  try {
    return await renderDocument({ markdown: text, title: String(title ?? ''), ...opts }, format);
  } catch (e: any) {
    // The layout engines throw on genuinely broken input; a stack trace in a
    // toast helps nobody.
    console.error('[document-export] render failed:', e);
    throw new Error('That document could not be laid out. If it has unusual content, try .md.');
  }
}

/** Make it and put it straight on the user's disk. No network at all. */
export async function saveDocument(
  markdown: string,
  title: string,
  format: DocFormat,
  opts: DocumentOptions = {},
): Promise<RenderedDocument> {
  const doc = await makeDocument(markdown, title, format, opts);
  const { downloadDocument } = await import('../document');
  downloadDocument(doc);
  return doc;
}

export interface UploadedDocument extends RenderedDocument {
  url: string;
}

/**
 * Store the finished file, for a caller that needs a URL.
 *
 * ONLY for the agent path. A user pressing a button gets `saveDocument`, which
 * costs them no storage and works offline — uploading their download would be
 * quota spent to achieve nothing.
 *
 * The retry mirrors cloud-sync's `authFetch`, for the same reason: a board left
 * open for an hour has a stale token, and one forced refresh fixes it. Asking
 * again when there was no token cannot help a signed-out user.
 */
/**
 * ── EVERY WAIT HERE IS BOUNDED, AND THAT IS NOT DEFENSIVENESS ───────────────
 *
 * `getParentToken` asks the PARENT window for a token and resolves when it
 * answers. If there is no parent — the board opened directly — or the parent is
 * signed out or wedged, it simply never settles. That turned an agent's
 * `create_document` call into a hang: the handler awaited this, never returned,
 * and so never replied, while the user's file had ALREADY been downloaded.
 * Nothing threw and nothing logged; the tool call just sat there until the
 * bridge gave up and told the user the board was unavailable.
 *
 * Found by calling the real RPC in a browser. Both unit tests and the handler
 * itself were happy, because neither of them waits on a parent.
 */
const TOKEN_WAIT_MS = 8_000;
const UPLOAD_WAIT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(what)), ms)),
  ]);
}

export async function uploadDocument(doc: RenderedDocument): Promise<UploadedDocument> {
  const form = new FormData();
  form.append('file', doc.blob, doc.fileName);

  let last: Response | null = null;
  for (const force of [false, true]) {
    const token = await withTimeout(getParentToken(force), TOKEN_WAIT_MS, 'token timeout')
      .catch(() => null);
    let res: Response;
    try {
      // A stalled connection must not hold the upload open either — the same
      // hang one layer down.
      res = await withTimeout(
        fetch(`${defaultApiBase()}/api/studio/upload-attachment`, {
          method: 'POST',
          // NO Content-Type: the browser must set the multipart boundary itself.
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: form,
        }),
        UPLOAD_WAIT_MS,
        'upload timeout',
      );
    } catch {
      throw new Error('The document is made, but it could not be uploaded. Check your connection.');
    }
    last = res;
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (!json?.url) throw new Error('The document was stored but came back without a link.');
      return { ...doc, url: json.url as string };
    }
    if (res.status !== 401 || !token) break;
  }

  if (last?.status === 401) throw new Error('Sign in to Voidspace to share documents.');
  if (last && (last.status === 507 || last.status === 413)) {
    const msg = await last.text().catch(() => '');
    throw new Error(msg || 'There is not enough space in your account for this document.');
  }
  throw new Error('The document is made, but it could not be uploaded.');
}
