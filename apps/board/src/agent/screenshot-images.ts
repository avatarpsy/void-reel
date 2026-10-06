/**
 * ── ONE PICTURE THAT NEVER LOADS MUST NOT STALL EVERY SCREENSHOT ─────────────
 *
 * `toCanvas` runs html2canvas once per block, and html2canvas clones the WHOLE
 * document — not the block — then waits for every `<img>` in that clone with no
 * timeout at all (`imagesReady` in html2canvas). So one image anywhere in the
 * board's document whose request never finishes stalls the capture of a single
 * note on the other side of the board. Measured in a local repro: one
 * `<img src>` pointed at an endpoint that never answers, outside the requested
 * ids, turned a 1.5s capture into the 30s "a picture on the board may be
 * pointing at a url that never answers".
 *
 * The board's own pictures are the usual way in. A picture the user DROPPED is
 * the original file from the board's blob store, often a large PNG; when this
 * device has no copy it streams back from the cloud backup, and until that
 * finishes, its `<img>` is incomplete.
 *
 * So before rendering, every image that has not finished is either given a
 * short wait (it is IN the picture) or excluded from the clone (it is not). The
 * excluding is html2canvas's own `data-html2canvas-ignore`, which keeps the
 * element out of the cloned document entirely, so `imagesReady` never sees it.
 * The marks come off again after the capture.
 *
 * A picture that is in frame and still not ready is NAMED, along with where it
 * comes from, instead of being waited on until the RPC gives up. "These two
 * character sheets are files stored only on another device" is something an
 * agent can act on, and a 30-second stall is not.
 */
import type { MountedBoard } from '../blocksuite/editor';
import { readBlockMeta } from '../board/board-meta';
import { decodeMediaRef } from '../board/media-ref';

/** html2canvas's own opt-out: an element with it is not cloned at all. */
export const IGNORE_ATTR = 'data-html2canvas-ignore';
/** How long a picture IN the shot gets to finish before it is named instead. */
export const SUBJECT_IMAGE_WAIT_MS = 8_000;

/** A picture that was in frame but could not be drawn. */
export interface MissingPicture {
  id: string;
  /** Where its bytes come from, in words: a Library url, or a file stored on the board. */
  source: string;
  problem: string;
}

/** Every `<img>`, including the ones inside open shadow roots, which html2canvas also clones. */
export function allImages(root: Document | ShadowRoot | Element, out: HTMLImageElement[] = []): HTMLImageElement[] {
  root.querySelectorAll('img').forEach(i => out.push(i as HTMLImageElement));
  root.querySelectorAll('*').forEach(el => {
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) allImages(shadow, out);
  });
  return out;
}

/** Still loading. An `<img>` with no src never blocks html2canvas, so it does not count. */
export function isPending(img: HTMLImageElement): boolean {
  return !!img.getAttribute('src') && !img.complete;
}

/** Finished, but there is nothing to draw — a dead or revoked url. */
export function isBroken(img: HTMLImageElement): boolean {
  return !!img.getAttribute('src') && img.complete && img.naturalWidth === 0;
}

/** Resolves once none of these is pending, or when the time is up. */
async function settleImages(imgs: HTMLImageElement[], ms: number): Promise<void> {
  const pending = imgs.filter(isPending);
  if (!pending.length) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(finish, ms);
    let left = pending.length;
    function one(this: HTMLImageElement) {
      this.removeEventListener('load', one);
      this.removeEventListener('error', one);
      if (--left <= 0) finish();
    }
    function finish() {
      clearTimeout(timer);
      for (const img of pending) {
        img.removeEventListener('load', one);
        img.removeEventListener('error', one);
      }
      resolve();
    }
    for (const img of pending) {
      img.addEventListener('load', one);
      img.addEventListener('error', one);
    }
  });
}

/**
 * Where a canvas block's picture comes from, in a sentence.
 *
 * Exported because the answer is just as useful outside a screenshot: "why does
 * this one not load" is always a question about its source.
 */
export function describePictureSource(board: MountedBoard, id: string): string {
  const props = board.store.getBlock(id)?.model.props as { sourceId?: string; name?: string } | undefined;
  const meta = readBlockMeta(board.doc, id);
  const key = props?.sourceId ?? '';
  const ref = key ? decodeMediaRef(key) : null;
  if (ref) return `Library ${ref.kind} ${meta?.originalUrl || ref.src}`;
  if (key) {
    const native = board.workspace.blobSource.native;
    const record = native?.records.get(key);
    const name = record?.name || meta?.name || props?.name || 'a dropped file';
    const mb = record?.bytes ? `, ${(record.bytes / 1_048_576).toFixed(1)} MB` : '';
    const where = native?.cloudUrl(key) ? 'backed up to the cloud' : 'with no cloud backup';
    const status = native?.status(key).message;
    return `file stored on the board ("${name}"${mb}, ${where})${status ? ` — ${status}` : ''}`;
  }
  if (meta?.originalUrl) return meta.originalUrl;
  return 'no source recorded';
}

export interface ImageGate {
  /** Pictures in frame that could not be drawn. */
  missing: MissingPicture[];
  /** Take the ignore marks back off. Always call it. */
  release(): void;
}

/**
 * Make the document safe to hand to html2canvas.
 *
 * @param subjectIds the blocks being photographed; their pictures are waited on.
 */
export async function gateImages(
  board: MountedBoard,
  subjectIds: string[],
  waitMs = SUBJECT_IMAGE_WAIT_MS,
): Promise<ImageGate> {
  const marked: HTMLImageElement[] = [];
  const mark = (img: HTMLImageElement) => {
    if (img.hasAttribute(IGNORE_ATTR)) return;
    img.setAttribute(IGNORE_ATTR, 'true');
    marked.push(img);
  };

  /** Which subject each image belongs to, found through the block's own element. */
  const owner = new Map<HTMLImageElement, string>();
  for (const id of subjectIds) {
    const el = board.std.view.getBlock(id) as unknown as HTMLElement | null;
    if (!el) continue;
    for (const img of allImages(el)) owner.set(img, id);
  }

  // Not in the picture: html2canvas only draws the block it was given, so a
  // pending image anywhere else contributes nothing but the wait. Out now.
  const doc = (board.std.host as unknown as HTMLElement | undefined)?.ownerDocument ?? document;
  for (const img of allImages(doc)) {
    if (!owner.has(img) && isPending(img)) mark(img);
  }

  // In the picture: worth a short wait, then named.
  await settleImages([...owner.keys()], waitMs);
  const missing = new Map<string, MissingPicture>();

  // A picture block with no `<img>` at all never got its bytes — the card is a
  // spinner or an error. It does not stall html2canvas, but it is not in the
  // picture either, and the agent must not be told it saw it.
  const withImage = new Set(owner.values());
  for (const id of subjectIds) {
    if (withImage.has(id)) continue;
    const flavour = board.store.getBlock(id)?.model.flavour;
    const type = (board.store.getBlock(id)?.model.props as { type?: string } | undefined)?.type ?? '';
    const isPicture = flavour === 'affine:image' || (flavour === 'affine:attachment' && type.startsWith('image/'));
    if (!isPicture || !board.std.view.getBlock(id)) continue;
    missing.set(id, { id, source: describePictureSource(board, id), problem: 'its picture never arrived on this device' });
  }
  for (const [img, id] of owner) {
    const pending = isPending(img);
    if (!pending && !isBroken(img)) continue;
    mark(img);
    if (!missing.has(id)) {
      missing.set(id, {
        id,
        source: describePictureSource(board, id),
        problem: pending
          ? `its picture had not loaded after ${Math.round(waitMs / 1000)}s`
          : 'its picture failed to load',
      });
    }
  }

  return {
    missing: [...missing.values()],
    release() {
      for (const img of marked) img.removeAttribute(IGNORE_ATTR);
      marked.length = 0;
    },
  };
}
