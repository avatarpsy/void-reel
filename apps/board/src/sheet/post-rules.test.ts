import { describe, expect, it } from 'vitest';

import { columnFor, formatKind, platformId, postIssues, splitPlatforms } from './post-rules';

describe('post rules', () => {
  it('warns when an X caption is over 280 characters, and only for X', () => {
    const caption = 'a'.repeat(300);
    const issues = postIssues({ platforms: ['Instagram', 'X'], caption });
    expect(issues).toEqual([{ field: 'caption', platform: 'x', text: 'Too long for X: 300 of 280 characters.' }]);
  });

  it('counts an emoji as one character', () => {
    expect(postIssues({ platforms: ['X'], caption: '🙂'.repeat(280) })).toEqual([]);
  });

  it('says in plain words when a platform cannot post a format', () => {
    expect(postIssues({ platforms: ['Instagram'], format: 'Text', caption: 'hi' })[0]?.text).toBe("Instagram can't post Text.");
    expect(postIssues({ platforms: ['YouTube'], format: 'Image' })[0]?.text).toBe("YouTube can't post an Image.");
    expect(postIssues({ platforms: ['X'], format: 'Story' })[0]?.text).toBe('A Story only goes to Instagram or Facebook, not X.');
  });

  it('ignores a story caption, and checks the YouTube title and Instagram hashtags', () => {
    expect(postIssues({ platforms: ['Instagram'], format: 'Story', caption: 'a'.repeat(5000) })).toEqual([]);
    expect(postIssues({ platforms: ['YouTube'], title: 'a'.repeat(101) })[0]?.field).toBe('title');
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    expect(postIssues({ platforms: ['Instagram'], caption: tags })[0]?.text).toBe('Too many hashtags for Instagram: 31 of 30.');
  });

  it('reads platforms, formats and columns the way people write them', () => {
    expect(splitPlatforms('Instagram, Twitter and YouTube Shorts')).toEqual(['instagram', 'x', 'youtube']);
    expect(platformId('Shorts')).toBe('youtube');
    expect(formatKind('Reel')).toBe('video');
    expect(formatKind('Thread')).toBe('text');
    expect(columnFor('title', ['Date', 'Hook', 'Caption'])).toBe(1);
    expect(columnFor('caption', ['Date', 'Hook', 'Caption'])).toBe(2);
  });
});
