/**
 * Placing Library media on the OPEN CANVAS.
 *
 * SHOTS DO NOT COME THROUGH HERE ANY MORE, and that is the point. An asset
 * dropped on a shot is appended to that shot's own media list (`shot/drop.ts`) —
 * no block is created, nothing is downloaded, and there is nothing on the canvas
 * to duplicate or drag out of place. This file now serves only the free canvas:
 * mood boards, alternatives to compare, the stuff of thinking.
 *
 * That deletion is why the "arranger" is gone. It used to run after every
 * placement, repositioning loose blocks into a shot's slots and lanes, and it
 * raced with the user's own drag — the single largest source of the stuck and
 * duplicated media the board was reported for.
 *
 * TWO RULES REMAIN, and every bug this file has had came from breaking one.
 *
 * 1. USE AFFiNE'S OWN INSERT HELPERS. `addImages` / `addAttachments` register the
 *    blob, size the block from real dimensions, convert the drop point, select
 *    the result and place it on the surface. An earlier build wrote
 *    `store.addBlock('affine:image', { sourceId: url })` by hand and every image
 *    rendered "Image not found", because `sourceId` is a blob key and never a
 *    URL. Drop, paste and toolbar-insert now go through literally the same
 *    function, so they cannot diverge.
 *
 * 2. THE BOARD NEVER OWNS THE BYTES. What the helpers register is a REFERENCE
 *    (`board/media-ref.ts`), announced to the blob engine before the call. So:
 *
 *      images  — fetched once at DISPLAY size (a server thumbnail or a resized
 *                proxy, tens of KB) so the drop is instant and the canvas copy
 *                is not a 4K master scaled into a 480px panel;
 *      video   — nothing is fetched at all. The card is created from metadata
 *                read over the network, and the player streams from the URL with
 *                range requests, exactly as it would on any web page;
 *      audio   — the same, minus the aspect probe.
 *
 *    That is what makes a 200-clip board open as fast as an empty one.
 */
import { addAttachments, AttachmentEmbedProvider } from '@blocksuite/affine/blocks/attachment';
import { addImages } from '@blocksuite/affine/blocks/image';
import type { AttachmentBlockModel } from '@blocksuite/affine/model';

import type { BlockStdScope } from '@blocksuite/std';
import { absoluteUrl } from '@openreel/asset-browser';

import type { BoardBlobEngine } from '../blocksuite/blob-source';
import { writeBlockMeta } from './board-meta';
import { topIndex } from '../shot/shots';
import { encodeMediaRef, guessMime } from './media-ref';
import { getParentToken, withToken } from './parent-auth';

/** How wide a placed image may be on the canvas. A storyboard panel is 480px;
 *  anything past this is detail no one will see at board zoom. */
const MAX_CANVAS_IMAGE_WIDTH = 960;

export interface PlaceAssetInput {
  /** What the CANVAS loads. A thumbnail or 720p proxy when the server has one. */
  displayUrl: string;
  /** Full quality, carried to compile. Defaults to `displayUrl`. */
  originalUrl?: string;
  kind: 'image' | 'video' | 'audio';
  /** Voidspace Library id, and which library it belongs to. */
  mediaId?: string;
  scope?: 'mine' | 'shared' | 'device';
  name?: string;
  mime?: string;
  /** A still for a video card, so it paints without touching the clip. */
  posterUrl?: string;
  /** Real byte size, so the card can state it without downloading anything. */
  bytes?: number;
  createdBy?: 'user' | 'agent';
  /** Screen coordinates of the drop, when there was one. */
  clientPoint?: [number, number];
  /** Where it came from — see `BlockMeta`. Recorded so "that one, but warmer"
   *  is an edit of a known thing rather than a fresh guess. */
  prompt?: string;
  referenceIds?: string[];
  model?: string;
  sourceUrl?: string;
  credit?: string;
}

export type PlaceResult =
  | { ok: true; blockId: string }
  | { ok: false; reason: 'unavailable' | 'rejected'; message: string };

/**
 * Real pixel dimensions, read over the network without downloading the file.
 *
 * `preload="metadata"` fetches only the container header, so probing a 2 GB
 * master costs a few kilobytes. Resolves null rather than rejecting: an
 * unreadable header should place the card at the default size, never fail the
 * drop — a clip the browser cannot parse is still a clip the user wants on the
 * board.
 */
function probeVideo(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let settled = false;
    const done = (r: { w: number; h: number } | null) => {
      if (settled) return;
      settled = true;
      v.removeAttribute('src');
      v.load();
      resolve(r);
    };
    v.onloadedmetadata = () =>
      done(v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : null);
    v.onerror = () => done(null);
    // A clip on a slow origin must not hold the drop open. The card lands at the
    // default ratio and the user can resize it — far better than a stalled drop.
    setTimeout(() => done(null), 6_000);
    v.src = src;
  });
}

/** Fetch the display variant with auth, retrying once with a fresh token. */
async function fetchDisplayBlob(url: string): Promise<Blob | null> {
  for (const force of [false, true]) {
    const token = await getParentToken(force).catch(() => null);
    try {
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.ok) return await res.blob();
      if (res.status !== 401 && res.status !== 403) return null;
      // Nothing to refresh — see the same note in blob-source.
      if (!token) return null;
    } catch {
      return null;
    }
  }
  return null;
}

function engineOf(std: BlockStdScope): BoardBlobEngine {
  return std.store.blobSync as unknown as BoardBlobEngine;
}

/**
 * Place one Library asset and record what it is.
 *
 * Returns a structured result rather than a boolean: the caller has to be able to
 * tell the user WHY nothing appeared. A silent false is how "adding media doesn't
 * work" stayed a mystery while the real cause was expired links in the library.
 */
export async function placeAsset(
  // No surfaceId: both add helpers resolve the surface through the gfx
  // controller, which is one less thing for a caller to get wrong.
  std: BlockStdScope,
  input: PlaceAssetInput,
): Promise<PlaceResult> {
  // A READ-ONLY DOCUMENT ACCEPTS NOTHING. Checked before the fetch, not after:
  // the user should not wait for a download to be told it will be refused.
  //
  // This is a genuinely read-only SESSION — a shared link — and no longer means
  // "compiled". Compiling leaves the board editable.
  if (std.store.readonly) {
    return {
      ok: false,
      reason: 'rejected',
      message: 'This board is open read-only, so media cannot be added right now.',
    };
  }

  const displayUrl = absoluteUrl(input.displayUrl);
  const mime = input.mime || guessMime(displayUrl, input.kind);
  const name = input.name?.trim() || `media.${input.kind === 'image' ? 'png' : 'mp4'}`;
  const engine = engineOf(std);

  const refKey = encodeMediaRef({
    src: displayUrl,
    kind: input.kind,
    mime,
    poster: input.posterUrl ? absoluteUrl(input.posterUrl) : undefined,
    id: input.mediaId,
    scope: input.scope,
  });

  // What the block IS, recorded where the viewer can find it. There is no role
  // here any more — a role only means something inside a shot, and a shot keeps
  // its own.
  const stamp = (blockId: string) => {
    writeBlockMeta(std.store.doc.spaceDoc, blockId, {
      mediaId: input.mediaId,
      scope: input.scope,
      kind: input.kind,
      originalUrl: absoluteUrl(input.originalUrl || input.displayUrl),
      name: input.name?.trim() || undefined,
      createdBy: input.createdBy ?? 'user',
      // Provenance, when the caller knows it. Omitted rather than stored empty
      // so "generated" and "dropped in" stay distinguishable.
      ...(input.prompt ? { prompt: input.prompt.slice(0, 2000) } : {}),
      ...(input.referenceIds?.length ? { referenceIds: input.referenceIds } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.credit ? { credit: input.credit } : {}),
    });
  };

  // ── VIDEO / AUDIO ────────────────────────────────────────────────────────
  // Nothing is downloaded. `addAttachments` needs a File for its name, type and
  // size, so it gets an EMPTY one carrying exactly those; the reference is what
  // the block ends up pointing at, and `media-embed.ts` streams from it.
  if (input.kind !== 'image') {
    const streamSrc = withToken(displayUrl);

    const stub = new File([], name, { type: mime });
    engine.hint(stub, refKey);

    const ids = await addAttachments(std, [stub], input.clientPoint, true);
    if (!ids.length) {
      return { ok: false, reason: 'rejected', message: 'The canvas refused this file.' };
    }

    const blockId = ids[0];
    const model = std.store.getBlock(blockId)?.model as AttachmentBlockModel | undefined;
    if (model) {
      // The real byte size, so the card states the truth even though we never
      // read a byte. Left at 0 it reads as an empty file.
      if (input.bytes) std.store.updateBlock(model, { size: input.bytes });
      // Turns the download CHIP into the PLAYER.
      std.get(AttachmentEmbedProvider).convertTo(model);
      /**
       * AN INDEX, because `addAttachments` does not set one.
       *
       * Unlike `addImages` (`affine-block-image/src/utils.ts:345`), the
       * attachment helper omits `index` entirely, so the block takes the
       * schema's literal `'a0'` — below every note and text on the board. The
       * visible result is a video card sliding UNDER the shot's notes, showing
       * as a black slab with words on top of it, and refusing to be clicked.
       */
      std.store.updateBlock(model, { index: topIndex(std) });
      stamp(blockId);

      /**
       * THE ASPECT PROBE RUNS AFTER THE CARD EXISTS, never before it.
       *
       * `probeVideo` waits on the network — up to six seconds for a clip whose
       * source is slow or dead. Awaiting it before inserting meant the canvas
       * sat empty for those six seconds with no sign the drop had registered,
       * which is exactly "I drag a video in and it gets stuck". The card now
       * appears immediately at 16:9 and corrects itself if the real ratio turns
       * out to differ.
       */
      if (input.kind === 'video') {
        void probeVideo(streamSrc).then(dims => {
          if (!dims || !dims.w) return;
          // The user may have deleted it, or moved it, while we were waiting —
          // so only the HEIGHT is corrected, from the card's current box.
          const live = std.store.getBlock(blockId);
          if (!live || std.store.readonly) return;
          const box = JSON.parse((live.model.props as { xywh: string }).xywh) as number[];
          std.store.updateBlock(live.model, {
            xywh: `[${box[0]},${box[1]},${box[2]},${Math.round((box[2] * dims.h) / dims.w)}]`,
          });
        });
      }
    }
    return { ok: true, blockId };
  }

  // ── IMAGE ────────────────────────────────────────────────────────────────
  // `addImages` reads real dimensions off the file, so this one genuinely needs
  // bytes — but only the DISPLAY variant's, which the caller sized for a canvas.
  const blob = await fetchDisplayBlob(displayUrl);
  if (!blob) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'That asset could not be loaded — its link may have expired.',
    };
  }
  if (!blob.type.startsWith('image/')) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'That link did not return an image.',
    };
  }

  const file = new File([blob], name, { type: blob.type });
  engine.hint(file, refKey);
  // Seeds the cache under the reference, so the picture paints from memory
  // instead of being re-fetched the instant the block connects.
  await engine.set(refKey, blob);

  const ids = await addImages(std, [file], {
    point: input.clientPoint,
    maxWidth: MAX_CANVAS_IMAGE_WIDTH,
    // AFFiNE converts screen → model coordinates itself; doing it here as well
    // double-transforms and lands the image somewhere else entirely.
    shouldTransformPoint: true,
  });
  if (!ids.length) {
    return { ok: false, reason: 'rejected', message: 'The canvas refused this image.' };
  }
  stamp(ids[0]);
  return { ok: true, blockId: ids[0] };
}
