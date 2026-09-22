/**
 * An uploaded file, into an editable document.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ONE DOOR, THREE ROUTES
 * ══════════════════════════════════════════════════════════════════════════
 * Everything that arrives — dropped on the canvas, picked from the Library,
 * handed over by the agent — comes through here and leaves as markdown the
 * board can place and the exporters can read back. What differs is only how
 * much has to be recovered first:
 *
 *   .md, .txt   already is the document. Nothing to infer.
 *   .docx       read from the OOXML, which HAS the formatting — see docx-import.
 *   .pdf        inferred from where the glyphs sit — see pdf-import.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AND WHY THE PDF ROUTE ASKS THE PARENT
 * ══════════════════════════════════════════════════════════════════════════
 * Reading a PDF needs pdfjs, which is about a megabyte, and the app already
 * carries it for `read_file`. Putting a second copy in the board would make
 * every board slower to load so that one user in a hundred can import a PDF.
 *
 * Word is the other way round: the OOXML reader is small and has no dependency
 * at all — a .docx is a zip of XML and the platform inflates zips — so it runs
 * here, and dropping one no longer needs the parent to answer at all.
 */
import type { Block, DocSpec } from './blocks';
import { importDocx } from './docx-import';
import { importPdfLayout, type PdfPageLayout } from './pdf-import';
import { toMarkdown } from './serialise';
import { uploadBlob } from '../board/document-export';

export type ImportKind = 'pdf' | 'docx' | 'text';

export interface ImportedFile {
  markdown: string;
  kind: ImportKind;
  /** Page setup the file carried, for a caller that exports it again. */
  spec: Partial<DocSpec>;
  /**
   * What the user should be told: what was guessed, what was skipped, what
   * could not be stored. Never empty for a PDF, because a PDF is always
   * inferred and saying so is the difference between a user who understands
   * what they are looking at and one who thinks we mangled their file.
   */
  notes: string[];
  images: { found: number; stored: number };
}

/** How many pictures are worth pulling out of one document. */
const MAX_IMAGES = 40;

/**
 * Word, read here, with its pictures stored so the board can point at them.
 *
 * A picture that cannot be stored is dropped from the document rather than
 * carried as a data URI: a ten-photograph report would otherwise become a
 * markdown file of several megabytes, which is slow to place, slow to sync and
 * impossible for the agent to read.
 */
async function fromDocx(bytes: Uint8Array, name: string): Promise<ImportedFile> {
  const { blocks, spec, images, unsupported } = await importDocx(bytes);
  const notes: string[] = [];
  let stored = 0;

  const usable = images.slice(0, MAX_IMAGES);
  if (images.length > usable.length) {
    notes.push(`only the first ${MAX_IMAGES} pictures were kept`);
  }

  for (const image of usable) {
    const block = blocks[image.blockIndex];
    if (!block || block.kind !== 'image') continue;
    try {
      const ext = image.contentType.split('/')[1]?.replace('+xml', '') ?? 'png';
      const url = await uploadBlob(
        new Blob([image.bytes as BlobPart], { type: image.contentType }),
        `${name.replace(/\.[^.]+$/, '')}-${stored + 1}.${ext}`,
      );
      block.url = url;
      stored += 1;
    } catch {
      // Keep going: one picture that would not store must not cost the others
      // or the document. The count below tells the user what happened.
    }
  }

  // Any image block still without a url never made it; drop it rather than
  // leaving a broken picture in the document.
  const kept = blocks.filter((b) => b.kind !== 'image' || !!b.url);
  if (stored < usable.length) {
    notes.push(`${usable.length - stored} picture${usable.length - stored === 1 ? '' : 's'} could not be stored`);
  }
  if (unsupported.length) notes.push(`not carried over: ${unsupported.join(', ')}`);

  return {
    markdown: toMarkdown(kept),
    kind: 'docx',
    spec,
    notes,
    images: { found: images.length, stored },
  };
}

/** A PDF, from the layout the app extracted for us. */
function fromPdfLayout(pages: PdfPageLayout[]): ImportedFile {
  const { blocks, inferred } = importPdfLayout(pages);
  const notes: string[] = [];
  if (!blocks.length) {
    notes.push('no text could be found — if this is a scan, the pages are pictures of writing');
  } else {
    // ALWAYS said, for a PDF. The format has no structure in it, so everything
    // below the words is our reading of the geometry, and the user is entitled
    // to know which parts of their document are a guess.
    notes.push(`a PDF has no structure to read, so this was rebuilt from the page: ${inferred.join(', ')}`);
  }
  return {
    markdown: toMarkdown(blocks as Block[]),
    kind: 'pdf',
    spec: {},
    notes,
    images: { found: 0, stored: 0 },
  };
}

/**
 * Ask the app for a PDF's positioned text.
 *
 * The same request the drop handler makes, in one place so the two cannot
 * disagree about the message name -- which is the sort of thing that fails
 * silently and looks like the parser being broken.
 */
export function parentPdfLayout(name: string, bytes: Uint8Array): Promise<PdfPageLayout[]> {
  if (!window.parent || window.parent === window) return Promise.resolve([]);
  return new Promise((resolve) => {
    const requestId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { cleanup(); resolve([]); }, PARENT_WAIT_MS);
    const onMsg = (e: MessageEvent) => {
      const d = e.data as any;
      if (d?.type !== 'voidspace:board-doc-converted' || d?.requestId !== requestId) return;
      cleanup();
      resolve(Array.isArray(d.pages) ? d.pages as PdfPageLayout[] : []);
    };
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
    };
    window.addEventListener('message', onMsg);
    try {
      // A copy, because the buffer is TRANSFERRED: sending the caller's own
      // bytes would leave them holding a detached array.
      const copy = bytes.slice().buffer;
      window.parent.postMessage(
        { type: 'voidspace:board-convert-doc', requestId, name, bytes: copy },
        '*',
        [copy],
      );
    } catch {
      cleanup();
      resolve([]);
    }
  });
}

/** Reading a PDF is a megabyte of parser and a real document; give it room. */
const PARENT_WAIT_MS = 45_000;

/**
 * A file the user already uploaded, by URL, as an editable document.
 *
 * This is the whole point of the import work: `read_file` gives a model the
 * WORDS of a contract, and this gives the user their contract, on the board,
 * with its headings, its table and its letterhead, ready to be changed.
 */
export async function importFromUrl(url: string, name?: string): Promise<ImportedFile> {
  const { fetchMediaBlob } = await import('../board/media-fetch');
  let blob: Blob | null = null;
  try {
    blob = await fetchMediaBlob(url);
  } catch (e: any) {
    throw new Error(`That file could not be fetched — ${e?.message ?? 'no response'}`);
  }
  // `fetchMediaBlob` answers null for a url it will not touch, which is not
  // the same as a throw and would otherwise become a confusing crash below.
  if (!blob) throw new Error('That file could not be fetched.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const fileName = String(name ?? nameFromUrl(url) ?? 'document');
  return importDocument(
    { name: fileName, bytes },
    { pdfLayout: (b) => parentPdfLayout(fileName, b) },
  );
}

/** The last path segment, without its query — a file name often enough. */
function nameFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url, 'https://voidspace.ai').pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '') || undefined;
  } catch {
    return undefined;
  }
}
export interface ImportSources {
  /** Asks the app for a PDF's positioned text. Absent means PDFs cannot be read. */
  pdfLayout?: (bytes: Uint8Array) => Promise<PdfPageLayout[]>;
}

/**
 * The one entry point.
 *
 * Throws with words fit to show a person — every caller puts the message
 * straight in front of the user.
 */
export async function importDocument(
  file: { name: string; bytes: Uint8Array; text?: string },
  sources: ImportSources = {},
): Promise<ImportedFile> {
  const name = String(file.name ?? 'document');

  if (/\.docx$/i.test(name)) return fromDocx(file.bytes, name);

  if (/\.pdf$/i.test(name)) {
    if (!sources.pdfLayout) {
      throw new Error('PDFs can only be imported from inside Voidspace.');
    }
    const pages = await sources.pdfLayout(file.bytes);
    if (!pages.length) throw new Error('That PDF has no pages.');
    return fromPdfLayout(pages);
  }

  const text = file.text ?? new TextDecoder().decode(file.bytes);
  if (!text.trim()) throw new Error('That file is empty.');
  return {
    markdown: text,
    kind: 'text',
    spec: {},
    notes: [],
    images: { found: 0, stored: 0 },
  };
}
