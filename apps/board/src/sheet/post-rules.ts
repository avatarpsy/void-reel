/**
 * WHAT EACH PLATFORM TAKES — caption lengths, and which formats it can post.
 *
 * The ONE copy of these rules. Pure and import-free, like `sheet-data.ts`, so
 * the board (the marker on a caption cell, the phone card) and the website
 * (`/api/board/sheet-post` and the `publish` tool) read the very same numbers:
 * `scripts/build-board.mjs` copies this file to
 * `Voidspace-Website/main/server/utils/board-post-rules.generated.ts`.
 *
 * A content-calendar row is ONE post: one caption, one time, one media, going
 * to one or more platforms. These rules only warn; nothing here blocks a write.
 */

/** The Format column's choices, in menu order. */
export const FORMATS = ['Reel', 'Short', 'Video', 'Carousel', 'Image', 'Story', 'Text', 'Thread'] as const;

/** What the publish tool calls each format. */
export type PostKind = 'video' | 'carousel' | 'image' | 'story' | 'text';

export function formatKind(format: string): PostKind | null {
  switch (format.trim().toLowerCase()) {
    case 'reel': case 'reels': case 'short': case 'shorts': case 'video': return 'video';
    case 'carousel': return 'carousel';
    case 'image': case 'picture': case 'photo': return 'image';
    case 'story': case 'stories': return 'story';
    case 'text': case 'thread': return 'text';
    default: return null;
  }
}

/** A platform as people type it ("Twitter", "IG", "YouTube Shorts") -> our id. */
export function platformId(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^@/, '').replace(/[\s_-]+/g, ' ');
  const alias: Record<string, string> = {
    twitter: 'x', 'x.com': 'x', tweet: 'x', ig: 'instagram', insta: 'instagram',
    yt: 'youtube', shorts: 'youtube', 'youtube shorts': 'youtube', 'yt shorts': 'youtube',
    fb: 'facebook', 'linked in': 'linkedin', 'tik tok': 'tiktok', 'whatsapp status': 'whatsapp',
  };
  return alias[s] ?? s.replace(/\s+/g, '');
}

const NAME: Record<string, string> = {
  x: 'X', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn',
  facebook: 'Facebook', threads: 'Threads', whatsapp: 'WhatsApp', pinterest: 'Pinterest',
};
export function platformName(id: string): string { return NAME[id] ?? id.charAt(0).toUpperCase() + id.slice(1); }

/** Caption characters each platform takes. Facebook (about 63,000) is never reached. YouTube: the description. */
export const CAPTION_LIMIT: Readonly<Record<string, number>> = {
  x: 280, threads: 500, instagram: 2200, tiktok: 2200, linkedin: 3000, youtube: 5000,
};
/** YouTube's title — the row's Title or Hook. */
export const TITLE_LIMIT: Readonly<Record<string, number>> = { youtube: 100 };
export const HASHTAG_LIMIT: Readonly<Record<string, number>> = { instagram: 30 };

/** Platforms that cannot post a format at all. Mirrors the publish tool's own checks. */
const CANNOT: Record<PostKind, readonly string[]> = {
  video: [],
  image: ['youtube'],
  carousel: ['youtube'],
  text: ['instagram', 'tiktok', 'youtube'],
  story: [],
};
/** A story goes to these only (Business Suite / the linked WhatsApp). */
const STORY_PLATFORMS = ['instagram', 'facebook', 'whatsapp'];

export function canPost(platform: string, kind: PostKind | null): boolean {
  if (!kind) return true;
  if (kind === 'story') return STORY_PLATFORMS.includes(platform);
  return !CANNOT[kind].includes(platform);
}

/** Characters as people count them (an emoji is one). */
export function charCount(s: string): number { return [...s].length; }
export function hashtagCount(s: string): number { return (s.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length; }

/**
 * Column names a row's fields go by, normalised (lower case, words only).
 * The first name a sheet has wins. Shared with sheet-post, which reads rows by meaning.
 */
export const ROW_NAMES = {
  status: ['status', 'state', 'post status', 'stage'],
  date: ['date', 'post date', 'publish date', 'day', 'go live date'],
  time: ['time', 'post time', 'publish time', 'go live time'],
  when: ['when', 'scheduled', 'scheduled for', 'publish at', 'post at', 'date time', 'datetime'],
  platforms: ['platforms', 'platform', 'channels', 'channel', 'networks', 'where', 'socials'],
  caption: ['caption', 'copy', 'post copy', 'post text', 'text', 'post', 'description'],
  title: ['title', 'video title', 'headline', 'hook'],
  media: ['media', 'video', 'image', 'images', 'asset', 'assets', 'creative', 'visual', 'media url', 'file'],
  cover: ['cover', 'thumbnail', 'cover image'],
  avatar: ['avatar', 'account', 'posting as', 'post as', 'persona'],
  via: ['via', 'post via', 'post from'],
  format: ['format', 'placement', 'type'],
  postLink: ['post link', 'link to post', 'live link', 'published link', 'post url'],
} as const;

export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Of these column names, the one that stands for `field` (first name in the list wins), or -1. */
export function columnFor(field: keyof typeof ROW_NAMES, names: readonly string[]): number {
  const norm = names.map(normName);
  for (const n of ROW_NAMES[field]) {
    const i = norm.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

/** A Platforms cell ("Instagram, TikTok") as platform ids, in order, once each. */
export function splitPlatforms(cell: string): string[] {
  const out: string[] = [];
  for (const p of cell.split(/[,;/|]+|\s+and\s+/i)) {
    const id = p.trim() ? platformId(p) : '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface PostIssue { field: 'caption' | 'title' | 'format'; platform: string; text: string }

/**
 * What would not fit, in plain words: a caption too long for a platform, too
 * many hashtags, a YouTube title over 100, a format a platform cannot post.
 */
export function postIssues(input: { platforms: readonly string[]; format?: string; caption?: string; title?: string }): PostIssue[] {
  const out: PostIssue[] = [];
  const format = (input.format ?? '').trim();
  const kind = formatKind(format);
  const ids = input.platforms.map(platformId).filter(Boolean);
  const caption = input.caption ?? '';
  const title = input.title ?? '';
  const n = charCount(caption);
  const tags = hashtagCount(caption);
  for (const p of ids) {
    const name = platformName(p);
    if (!canPost(p, kind)) {
      out.push({
        field: 'format', platform: p,
        text: kind === 'story' ? `A Story only goes to Instagram or Facebook, not ${name}.`
          : `${name} can't post ${/^text$/i.test(format) ? 'Text' : `${/^[aeiou]/i.test(format) ? 'an' : 'a'} ${format}`}.`,
      });
      continue;
    }
    // A story does not show its caption, so its length never matters.
    if (kind === 'story') continue;
    const limit = CAPTION_LIMIT[p];
    if (limit && n > limit) out.push({ field: 'caption', platform: p, text: `Too long for ${name}: ${n.toLocaleString('en')} of ${limit.toLocaleString('en')} characters.` });
    const tagLimit = HASHTAG_LIMIT[p];
    if (tagLimit && tags > tagLimit) out.push({ field: 'caption', platform: p, text: `Too many hashtags for ${name}: ${tags} of ${tagLimit}.` });
    const tl = TITLE_LIMIT[p];
    if (tl && charCount(title) > tl) out.push({ field: 'title', platform: p, text: `Too long for a ${name} title: ${charCount(title)} of ${tl} characters.` });
  }
  return out;
}
