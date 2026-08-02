/**
 * Media references — what the board stores INSTEAD of bytes.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 * BlockSuite addresses media through `sourceId`, a key into the workspace's blob
 * store. AFFiNE's own helpers (`addImages`, `addAttachments`) put the FILE there,
 * which is correct for a note-taking app whose attachments have no other home.
 * A Voidspace board is different: every asset on it already lives in the user's
 * Library, and it is going to be compiled into a video project that reads the
 * Library too. Copying the bytes into the board would mean
 *
 *   • the board's local database grows with total media size, so opening a
 *     50-shot board of 4K stills means reading ~500 MB off disk before anything
 *     paints — the exact opposite of "must work regardless of how big";
 *   • every drop waits for a full download before the user sees anything;
 *   • a cloud snapshot of the board carries a second copy of media Voidspace is
 *     already storing and already charging for.
 *
 * SO A `sourceId` ON THIS BOARD IS A REFERENCE, NOT A KEY TO BYTES. It encodes
 * where the asset lives, and the blob source (`blocksuite/blob-source.ts`)
 * resolves it on demand: images are fetched at display size and cached, video and
 * audio are STREAMED straight from the URL by the player and never held at all.
 * The document itself stays a few hundred bytes per card no matter how big the
 * media is.
 *
 * The encoding is deliberately a plain string: `sourceId` is a string in the
 * BlockSuite schema, it is what the native helpers pass around, and keeping the
 * reference inside it means every native affordance — copy/paste, duplicate,
 * undo, the edgeless clipboard — carries the reference correctly for free.
 */

/** Marks a `sourceId` as one of ours. Anything without it is a real local blob. */
export const MEDIA_REF_PREFIX = 'vsmedia:';

export interface MediaRef {
  /**
   * What the CANVAS loads: a display-sized variant (server thumbnail, 720p
   * proxy) when one exists. Never the master — a storyboard panel is ~480px
   * wide and pulling a 4K original to fill it is the slow path for no gain.
   */
  src: string;
  kind: 'image' | 'video' | 'audio';
  /** MIME, so a streamed card knows what it is without fetching a byte. */
  mime?: string;
  /**
   * A still for a video card.
   *
   * With one, the `<video>` needs `preload="none"` and fetches nothing until the
   * user presses play — which is the difference between a hundred clips costing
   * a hundred small images and costing a hundred container headers.
   */
  poster?: string;
  /** Voidspace Library id. What compile carries into the project. */
  id?: string;
  /** Which library the id belongs to — they have separate id spaces. */
  scope?: 'mine' | 'shared' | 'device';
}

export function isMediaRef(key: string): boolean {
  return typeof key === 'string' && key.startsWith(MEDIA_REF_PREFIX);
}

/**
 * `encodeURIComponent` rather than base64: the payload contains URLs with
 * non-ASCII characters in filenames, and `btoa` throws on those — a failure that
 * would only appear for the one user whose file is called `café.png`.
 */
export function encodeMediaRef(ref: MediaRef): string {
  return MEDIA_REF_PREFIX + encodeURIComponent(JSON.stringify(ref));
}

export function decodeMediaRef(key: string): MediaRef | null {
  if (!isMediaRef(key)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(key.slice(MEDIA_REF_PREFIX.length))) as MediaRef;
    return parsed && typeof parsed.src === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A best-effort MIME from a URL.
 *
 * Video and audio are placed WITHOUT downloading anything, so there is no blob to
 * sniff — but the attachment block's embed configs dispatch on
 * `type.startsWith('video/')`, so a wrong or empty type silently produces a
 * download chip instead of a player. Guessing from the extension covers the real
 * library; the caller's own `mime` wins whenever the API supplied one.
 */
export function guessMime(url: string, kind: 'image' | 'video' | 'audio'): string {
  const ext = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? '';
  const byExt: Record<string, string> = {
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
    mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
    ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
  };
  const hit = byExt[ext];
  if (hit && hit.startsWith(`${kind === 'audio' ? 'audio' : kind}/`)) return hit;
  // A generic fallback per kind. `application/octet-stream` would fail every
  // embed check and give the user a download chip they cannot play.
  return kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg';
}
