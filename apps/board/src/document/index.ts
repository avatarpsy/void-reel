/**
 * Documents, made here — on the device, never on the server.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE RULE THIS FILE EXISTS TO HOLD
 * ══════════════════════════════════════════════════════════════════════════
 * Voidspace's server manages STATE. It does not do heavy work. Typesetting a
 * document is heavy work — measuring every word, breaking every line,
 * paginating, decoding and re-encoding pictures — and it is work that scales
 * with the number of users doing it at once, which is the worst possible shape
 * for a shared machine. One person exporting a long report would be spending
 * everybody else's latency.
 *
 * The browser the user is already sitting in has the same fonts, the same
 * arithmetic, an idle CPU and a canvas for image conversion. So the whole
 * pipeline runs there, and the only thing that ever reaches the server is a
 * finished file, on the one path that needs a URL.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TWO EXITS, AND ONLY ONE OF THEM TOUCHES THE SERVER
 * ══════════════════════════════════════════════════════════════════════════
 * `downloadDocument` — the user pressed a button. The Blob goes straight to
 *   their disk. No request, no upload, no storage billed, works offline.
 * `uploadDocument`   — an AGENT asked for the document. A tool result has to
 *   carry a URL, so the finished bytes are stored. That is the server doing
 *   storage, which is its job, and it never sees the markdown.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NOTHING HEAVY IS IN THE BUNDLE
 * ══════════════════════════════════════════════════════════════════════════
 * `docx` and `pdf-lib` are ~900KB together. Each is imported at the moment of
 * use, in its own module, so a session that exports nothing downloads neither,
 * and choosing PDF never pulls in the Word writer.
 */
import {
  documentFileName, parseMarkdown, DOC_CONTENT_TYPE, type DocFormat, type DocSpec,
} from './blocks';

export type { Block, Inline, DocFormat, DocSpec } from './blocks';
export { parseMarkdown, documentFileName, DOC_CONTENT_TYPE } from './blocks';

export interface RenderedDocument {
  blob: Blob;
  fileName: string;
  format: DocFormat;
  bytes: number;
  /** PDF only. */
  pages?: number;
  /** PDF only — characters the standard fonts could not set. */
  droppedGlyphs?: number;
}

/**
 * Turn markdown into a finished file, here.
 *
 * `md` is not a no-op: it is the source, and normalising the title into it is
 * what stops the same document being called two different things depending on
 * which button produced it.
 */
/** The blank line between the injected title and the document under it. */
const BLANK_LINE = String.fromCharCode(10, 10);

export async function renderDocument(spec: DocSpec, format: DocFormat): Promise<RenderedDocument> {
  const title = String(spec.title ?? '').trim();
  const fileName = documentFileName(title, format);

  if (format === 'docx') {
    const { renderDocx } = await import('./docx');
    const blob = await renderDocx(spec);
    return { blob, fileName, format, bytes: blob.size };
  }

  if (format === 'pdf') {
    const { renderPdf } = await import('./pdf');
    const { blob, pages, droppedGlyphs } = await renderPdf(spec);
    return { blob, fileName, format, bytes: blob.size, pages, droppedGlyphs };
  }

  /**
   * -- THE SAME TITLE RULE THE OTHER TWO USE --------------------------------
   *
   * This path had its OWN rule -- prepend the title unless the markdown starts
   * with a hash -- and it disagreed with `parseMarkdown`, which also declines
   * when the document opens with a picture, because that is a masthead the
   * author composed. So one certificate came out with a heading above the logo
   * in .md and without one in .pdf. Asking the block model is the fix: one
   * rule, in the place that already owns it.
   */
  const first = parseMarkdown(spec.markdown).find((b) => b.kind !== 'rule');
  const ownsItsOpening = first?.kind === 'image'
    || (first?.kind === 'heading' && first.level === 1);
  const heading = title && !ownsItsOpening ? `# ${title}${BLANK_LINE}` : '';
  const blob = new Blob([heading + spec.markdown], { type: DOC_CONTENT_TYPE.md });
  return { blob, fileName, format: 'md', bytes: blob.size };
}

/**
 * Straight to the user's disk.
 *
 * An object URL, not a remote one: the bytes are already here, so a round trip
 * to storage and back would be latency and quota spent to achieve nothing. It
 * also means this works with no network at all.
 */
export function downloadDocument(doc: RenderedDocument): void {
  const url = URL.createObjectURL(doc.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked next tick — immediately would race the download starting.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
