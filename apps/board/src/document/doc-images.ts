/**
 * Pictures inside a document.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE ADAPTER'S OWN IMAGE HANDLING IS NOT ENOUGH
 * ══════════════════════════════════════════════════════════════════════════
 * BlockSuite's markdown adapter does understand `![alt](url)`: it FETCHES the
 * image, hashes the bytes, writes them to blob storage and emits an
 * `affine:image` block. Two things make that wrong here.
 *
 * 1. THE BYTES WOULD BE DEVICE-LOCAL. A hashed blob goes to this browser's
 *    IndexedDB. The board's own rule — the one every other image on the canvas
 *    already follows — is that a picture is a REFERENCE to the Library
 *    (`board/media-ref.ts`), resolved wherever it is opened. A document
 *    imported on the desktop app would otherwise open with broken images on the
 *    phone, and nothing would say why.
 *
 * 2. IT WOULD FETCH EVERY IMAGE AT IMPORT. A Word file with thirty figures
 *    would download thirty images before the document appeared, to produce
 *    copies of pictures we already have.
 *
 * So images are lifted OUT of the markdown before conversion, and put back as
 * media-reference image blocks afterwards. Nothing is fetched, and the document
 * carries the same kind of image block as the rest of the board.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AND BACK OUT AGAIN
 * ══════════════════════════════════════════════════════════════════════════
 * Reading has the mirror problem: the adapter serialises an image as
 * `assets/<name>.png`, a path into a zip that only exists during an export — so
 * a document read by the agent would come back referring to files nobody has.
 * The same swap runs in reverse, and `document_read` returns the real URL.
 *
 * Both directions share ONE sentinel format, defined once here, which is what
 * keeps them from drifting apart.
 */
import { decodeMediaRef, encodeMediaRef, guessMime, isMediaRef } from '../board/media-ref';

/** A token no markdown construct touches and no human writes by accident. */
const TOKEN = (n: number) => `!!vsimg-${n}!!`;
const TOKEN_RE = /^!!vsimg-(\d+)!!$/;

/** `![alt](url)`, with the alt text optional and the url unquoted. */
const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)[^)]*\)/g;

export interface LiftedImage {
  url: string;
  alt: string;
}

/**
 * Take the http(s) images out, leaving a sentinel paragraph behind.
 *
 * `data:` URIs are deliberately LEFT IN PLACE. The adapter can read one without
 * a network round trip, and a pasted screenshot inlined into markdown has no
 * Library URL to reference — dropping it would lose the only copy. The import
 * path avoids ever producing them (`docxToMarkdownDetailed` uploads instead),
 * so in practice this is the hand-pasted case only.
 */
export function liftImages(markdown: string): { text: string; images: LiftedImage[] } {
  const images: LiftedImage[] = [];
  const text = String(markdown ?? '').replace(IMAGE_RE, (whole, alt: string, raw: string) => {
    const url = String(raw ?? '').replace(/^<|>$/g, '').trim();
    if (!/^https?:\/\//i.test(url)) return whole;
    const n = images.length;
    images.push({ url, alt: String(alt ?? '').trim() });
    // Blank lines around it: an image inside a sentence becomes its own block,
    // which is what a block editor does with one anyway.
    return `\n\n${TOKEN(n)}\n\n`;
  });
  return { text, images };
}

/** A block snapshot node, loosely — the adapter's output is not typed for us. */
type Node = { type?: string; flavour?: string; props?: any; children?: Node[] };

/** The text of a paragraph snapshot, which carries a Y.Text delta. */
function snapshotText(node: Node): string {
  const delta = node?.props?.text?.delta;
  if (!Array.isArray(delta)) return '';
  return delta.map((d: any) => String(d?.insert ?? '')).join('').trim();
}

/**
 * Put the images back, as reference-backed image blocks.
 *
 * Walks the whole tree rather than only the top level: a picture inside a list
 * item or a quote is still a picture, and a sentinel left behind renders as the
 * literal text `!!vsimg-3!!` in the middle of the user's document — the kind of
 * failure that is obvious on screen and invisible to a model test.
 */
export function restoreImages(root: Node, images: LiftedImage[], nanoid: () => string): number {
  if (!images.length) return 0;
  let placed = 0;

  const walk = (node: Node): void => {
    const kids = node?.children;
    if (!Array.isArray(kids)) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      const match = TOKEN_RE.exec(snapshotText(child));
      const image = match ? images[Number(match[1])] : undefined;
      if (image) {
        kids[i] = {
          type: 'block',
          id: nanoid(),
          flavour: 'affine:image',
          props: {
            sourceId: encodeMediaRef({
              src: image.url,
              kind: 'image',
              mime: guessMime(image.url, 'image'),
            }),
            caption: image.alt || '',
          },
          children: [],
        } as any;
        placed += 1;
        continue;
      }
      walk(child);
    }
  };

  walk(root);
  return placed;
}

/**
 * ── READING ────────────────────────────────────────────────────────────────
 * Replace reference-backed image blocks with sentinel paragraphs so the adapter
 * does not try to resolve them, and hand back the urls to splice into the
 * markdown afterwards.
 *
 * A LOCAL blob (a pasted screenshot) is left alone: the adapter can serialise
 * that one properly, and it has no url to put in its place.
 */
export function stripImages(root: Node): LiftedImage[] {
  const images: LiftedImage[] = [];

  const walk = (node: Node): void => {
    const kids = node?.children;
    if (!Array.isArray(kids)) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      const sourceId = child?.flavour === 'affine:image' ? String(child?.props?.sourceId ?? '') : '';
      if (sourceId && isMediaRef(sourceId)) {
        const ref = decodeMediaRef(sourceId);
        if (ref?.src) {
          const n = images.length;
          images.push({
            url: withDrawnWidth(ref.src, Number(child?.props?.width)),
            alt: String(child?.props?.caption ?? '').trim(),
          });
          kids[i] = {
            type: 'block',
            id: `vsimg-${n}`,
            flavour: 'affine:paragraph',
            props: { type: 'text', text: { '$blocksuite:internal:text$': true, delta: [{ insert: TOKEN(n) }] } },
            children: [],
          } as any;
          continue;
        }
      }
      walk(child);
    }
  };

  walk(root);
  return images;
}

/**
 * -- A PICTURE RESIZED BY HAND HAS TO LEAVE AT THAT SIZE --------------------
 *
 * The size went ONE WAY. `#w=38` set the block's width when the document was
 * placed, and the export then read the URL again — the same 38 it started
 * with. So a user who dragged the logo bigger saw it bigger on the canvas,
 * exported, and got the old size back, with nothing to indicate why.
 *
 * The block is the truth once the document is on the board: it is what the
 * user sees and what they dragged. Its width is in CSS pixels and the hint is
 * in points, which is the 96-against-72 the other direction already uses.
 *
 * A width of 0 means the picture was never sized — BlockSuite's default — so
 * the hint is dropped entirely and the renderer falls back to the full text
 * column, which is the right answer for a chart.
 */
export function withDrawnWidth(url: string, widthPx: number): string {
  const raw = String(url ?? '');
  /**
   * A block width of 0 is BlockSuite's default and means the picture has not
   * been sized yet — the measuring pass has not finished, or the picture never
   * loaded. It does NOT mean 'the author wanted it full width', so the
   * document's own hint is left exactly as it was.
   *
   * Getting this backwards silently deleted the size from every document that
   * was exported before its pictures finished loading.
   */
  const points = Number.isFinite(widthPx) && widthPx > 0
    ? Math.round(widthPx * (72 / 96))
    : 0;
  if (points <= 0) return raw;

  const [base, fragment = ''] = raw.split('#');
  // Everything on the fragment EXCEPT the width, which is being replaced.
  const kept = fragment
    .split('&')
    .filter((part) => part && !/^(w|width)=/i.test(part));
  kept.unshift(`w=${points}`);
  return `${base}#${kept.join('&')}`;
}

/** Turn the sentinels in serialised markdown back into image syntax. */
export function restoreMarkdownImages(markdown: string, images: LiftedImage[]): string {
  if (!images.length) return markdown;
  return String(markdown ?? '').replace(/!!vsimg-(\d+)!!/g, (whole, n: string) => {
    const image = images[Number(n)];
    return image ? `![${image.alt}](${image.url})` : whole;
  });
}

/** How many pictures a piece of markdown carries — for the import message. */
export function countImages(markdown: string): number {
  return (String(markdown ?? '').match(IMAGE_RE) ?? []).length;
}

/**
 * -- A LOGO IS 38 POINTS ON THE PAGE AND WAS FULL WIDTH ON THE CANVAS -------
 *
 * `![](logo.png#w=38)` sizes the picture in the exported PDF and the Word
 * file, because both renderers read the hint. The CANVAS read nothing: the
 * image block was built with `width: 0`, which BlockSuite renders at the
 * picture's natural size, so a masthead logo filled the top quarter of the
 * document the user was looking at while the file it exported was correct.
 * Two different documents, one of which nobody could see.
 *
 * The height cannot be guessed, so it is measured: the browser is going to
 * load the picture to display it anyway, and the second request is served
 * from cache. A picture that will not load keeps its natural size, which is
 * what it did before.
 */
export async function sizeImagesFromHints(board: any, noteId: string): Promise<number> {
  const note = board?.store?.getBlock?.(noteId)?.model;
  const children: any[] = note?.children ?? [];
  const images = children.filter((c) => c?.flavour === 'affine:image');
  if (!images.length) return 0;

  const [{ decodeMediaRef }, { imageHints }] = await Promise.all([
    import('../board/media-ref'),
    import('./blocks'),
  ]);

  let sized = 0;
  await Promise.all(images.map(async (block: any) => {
    // Already sized by the user, or by a previous pass. Never overrule that.
    if (Number(block.props?.width) > 0) return;
    const src = decodeMediaRef(String(block.props?.sourceId ?? ''))?.src;
    if (!src) return;
    const { width } = imageHints(src);
    if (!width) return;

    // POINTS on the page, pixels on the canvas: 96 per inch against 72.
    const px = Math.max(8, Math.round(width * (96 / 72)));
    const aspect = await naturalAspect(src);
    try {
      board.store.updateBlock(block, {
        width: px,
        height: Math.max(8, Math.round(px * aspect)),
      });
      sized += 1;
    } catch { /* a block that went away mid-flight */ }
  }));
  return sized;
}

/** height / width of the real picture, or 1 if it cannot be measured. */
function naturalAspect(src: string): Promise<number> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') { resolve(1); return; }
    const img = new Image();
    // A picture that never answers must not hold the import open.
    const timer = setTimeout(() => resolve(1), 8000);
    const done = (value: number) => { clearTimeout(timer); resolve(value); };
    img.onload = () => done(img.naturalWidth > 0
      ? img.naturalHeight / img.naturalWidth
      : 1);
    img.onerror = () => done(1);
    img.src = src;
  });
}
