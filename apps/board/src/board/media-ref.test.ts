import { describe, expect, it } from 'vitest';

import { decodeMediaRef, encodeMediaRef, guessMime, isMediaRef } from './media-ref';

describe('media references', () => {
  it('round-trips every field', () => {
    const ref = {
      src: 'https://x.test/a.png?sig=1',
      kind: 'image' as const,
      mime: 'image/png',
      poster: 'https://x.test/p.jpg',
      id: 'asset-1',
      scope: 'shared' as const,
    };
    expect(decodeMediaRef(encodeMediaRef(ref))).toEqual(ref);
  });

  it('survives non-ASCII filenames', () => {
    // `btoa` throws on these. It was the obvious encoding and would have broken
    // for exactly the users whose files are not named in English.
    const ref = { src: 'https://x.test/café — final.png', kind: 'image' as const };
    expect(decodeMediaRef(encodeMediaRef(ref))?.src).toBe(ref.src);
  });

  it('does not claim a plain blob key', () => {
    // AFFiNE's own content-hash keys must keep going to local storage.
    expect(isMediaRef('8f4a2c9e1b')).toBe(false);
    expect(decodeMediaRef('8f4a2c9e1b')).toBeNull();
  });

  it('returns null for a corrupt reference instead of throwing', () => {
    // A doc written by a future build, or a truncated key. The board must render
    // that block as unavailable, not fail to open.
    expect(decodeMediaRef('vsmedia:%7Bnot-json')).toBeNull();
  });

  it('guesses a MIME the embed configs will accept', () => {
    // `check: type.startsWith('video/')` decides player vs download chip, so an
    // empty or wrong type silently downgrades the card.
    expect(guessMime('https://x.test/clip.mov', 'video')).toBe('video/quicktime');
    expect(guessMime('https://x.test/song.wav', 'audio')).toBe('audio/wav');
    expect(guessMime('https://x.test/a.png', 'image')).toBe('image/png');
  });

  it('falls back per kind when the url carries no extension', () => {
    // Signed cloud urls routinely end in a token, not a filename.
    expect(guessMime('https://x.test/file?token=abc', 'video')).toBe('video/mp4');
    expect(guessMime('https://x.test/file?token=abc', 'audio')).toBe('audio/mpeg');
  });

  it('ignores an extension that contradicts the kind', () => {
    // A video's POSTER url ends in .jpg; treating that as the clip's type would
    // make the card render as an image and never play.
    expect(guessMime('https://x.test/thumb.jpg', 'video')).toBe('video/mp4');
  });
});
