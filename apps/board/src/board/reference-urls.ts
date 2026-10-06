/**
 * Canvas blocks → urls a GENERATION can be handed.
 *
 * A generation runs on the server, so every reference must be a url the server
 * can fetch. A Library picture already has one. A picture the user DROPPED onto
 * the board does not: it is a content key in the board's own blob store, and
 * `mediaUrlOf` used to return nothing for it — so "use these two character
 * sheets" came back as "None of those ids are media on the canvas" while both
 * sheets sat right there.
 *
 * For such a block this returns the board's durable cloud backup: the one the
 * drop already made when it finished, or — if it has not — one made now through
 * the same door (`NativeMediaStore.durableUrl`, i.e. `upload-attachment`),
 * which records it beside the key so it is never uploaded twice. The url is
 * also written to the block's `boardMeta.originalUrl`, so every other reader
 * (`mediaUrlOf`, the viewer, an attach) finds it without asking again.
 *
 * Never returns `vs-local:`/`blob:`/`data:` — those are this tab's addresses.
 * A picture that cannot be made available is reported per id, with why
 * (storage full, signed out, original missing), separately from an id that is
 * simply not media.
 */
import type { BlockStdScope } from '@blocksuite/std';
import type { BoardWorkspace } from '../blocksuite/workspace';
import { readBlockMeta, writeBlockMeta } from './board-meta';
import { isServerFetchable, localMediaKey, mediaUrlOf } from './canvas';
import { decodeMediaRef } from './media-ref';
import { uploadBlob } from './document-export';

export type ReferenceProblemReason = 'not_found' | 'not_media' | 'storage_full' | 'unavailable';

export interface ReferenceProblem {
  id: string;
  reason: ReferenceProblemReason;
  message: string;
}

export interface ResolvedReferences {
  /** The ids that resolved, in the order asked for. */
  ids: string[];
  /** Server-fetchable urls, parallel to `ids`. */
  mediaUrls: string[];
  /** Every id that did not resolve, and why. */
  problems: ReferenceProblem[];
}

/** Whether a canvas block holds a picture, clip or track at all. */
export function isCanvasMediaBlock(std: BlockStdScope, id: string): boolean {
  const block = std.store.getBlock(id);
  if (!block) return false;
  if (block.flavour === 'affine:image') return true;
  if (block.flavour !== 'affine:attachment') return false;
  const props = block.model.props as { sourceId?: string; type?: string };
  if (/^(image|video|audio)\//.test(props.type ?? '')) return true;
  if (props.sourceId && decodeMediaRef(props.sourceId)) return true;
  return !!readBlockMeta(std.store.doc.spaceDoc, id)?.kind;
}

/** Words that mean the account has no room, as the upload door phrases it. */
const STORAGE_FULL = /\b(space|storage|quota|full)\b/i;

async function durableUrlFor(std: BlockStdScope, id: string, key: string): Promise<string> {
  const native = (std.store.doc.workspace as BoardWorkspace).blobSource?.native;
  if (native) return native.durableUrl(key);
  // No native store (a board opened without its doc): the same door, directly.
  const blob = await std.store.blobSync.get(key);
  if (!blob) throw new Error('The original file is not on this device. Relink its original.');
  const name = String((std.store.getBlock(id)?.model.props as { name?: string })?.name || 'board-reference');
  return uploadBlob(blob, name, 'durable');
}

/**
 * Resolve ids to server-fetchable urls, ORDER FOLLOWING THE CALLER — a model
 * takes references positionally, so "the first one is the style" must survive.
 */
export async function resolveReferenceUrls(std: BlockStdScope, ids: string[]): Promise<ResolvedReferences> {
  const results = await Promise.all(ids.map(async (id): Promise<{ id: string; url?: string; problem?: ReferenceProblem }> => {
    const block = std.store.getBlock(id);
    if (!block) {
      return { id, problem: { id, reason: 'not_found', message: `${id} is not on the board. Call board_canvas_read for the current ids.` } };
    }
    const ready = mediaUrlOf(std, id);
    if (ready) return { id, url: ready };
    if (!isCanvasMediaBlock(std, id)) {
      return { id, problem: { id, reason: 'not_media', message: `${id} is not a picture, clip or track.` } };
    }
    const key = localMediaKey(std, id);
    if (!key) {
      return { id, problem: { id, reason: 'unavailable', message: `${id} has no file behind it. Replace or relink it.` } };
    }
    try {
      const url = await durableUrlFor(std, id, key);
      if (!isServerFetchable(url)) throw new Error('Cloud backup came back without a usable link.');
      // Recorded only while the block still holds the SAME original — the user
      // may have relinked or deleted it during the upload.
      if (!std.store.readonly && localMediaKey(std, id) === key) {
        writeBlockMeta(std.store.doc.spaceDoc, id, { originalUrl: url });
      }
      return { id, url };
    } catch (e) {
      const why = e instanceof Error && e.message ? e.message : 'Cloud backup failed.';
      return {
        id,
        problem: {
          id,
          reason: STORAGE_FULL.test(why) ? 'storage_full' : 'unavailable',
          message: `${id} is on the board but could not be made available to the generator: ${why}`,
        },
      };
    }
  }));
  const ok = results.filter(r => r.url);
  return {
    ids: ok.map(r => r.id),
    mediaUrls: ok.map(r => r.url!),
    problems: results.flatMap(r => (r.problem ? [r.problem] : [])),
  };
}
