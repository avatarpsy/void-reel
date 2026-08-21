/**
 * Block QA — measure every block against the content that breaks layouts.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Eight deck blocks were reviewed by eye, one size each, filled with their own
 * samples, and every one of them looked right. Then this sweep ran them at their
 * content extremes and found five real faults in the same eight blocks:
 *
 *   - the fit guards could not shrink text at all, because the children size
 *     themselves with clamp() and clamp() is an absolute length;
 *   - the guards measured a container against its own box, which in a centred
 *     flex column never clips, so they reported "fits" while type was already
 *     off the slide;
 *   - a guard measured getBoundingClientRect(), which includes transforms, so an
 *     element held 20px low by its entrance animation read as overflow and the
 *     guard shrank the type to its floor chasing it;
 *   - the guards only ever shrank and never reset, so one bad measurement taken
 *     before the layout settled was permanent;
 *   - a max-height with overflow:hidden was silently slicing the descenders off
 *     a headline.
 *
 * None of those are visible in a screenshot of the happy path. All of them are
 * measurable. That is the whole argument for this file.
 *
 * ── WHAT IT CHECKS ───────────────────────────────────────────────────────────
 * Per block, per case: content past the frame edge, text clipped by its own box
 * or by an ancestor, text still invisible after the pose, type overlapping type,
 * and how much of the frame the design actually uses.
 *
 * ── RUNNING IT ───────────────────────────────────────────────────────────────
 *   node scripts/block-qa/run.mjs
 * then open the printed URL and evaluate `await window.__run()` — it returns one
 * row per case. `contact.html?case=<id>` renders every block at once for a look.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCases, CASE_IDS } from './build-cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BLOCK_QA_PORT || 8792);

const TYPES = { '.html': 'text/html', '.json': 'application/json', '.mjs': 'text/javascript' };

const built = await buildCases();
console.log(`built ${built.count} cases across ${built.blocks} blocks (${CASE_IDS.join(', ')} + declared aspects)`);
if (built.missingSelectors.length) {
  // A manifest that points at a selector its own block does not have fails
  // silently at render time, so it is worth shouting about here.
  console.log('\nMANIFESTS POINTING AT NOTHING:');
  for (const m of built.missingSelectors) console.log('  ' + m);
}

createServer((req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = join(HERE, path === '/' ? 'harness.html' : path.replace(/^\/+/, ''));
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  sweep:        http://127.0.0.1:${PORT}/harness.html   (await window.__run())`);
  console.log(`  contact sheet: http://127.0.0.1:${PORT}/contact.html?case=samples\n`);
});
