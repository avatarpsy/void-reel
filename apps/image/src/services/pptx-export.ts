/**
 * Export a project as a PowerPoint deck (.pptx) or a PDF.
 *
 * ── THE DECISION THIS FILE IS BUILT AROUND ───────────────────────────────────
 * There are two honest ways to put a designed page into PowerPoint, and they
 * trade off against each other:
 *
 *   PICTURE  — render the page and drop it in full-bleed. Pixel-identical to
 *              what the user designed, on every machine, forever. Nothing can
 *              be edited in PowerPoint, and the text is not selectable or
 *              searchable.
 *   EDITABLE — map layers to real PowerPoint objects: text boxes, shapes,
 *              pictures. The recipient can fix a typo, restyle to their
 *              template, and read it with a screen reader. But PowerPoint has
 *              no equivalent for a good deal of what this editor can do, and
 *              anything we approximate will look DIFFERENT from what the user
 *              approved.
 *
 * We do both, per layer, and the rule when they conflict is:
 *
 *   ** IF IT WOULD NOT LOOK THE SAME, RASTERISE IT. **
 *
 * A picture that matches the design beats a text box that does not. A user who
 * exports a deck and finds their gradient headline flat-filled and their blend
 * mode gone has been given something worse than a screenshot, and — because it
 * still LOOKS like a deck — will not notice until they are presenting it. So
 * every unmappable feature falls back to rendering that one layer at full
 * resolution and placing it exactly where it was. The deck stays editable
 * wherever it can be and stays CORRECT everywhere.
 *
 * ── WHY NOT SERVER-SIDE ──────────────────────────────────────────────────────
 * The project lives in this browser's IndexedDB and its bitmaps are data URLs;
 * the renderer that knows how to draw a layer is this bundle. Exporting on a
 * server would mean shipping the whole document up and reimplementing the
 * renderer there — two renderers to keep in agreement, which is the failure this
 * codebase avoids everywhere else. Nothing here touches the network.
 */
import PptxGenJS from 'pptxgenjs';
import { PDFDocument } from 'pdf-lib';

import { exportArtboard, renderLayersToDataURL } from './export-service';
import {
  DEFAULT_FILTER,
  type Artboard,
  type GroupLayer,
  type ImageLayer,
  type Layer,
  type Project,
  type ShapeLayer,
  type TextLayer,
} from '../types/project';

/**
 * Slide HEIGHT, in inches. Fixed, with the width derived from the artboard's
 * aspect — which reproduces both PowerPoint standards exactly rather than
 * approximating them:
 *
 *   1920×1080 → 13.333 × 7.5in   (PowerPoint's own 16:9)
 *   1024×768  → 10.0   × 7.5in   (PowerPoint's own 4:3)
 *
 * Deriving from a fixed height rather than a fixed width is what makes that
 * true for both at once, and it keeps a portrait or square page sane instead of
 * producing a slide two feet tall.
 */
const SLIDE_HEIGHT_IN = 7.5;

/** PowerPoint's own ceiling on a slide dimension. A page far outside 16:9 could
 *  otherwise derive a width PowerPoint silently refuses to open. */
const MAX_SLIDE_IN = 56;

export type PptxMode = 'editable' | 'picture';


export interface PptxExportOptions {
  /**
   * 'editable' maps what it safely can and rasterises the rest (the default —
   * it is never worse-looking than 'picture', only sometimes larger).
   * 'picture' flattens every page to one image: the smallest, most faithful,
   * least useful option. Right when the deck is being SENT rather than handed
   * over for editing.
   */
  mode?: PptxMode;
  /** Pixel scale for anything rasterised. 2 keeps type crisp on a projector. */
  scale?: number;
  /** Which pages, in order. Omit for all of them. */
  artboardIds?: string[];
  onProgress?: (pct: number, message: string) => void;
}

/** Geometry for one deck: how artboard pixels become inches. */
interface Frame {
  slideW: number;
  slideH: number;
  /** inches per artboard pixel */
  k: number;
}

function frameFor(artboard: Artboard): Frame {
  const { width, height } = artboard.size;
  const k = SLIDE_HEIGHT_IN / Math.max(1, height);
  const slideW = Math.min(MAX_SLIDE_IN, width * k);
  return { slideW, slideH: SLIDE_HEIGHT_IN, k };
}

/** PptxGenJS wants `RRGGBB` with no leading hash and no alpha. */
function hex(color: string | null | undefined, fallback = '000000'): string {
  const c = String(color ?? '').trim();
  const m = c.match(/^#?([0-9a-f]{6})/i);
  if (m) return m[1].toUpperCase();
  const short = c.match(/^#?([0-9a-f]{3})$/i);
  if (short) return short[1].split('').map((ch) => ch + ch).join('').toUpperCase();
  return fallback;
}

/**
 * The alpha of a CSS colour as a PowerPoint TRANSPARENCY percentage.
 *
 * Two conversions in one place because they are easy to get backwards:
 * PowerPoint counts transparency (0 = opaque) where CSS counts alpha
 * (1 = opaque), and a scrim exported with those swapped is either invisible or
 * a solid black rectangle over the slide.
 */
function transparencyOf(color: string | null | undefined, layerOpacity = 1): number {
  const c = String(color ?? '').trim();
  let alpha = 1;
  const rgba = c.match(/rgba?\(([^)]+)\)/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => parseFloat(p.trim()));
    if (parts.length >= 4 && Number.isFinite(parts[3])) alpha = parts[3];
  }
  const hex8 = c.match(/^#?[0-9a-f]{6}([0-9a-f]{2})$/i);
  if (hex8) alpha = parseInt(hex8[1], 16) / 255;
  return Math.round((1 - Math.max(0, Math.min(1, alpha * layerOpacity))) * 100);
}

/**
 * Does this layer need a picture rather than a PowerPoint object?
 *
 * Every entry is something PowerPoint genuinely cannot express, so approximating
 * it would silently change the design. Read as: "the honest answer here is a
 * render." Erring toward `true` costs file size; erring toward `false` costs the
 * user a deck that does not look like the one they made.
 */
function needsRaster(layer: Layer): boolean {
  // Blend modes. PowerPoint has none — 'multiply' would export as 'normal' and
  // a darkened overlay would become an opaque block.
  if (layer.blendMode?.mode && layer.blendMode.mode !== 'normal') return true;

  // Non-destructive colour work. All of it is a pixel operation.
  const f = layer.filters;
  if (f && (Object.keys(DEFAULT_FILTER) as Array<keyof typeof DEFAULT_FILTER>)
    .some((key) => (f as any)[key] !== DEFAULT_FILTER[key])) return true;
  for (const adj of [
    layer.levels, layer.curves, layer.colorBalance, layer.selectiveColor,
    layer.blackWhite, layer.photoFilter, layer.channelMixer, layer.gradientMap,
    layer.posterize, layer.threshold,
  ]) {
    if ((adj as any)?.enabled) return true;
  }

  // A mask is a per-pixel alpha channel; a clipping mask is the same idea
  // expressed through the layer below it.
  if (layer.mask?.enabled || layer.clippingMask) return true;

  // Glow and inner shadow have no PowerPoint equivalent. (An OUTER shadow does,
  // and is mapped below.)
  if (layer.glow?.enabled || layer.innerShadow?.enabled) return true;

  // Skew is not expressible on a PowerPoint shape.
  if (layer.transform.skewX || layer.transform.skewY) return true;

  if (layer.type === 'text') {
    const st = (layer as TextLayer).style;
    // Gradient-filled type, and text on a path-like justification PowerPoint
    // renders differently enough to be noticed.
    if (st.fillType === 'gradient' || st.gradient) return true;
  }

  if (layer.type === 'shape') {
    const s = layer as ShapeLayer;
    // A drawn path has no shape primitive to become.
    if (s.shapeType === 'path') return true;
    if (s.shapeStyle.fillType === 'gradient' || s.shapeStyle.fillType === 'noise') return true;
    if (s.shapeStyle.individualCorners) return true;
  }

  // A smart object is another project; flattening is the only correct answer
  // short of exporting it as its own deck.
  if (layer.type === 'smart-object') return true;

  return false;
}

/** Shape primitives PowerPoint has, by this editor's name for them. */
function pptShapeType(s: ShapeLayer): string | null {
  switch (s.shapeType) {
    case 'rectangle': return s.shapeStyle.cornerRadius > 0 ? 'roundRect' : 'rect';
    case 'ellipse': return 'ellipse';
    case 'triangle': return 'triangle';
    case 'star': return 'star5';
    case 'line': return 'line';
    case 'arrow': return 'rightArrow';
    case 'polygon': {
      const sides = s.sides ?? 6;
      if (sides === 5) return 'pentagon';
      if (sides === 6) return 'hexagon';
      if (sides === 7) return 'heptagon';
      if (sides === 8) return 'octagon';
      // Anything else has no primitive — the caller rasterises on null.
      return null;
    }
    default: return null;
  }
}

/** Layer bounds in inches, ready to spread into a PptxGenJS call. */
function box(layer: Layer, k: number) {
  const t = layer.transform;
  return {
    x: +(t.x * k).toFixed(4),
    y: +(t.y * k).toFixed(4),
    w: +(Math.max(1, t.width) * k).toFixed(4),
    h: +(Math.max(1, t.height) * k).toFixed(4),
  };
}

/**
 * Flatten the artboard's layer tree into bottom-to-top draw order.
 *
 * TWO REVERSALS, and both are load-bearing. `artboard.layerIds[0]` is the TOP
 * layer (Canvas draws the array reversed), and PowerPoint stacks in INSERTION
 * order — later is on top. So the array has to be reversed to hand PowerPoint
 * the bottom one first. Groups nest the same way.
 *
 * A group whose own properties need a raster (a blend mode, a mask, group
 * opacity) is returned WHOLE rather than descended into: its children are only
 * correct when composited together under it.
 */
function drawOrder(project: Project, artboard: Artboard): Layer[] {
  const out: Layer[] = [];
  const walk = (ids: string[]) => {
    for (const id of [...ids].reverse()) {
      const layer = project.layers[id];
      if (!layer || !layer.visible) continue;
      if (layer.type === 'group') {
        const g = layer as GroupLayer;
        if (needsRaster(g) || (g.transform.opacity ?? 1) < 1) out.push(g);
        else walk(g.childIds);
        continue;
      }
      out.push(layer);
    }
  };
  walk(artboard.layerIds);
  return out;
}

/** Render ONE layer, alone, at its own bounds — the rasterise fallback. */
async function rasterLayer(
  project: Project,
  layer: Layer,
  scale: number,
): Promise<{ data: string } | null> {
  const t = layer.transform;
  const w = Math.max(1, Math.round(t.width * scale));
  const h = Math.max(1, Math.round(t.height * scale));

  /**
   * The renderer draws in ARTBOARD coordinates, so a layer at x=800 would land
   * outside a canvas that is only as wide as the layer. It is rendered inside a
   * shifted copy of the project instead — the layer moved to the origin — which
   * keeps `renderLayersToDataURL` as the single renderer rather than growing a
   * second one that takes an offset.
   */
  const shifted: Project = {
    ...project,
    layers: {
      ...project.layers,
      [layer.id]: { ...layer, transform: { ...t, x: 0, y: 0, width: t.width, height: t.height } } as Layer,
    },
  };

  try {
    const data = await renderLayersToDataURL(shifted, [layer.id], w, h);
    return data ? { data } : null;
  } catch {
    // A layer that will not render must not lose the whole deck — the page is
    // still worth exporting without it, and the caller reports what was dropped.
    return null;
  }
}

/** Add one layer to a slide, as a PowerPoint object where that is faithful. */
async function addLayer(
  slide: PptxGenJS.Slide,
  project: Project,
  layer: Layer,
  k: number,
  scale: number,
  dropped: string[],
): Promise<void> {
  const b = box(layer, k);
  const opacity = layer.transform.opacity ?? 1;
  const rotate = layer.transform.rotation || 0;

  if (needsRaster(layer)) {
    const r = await rasterLayer(project, layer, scale);
    if (r) slide.addImage({ data: r.data, ...b, ...(rotate ? { rotate } : {}) });
    else dropped.push(layer.name || layer.id);
    return;
  }

  if (layer.type === 'text') {
    const t = layer as TextLayer;
    const st = t.style;
    // px → points. `k` is inches-per-pixel and a point is 1/72in, so this is
    // exact rather than a DPI guess: a 96px headline on a 1080px-tall page
    // becomes 48pt, which is what the same design would be authored at.
    const fontSize = Math.max(1, +(st.fontSize * k * 72).toFixed(1));
    slide.addText(t.content ?? '', {
      ...b,
      fontFace: st.fontFamily || undefined,
      fontSize,
      bold: (st.fontWeight ?? 400) >= 600,
      italic: st.fontStyle === 'italic',
      underline: st.textDecoration === 'underline' ? { style: 'sng' } : undefined,
      strike: st.textDecoration === 'line-through' ? 'sngStrike' : undefined,
      color: hex(st.color, '000000'),
      align: st.textAlign === 'justify' ? 'justify' : (st.textAlign || 'left'),
      valign: st.verticalAlign === 'middle' ? 'middle' : (st.verticalAlign || 'top'),
      // PowerPoint's lineSpacing is in points, not a multiplier.
      lineSpacing: +(st.fontSize * (st.lineHeight || 1.2) * k * 72).toFixed(1),
      charSpacing: st.letterSpacing ? +(st.letterSpacing * k * 72).toFixed(1) : undefined,
      // The scrim. Without this a caption authored over a photograph exports as
      // bare type and becomes unreadable on the very slides that needed it most.
      fill: st.backgroundColor
        ? { color: hex(st.backgroundColor, 'FFFFFF'), transparency: transparencyOf(st.backgroundColor) }
        : undefined,
      outline: st.strokeColor && st.strokeWidth
        ? { size: +(st.strokeWidth * k * 72).toFixed(1), color: hex(st.strokeColor) }
        : undefined,
      shadow: t.shadow?.enabled
        ? {
            type: 'outer',
            color: hex(t.shadow.color, '000000'),
            blur: +(t.shadow.blur * k * 72).toFixed(1),
            offset: +(Math.hypot(t.shadow.offsetX, t.shadow.offsetY) * k * 72).toFixed(1),
            angle: Math.round((Math.atan2(t.shadow.offsetY, t.shadow.offsetX) * 180) / Math.PI + 360) % 360,
            opacity: 0.5,
          }
        : undefined,
      transparency: opacity < 1 ? Math.round((1 - opacity) * 100) : undefined,
      rotate: rotate || undefined,
      // The box is sized from the design; letting PowerPoint reflow it would
      // move the text off the layout the user approved.
      shrinkText: false,
      isTextBox: true,
      margin: 0,
    });
    return;
  }

  if (layer.type === 'shape') {
    const s = layer as ShapeLayer;
    const kind = pptShapeType(s);
    if (!kind) {
      const r = await rasterLayer(project, s, scale);
      if (r) slide.addImage({ data: r.data, ...b, ...(rotate ? { rotate } : {}) });
      else dropped.push(s.name || s.id);
      return;
    }
    const st = s.shapeStyle;
    slide.addShape(kind as any, {
      ...b,
      fill: st.fill
        ? {
            color: hex(st.fill),
            transparency: Math.round((1 - (st.fillOpacity ?? 1) * opacity) * 100),
          }
        : { type: 'none' },
      line: st.stroke && st.strokeWidth
        ? {
            color: hex(st.stroke),
            width: +(st.strokeWidth * k * 72).toFixed(2),
            dashType: st.strokeDash === 'dashed' ? 'dash'
              : st.strokeDash === 'dotted' ? 'sysDot'
              : st.strokeDash === 'dash-dot' ? 'dashDot'
              : st.strokeDash === 'long-dash' ? 'lgDash'
              : 'solid',
          }
        : { type: 'none' },
      // PowerPoint expresses corner radius as a FRACTION of the shorter side,
      // not in points — passing pixels here rounds a card into a pill.
      rectRadius: kind === 'roundRect'
        ? Math.min(0.5, st.cornerRadius / Math.max(1, Math.min(s.transform.width, s.transform.height)))
        : undefined,
      shadow: s.shadow?.enabled
        ? {
            type: 'outer',
            color: hex(s.shadow.color, '000000'),
            blur: +(s.shadow.blur * k * 72).toFixed(1),
            offset: +(Math.hypot(s.shadow.offsetX, s.shadow.offsetY) * k * 72).toFixed(1),
            angle: Math.round((Math.atan2(s.shadow.offsetY, s.shadow.offsetX) * 180) / Math.PI + 360) % 360,
            opacity: 0.5,
          }
        : undefined,
      rotate: rotate || undefined,
    });
    return;
  }

  if (layer.type === 'image') {
    const img = layer as ImageLayer;
    const asset = project.assets[img.sourceId];
    const src = asset?.dataUrl || asset?.blobUrl || asset?.thumbnailUrl;
    if (!src) { dropped.push(img.name || img.id); return; }
    // A CROP is a different picture, and PowerPoint's own cropping is expressed
    // in source coordinates we would have to re-derive. Rendering the layer
    // gives exactly what is on the canvas for one extra image in the file.
    if (img.cropRect) {
      const r = await rasterLayer(project, img, scale);
      if (r) slide.addImage({ data: r.data, ...b, ...(rotate ? { rotate } : {}) });
      else dropped.push(img.name || img.id);
      return;
    }
    slide.addImage({
      ...(src.startsWith('data:') ? { data: src } : { path: src }),
      ...b,
      rotate: rotate || undefined,
      transparency: opacity < 1 ? Math.round((1 - opacity) * 100) : undefined,
    });
    return;
  }

  // Group reaching here means it was safe to descend but was pushed whole
  // anyway (opacity < 1) — render it as a unit.
  const r = await rasterLayer(project, layer, scale);
  if (r) slide.addImage({ data: r.data, ...b, ...(rotate ? { rotate } : {}) });
  else dropped.push(layer.name || layer.id);
}

export interface PptxExportResult {
  blob: Blob;
  /** Layers that could not be exported at all. Named so the caller can TELL the
   *  user rather than let them discover a hole in slide six while presenting. */
  dropped: string[];
}

export async function exportProjectToPptx(
  project: Project,
  options: PptxExportOptions = {},
): Promise<PptxExportResult> {
  const mode: PptxMode = options.mode ?? 'editable';
  const scale = options.scale ?? 2;
  const onProgress = options.onProgress;

  const artboards = options.artboardIds
    ? project.artboards.filter((a) => options.artboardIds!.includes(a.id))
    : project.artboards;
  if (!artboards.length) throw new Error('Nothing to export — this project has no pages.');

  const pptx = new PptxGenJS();
  // Every page of a deck is the same size, so the FIRST page defines the slide.
  // A project with mixed page sizes is a carousel, not a deck; the odd ones are
  // letterboxed by PowerPoint rather than silently re-cropped.
  const frame = frameFor(artboards[0]);
  pptx.defineLayout({ name: 'VOIDSPACE', width: frame.slideW, height: frame.slideH });
  pptx.layout = 'VOIDSPACE';
  pptx.title = project.name || 'Presentation';

  const dropped: string[] = [];

  for (let i = 0; i < artboards.length; i++) {
    const artboard = artboards[i];
    onProgress?.((i / artboards.length) * 100, `Slide ${i + 1} of ${artboards.length}…`);
    const slide = pptx.addSlide();

    const bg = artboard.background;
    if (bg?.type === 'color' && bg.color) slide.background = { color: hex(bg.color, 'FFFFFF') };

    if (mode === 'picture') {
      const blob = await exportArtboard(project, artboard, {
        scale, format: 'png', quality: 'high', background: 'include',
      } as any);
      slide.addImage({ data: await blobToDataUrl(blob), x: 0, y: 0, w: frame.slideW, h: frame.slideH });
      continue;
    }

    /**
     * A gradient page background is not a slide colour — PowerPoint has slide
     * gradients but not this editor's angle/stop model, so it is DRAWN, as a
     * full-bleed picture underneath everything else.
     *
     * Rendered from a copy of the artboard with NO layers: rendering the real
     * one would composite the whole page into the "background" and then draw
     * every layer again on top of itself.
     */
    if (bg && bg.type !== 'color' && bg.type !== 'transparent') {
      try {
        const bare = { ...artboard, layerIds: [] as string[] };
        const bgBlob = await exportArtboard(project, bare, {
          scale, format: 'png', quality: 'high', background: 'include',
        } as any);
        slide.addImage({
          data: await blobToDataUrl(bgBlob), x: 0, y: 0, w: frame.slideW, h: frame.slideH,
        });
      } catch {
        // A background that will not render is worth losing; the slide's content
        // is not. Named so the caller can say what happened.
        dropped.push(`${artboard.name || 'page'} background`);
      }
    }

    for (const layer of drawOrder(project, artboard)) {
      await addLayer(slide, project, layer, frame.k, scale, dropped);
    }
  }

  onProgress?.(100, 'Writing the file…');
  const blob = (await pptx.write({ outputType: 'blob' })) as Blob;
  return { blob, dropped };
}

/**
 * PDF, from the same renders.
 *
 * Deliberately picture-only. A PDF that people can edit is not what anyone asks
 * for when they ask for a PDF — they want the thing that looks right and prints
 * right — and building a text-layer PDF would be a second, weaker typesetter
 * next to the canvas renderer.
 */
export async function exportProjectToPdf(
  project: Project,
  options: Omit<PptxExportOptions, 'mode'> = {},
): Promise<Blob> {
  const scale = options.scale ?? 2;
  const artboards = options.artboardIds
    ? project.artboards.filter((a) => options.artboardIds!.includes(a.id))
    : project.artboards;
  if (!artboards.length) throw new Error('Nothing to export — this project has no pages.');

  const pdf = await PDFDocument.create();
  pdf.setTitle(project.name || 'Document');

  for (let i = 0; i < artboards.length; i++) {
    const artboard = artboards[i];
    options.onProgress?.((i / artboards.length) * 100, `Page ${i + 1} of ${artboards.length}…`);
    const blob = await exportArtboard(project, artboard, {
      scale, format: 'png', quality: 'high', background: 'include',
    } as any);
    const png = await pdf.embedPng(await blob.arrayBuffer());
    // PDF points at 72/in. The page is sized from the ARTBOARD (not the render
    // scale) so a 2× export is a sharper page, never a page twice the size.
    const w = (artboard.size.width / 96) * 72;
    const h = (artboard.size.height / 96) * 72;
    const page = pdf.addPage([w, h]);
    page.drawImage(png, { x: 0, y: 0, width: w, height: h });
  }

  options.onProgress?.(100, 'Writing the file…');
  // Copied into a plain ArrayBuffer: `save()` is typed as a Uint8Array over
  // ArrayBufferLike, which TypeScript will not accept as a BlobPart because it
  // could in principle be shared memory. The copy is a few MB and once.
  const bytes = await pdf.save();
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return new Blob([buf], { type: 'application/pdf' });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
