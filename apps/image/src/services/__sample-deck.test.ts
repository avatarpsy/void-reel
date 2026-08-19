/**
 * Not a test — a GENERATOR. Writes a real .pptx so a human can double-click it.
 *
 * Every assertion in pptx-export.test.ts reads the XML we just wrote, which
 * proves the file says what we meant. It cannot prove PowerPoint AGREES: that
 * the 13.333x7.5in slide opens as widescreen rather than letterboxed, that 48pt
 * lands where the design put it, that a scrim renders as a translucent shape and
 * not an opaque block. Those are judgements only the real application makes.
 *
 * Run: SAMPLE_DECK=1 npx vitest run src/services/__sample-deck.test.ts
 * Out: apps/image/sample-deck.pptx
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';

import { exportProjectToPptx } from './pptx-export';
import {
  DEFAULT_BLEND_MODE, DEFAULT_FILTER, DEFAULT_GLOW, DEFAULT_INNER_SHADOW,
  DEFAULT_SHADOW, DEFAULT_SHAPE_STYLE, DEFAULT_STROKE, DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM, type Layer, type Project,
} from '../types/project';
import {
  DEFAULT_BLACK_WHITE, DEFAULT_CHANNEL_MIXER, DEFAULT_COLOR_BALANCE, DEFAULT_CURVES,
  DEFAULT_GRADIENT_MAP, DEFAULT_LEVELS, DEFAULT_PHOTO_FILTER, DEFAULT_POSTERIZE,
  DEFAULT_SELECTIVE_COLOR, DEFAULT_THRESHOLD,
} from '@openreel/image-core';

const base = (id: string, over: any = {}): any => ({
  id, name: id, visible: true, locked: false,
  transform: { ...DEFAULT_TRANSFORM }, blendMode: { ...DEFAULT_BLEND_MODE },
  shadow: { ...DEFAULT_SHADOW }, innerShadow: { ...DEFAULT_INNER_SHADOW },
  stroke: { ...DEFAULT_STROKE }, glow: { ...DEFAULT_GLOW }, filters: { ...DEFAULT_FILTER },
  parentId: null, flipHorizontal: false, flipVertical: false, mask: null, clippingMask: false,
  levels: { ...DEFAULT_LEVELS }, curves: { ...DEFAULT_CURVES },
  colorBalance: { ...DEFAULT_COLOR_BALANCE }, selectiveColor: { ...DEFAULT_SELECTIVE_COLOR },
  blackWhite: { ...DEFAULT_BLACK_WHITE }, photoFilter: { ...DEFAULT_PHOTO_FILTER },
  channelMixer: { ...DEFAULT_CHANNEL_MIXER }, gradientMap: { ...DEFAULT_GRADIENT_MAP },
  posterize: { ...DEFAULT_POSTERIZE }, threshold: { ...DEFAULT_THRESHOLD },
  ...over,
});

const text = (id: string, content: string, t: any, style: any = {}): Layer => base(id, {
  type: 'text', content, autoSize: false,
  style: { ...DEFAULT_TEXT_STYLE, ...style },
  transform: { ...DEFAULT_TRANSFORM, ...t },
}) as Layer;

const shape = (id: string, t: any, s: any = {}): Layer => base(id, {
  type: 'shape', shapeType: s.shapeType ?? 'rectangle',
  shapeStyle: { ...DEFAULT_SHAPE_STYLE, ...s },
  transform: { ...DEFAULT_TRANSFORM, ...t },
}) as Layer;

const W = 1920, H = 1080;
const INK = '#0b1020', PAPER = '#ffffff', ACCENT = '#4f7cff';

/** Slides are given TOP-FIRST, as artboard.layerIds are. */
function slide(n: number, name: string, layers: Layer[]) {
  return { id: `ab${n}`, name, size: { width: W, height: H },
    background: { type: 'color', color: n === 1 ? INK : PAPER },
    layerIds: layers.map((l) => l.id), position: { x: 0, y: 0 } };
}

// Opt-in: it writes a file into the repo, so it must not run on every suite.
it.skipIf(!process.env.SAMPLE_DECK)('writes a sample deck', async () => {
  const s1 = [
    text('t1', 'Voidspace decks,\nbuilt by the agent', { x: 140, y: 360, width: 1500, height: 300 },
      { fontSize: 110, fontWeight: 800, color: PAPER, lineHeight: 1.1, letterSpacing: -2 }),
    text('t1b', 'A slide is a page. A deck is a project.', { x: 140, y: 700, width: 1200, height: 80 },
      { fontSize: 40, color: '#9aa6c8' }),
    shape('r1', { x: 140, y: 300, width: 180, height: 12 }, { fill: ACCENT }),
  ];
  const s2 = [
    text('t2', 'Type converts to real points', { x: 140, y: 160, width: 1500, height: 140 },
      { fontSize: 96, fontWeight: 700, color: INK, letterSpacing: -2 }),
    text('t2b',
      '96px on a 1080px page becomes 48pt — what the same design would be authored at.\n'
      + 'Body copy sits at 40px, so it lands at 20pt and keeps its hierarchy.',
      { x: 140, y: 360, width: 1400, height: 200 }, { fontSize: 40, color: '#41496b', lineHeight: 1.5 }),
    shape('r2', { x: 140, y: 620, width: 1400, height: 3 }, { fill: '#d7dcec' }),
    text('t2c', 'Everything on this slide is a REAL PowerPoint object — click it and edit it.',
      { x: 140, y: 680, width: 1400, height: 80 }, { fontSize: 32, color: ACCENT, fontStyle: 'italic' }),
  ];
  const s3 = [
    text('t3', 'Scrims are shapes, not baked pixels', { x: 140, y: 150, width: 1500, height: 120 },
      { fontSize: 80, fontWeight: 700, color: INK }),
    text('t3b', 'White text on a dark plate, exported as a text box over a translucent shape.',
      { x: 200, y: 520, width: 1120, height: 90 }, { fontSize: 38, color: PAPER }),
    shape('r3', { x: 160, y: 470, width: 1200, height: 200 }, { fill: INK, fillOpacity: 0.85, cornerRadius: 24 }),
    shape('r3b', { x: 140, y: 380, width: 1640, height: 420 }, { fill: ACCENT, fillOpacity: 0.25 }),
  ];
  const s4 = [
    text('t4', 'Shapes keep their fill, stroke and radius', { x: 140, y: 150, width: 1600, height: 120 },
      { fontSize: 72, fontWeight: 700, color: INK }),
    shape('c1', { x: 200, y: 420, width: 320, height: 320 }, { shapeType: 'ellipse', fill: ACCENT }),
    shape('c2', { x: 620, y: 420, width: 320, height: 320 },
      { fill: PAPER, stroke: INK, strokeWidth: 6, cornerRadius: 48 }),
    shape('c3', { x: 1040, y: 420, width: 320, height: 320 }, { shapeType: 'triangle', fill: '#ffb020' }),
  ];

  const layers: Record<string, Layer> = {};
  for (const l of [...s1, ...s2, ...s3, ...s4]) layers[l.id] = l;

  const project = {
    id: 'sample', name: 'Voidspace Sample Deck', createdAt: 0, updatedAt: 0, version: 1,
    artboards: [
      slide(1, 'Title', s1), slide(2, 'Typography', s2),
      slide(3, 'Scrims', s3), slide(4, 'Shapes', s4),
    ],
    layers, assets: {}, exportPresets: [], activeArtboardId: 'ab1',
  } as unknown as Project;

  const { blob, dropped } = await exportProjectToPptx(project, {});
  const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as ArrayBuffer);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
  writeFileSync('sample-deck.pptx', Buffer.from(buf));
  console.log(`\n  → sample-deck.pptx  (${(buf.byteLength / 1024).toFixed(0)} KB, 4 slides, dropped: ${dropped.length})\n`);
});
