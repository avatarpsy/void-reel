/**
 * Pictures, ready to embed.
 *
 * ── WHY NOT JUST `fetch(url)` ───────────────────────────────────────────────
 * Because the document's pictures live in Voidspace storage, on another origin,
 * and a plain cross-origin fetch of them fails. `fetchMediaBlob` is the board's
 * existing answer: same-origin goes direct with a token, everything else goes
 * through `/api/studio/media-proxy`, which is same-origin and therefore never
 * preflighted. Reusing it means this file inherits every rule that module has
 * already had to learn — including that an `Authorization` header on a
 * cross-origin request turns a working image into a `TypeError`.
 *
 * ── WHY IT ASKS FOR A SMALLER ONE ───────────────────────────────────────────
 * A generated picture is often 2048px wide. A document column is about 6.5
 * inches, so anything past ~1600px is bytes the reader downloads and never
 * sees. The proxy resizes, so asking costs nothing and a ten-picture report
 * stops being a 40MB file.
 *
 * ── WHY A DEAD PICTURE IS NOT AN ERROR ──────────────────────────────────────
 * Returning null rather than throwing, per picture. A report whose third
 * illustration 404s should still be a report, with that picture's caption in
 * its place. Losing the whole export over one dead URL is strictly worse.
 */
import { fetchMediaBlob } from '../board/media-fetch';

import type { Block } from './blocks';

/** Wider than any document column; the proxy resizes to this. */
const TARGET_WIDTH = 1600;
/** A picture past this is a mistake, not a picture. */
const MAX_BYTES = 12 * 1024 * 1024;
/** A document with fifty remote pictures would stall the tab fetching them. */
const MAX_COUNT = 40;

export interface LoadedImage {
  bytes: Uint8Array;
  /** pdf-lib and docx both need to be told which decoder to use. */
  png: boolean;
  width: number;
  height: number;
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    // SOF0..SOF15, minus the markers in that range that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
    }
    i += 2 + v.getUint16(i + 2);
  }
  return null;
}

/**
 * Re-encode anything that is not already PNG or JPEG.
 *
 * WebP and AVIF are what a modern pipeline produces and what NEITHER exporter
 * can embed — pdf-lib takes PNG and JPEG, and Word's picture parts are the
 * same two in practice. On a server that would mean a native image library; in
 * a browser it is a canvas, which is already there and already hardware-backed.
 * This is the clearest case for doing the work on the device rather than
 * shipping the bytes somewhere to be converted and shipped back.
 */
async function toEmbeddable(blob: Blob): Promise<LoadedImage | null> {
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(bitmap.width, TARGET_WIDTH);
    canvas.height = Math.round(bitmap.height * (canvas.width / bitmap.width));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Photographs re-encode to JPEG at a fraction of PNG's size, and a document
    // is almost always photographs. Transparency is the exception that has to
    // stay lossless, and a white matte would be visible against paper.
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const png = /png|gif|svg/i.test(blob.type);
    const out: Blob | null = await new Promise((resolve) => {
      canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', 0.88);
    });
    if (!out) return null;
    return {
      bytes: new Uint8Array(await out.arrayBuffer()),
      png,
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    bitmap.close?.();
  }
}

async function loadOne(url: string): Promise<LoadedImage | null> {
  const blob = await fetchMediaBlob(url, { width: TARGET_WIDTH });
  if (!blob || blob.size > MAX_BYTES) return null;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Already embeddable and already a sensible size: pass the ORIGINAL bytes
  // through rather than re-encoding, which would only lose quality.
  const asPng = pngSize(bytes);
  if (asPng && asPng.width <= TARGET_WIDTH) return { bytes, png: true, ...asPng };
  const asJpeg = jpegSize(bytes);
  if (asJpeg && asJpeg.width <= TARGET_WIDTH) return { bytes, png: false, ...asJpeg };

  return toEmbeddable(blob);
}

/**
 * Every distinct picture in the document, fetched in parallel.
 *
 * Keyed by URL, so the same logo used in six places is fetched once and
 * embedded six times from one copy.
 */
export async function loadImages(blocks: Block[]): Promise<Map<string, LoadedImage>> {
  const urls: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'image' && b.url && !urls.includes(b.url)) urls.push(b.url);
    if (urls.length >= MAX_COUNT) break;
  }
  const loaded = new Map<string, LoadedImage>();
  await Promise.all(urls.map(async (u) => {
    const img = await loadOne(u).catch(() => null);
    if (img) loaded.set(u, img);
  }));
  return loaded;
}
