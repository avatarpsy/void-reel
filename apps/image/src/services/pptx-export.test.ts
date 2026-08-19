/**
 * The .pptx is checked by OPENING it, not by trusting the exporter returned.
 *
 * A deck export can fail in a way no unit test of the mapping functions would
 * see: the file is produced, the download works, the notification says success,
 * and PowerPoint refuses to open it — or opens it with the type in the wrong
 * place, or in the wrong stacking order, or a quarter of the size. By the time
 * anyone finds out they are standing in front of the deck.
 *
 * So these tests unzip the result and read the slide XML. That is the only level
 * at which "did this actually work" is answerable here, and it is cheap: a pptx
 * is a zip of XML, and the assertions below are about the four things that
 * silently ruin a deck — geometry, stacking, type size, and whether the text
 * survived as text at all.
 */
import { describe, expect, it } from 'vitest';

import { exportProjectToPptx } from './pptx-export';
import {
  DEFAULT_BLEND_MODE, DEFAULT_FILTER, DEFAULT_GLOW, DEFAULT_INNER_SHADOW,
  DEFAULT_SHADOW, DEFAULT_SHAPE_STYLE, DEFAULT_STROKE, DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM,
  type Layer, type Project, type ShapeLayer, type TextLayer,
} from '../types/project';
import {
  DEFAULT_BLACK_WHITE, DEFAULT_CHANNEL_MIXER, DEFAULT_COLOR_BALANCE, DEFAULT_CURVES,
  DEFAULT_GRADIENT_MAP, DEFAULT_LEVELS, DEFAULT_PHOTO_FILTER, DEFAULT_POSTERIZE,
  DEFAULT_SELECTIVE_COLOR, DEFAULT_THRESHOLD,
} from '@openreel/image-core';

/** Every field BaseLayer demands, at its default — so a fixture states only
 *  what the test is actually about. */
const baseLayer = (id: string, over: Partial<Layer> = {}): any => ({
  id,
  name: id,
  visible: true,
  locked: false,
  transform: { ...DEFAULT_TRANSFORM },
  blendMode: { ...DEFAULT_BLEND_MODE },
  shadow: { ...DEFAULT_SHADOW },
  innerShadow: { ...DEFAULT_INNER_SHADOW },
  stroke: { ...DEFAULT_STROKE },
  glow: { ...DEFAULT_GLOW },
  filters: { ...DEFAULT_FILTER },
  parentId: null,
  flipHorizontal: false,
  flipVertical: false,
  mask: null,
  clippingMask: false,
  levels: { ...DEFAULT_LEVELS },
  curves: { ...DEFAULT_CURVES },
  colorBalance: { ...DEFAULT_COLOR_BALANCE },
  selectiveColor: { ...DEFAULT_SELECTIVE_COLOR },
  blackWhite: { ...DEFAULT_BLACK_WHITE },
  photoFilter: { ...DEFAULT_PHOTO_FILTER },
  channelMixer: { ...DEFAULT_CHANNEL_MIXER },
  gradientMap: { ...DEFAULT_GRADIENT_MAP },
  posterize: { ...DEFAULT_POSTERIZE },
  threshold: { ...DEFAULT_THRESHOLD },
  ...over,
});

const text = (id: string, content: string, over: any = {}): TextLayer => baseLayer(id, {
  type: 'text',
  content,
  autoSize: false,
  style: { ...DEFAULT_TEXT_STYLE, ...(over.style ?? {}) },
  transform: { ...DEFAULT_TRANSFORM, ...(over.transform ?? {}) },
}) as TextLayer;

const shape = (id: string, over: any = {}): ShapeLayer => baseLayer(id, {
  type: 'shape',
  shapeType: over.shapeType ?? 'rectangle',
  shapeStyle: { ...DEFAULT_SHAPE_STYLE, ...(over.shapeStyle ?? {}) },
  transform: { ...DEFAULT_TRANSFORM, ...(over.transform ?? {}) },
}) as ShapeLayer;

/**
 * A 1920×1080 deck — the case the whole feature is for.
 *
 * `layers` is given TOP-FIRST, because that is what `artboard.layerIds` means
 * in this editor (Canvas draws the array reversed). An earlier version of this
 * helper reversed its argument to be "friendlier", which made every stacking
 * assertion a double negative and duly produced a test that passed against a
 * deliberately broken export. The fixture now says exactly what the field says.
 */
function deck(layers: Layer[], pages = 1): Project {
  const byId: Record<string, Layer> = {};
  for (const l of layers) byId[l.id] = l;
  const ids = layers.map((l) => l.id);
  return {
    id: 'p1',
    name: 'Q3 Review',
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    artboards: Array.from({ length: pages }, (_, i) => ({
      id: `ab${i + 1}`,
      name: `Slide ${i + 1}`,
      size: { width: 1920, height: 1080 },
      background: { type: 'color', color: '#0b1020' },
      layerIds: i === 0 ? ids : [],
      position: { x: 0, y: 0 },
    })),
    layers: byId,
    assets: {},
    exportPresets: [],
    activeArtboardId: 'ab1',
  } as unknown as Project;
}

/**
 * Read a Blob under jsdom.
 *
 * `Blob.arrayBuffer()` does not exist there — jsdom implements the older
 * FileReader surface only — so the obvious one-liner throws for every test at
 * once and looks like the exporter failing rather than the environment.
 */
function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as ArrayBuffer);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

/** Unzip the pptx and hand back the entries the assertions care about. */
async function openPptx(blob: Blob) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await blobBytes(blob));
  const names = Object.keys(zip.files);
  const slideXml = async (n = 1) =>
    (await zip.file(`ppt/slides/slide${n}.xml`)?.async('string')) ?? '';
  const presentationXml = (await zip.file('ppt/presentation.xml')?.async('string')) ?? '';
  return { zip, names, slideXml, presentationXml };
}

describe('pptx export — is it a real PowerPoint file', () => {
  it('produces a deck PowerPoint can open, one slide per page', async () => {
    const { blob, dropped } = await exportProjectToPptx(deck([text('t1', 'The hook')]), {});
    expect(dropped).toEqual([]);

    const { names } = await openPptx(blob);
    // The three entries that make a file a pptx rather than a zip of xml.
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('ppt/presentation.xml');
    expect(names).toContain('ppt/slides/slide1.xml');
  });

  it('makes one slide per page, in order', async () => {
    const { blob } = await exportProjectToPptx(deck([text('t1', 'One')], 3), {});
    const { names } = await openPptx(blob);
    const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slides).toHaveLength(3);
  });

  it('sizes the slide as PowerPoint 16:9, exactly', async () => {
    const { blob } = await exportProjectToPptx(deck([text('t1', 'x')]), {});
    const { presentationXml } = await openPptx(blob);
    // EMU: 914400 per inch. 13.333×7.5in is PowerPoint's own widescreen, and
    // getting this wrong is how a deck opens letterboxed inside a 4:3 slide.
    const m = presentationXml.match(/sldSz[^/]*cx="(\d+)"[^/]*cy="(\d+)"/);
    expect(m, 'no slide size in presentation.xml').toBeTruthy();
    expect(Number(m![1]) / 914400).toBeCloseTo(13.333, 2);
    expect(Number(m![2]) / 914400).toBeCloseTo(7.5, 2);
  });
});

describe('pptx export — is the deck still editable', () => {
  it('keeps text as TEXT, not as a picture of text', async () => {
    const { blob } = await exportProjectToPptx(
      deck([text('t1', 'Why the current process fails')]),
      {},
    );
    const { slideXml } = await openPptx(blob);
    const xml = await slideXml();
    // The whole point of the editable mode: someone can fix a typo.
    expect(xml).toContain('Why the current process fails');
    expect(xml).toMatch(/<p:sp>/);
  });

  it('converts type size to points against the slide, not the pixel count', async () => {
    // 96px on a 1080px-tall page → 7.5in/1080 × 96 × 72 = 48pt. If this were
    // treated as 96pt the headline would be twice the size it was designed at,
    // which looks like a bug in the design rather than in the export.
    const { blob } = await exportProjectToPptx(
      deck([text('t1', 'Headline', { style: { fontSize: 96 } })]),
      {},
    );
    const xml = await (await openPptx(blob)).slideXml();
    // pptx stores hundredths of a point.
    expect(xml).toMatch(/sz="4800"/);
  });

  it('writes shapes as shapes, with their fill', async () => {
    const { blob } = await exportProjectToPptx(
      deck([shape('s1', { shapeStyle: { fill: '#ff0055' } })]),
      {},
    );
    const xml = await (await openPptx(blob)).slideXml();
    expect(xml).toMatch(/prstGeom prst="rect"/);
    expect(xml).toContain('FF0055');
  });

  it('writes the editor\'s TOP layer last, so it lands on top in PowerPoint', async () => {
    /**
     * The editor's `layerIds[0]` is the TOP layer; PowerPoint stacks in
     * INSERTION order, so whatever is written last wins. The export therefore
     * has to reverse, and getting it backwards hides every headline behind its
     * own background while producing a file that opens perfectly.
     *
     * Discriminated by the shape's FILL COLOUR, not by `prstGeom prst="rect"`:
     * a PowerPoint text box is itself a rect and emits the same element, so
     * searching for the geometry finds whichever box comes first and the
     * assertion holds no matter which order the export used. That is how the
     * first version of this test passed against a deliberately broken export.
     */
    const bg = shape('bg', { shapeStyle: { fill: '#123456' } });
    const headline = text('t1', 'ON TOP');
    // Top-first, as layerIds are: the headline is the top layer, over the bg.
    const { blob } = await exportProjectToPptx(deck([headline, bg]), {});
    const xml = await (await openPptx(blob)).slideXml();

    const bgAt = xml.indexOf('123456');
    const headlineAt = xml.indexOf('ON TOP');
    expect(bgAt, 'the background shape is missing from the slide').toBeGreaterThan(-1);
    expect(headlineAt, 'the headline is missing from the slide').toBeGreaterThan(-1);
    expect(bgAt, 'the headline was written UNDER the background — the deck is unreadable')
      .toBeLessThan(headlineAt);
  });
});

describe('pptx export — when it must not pretend', () => {
  it('refuses a project with no pages rather than writing an empty deck', async () => {
    const empty = { ...deck([]), artboards: [] } as unknown as Project;
    await expect(exportProjectToPptx(empty, {})).rejects.toThrow(/no pages/i);
  });

  it('skips a hidden layer instead of exporting it invisibly', async () => {
    const hidden = text('t1', 'SHOULD NOT APPEAR');
    (hidden as any).visible = false;
    const { blob } = await exportProjectToPptx(deck([hidden, text('t2', 'visible')]), {});
    const xml = await (await openPptx(blob)).slideXml();
    expect(xml).not.toContain('SHOULD NOT APPEAR');
    expect(xml).toContain('visible');
  });
});
