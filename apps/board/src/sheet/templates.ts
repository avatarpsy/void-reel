/**
 * Ready-made sheets — the three jobs people plan in a table on this product.
 *
 *   content-calendar  daily posting and social media marketing
 *   season-plan       one row per episode of a series
 *   shot-list         the board's own shots, as a table (bound, no copies)
 */
import type { TabSpec } from './ops';

export type TemplateId = 'content-calendar' | 'season-plan' | 'shot-list' | 'blank';

export const TEMPLATES: Array<{ id: TemplateId; label: string; hint: string }> = [
  { id: 'content-calendar', label: 'Content calendar', hint: 'Plan daily posts: date, platforms, hook, caption, status.' },
  { id: 'season-plan', label: 'Season plan', hint: 'One row per episode: title, logline, beats, cast, air date.' },
  { id: 'shot-list', label: 'Shot list', hint: "This board's shots as a table. Edits change the cards." },
  { id: 'blank', label: 'Blank sheet', hint: 'Start from empty columns.' },
];

export const PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'Shorts', 'X', 'LinkedIn', 'Facebook', 'Threads'];
export const POST_STATUS = [
  { label: 'Idea', color: 'grey' },
  { label: 'Draft', color: 'blue' },
  { label: 'Ready', color: 'purple' },
  { label: 'Scheduled', color: 'amber' },
  { label: 'Posted', color: 'green' },
];

function isoDay(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function templateTab(id: TemplateId, opts: { rows?: number } = {}): { title: string; tab: TabSpec } {
  switch (id) {
    case 'content-calendar': {
      const n = opts.rows ?? 7;
      return {
        title: 'Content calendar',
        tab: {
          name: 'Posts',
          columns: [
            { name: 'Date', type: 'date' },
            { name: 'Time', type: 'time' },
            { name: 'Platforms', type: 'status', multi: true, options: PLATFORMS.map((label, i) => ({ label, color: ['pink', 'grey', 'red', 'red', 'grey', 'blue', 'blue', 'grey'][i] })), width: 200 },
            { name: 'Hook', type: 'text', width: 220 },
            { name: 'Caption', type: 'longtext', width: 300 },
            { name: 'Media', type: 'media', width: 110 },
            { name: 'Status', type: 'status', options: POST_STATUS },
            { name: 'Post link', type: 'url' },
            { name: 'Notes', type: 'longtext', width: 240 },
          ],
          rows: Array.from({ length: n }, (_, i) => ({ Date: isoDay(i), Status: 'Idea' })),
        },
      };
    }
    case 'season-plan': {
      const n = opts.rows ?? 10;
      return {
        title: 'Season plan',
        tab: {
          name: 'Season 1',
          // One row per episode: what a series follows (SHEETS_PLAN.md).
          binding: { kind: 'episodes' },
          columns: [
            { name: 'Episode', type: 'number', width: 116 },
            { name: 'Title', type: 'text', width: 200 },
            { name: 'Logline', type: 'longtext', width: 280 },
            { name: 'Beats', type: 'longtext', width: 300 },
            { name: 'Cast', type: 'text', width: 180 },
            { name: 'Location', type: 'text', width: 160 },
            { name: 'Length', type: 'duration' },
            { name: 'Air date', type: 'date' },
            { name: 'Status', type: 'status', options: [
              { label: 'Idea', color: 'grey' }, { label: 'Writing', color: 'blue' },
              { label: 'Ready', color: 'purple' }, { label: 'In production', color: 'amber' },
              { label: 'Published', color: 'green' },
            ] },
          ],
          rows: Array.from({ length: n }, (_, i) => ({ Episode: i + 1, Status: 'Idea' })),
        },
      };
    }
    case 'shot-list':
      return {
        title: 'Shot list',
        tab: {
          name: 'Shot list',
          binding: { kind: 'shots' },
          columns: [
            { name: 'Shot', type: 'text', bind: 'shot.title', width: 200 },
            { name: 'Scene', type: 'text', bind: 'shot.sceneKey', width: 170 },
            { name: 'Action', type: 'longtext', bind: 'shot.action', width: 320 },
            { name: 'Voiceover', type: 'longtext', bind: 'shot.voiceover', width: 260 },
            { name: 'Length', type: 'duration', bind: 'shot.durationSec' },
            { name: 'Model', type: 'text', bind: 'shot.model', width: 150 },
            { name: 'Status', type: 'status', options: [
              { label: 'To do', color: 'grey' }, { label: 'In progress', color: 'blue' },
              { label: 'Needs a fix', color: 'red' }, { label: 'Done', color: 'green' },
            ] },
            { name: 'Notes', type: 'longtext', width: 240 },
          ],
        },
      };
    default:
      return {
        title: 'Untitled sheet',
        tab: {
          name: 'Sheet 1',
          columns: [
            { name: 'Name', type: 'text', width: 220 },
            { name: 'Notes', type: 'longtext', width: 300 },
            { name: 'Status', type: 'status', options: [
              { label: 'To do', color: 'grey' }, { label: 'Doing', color: 'blue' }, { label: 'Done', color: 'green' },
            ] },
          ],
          rows: Array.from({ length: opts.rows ?? 5 }, () => []),
        },
      };
  }
}
