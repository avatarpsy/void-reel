/**
 * Build every block × every content extreme, through the REAL prepare code.
 *
 * Feeding a block its own samples at its own native size checks a picture. What
 * a user does is different — empty slots, every optional slot filled, a headline
 * pasted from a paragraph, a frame whose aspect the manifest merely PROMISED —
 * and those are the cases where layouts fail. So is going through
 * `services/composition/document.ts` rather than a stand-in: a manifest whose
 * selector matches nothing looks fine until the real filler is the one looking.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const BLOCKS = process.env.BLOCK_QA_DIR
  || join(homedir(), 'Voidspace', '.hyperframes', 'blocks', 'starter');
const OUT = join(HERE, 'cases');

/** The palette the app themes with, so what is measured is what a user sees. */
const THEME = { accent: '#7C5CFF', accent2: '#22D3EE', bg: '#07070E', ink: '#F4F4FF' };

const LONG = 'Extraordinarily comprehensive multidimensional infrastructure transformation';
const VERY_LONG = [LONG, LONG, LONG].join(' ');

const samples = (slots) => Object.fromEntries(
  Object.entries(slots).filter(([, s]) => s.kind === 'text').map(([k, s]) => [k, s.sample ?? '']));

/** Every text slot filled, including the ones the samples leave blank. Values
 *  stay plausible for their role — prose in a chart's `value6` tests nothing. */
function full(slots) {
  const v = samples(slots);
  for (const [k, s] of Object.entries(slots)) {
    if (s.kind !== 'text' || v[k]) continue;
    v[k] = /^value/.test(k) ? '19' : /^when/.test(k) ? 'LATER' : 'One more line that has to fit';
  }
  return v;
}
const colours = (slots) => Object.fromEntries(
  Object.entries(slots).filter(([k, s]) => s.kind === 'color' && THEME[k]).map(([k]) => [k, THEME[k]]));

const CASES = [
  { id: 'samples', values: samples },
  { id: 'full', values: full },
  // Almost nothing to draw: the dead-frame case.
  { id: 'sparse', values: (s) => {
      const v = samples(s);
      Object.keys(v).slice(1).forEach((k) => { v[k] = ''; });
      return v;
    } },
  // Nothing at all. Must not throw, and must not leave the designer's demo text
  // inside a user's work — which is what fillMode 'render' is for.
  { id: 'empty', fillMode: 'render', values: () => ({}) },
  // Prose where a headline belongs. The block cannot invent space, but it must
  // degrade to small type rather than to spilled type.
  { id: 'long', values: (s) => {
      const v = full(s);
      for (const k of ['headline', 'title']) if (k in v) v[k] = VERY_LONG;
      return v;
    } },
];
export const CASE_IDS = CASES.map((c) => c.id);

/** prepareComposition runs in a browser and uses DOM globals. Give node the same
 *  ones vitest gives it rather than bending the code to suit the harness. */
function installDom() {
  const { window } = new JSDOM('');
  for (const k of ['DOMParser', 'XMLSerializer', 'HTMLElement', 'Element', 'Node']) {
    if (!globalThis[k]) globalThis[k] = window[k];
  }
}

export async function buildCases() {
  installDom();
  // esbuild's JS API rather than its binary: the package is hoisted to the
  // workspace root, so a path guessed from this app's node_modules misses it.
  const bundle = join(HERE, 'document.bundle.mjs');
  await build({
    entryPoints: [join(APP, 'src', 'services', 'composition', 'document.ts')],
    bundle: true, format: 'esm', logLevel: 'error', outfile: bundle,
  });
  const { prepareFromSource } = await import('file://' + bundle.replace(/\\/g, '/') + '?t=' + Date.now());

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const names = readdirSync(BLOCKS, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const index = [];
  const missingSelectors = [];

  for (const name of names) {
    let html, manifest;
    try {
      html = readFileSync(join(BLOCKS, name, 'block.html'), 'utf8');
      manifest = JSON.parse(readFileSync(join(BLOCKS, name, 'block.json'), 'utf8'));
    } catch { continue; }
    const slots = manifest.slots || {};

    // A manifest names a selector its block does not contain: it fails silently
    // at render time, so it is caught here where somebody is looking.
    const doc = new JSDOM(html).window.document;
    for (const [key, spec] of Object.entries(slots)) {
      if (spec.sel && !doc.querySelector(spec.sel)) missingSelectors.push(`${name}: ${key} -> ${spec.sel}`);
    }

    const frames = [{ id: '', w: 1920, h: 1080 }].concat(
      // An aspect a manifest CLAIMS is a promise to the picker. Test the promise.
      (manifest.aspects || []).map((a) => {
        const [aw, ah] = a.split(':').map(Number);
        if (!aw || !ah) return null;
        return aw >= ah
          ? { id: 'aspect-' + a.replace(':', 'x'), w: 1920, h: Math.round(1920 * (ah / aw)) }
          : { id: 'aspect-' + a.replace(':', 'x'), w: Math.round(1920 * (aw / ah)), h: 1920 };
      }).filter(Boolean));

    for (const c of CASES) {
      writeCase(name, c.id, 1920, 1080, c, slots, html, prepareFromSource, index);
    }
    for (const f of frames) {
      if (!f.id) continue;
      writeCase(name, f.id, f.w, f.h, CASES[0], slots, html, prepareFromSource, index);
    }
  }

  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2));
  return { count: index.length, blocks: new Set(index.map((r) => r.block)).size, missingSelectors };
}

function writeCase(name, caseId, w, h, c, slots, html, prepareFromSource, index) {
  const prepared = prepareFromSource(html, {
    slots: { ...c.values(slots), ...colours(slots) },
    fillMode: c.fillMode || 'preview',
    poseTime: 'end',
    frameWidth: w,
    frameHeight: h,
  }, slots, { readyTimeoutMs: 4000 });
  const file = `${name}__${caseId}.html`;
  writeFileSync(join(OUT, file), prepared.html, 'utf8');
  index.push({ block: name, case: caseId, file, w: prepared.width, h: prepared.height,
    nativeW: prepared.nativeWidth, nativeH: prepared.nativeHeight });
}
