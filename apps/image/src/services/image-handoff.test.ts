/**
 * WHICH SOURCES CAN BE EDITED IN PLACE.
 *
 * This one answer decides the whole shape of Save: a source with an overwrite
 * target defaults to "Update original" and changes the picture everywhere it is
 * already referenced; a source without one can only save a copy, which leaves
 * the card that opened the editor still showing the old image unless the caller
 * asked for the round trip.
 *
 * Getting it wrong in either direction is a real failure — offering "Update
 * original" for a provider url produces a save that cannot work, and refusing
 * it for our own cover is the one-way trip this parser was added to end.
 */
import { describe, expect, it } from 'vitest';

import { parseCloudEditSource, parseEditSource, parseLocalAssetSource } from './image-handoff';

const BUCKET = 'voidspace-v1.appspot.com';

describe('a studio file on disk', () => {
  it('is a local overwrite target', () => {
    const src = '/api/studio/local-asset?projectId=p1&kind=image&filename=scene_1.png';
    expect(parseLocalAssetSource(src)).toMatchObject({
      origin: 'local', projectId: 'p1', kind: 'image', filename: 'scene_1.png', ext: 'png',
    });
  });

  it('is what `parseEditSource` prefers, when a url is both', () => {
    // Not a real overlap today, but the order is load-bearing: writing through
    // save-render keeps the studio's manifest in step, which the cloud path
    // knows nothing about.
    const src = '/api/studio/local-asset?projectId=p1&filename=a.png';
    expect(parseEditSource(src)!.origin).toBe('local');
  });
});

describe('an image in our own bucket', () => {
  it('is a cloud overwrite target', () => {
    // What `mirrorToDurableStorage` writes for a generated cover.
    const src = `https://storage.googleapis.com/${BUCKET}/studio-mirrors/u1/agent_img_9.png`;
    expect(parseCloudEditSource(src)).toMatchObject({
      origin: 'cloud', filename: 'agent_img_9.png', ext: 'png', url: src,
    });
  });

  it('reads the bucket-subdomain and Firebase download spellings too', () => {
    expect(parseCloudEditSource(`https://${BUCKET}.storage.googleapis.com/project-covers/u1/p.jpg`))
      .toMatchObject({ origin: 'cloud', filename: 'p.jpg', ext: 'jpg' });
    expect(parseCloudEditSource(
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/agent_chat_images%2Fu1%2Fa.webp?alt=media&token=t`,
    )).toMatchObject({ origin: 'cloud', filename: 'a.webp', ext: 'webp' });
  });

  it('keeps the url EXACTLY as given, cache-buster and all', () => {
    // The card displays covers with an `r=` buster appended, so that is the
    // string Edit hands over. It must travel back to the server unchanged —
    // the server matches on the object path and ignores the query, and any
    // "tidying" here is a second url-parser to keep in step with that one.
    const src = `https://storage.googleapis.com/${BUCKET}/studio-mirrors/u1/c.png?r=4`;
    expect(parseCloudEditSource(src)!.url).toBe(src);
  });
});

describe('sources with no overwrite target', () => {
  it('refuses a provider url', () => {
    // A Suno cover or a Kie tempfile: not ours to write, and offering to
    // replace it would produce a save that always fails.
    expect(parseCloudEditSource('https://cdn2.suno.ai/image_abc.jpeg')).toBeNull();
    expect(parseCloudEditSource('https://tempfile.aiquickdraw.com/s/x.png')).toBeNull();
    expect(parseEditSource('https://cdn2.suno.ai/image_abc.jpeg')).toBeNull();
  });

  it('refuses a format we cannot encode back', () => {
    // The url and its extension do not change on an overwrite, so bytes in a
    // different format would serve as a broken image at an address nothing
    // downstream can correct.
    expect(parseCloudEditSource(`https://storage.googleapis.com/${BUCKET}/m/u1/a.gif`)).toBeNull();
    expect(parseCloudEditSource(`https://storage.googleapis.com/${BUCKET}/m/u1/a.svg`)).toBeNull();
    expect(parseCloudEditSource(`https://storage.googleapis.com/${BUCKET}/m/u1/track.mp3`)).toBeNull();
    expect(parseCloudEditSource(`https://storage.googleapis.com/${BUCKET}/m/u1/noext`)).toBeNull();
  });

  it('refuses plain http and junk', () => {
    expect(parseCloudEditSource(`http://storage.googleapis.com/${BUCKET}/m/u1/a.png`)).toBeNull();
    expect(parseCloudEditSource('')).toBeNull();
    expect(parseCloudEditSource('not a url')).toBeNull();
  });
});
