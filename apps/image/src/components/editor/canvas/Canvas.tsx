import { useEffect, useRef, useCallback, useState } from 'react';
import { useProjectStore } from '../../../stores/project-store';
import { useUIStore } from '../../../stores/ui-store';
import { useCanvasStore, type ResizeHandle } from '../../../stores/canvas-store';
import { useSelectionStore } from '../../../stores/selection-store';
import { selectionToPath2D, boundsFromPath, combineSelections, type Selection } from '../../../types/selection';
import { calculateSnap } from '../../../utils/snapping';
import type { Layer, ImageLayer, TextLayer, ShapeLayer, GroupLayer } from '../../../types/project';
import { Rulers } from './Rulers';
import { ContextMenu, type ContextMenuPosition, type ContextMenuType } from './ContextMenu';
import { hasActiveAdjustments, applyAllAdjustments, type LayerAdjustments } from '../../../utils/apply-adjustments';
import { getToolCursor } from '../../../utils/cursors';
import { floodFill, type FloodFillOptions } from '../../../utils/flood-fill';
import { SmudgeTool } from '../../../tools/paint/smudge';
import { BlurSharpenTool } from '../../../tools/paint/blur-sharpen';
import { EraserTool } from '../../../tools/paint/eraser';
import { BrushTool } from '../../../tools/paint/brush';
import { DEFAULT_BRUSH_DYNAMICS } from '../../../tools/brush/brush-engine';
import { DodgeBurnTool } from '../../../tools/retouch/dodge-burn';
import { SpongeTool } from '../../../tools/retouch/sponge';
import { CloneStampTool } from '../../../tools/retouch/clone-stamp';
import { HealingBrushTool } from '../../../tools/retouch/healing-brush';
import { SpotHealingTool } from '../../../tools/retouch/spot-healing';

const RULER_SIZE = 20;
const HANDLE_SIZE = 8;
const ROTATION_HANDLE_DISTANCE = 24;

const MAX_IMAGE_CACHE_SIZE = 50;
const imageCache = new Map<string, HTMLImageElement>();
const imageCacheOrder: string[] = [];
let renderCallback: (() => void) | null = null;

// Phase 2 — persistent raster buffers. A painted image layer keeps a live
// OffscreenCanvas (its editable pixels) keyed by layer id. The renderer draws
// it DIRECTLY, so strokes are instant and never spawn a new asset or flash a
// "Loading" placeholder. The layer's asset.dataUrl is updated in place (same
// id) only for save/export/reload — never creating extra Assets-panel entries.
const rasterBuffers = new Map<string, OffscreenCanvas | HTMLCanvasElement>();
/** Drop a layer's raster buffer (call when the layer is deleted). */
export function dropRasterBuffer(layerId: string) {
  rasterBuffers.delete(layerId);
}

// While a mask stroke is in progress, the layer's pixels are unchanged but its
// mask is being painted in this buffer — renderLayer reads it for a live preview.
let liveMaskPaint: { layerId: string; maskCanvas: OffscreenCanvas } | null = null;

/** Copy a canvas so we can keep a pre-stroke snapshot. */
function snapshotCanvas(src: OffscreenCanvas): OffscreenCanvas {
  const c = new OffscreenCanvas(src.width, src.height);
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

/** Confine a paint stroke to the active selection (Photoshop clips painting to
 *  the marquee): keep `orig` everywhere, overlay `painted` only inside the
 *  selection polygon (mapped from artboard space to the buffer's pixel space). */
function gateToSelection(
  painted: OffscreenCanvas,
  orig: OffscreenCanvas,
  selectionPath: { x: number; y: number }[],
  transform: { x: number; y: number; width: number; height: number },
): OffscreenCanvas {
  const W = painted.width;
  const H = painted.height;
  const sx = W / transform.width;
  const sy = H / transform.height;

  // Selection polygon in buffer-pixel space.
  const mask = new OffscreenCanvas(W, H);
  const mc = mask.getContext('2d')!;
  mc.fillStyle = 'white';
  mc.beginPath();
  mc.moveTo((selectionPath[0].x - transform.x) * sx, (selectionPath[0].y - transform.y) * sy);
  for (let i = 1; i < selectionPath.length; i++) {
    mc.lineTo((selectionPath[i].x - transform.x) * sx, (selectionPath[i].y - transform.y) * sy);
  }
  mc.closePath();
  mc.fill();

  // painted ∩ selection
  const clip = new OffscreenCanvas(W, H);
  const cc = clip.getContext('2d')!;
  cc.drawImage(painted, 0, 0);
  cc.globalCompositeOperation = 'destination-in';
  cc.drawImage(mask, 0, 0);

  // orig everywhere, then the clipped paint on top
  const out = new OffscreenCanvas(W, H);
  const oc = out.getContext('2d')!;
  oc.drawImage(orig, 0, 0);
  oc.drawImage(clip, 0, 0);
  return out;
}

/** Brush color -> its grayscale equivalent (masks are grayscale: white reveals,
 *  black hides). Accepts #RGB / #RRGGBB; passes other values through. */
function colorToGrayHex(color: string): string {
  const s = color.trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(s) || /^#?([0-9a-f]{3})$/i.exec(s);
  if (!m) return s;
  const hex = m[1];
  const exp = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const r = parseInt(exp.slice(0, 2), 16);
  const g = parseInt(exp.slice(2, 4), 16);
  const b = parseInt(exp.slice(4, 6), 16);
  const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const h = lum.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

// Convert a mask image to an alpha mask from its LUMINANCE (Photoshop masks are
// grayscale: white reveals, black hides). `invert` flips it; `density` (0-100,
// Photoshop's mask Density) scales how strongly the mask hides — at 0 the mask
// has no effect. This lets the user paint black/white onto the mask AND fade it.
function maskToAlphaCanvas(maskImg: CanvasImageSource, w: number, h: number, invert: boolean, density = 100): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(maskImg, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h);
  const p = d.data;
  const k = Math.max(0, Math.min(100, density)) / 100;
  for (let i = 0; i < p.length; i += 4) {
    const lum = invert ? 255 - p[i] : p[i]; // red channel — grayscale luminance
    p[i + 3] = 255 - (255 - lum) * k; // density fades the hidden areas back in
  }
  cx.putImageData(d, 0, 0);
  return c;
}

const MAX_LAYER_CACHE_SIZE = 30;
interface LayerCacheEntry {
  canvas: OffscreenCanvas;
  hash: string;
  width: number;
  height: number;
}
const layerCache = new Map<string, LayerCacheEntry>();
const layerCacheOrder: string[] = [];

function getLayerHash(
  layer: Layer,
  _assets: Record<string, { dataUrl?: string; blobUrl?: string }>
): string {
  const { transform } = layer;
  const baseHash = `${layer.id}-${transform.width}-${transform.height}-${transform.opacity}-${transform.scaleX}-${transform.scaleY}-${transform.skewX ?? 0}-${transform.skewY ?? 0}-${layer.flipHorizontal ?? false}-${layer.flipVertical ?? false}-${layer.blendMode?.mode ?? 'normal'}`;

  const shadow = layer.shadow;
  const shadowHash = shadow?.enabled ? `${shadow.color}-${shadow.blur}-${shadow.offsetX}-${shadow.offsetY}` : 'no-shadow';

  const innerShadow = layer.innerShadow;
  const innerShadowHash = innerShadow?.enabled ? `${innerShadow.color}-${innerShadow.blur}-${innerShadow.offsetX}-${innerShadow.offsetY}` : 'no-inner';

  const glow = layer.glow;
  const glowHash = glow?.enabled ? `${glow.color}-${glow.blur}-${glow.intensity ?? 1}` : 'no-glow';

  let contentHash = '';
  if (layer.type === 'image') {
    const imgLayer = layer as ImageLayer;
    const { filters, cropRect } = imgLayer;
    const cropHash = cropRect ? `${cropRect.x}-${cropRect.y}-${cropRect.width}-${cropRect.height}` : 'no-crop';
    contentHash = `img-${imgLayer.sourceId}-${cropHash}-${filters.brightness}-${filters.contrast}-${filters.saturation}-${filters.hue}-${filters.blur}-${filters.blurType}-${filters.sepia}-${filters.invert}-${filters.exposure}-${filters.highlights}-${filters.shadows}-${filters.clarity}-${filters.vibrance}`;
  } else if (layer.type === 'text') {
    const textLayer = layer as TextLayer;
    const { style, content } = textLayer;
    contentHash = `txt-${content}-${style.fontFamily}-${style.fontSize}-${style.fontWeight}-${style.fontStyle}-${style.color}-${style.textAlign}-${style.lineHeight}-${style.fillType ?? 'solid'}-${style.strokeColor ?? ''}-${style.strokeWidth ?? 0}-${JSON.stringify(style.gradient ?? {})}-${JSON.stringify(style.textShadow ?? {})}`;
  } else if (layer.type === 'shape') {
    const shapeLayer = layer as ShapeLayer;
    const { shapeType, shapeStyle } = shapeLayer;
    contentHash = `shp-${shapeType}-${shapeStyle.fill ?? ''}-${shapeStyle.stroke ?? ''}-${shapeStyle.strokeWidth}-${shapeStyle.fillOpacity}-${shapeStyle.strokeOpacity}-${shapeStyle.cornerRadius}-${shapeStyle.fillType ?? 'solid'}-${JSON.stringify(shapeStyle.gradient ?? {})}-${shapeLayer.sides ?? 0}-${shapeLayer.innerRadius ?? 0}`;
  }

  return `${baseHash}|${shadowHash}|${innerShadowHash}|${glowHash}|${contentHash}`;
}

function getCachedLayerCanvas(
  layer: Layer,
  project: { assets: Record<string, { dataUrl?: string; blobUrl?: string }> }
): OffscreenCanvas | null {
  if (typeof OffscreenCanvas === 'undefined') return null;

  const { width, height } = layer.transform;
  if (width <= 0 || height <= 0) return null;

  const hash = getLayerHash(layer, project.assets);
  const cached = layerCache.get(layer.id);

  if (cached && cached.hash === hash && cached.width === Math.ceil(width) && cached.height === Math.ceil(height)) {
    const idx = layerCacheOrder.indexOf(layer.id);
    if (idx > -1) {
      layerCacheOrder.splice(idx, 1);
      layerCacheOrder.push(layer.id);
    }
    return cached.canvas;
  }

  return null;
}

function setCachedLayerCanvas(
  layerId: string,
  canvas: OffscreenCanvas,
  hash: string,
  width: number,
  height: number
): void {
  if (layerCache.size >= MAX_LAYER_CACHE_SIZE && !layerCache.has(layerId)) {
    const oldest = layerCacheOrder.shift();
    if (oldest) {
      layerCache.delete(oldest);
    }
  }

  const existingIdx = layerCacheOrder.indexOf(layerId);
  if (existingIdx > -1) {
    layerCacheOrder.splice(existingIdx, 1);
  }
  layerCacheOrder.push(layerId);

  layerCache.set(layerId, { canvas, hash, width, height });
}

function clearLayerCache(layerIds?: Set<string>): void {
  if (!layerIds) {
    layerCache.clear();
    layerCacheOrder.length = 0;
    return;
  }

  const toRemove: string[] = [];
  layerCache.forEach((_, id) => {
    if (!layerIds.has(id)) {
      toRemove.push(id);
    }
  });

  toRemove.forEach((id) => {
    layerCache.delete(id);
    const idx = layerCacheOrder.indexOf(id);
    if (idx > -1) {
      layerCacheOrder.splice(idx, 1);
    }
  });
}

const failedImages = new Set<string>();

function getCachedImage(src: string): HTMLImageElement | null {
  if (!src) return null;
  if (failedImages.has(src)) return null;

  const cached = imageCache.get(src);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    const idx = imageCacheOrder.indexOf(src);
    if (idx > -1) {
      imageCacheOrder.splice(idx, 1);
      imageCacheOrder.push(src);
    }
    return cached;
  }

  if (!cached) {
    if (imageCache.size >= MAX_IMAGE_CACHE_SIZE) {
      const oldest = imageCacheOrder.shift();
      if (oldest) {
        const oldImg = imageCache.get(oldest);
        if (oldImg?.src?.startsWith('blob:')) {
          URL.revokeObjectURL(oldImg.src);
        }
        imageCache.delete(oldest);
      }
    }

    const img = new window.Image();
    imageCache.set(src, img);
    imageCacheOrder.push(src);

    img.onload = () => {
      if (renderCallback) {
        renderCallback();
      }
    };

    img.onerror = () => {
      failedImages.add(src);
      imageCache.delete(src);
      const idx = imageCacheOrder.indexOf(src);
      if (idx > -1) {
        imageCacheOrder.splice(idx, 1);
      }
      console.warn(`Failed to load image: ${src.substring(0, 100)}`);
    };

    img.src = src;
  }

  const img = imageCache.get(src);
  if (img && img.complete && img.naturalWidth > 0) {
    return img;
  }

  return null;
}

interface ViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function getViewportBounds(
  canvasWidth: number,
  canvasHeight: number,
  artboardWidth: number,
  artboardHeight: number,
  zoom: number,
  panX: number,
  panY: number
): ViewportBounds {
  const centerX = canvasWidth / 2 + panX;
  const centerY = canvasHeight / 2 + panY;
  const artboardX = centerX - (artboardWidth * zoom) / 2;
  const artboardY = centerY - (artboardHeight * zoom) / 2;

  return {
    left: -artboardX / zoom,
    top: -artboardY / zoom,
    right: (canvasWidth - artboardX) / zoom,
    bottom: (canvasHeight - artboardY) / zoom,
  };
}

function isLayerInViewport(layer: Layer, viewport: ViewportBounds): boolean {
  const { x, y, width, height } = layer.transform;
  return !(
    x + width < viewport.left ||
    x > viewport.right ||
    y + height < viewport.top ||
    y > viewport.bottom
  );
}

export function Canvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const renderScheduledRef = useRef(false);
  const lastRenderHashRef = useRef<string>('');
  const forceRenderRef = useRef(false);

  const {
    project,
    selectedLayerIds,
    selectedArtboardId,
    updateLayerTransform,
    updateLayer,
    selectLayer,
    selectLayers,
    deselectAllLayers,
    addPathLayer,
    addTextLayer,
    addShapeLayer,
    removeLayer,
    duplicateLayer,
    copyLayers,
    cutLayers,
    pasteLayers,
    copiedLayers,
    copyLayerStyle,
    pasteLayerStyle,
    copiedStyle,
    moveLayerToTop,
    moveLayerUp,
    moveLayerDown,
    moveLayerToBottom,
    groupLayers,
    ungroupLayers,
  } = useProjectStore();
  const { zoom, panX, panY, setPan, setZoom, activeTool, showGrid, showRulers, toggleGrid, toggleRulers, gridSize, crop, snapToObjects, snapToGuides, snapToGrid, penSettings, brushSettings, eraserSettings, drawing, startDrawing, addDrawingPoint, finishDrawing, startCrop, updateCropRect, setBrushSettings, gradientSettings, paintBucketSettings, smudgeSettings, blurSharpenSettings, dodgeBurnSettings, spongeSettings, cloneStampSettings, healingBrushSettings, spotHealingSettings, maskEditLayerId, setMaskEditLayerId, setGenerativeFillOpen } = useUIStore();
  const { setCanvasRef, setContainerRef, startDrag, updateDrag, endDrag, isDragging, dragMode, dragStartX, dragStartY, dragCurrentX, dragCurrentY, guides, smartGuides, setSmartGuides, clearSmartGuides, isMarqueeSelecting, marqueeRect, startMarqueeSelect, updateMarqueeSelect, endMarqueeSelect, activeResizeHandle, setActiveResizeHandle } = useCanvasStore();
  const [cursorStyle, setCursorStyle] = useState('default');
  const initialTransformRef = useRef<{ x: number; y: number; width: number; height: number; rotation: number } | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    position: ContextMenuPosition;
    type: ContextMenuType;
  } | null>(null);

  const [gradientDrag, setGradientDrag] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    layerId: string;
  } | null>(null);

  const smudgeToolRef = useRef<SmudgeTool | null>(null);
  const blurSharpenToolRef = useRef<BlurSharpenTool | null>(null);
  const eraserToolRef = useRef<EraserTool | null>(null);
  const brushToolRef = useRef<BrushTool | null>(null);
  const dodgeBurnToolRef = useRef<DodgeBurnTool | null>(null);
  const spongeToolRef = useRef<SpongeTool | null>(null);
  const cloneStampToolRef = useRef<CloneStampTool | null>(null);
  const healingBrushToolRef = useRef<HealingBrushTool | null>(null);
  const spotHealingToolRef = useRef<SpotHealingTool | null>(null);
  const paintCanvasRef = useRef<OffscreenCanvas | null>(null);
  const paintLayerIdRef = useRef<string | null>(null);
  // True while a brush/eraser stroke is editing a layer MASK (not its pixels).
  const paintingMaskRef = useRef(false);
  // Pre-stroke snapshot of the painted buffer — used to confine brush/eraser
  // strokes to the active selection (Photoshop clips painting to the marquee).
  const origPaintRef = useRef<OffscreenCanvas | null>(null);

  // Pixel selections (marquee / lasso / wand). `lassoDraftRef` holds the
  // in-progress freehand path (artboard coords); the committed selection lives
  // in useSelectionStore.active. `marchingOffsetRef` animates the marching ants.
  const lassoDraftRef = useRef<{ x: number; y: number }[] | null>(null);
  const marchingOffsetRef = useRef(0);
  const activeSelection = useSelectionStore((s) => s.active);

  const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);

  useEffect(() => {
    if (canvasRef.current) {
      setCanvasRef(canvasRef.current);
    }
    if (containerRef.current) {
      setContainerRef(containerRef.current);
    }
  }, [setCanvasRef, setContainerRef]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !artboard || !project) return;

    const container = containerRef.current;
    if (container) {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
    }

    const marqueeHash = marqueeRect ? `${marqueeRect.x}-${marqueeRect.y}-${marqueeRect.width}-${marqueeRect.height}` : 'none';
    const gradientHash = gradientDrag ? `${gradientDrag.startX}-${gradientDrag.startY}-${gradientDrag.endX}-${gradientDrag.endY}` : 'none';
    const selHash = `${activeSelection?.id ?? 'none'}-${marchingOffsetRef.current}-${lassoDraftRef.current?.length ?? 0}`;
    const renderHash = `${zoom}-${panX}-${panY}-${selectedLayerIds.join(',')}-${project.updatedAt}-${showGrid}-${drawing.isDrawing}-${drawing.currentPath?.length ?? 0}-${isMarqueeSelecting}-${marqueeHash}-${gradientHash}-${selHash}`;
    // While a paint/retouch stroke is active, the buffer changes every move but
    // none of the hash inputs do — so bypass the dedupe to draw the live stroke.
    const livePainting = !!(paintCanvasRef.current && paintLayerIdRef.current) || !!lassoDraftRef.current;
    if (renderHash === lastRenderHashRef.current && !forceRenderRef.current && !livePainting) {
      return;
    }
    lastRenderHashRef.current = renderHash;
    forceRenderRef.current = false;

    ctx.save();
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2 + panX;
    const centerY = canvas.height / 2 + panY;
    const artboardX = centerX - (artboard.size.width * zoom) / 2;
    const artboardY = centerY - (artboard.size.height * zoom) / 2;

    ctx.save();
    ctx.translate(artboardX, artboardY);
    ctx.scale(zoom, zoom);

    if (artboard.background.type === 'color') {
      ctx.fillStyle = artboard.background.color ?? '#ffffff';
    } else if (artboard.background.type === 'transparent') {
      const patternSize = 10;
      for (let y = 0; y < artboard.size.height; y += patternSize) {
        for (let x = 0; x < artboard.size.width; x += patternSize) {
          ctx.fillStyle = (x + y) % (patternSize * 2) === 0 ? '#ffffff' : '#e5e5e5';
          ctx.fillRect(x, y, patternSize, patternSize);
        }
      }
    } else {
      ctx.fillStyle = '#ffffff';
    }
    if (artboard.background.type !== 'transparent') {
      ctx.fillRect(0, 0, artboard.size.width, artboard.size.height);
    }

    if (showGrid) {
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)';
      ctx.lineWidth = 1 / zoom;
      for (let x = 0; x <= artboard.size.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, artboard.size.height);
        ctx.stroke();
      }
      for (let y = 0; y <= artboard.size.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(artboard.size.width, y);
        ctx.stroke();
      }
    }

    const viewport = getViewportBounds(
      canvas.width,
      canvas.height,
      artboard.size.width,
      artboard.size.height,
      zoom,
      panX,
      panY
    );

    // Keep the active stroke's buffer current so renderLayer draws it live. A
    // pixel stroke updates `rasterBuffers`; a MASK stroke updates `liveMaskPaint`
    // (the layer's pixels are unchanged — only its mask is being painted).
    if (paintCanvasRef.current && paintLayerIdRef.current) {
      if (paintingMaskRef.current) {
        liveMaskPaint = { layerId: paintLayerIdRef.current, maskCanvas: paintCanvasRef.current };
      } else {
        rasterBuffers.set(paintLayerIdRef.current, paintCanvasRef.current);
        liveMaskPaint = null;
      }
    } else {
      liveMaskPaint = null;
    }

    // Bottom-to-top. A layer with `clippingMask` clips to the layer below it
    // (its "base"): it shows only where the base has pixels (Photoshop). We draw
    // the base normally, then draw each clipped layer through the base's shape.
    const sortedLayers = [...artboard.layerIds].reverse().map((id) => project.layers[id]);
    const AW = Math.max(1, Math.ceil(artboard.size.width));
    const AH = Math.max(1, Math.ceil(artboard.size.height));
    for (let i = 0; i < sortedLayers.length; i++) {
      const layer = sortedLayers[i];
      if (!layer || !layer.visible) continue;

      // Gather the clipped layers stacked directly above this base.
      const clipped: Layer[] = [];
      let j = i + 1;
      while (j < sortedLayers.length && sortedLayers[j]?.clippingMask) {
        if (sortedLayers[j].visible) clipped.push(sortedLayers[j]);
        j++;
      }

      if (isLayerInViewport(layer, viewport)) {
        renderLayerWithChildren(ctx, layer, project);
      }

      if (clipped.length > 0) {
        // The base's rendered shape becomes the clip region for the layers above.
        const baseShape = document.createElement('canvas');
        baseShape.width = AW;
        baseShape.height = AH;
        const bctx = baseShape.getContext('2d');
        if (bctx) {
          renderLayerWithChildren(bctx, layer, project);
          for (const clip of clipped) {
            const clipOff = document.createElement('canvas');
            clipOff.width = AW;
            clipOff.height = AH;
            const cctx = clipOff.getContext('2d');
            if (!cctx) continue;
            renderLayerWithChildren(cctx, clip, project);
            cctx.globalCompositeOperation = 'destination-in';
            cctx.drawImage(baseShape, 0, 0);
            ctx.drawImage(clipOff, 0, 0);
          }
        }
        i = j - 1; // skip the clipped layers we just drew
      }
    }

    ctx.restore();

    selectedLayerIds.forEach((layerId) => {
      const layer = project.layers[layerId];
      if (!layer) return;
      const { x, y, width, height, rotation } = layer.transform;

      ctx.save();
      ctx.translate(artboardX + (x + width / 2) * zoom, artboardY + (y + height / 2) * zoom);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-(width / 2) * zoom, -(height / 2) * zoom);

      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(0, 0, width * zoom, height * zoom);

      const handleSize = HANDLE_SIZE;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;

      const handles = [
        { x: 0, y: 0 },
        { x: width * zoom / 2, y: 0 },
        { x: width * zoom, y: 0 },
        { x: width * zoom, y: height * zoom / 2 },
        { x: width * zoom, y: height * zoom },
        { x: width * zoom / 2, y: height * zoom },
        { x: 0, y: height * zoom },
        { x: 0, y: height * zoom / 2 },
      ];

      handles.forEach((h) => {
        ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
        ctx.strokeRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
      });

      ctx.beginPath();
      ctx.moveTo(width * zoom / 2, 0);
      ctx.lineTo(width * zoom / 2, -ROTATION_HANDLE_DISTANCE);
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(width * zoom / 2, -ROTATION_HANDLE_DISTANCE, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();
    });

    if (drawing.isDrawing && drawing.currentPath.length > 1) {
      ctx.save();
      if (activeTool === 'brush') {
        ctx.strokeStyle = brushSettings.color;
        ctx.lineWidth = brushSettings.size;
        ctx.globalAlpha = brushSettings.opacity;
      } else {
        ctx.strokeStyle = penSettings.color;
        ctx.lineWidth = penSettings.width;
        ctx.globalAlpha = penSettings.opacity;
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(
        artboardX + drawing.currentPath[0].x * zoom,
        artboardY + drawing.currentPath[0].y * zoom
      );

      for (let i = 1; i < drawing.currentPath.length; i++) {
        ctx.lineTo(
          artboardX + drawing.currentPath[i].x * zoom,
          artboardY + drawing.currentPath[i].y * zoom
        );
      }

      ctx.stroke();
      ctx.restore();
    }

    if (gradientDrag && activeTool === 'gradient') {
      ctx.save();

      const gStartX = artboardX + gradientDrag.startX * zoom;
      const gStartY = artboardY + gradientDrag.startY * zoom;
      const gEndX = artboardX + gradientDrag.endX * zoom;
      const gEndY = artboardY + gradientDrag.endY * zoom;

      const colors = gradientSettings.reverse
        ? [...gradientSettings.colors].reverse()
        : gradientSettings.colors;

      const minX = Math.min(gStartX, gEndX);
      const minY = Math.min(gStartY, gEndY);
      const maxX = Math.max(gStartX, gEndX);
      const maxY = Math.max(gStartY, gEndY);
      const previewWidth = Math.max(maxX - minX, 50);
      const previewHeight = Math.max(maxY - minY, 50);

      let gradient: CanvasGradient;
      if (gradientSettings.type === 'radial') {
        const centerX = (gStartX + gEndX) / 2;
        const centerY = (gStartY + gEndY) / 2;
        const radius = Math.sqrt(previewWidth ** 2 + previewHeight ** 2) / 2;
        gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
      } else {
        gradient = ctx.createLinearGradient(gStartX, gStartY, gEndX, gEndY);
      }

      colors.forEach((color, i) => {
        gradient.addColorStop(i / Math.max(colors.length - 1, 1), color);
      });

      ctx.fillStyle = gradient;
      ctx.globalAlpha = gradientSettings.opacity;
      ctx.fillRect(minX, minY, previewWidth, previewHeight);

      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gStartX, gStartY);
      ctx.lineTo(gEndX, gEndY);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(gStartX, gStartY, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(gEndX, gEndY, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    if (smartGuides.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      smartGuides.forEach((guide) => {
        ctx.beginPath();
        if (guide.type === 'vertical') {
          ctx.moveTo(artboardX + guide.position * zoom, artboardY + guide.start * zoom);
          ctx.lineTo(artboardX + guide.position * zoom, artboardY + guide.end * zoom);
        } else {
          ctx.moveTo(artboardX + guide.start * zoom, artboardY + guide.position * zoom);
          ctx.lineTo(artboardX + guide.end * zoom, artboardY + guide.position * zoom);
        }
        ctx.stroke();
      });

      ctx.restore();
    }

    if (isMarqueeSelecting && marqueeRect) {
      ctx.save();
      ctx.fillStyle = 'rgba(34, 197, 94, 0.1)';
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      const mx = artboardX + marqueeRect.x * zoom;
      const my = artboardY + marqueeRect.y * zoom;
      const mw = marqueeRect.width * zoom;
      const mh = marqueeRect.height * zoom;

      ctx.fillRect(mx, my, mw, mh);
      ctx.strokeRect(mx, my, mw, mh);
      ctx.restore();
    }

    // Active pixel selection (marching ants) + in-progress lasso path. Drawn in
    // artboard space; dashes/line-width divided by zoom to stay screen-constant.
    if (activeSelection || lassoDraftRef.current) {
      ctx.save();
      ctx.translate(artboardX, artboardY);
      ctx.scale(zoom, zoom);
      ctx.lineWidth = 1 / zoom;
      if (activeSelection) {
        const p = selectionToPath2D(activeSelection);
        const off = marchingOffsetRef.current / zoom;
        ctx.setLineDash([4 / zoom, 4 / zoom]);
        ctx.lineDashOffset = -off;
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.stroke(p);
        ctx.lineDashOffset = -off + 4 / zoom;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.stroke(p);
      }
      if (lassoDraftRef.current && lassoDraftRef.current.length > 1) {
        const pts = lassoDraftRef.current;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.setLineDash([4 / zoom, 4 / zoom]);
        ctx.lineDashOffset = 0;
        ctx.strokeStyle = '#22c55e';
        ctx.stroke();
      }
      ctx.restore();
    }

    if (crop.isActive && crop.layerId && crop.cropRect) {
      const cropLayer = project.layers[crop.layerId];
      if (cropLayer) {
        const { x: layerX, y: layerY, width: layerW, height: layerH } = cropLayer.transform;
        const { x: cropX, y: cropY, width: cropW, height: cropH } = crop.cropRect;

        ctx.save();

        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(
          artboardX + layerX * zoom,
          artboardY + layerY * zoom,
          layerW * zoom,
          cropY * zoom
        );
        ctx.fillRect(
          artboardX + layerX * zoom,
          artboardY + (layerY + cropY + cropH) * zoom,
          layerW * zoom,
          (layerH - cropY - cropH) * zoom
        );
        ctx.fillRect(
          artboardX + layerX * zoom,
          artboardY + (layerY + cropY) * zoom,
          cropX * zoom,
          cropH * zoom
        );
        ctx.fillRect(
          artboardX + (layerX + cropX + cropW) * zoom,
          artboardY + (layerY + cropY) * zoom,
          (layerW - cropX - cropW) * zoom,
          cropH * zoom
        );

        const cX = artboardX + (layerX + cropX) * zoom;
        const cY = artboardY + (layerY + cropY) * zoom;
        const cW = cropW * zoom;
        const cH = cropH * zoom;

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(cX, cY, cW, cH);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(cX + (cW * i) / 3, cY);
          ctx.lineTo(cX + (cW * i) / 3, cY + cH);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cX, cY + (cH * i) / 3);
          ctx.lineTo(cX + cW, cY + (cH * i) / 3);
          ctx.stroke();
        }

        const handleSize = 10;
        const handlePositions = [
          { x: cX, y: cY },
          { x: cX + cW / 2, y: cY },
          { x: cX + cW, y: cY },
          { x: cX + cW, y: cY + cH / 2 },
          { x: cX + cW, y: cY + cH },
          { x: cX + cW / 2, y: cY + cH },
          { x: cX, y: cY + cH },
          { x: cX, y: cY + cH / 2 },
        ];

        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        handlePositions.forEach((h) => {
          ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
          ctx.strokeRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
        });

        ctx.restore();
      }
    }

    ctx.restore();
  }, [artboard, project, zoom, panX, panY, selectedLayerIds, showGrid, gridSize, crop, smartGuides, drawing, penSettings, brushSettings, activeTool, isMarqueeSelecting, marqueeRect, activeSelection]);

  const scheduleRender = useCallback(() => {
    if (renderScheduledRef.current) return;
    renderScheduledRef.current = true;

    requestAnimationFrame(() => {
      render();
      renderScheduledRef.current = false;
    });
  }, [render]);

  const forceRender = useCallback(() => {
    forceRenderRef.current = true;
    scheduleRender();
  }, [scheduleRender]);

  useEffect(() => {
    scheduleRender();
  }, [scheduleRender]);

  useEffect(() => {
    renderCallback = forceRender;
    return () => {
      renderCallback = null;
    };
  }, [forceRender]);

  useEffect(() => {
    const handleResize = () => {
      forceRender();
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, [forceRender]);

  useEffect(() => {
    if (!project) return;
    const currentLayerIds = new Set(Object.keys(project.layers));
    clearLayerCache(currentLayerIds);
  }, [project?.layers]);

  const screenToCanvas = useCallback(
    (screenX: number, screenY: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !artboard) return { x: 0, y: 0 };

      const rect = canvas.getBoundingClientRect();
      const canvasX = screenX - rect.left;
      const canvasY = screenY - rect.top;

      const centerX = canvas.width / 2 + panX;
      const centerY = canvas.height / 2 + panY;
      const artboardX = centerX - (artboard.size.width * zoom) / 2;
      const artboardY = centerY - (artboard.size.height * zoom) / 2;

      return {
        x: (canvasX - artboardX) / zoom,
        y: (canvasY - artboardY) / zoom,
      };
    },
    [artboard, zoom, panX, panY]
  );

  const findLayerAtPoint = useCallback(
    (x: number, y: number): string | null => {
      if (!artboard || !project) return null;

      for (const layerId of artboard.layerIds) {
        const layer = project.layers[layerId];
        if (!layer || !layer.visible || layer.locked) continue;

        const { transform } = layer;
        if (
          x >= transform.x &&
          x <= transform.x + transform.width &&
          y >= transform.y &&
          y <= transform.y + transform.height
        ) {
          return layerId;
        }
      }
      return null;
    },
    [artboard, project]
  );

  // ── Pixel-selection helpers (marquee / lasso / magic wand) ────────────────
  // All selections live in ARTBOARD coordinates so marching-ants rendering and
  // edit-gating share one space. Committed selection = useSelectionStore.active.
  const commitSelectionShape = useCallback(
    (sel: Selection) => {
      const store = useSelectionStore.getState();
      const final = store.active && store.mode !== 'new'
        ? combineSelections(store.active, sel, store.mode)
        : sel;
      store.setActiveSelection(final);
      scheduleRender();
    },
    [scheduleRender]
  );

  const commitMarqueeSelection = useCallback(
    (rect: { x: number; y: number; width: number; height: number }, ellipse: boolean) => {
      if (rect.width < 1 || rect.height < 1) return;
      commitSelectionShape({
        id: `sel-${Date.now()}`,
        type: ellipse ? 'elliptical' : 'rectangular',
        bounds: rect,
        path: [
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.width, y: rect.y },
          { x: rect.x + rect.width, y: rect.y + rect.height },
          { x: rect.x, y: rect.y + rect.height },
        ],
        feather: 0,
        antiAlias: true,
        opacity: 1,
      });
    },
    [commitSelectionShape]
  );

  const commitLassoSelection = useCallback(
    (points: { x: number; y: number }[]) => {
      if (points.length < 3) return;
      commitSelectionShape({
        id: `sel-${Date.now()}`,
        type: 'lasso',
        bounds: boundsFromPath(points),
        path: points,
        feather: 0,
        antiAlias: true,
        opacity: 1,
      });
    },
    [commitSelectionShape]
  );

  // Rasterize an image layer to ImageData (prefers its live raster buffer).
  const layerToImageData = useCallback(
    (layer: ImageLayer): { data: ImageData; w: number; h: number } | null => {
      const buf = rasterBuffers.get(layer.id);
      if (buf) {
        const c = (buf as OffscreenCanvas).getContext('2d', { willReadFrequently: true }) as
          | OffscreenCanvasRenderingContext2D | null;
        if (c) return { data: c.getImageData(0, 0, buf.width, buf.height), w: buf.width, h: buf.height };
      }
      const asset = project?.assets[layer.sourceId];
      const img = getCachedImage(asset?.dataUrl ?? asset?.blobUrl ?? '');
      if (!img || !img.complete || img.naturalWidth === 0) return null;
      const oc = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const c = oc.getContext('2d', { willReadFrequently: true });
      if (!c) return null;
      c.drawImage(img, 0, 0);
      return { data: c.getImageData(0, 0, oc.width, oc.height), w: oc.width, h: oc.height };
    },
    [project]
  );

  const magicWandSelect = useCallback(
    (x: number, y: number) => {
      if (!project) return;
      const layerId = findLayerAtPoint(x, y);
      if (!layerId) return;
      const layer = project.layers[layerId];
      if (layer?.type !== 'image') return;
      const il = layer as ImageLayer;
      const t = il.transform;
      const res = layerToImageData(il);
      if (!res) return;
      const px = Math.floor(((x - t.x) / t.width) * res.w);
      const py = Math.floor(((y - t.y) / t.height) * res.h);
      if (px < 0 || py < 0 || px >= res.w || py >= res.h) return;
      const store = useSelectionStore.getState();
      const prevActive = store.active;
      const prevMode = store.mode;
      // selectByColor works in image-pixel coords; run it un-combined, then map
      // the result to artboard coords and combine with the existing selection.
      store.setSelectionMode('new');
      store.selectByColor(res.data, px, py, store.magicWandOptions);
      const wand = useSelectionStore.getState().active;
      store.setSelectionMode(prevMode);
      if (!wand || wand.path.length < 3) { store.setActiveSelection(prevActive); return; }
      const toArt = (p: { x: number; y: number }) => ({
        x: t.x + (p.x / res.w) * t.width,
        y: t.y + (p.y / res.h) * t.height,
      });
      const artPath = wand.path.map(toArt);
      const artSel: Selection = { ...wand, path: artPath, bounds: boundsFromPath(artPath) };
      const final = prevActive && prevMode !== 'new'
        ? combineSelections(prevActive, artSel, prevMode)
        : artSel;
      store.setActiveSelection(final);
      scheduleRender();
    },
    [project, findLayerAtPoint, layerToImageData, scheduleRender]
  );

  const getHandleAtPoint = useCallback(
    (canvasX: number, canvasY: number): { handle: ResizeHandle | 'rotate'; layerId: string } | null => {
      if (!artboard || !project || selectedLayerIds.length !== 1) return null;

      const canvas = canvasRef.current;
      if (!canvas) return null;

      const layerId = selectedLayerIds[0];
      const layer = project.layers[layerId];
      if (!layer) return null;

      const { x, y, width, height, rotation } = layer.transform;

      const centerX = canvas.width / 2 + panX;
      const centerY = canvas.height / 2 + panY;
      const artboardX = centerX - (artboard.size.width * zoom) / 2;
      const artboardY = centerY - (artboard.size.height * zoom) / 2;

      const layerCenterX = artboardX + (x + width / 2) * zoom;
      const layerCenterY = artboardY + (y + height / 2) * zoom;

      const rad = -(rotation * Math.PI) / 180;
      const dx = canvasX - layerCenterX;
      const dy = canvasY - layerCenterY;
      const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
      const localY = dx * Math.sin(rad) + dy * Math.cos(rad);

      const halfW = (width * zoom) / 2;
      const halfH = (height * zoom) / 2;
      const threshold = HANDLE_SIZE + 4;

      const rotHandleY = -halfH - ROTATION_HANDLE_DISTANCE;
      if (Math.abs(localX) < threshold && Math.abs(localY - rotHandleY) < threshold) {
        return { handle: 'rotate', layerId };
      }

      const handlePositions: { handle: ResizeHandle; x: number; y: number }[] = [
        { handle: 'nw', x: -halfW, y: -halfH },
        { handle: 'n', x: 0, y: -halfH },
        { handle: 'ne', x: halfW, y: -halfH },
        { handle: 'e', x: halfW, y: 0 },
        { handle: 'se', x: halfW, y: halfH },
        { handle: 's', x: 0, y: halfH },
        { handle: 'sw', x: -halfW, y: halfH },
        { handle: 'w', x: -halfW, y: 0 },
      ];

      for (const pos of handlePositions) {
        if (Math.abs(localX - pos.x) < threshold && Math.abs(localY - pos.y) < threshold) {
          return { handle: pos.handle, layerId };
        }
      }

      return null;
    },
    [artboard, project, selectedLayerIds, zoom, panX, panY]
  );

  const getCursorForHandle = (handle: ResizeHandle | 'rotate' | null): string => {
    if (!handle) return 'default';
    if (handle === 'rotate') return 'crosshair';

    const cursors: Record<ResizeHandle, string> = {
      'nw': 'nwse-resize',
      'n': 'ns-resize',
      'ne': 'nesw-resize',
      'e': 'ew-resize',
      'se': 'nwse-resize',
      's': 'ns-resize',
      'sw': 'nesw-resize',
      'w': 'ew-resize',
    };

    return cursors[handle] || 'default';
  };

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      const { x, y } = screenToCanvas(e.clientX, e.clientY);

      if (activeTool === 'hand' || e.button === 1) {
        startDrag('pan', e.clientX, e.clientY);
        return;
      }

      if (activeTool === 'pen') {
        startDrawing({ x, y });
        return;
      }

      if (activeTool === 'marquee-rect' || activeTool === 'marquee-ellipse') {
        deselectAllLayers();
        startMarqueeSelect(x, y);
        startDrag('marquee', e.clientX, e.clientY);
        return;
      }

      if (activeTool === 'lasso' || activeTool === 'lasso-polygon') {
        // Freehand lasso: collect the path while the button is held; commit on
        // mouse-up. (Polygon falls back to freehand for now.)
        deselectAllLayers();
        lassoDraftRef.current = [{ x, y }];
        return;
      }

      if (activeTool === 'magic-wand') {
        deselectAllLayers();
        magicWandSelect(x, y);
        return;
      }

      if (activeTool === 'free-transform' || activeTool === 'warp' || activeTool === 'perspective' || activeTool === 'liquify') {
        const handleHit = getHandleAtPoint(canvasX, canvasY);
        if (handleHit) {
          const layer = project?.layers[handleHit.layerId];
          if (layer) {
            initialTransformRef.current = {
              x: layer.transform.x,
              y: layer.transform.y,
              width: layer.transform.width,
              height: layer.transform.height,
              rotation: layer.transform.rotation,
            };
            if (handleHit.handle === 'rotate') {
              startDrag('rotate', e.clientX, e.clientY);
            } else {
              setActiveResizeHandle(handleHit.handle);
              startDrag('resize', e.clientX, e.clientY);
            }
            return;
          }
        }

        const layerId = findLayerAtPoint(x, y);
        if (layerId) {
          if (!selectedLayerIds.includes(layerId)) {
            selectLayer(layerId);
          }
          startDrag('move', e.clientX, e.clientY);
        }
        return;
      }

      // If the mask is targeted but the user clicks a DIFFERENT layer, they want
      // to paint that layer's pixels — leave mask mode (prevents painting one
      // layer's mask while clicking another).
      if ((activeTool === 'brush' || activeTool === 'eraser') && maskEditLayerId) {
        const hit = findLayerAtPoint(x, y);
        if (hit && hit !== maskEditLayerId) setMaskEditLayerId(null);
      }

      // Paint-on-mask: when a layer's MASK is the active edit target (its mask
      // thumbnail was clicked), the brush paints onto the mask — grayscale, so
      // black hides and white reveals (Photoshop). The stroke is stamped by the
      // normal paint-move handler and saved to mask.data on mouse-up.
      if (activeTool === 'brush' && maskEditLayerId && project && findLayerAtPoint(x, y) === maskEditLayerId) {
        const layer = project.layers[maskEditLayerId];
        if (layer?.type === 'image' && layer.mask?.data) {
          const W = Math.max(1, Math.round(layer.transform.width));
          const H = Math.max(1, Math.round(layer.transform.height));
          const maskImg = getCachedImage(layer.mask.data);
          if (maskImg && maskImg.complete) {
            const buf = new OffscreenCanvas(W, H);
            const bctx = buf.getContext('2d', { willReadFrequently: true });
            if (bctx) {
              bctx.drawImage(maskImg, 0, 0, W, H);
              paintCanvasRef.current = buf;
              paintLayerIdRef.current = layer.id;
              paintingMaskRef.current = true;
              const localX = x - layer.transform.x;
              const localY = y - layer.transform.y;
              const tool = new BrushTool({
                size: brushSettings.size,
                hardness: brushSettings.hardness,
                opacity: brushSettings.opacity,
                flow: brushSettings.flow,
                color: colorToGrayHex(brushSettings.color),
                blendMode: 'normal',
              });
              tool.setCanvas(buf);
              tool.startStroke(localX, localY, 1);
              brushToolRef.current = tool;
              if (!selectedLayerIds.includes(layer.id)) selectLayer(layer.id);
              startDrag('paint', e.clientX, e.clientY);
              return;
            }
          }
        }
      }

      if (activeTool === 'brush') {
        const layerId = findLayerAtPoint(x, y);
        if (layerId && project) {
          const layer = project.layers[layerId];
          if (layer?.type === 'image') {
            const imageLayer = layer as ImageLayer;
            const asset = project.assets[imageLayer.sourceId];
            const src = asset?.blobUrl ?? asset?.dataUrl;
            if (src) {
              const img = getCachedImage(src);
              if (img && img.complete && img.naturalWidth > 0) {
                const tempCanvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                if (tempCtx) {
                  tempCtx.drawImage(rasterBuffers.get(layerId) ?? img, 0, 0);
                  paintCanvasRef.current = tempCanvas;
                  paintLayerIdRef.current = layerId;
                  origPaintRef.current = snapshotCanvas(tempCanvas);

                  const localX = (x - layer.transform.x) * (img.naturalWidth / layer.transform.width);
                  const localY = (y - layer.transform.y) * (img.naturalHeight / layer.transform.height);

                  const tool = new BrushTool({
                    size: brushSettings.size * (img.naturalWidth / layer.transform.width),
                    hardness: brushSettings.hardness,
                    opacity: brushSettings.opacity,
                    flow: brushSettings.flow,
                    color: brushSettings.color,
                    blendMode: brushSettings.blendMode,
                  });
                  tool.setCanvas(tempCanvas);
                  tool.startStroke(localX, localY, 1);
                  brushToolRef.current = tool;

                  if (!selectedLayerIds.includes(layerId)) {
                    selectLayer(layerId);
                  }
                  startDrag('paint', e.clientX, e.clientY);
                }
              }
            }
          }
        } else {
          startDrawing({ x, y });
        }
        return;
      }

      if (activeTool === 'eraser') {
        const layerId = findLayerAtPoint(x, y);
        if (layerId && project) {
          const layer = project.layers[layerId];
          if (layer?.type === 'image') {
            const imageLayer = layer as ImageLayer;
            const asset = project.assets[imageLayer.sourceId];
            const src = asset?.blobUrl ?? asset?.dataUrl;
            if (src) {
              const img = getCachedImage(src);
              if (img && img.complete && img.naturalWidth > 0) {
                const tempCanvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                if (tempCtx) {
                  tempCtx.drawImage(rasterBuffers.get(layerId) ?? img, 0, 0);
                  paintCanvasRef.current = tempCanvas;
                  paintLayerIdRef.current = layerId;
                  origPaintRef.current = snapshotCanvas(tempCanvas);

                  const localX = (x - layer.transform.x) * (img.naturalWidth / layer.transform.width);
                  const localY = (y - layer.transform.y) * (img.naturalHeight / layer.transform.height);

                  const tool = new EraserTool({
                    size: eraserSettings.size * (img.naturalWidth / layer.transform.width),
                    hardness: eraserSettings.hardness,
                    opacity: eraserSettings.opacity,
                    flow: eraserSettings.flow,
                    mode: eraserSettings.mode,
                    spacing: 25,
                    sizeDynamics: { ...DEFAULT_BRUSH_DYNAMICS },
                    opacityDynamics: { ...DEFAULT_BRUSH_DYNAMICS },
                    flowDynamics: { ...DEFAULT_BRUSH_DYNAMICS },
                  });
                  tool.startErase(localX, localY, 1);
                  eraserToolRef.current = tool;

                  if (!selectedLayerIds.includes(layerId)) {
                    selectLayer(layerId);
                  }
                  startDrag('paint', e.clientX, e.clientY);
                }
              }
            }
          }
        }
        return;
      }

      if (activeTool === 'gradient') {
        setGradientDrag({
          startX: x,
          startY: y,
          endX: x,
          endY: y,
          layerId: selectedLayerIds[0] ?? '',
        });
        startDrag('paint', e.clientX, e.clientY);
        return;
      }

      if (activeTool === 'paint-bucket') {
        const layerId = findLayerAtPoint(x, y);
        if (layerId && project) {
          const layer = project.layers[layerId];
          if (layer?.type === 'image') {
            const imageLayer = layer as ImageLayer;
            const asset = project.assets[imageLayer.sourceId];
            const src = asset?.blobUrl ?? asset?.dataUrl;
            if (src) {
              const img = getCachedImage(src);
              if (img && img.complete && img.naturalWidth > 0) {
                const localX = x - layer.transform.x;
                const localY = y - layer.transform.y;
                const scaleX = img.naturalWidth / layer.transform.width;
                const scaleY = img.naturalHeight / layer.transform.height;
                const imgX = Math.floor(localX * scaleX);
                const imgY = Math.floor(localY * scaleY);

                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = img.naturalWidth;
                tempCanvas.height = img.naturalHeight;
                const tempCtx = tempCanvas.getContext('2d');
                if (tempCtx) {
                  tempCtx.drawImage(rasterBuffers.get(layerId) ?? img, 0, 0);
                  const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);

                  const fillOptions: FloodFillOptions = {
                    tolerance: paintBucketSettings.tolerance,
                    contiguous: paintBucketSettings.contiguous,
                    antiAlias: paintBucketSettings.antiAlias,
                    opacity: paintBucketSettings.opacity,
                  };

                  const filledData = floodFill(imageData, imgX, imgY, paintBucketSettings.color, fillOptions);
                  tempCtx.putImageData(filledData, 0, 0);

                  // Phase 2: persist the fill into the layer's raster buffer and
                  // update its existing asset in place (no new "filled-*" asset).
                  rasterBuffers.set(layerId, tempCanvas);
                  const sourceId = imageLayer.sourceId;
                  const dataUrl = tempCanvas.toDataURL('image/png');
                  if (asset?.blobUrl?.startsWith('blob:')) {
                    URL.revokeObjectURL(asset.blobUrl);
                  }
                  useProjectStore.getState().addAsset({
                    id: sourceId,
                    name: asset && 'name' in asset ? (asset as { name?: string }).name ?? (imageLayer.name || 'Image') : (imageLayer.name || 'Image'),
                    type: 'image',
                    mimeType: 'image/png',
                    size: dataUrl.length,
                    width: tempCanvas.width,
                    height: tempCanvas.height,
                    thumbnailUrl: dataUrl,
                    dataUrl,
                  });
                  useProjectStore.getState().updateLayer(layerId, {});
                  getCachedImage(dataUrl); // warm cache for the next edit's guard
                  forceRender();
                }
              }
            }
          } else if (layer?.type === 'shape') {
            updateLayer(layerId, {
              shapeStyle: {
                ...(layer as ShapeLayer).shapeStyle,
                fill: paintBucketSettings.color,
                fillOpacity: paintBucketSettings.opacity,
              },
            } as Partial<ShapeLayer>);
          }
        }
        return;
      }

      if (activeTool === 'smudge' || activeTool === 'blur' || activeTool === 'sharpen') {
        const layerId = findLayerAtPoint(x, y);
        if (layerId && project) {
          const layer = project.layers[layerId];
          if (layer?.type === 'image') {
            const imageLayer = layer as ImageLayer;
            const asset = project.assets[imageLayer.sourceId];
            const src = asset?.blobUrl ?? asset?.dataUrl;
            if (src) {
              const img = getCachedImage(src);
              if (img && img.complete && img.naturalWidth > 0) {
                const tempCanvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                if (tempCtx) {
                  tempCtx.drawImage(rasterBuffers.get(layerId) ?? img, 0, 0);
                  paintCanvasRef.current = tempCanvas;
                  paintLayerIdRef.current = layerId;

                  const localX = (x - layer.transform.x) * (img.naturalWidth / layer.transform.width);
                  const localY = (y - layer.transform.y) * (img.naturalHeight / layer.transform.height);

                  if (activeTool === 'smudge') {
                    const tool = new SmudgeTool({
                      size: smudgeSettings.size * (img.naturalWidth / layer.transform.width),
                      hardness: 50,
                      strength: smudgeSettings.strength,
                      fingerPainting: smudgeSettings.fingerPainting,
                      sampleAllLayers: smudgeSettings.sampleAllLayers,
                      fingerColor: brushSettings.color,
                    });
                    tool.setCanvas(tempCanvas);
                    tool.startStroke(localX, localY, 1);
                    smudgeToolRef.current = tool;
                    blurSharpenToolRef.current = null;
                  } else {
                    const tool = new BlurSharpenTool({
                      size: blurSharpenSettings.size * (img.naturalWidth / layer.transform.width),
                      hardness: 50,
                      strength: blurSharpenSettings.strength,
                      mode: activeTool === 'blur' ? 'blur' : 'sharpen',
                      sampleAllLayers: blurSharpenSettings.sampleAllLayers,
                    });
                    tool.setCanvas(tempCanvas);
                    tool.startStroke(localX, localY, 1);
                    blurSharpenToolRef.current = tool;
                    smudgeToolRef.current = null;
                  }

                  if (!selectedLayerIds.includes(layerId)) {
                    selectLayer(layerId);
                  }
                  startDrag('paint', e.clientX, e.clientY);
                }
              }
            }
          }
        }
        return;
      }

      if (activeTool === 'dodge' || activeTool === 'burn' || activeTool === 'sponge' || activeTool === 'spot-healing') {
        const layerId = findLayerAtPoint(x, y);
        if (layerId && project) {
          const layer = project.layers[layerId];
          if (layer?.type === 'image') {
            const imageLayer = layer as ImageLayer;
            const asset = project.assets[imageLayer.sourceId];
            const src = asset?.blobUrl ?? asset?.dataUrl;
            if (src) {
              const img = getCachedImage(src);
              if (img && img.complete && img.naturalWidth > 0) {
                const tempCanvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                if (tempCtx) {
                  tempCtx.drawImage(rasterBuffers.get(layerId) ?? img, 0, 0);
                  paintCanvasRef.current = tempCanvas;
                  paintLayerIdRef.current = layerId;

                  const localX = (x - layer.transform.x) * (img.naturalWidth / layer.transform.width);
                  const localY = (y - layer.transform.y) * (img.naturalHeight / layer.transform.height);

                  if (activeTool === 'dodge' || activeTool === 'burn') {
                    const tool = new DodgeBurnTool({
                      size: dodgeBurnSettings.size * (img.naturalWidth / layer.transform.width),
                      type: activeTool,
                      range: dodgeBurnSettings.range,
                      exposure: dodgeBurnSettings.exposure,
                    });
                    tool.setCanvas(tempCanvas);
                    tool.startStroke(localX, localY, 1);
                    tool.apply(tempCtx, localX, localY, 1);
                    dodgeBurnToolRef.current = tool;
                  } else if (activeTool === 'sponge') {
                    const tool = new SpongeTool({
                      size: spongeSettings.size * (img.naturalWidth / layer.transform.width),
                      mode: spongeSettings.mode,
                      flow: spongeSettings.flow,
                    });
                    tool.setCanvas(tempCanvas);
                    tool.startStroke(localX, localY, 1);
                    tool.apply(tempCtx, localX, localY, 1);
                    spongeToolRef.current = tool;
                  } else if (activeTool === 'spot-healing') {
                    const tool = new SpotHealingTool({
                      size: spotHealingSettings.size * (img.naturalWidth / layer.transform.width),
                      type: spotHealingSettings.type,
                      sampleAllLayers: spotHealingSettings.sampleAllLayers,
                    });
                    tool.setCanvas(tempCanvas);
                    tool.heal(tempCtx, localX, localY);
                    spotHealingToolRef.current = tool;
                  }

                  if (!selectedLayerIds.includes(layerId)) {
                    selectLayer(layerId);
                  }
                  startDrag('paint', e.clientX, e.clientY);
                }
              }
            }
          }
        }
        return;
      }

      if (activeTool === 'clone-stamp' || activeTool === 'healing-brush') {
        const layerId = findLayerAtPoint(x, y);
        if (layerId && project) {
          const layer = project.layers[layerId];
          if (layer?.type === 'image') {
            const imageLayer = layer as ImageLayer;
            const asset = project.assets[imageLayer.sourceId];
            const src = asset?.blobUrl ?? asset?.dataUrl;
            if (src) {
              const img = getCachedImage(src);
              if (img && img.complete && img.naturalWidth > 0) {
                const tempCanvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                if (tempCtx) {
                  tempCtx.drawImage(rasterBuffers.get(layerId) ?? img, 0, 0);
                  paintCanvasRef.current = tempCanvas;
                  paintLayerIdRef.current = layerId;

                  const localX = (x - layer.transform.x) * (img.naturalWidth / layer.transform.width);
                  const localY = (y - layer.transform.y) * (img.naturalHeight / layer.transform.height);

                  if (e.altKey) {
                    if (activeTool === 'clone-stamp') {
                      if (!cloneStampToolRef.current) {
                        cloneStampToolRef.current = new CloneStampTool({
                          size: cloneStampSettings.size * (img.naturalWidth / layer.transform.width),
                          hardness: cloneStampSettings.hardness,
                          opacity: cloneStampSettings.opacity,
                          flow: cloneStampSettings.flow,
                          aligned: cloneStampSettings.aligned,
                        });
                      }
                      cloneStampToolRef.current.setSourceCanvas(tempCanvas);
                      cloneStampToolRef.current.setSource(localX, localY, layerId);
                    } else {
                      if (!healingBrushToolRef.current) {
                        healingBrushToolRef.current = new HealingBrushTool({
                          size: healingBrushSettings.size * (img.naturalWidth / layer.transform.width),
                          hardness: healingBrushSettings.hardness,
                          aligned: healingBrushSettings.aligned,
                        });
                      }
                      healingBrushToolRef.current.setCanvases(tempCanvas, tempCanvas);
                      healingBrushToolRef.current.setSource(localX, localY, layerId);
                    }
                    return;
                  }

                  if (activeTool === 'clone-stamp' && cloneStampToolRef.current?.hasSource()) {
                    cloneStampToolRef.current.updateSettings({
                      size: cloneStampSettings.size * (img.naturalWidth / layer.transform.width),
                      hardness: cloneStampSettings.hardness,
                      opacity: cloneStampSettings.opacity,
                      flow: cloneStampSettings.flow,
                      aligned: cloneStampSettings.aligned,
                    });
                    cloneStampToolRef.current.setSourceCanvas(tempCanvas);
                    cloneStampToolRef.current.startClone(localX, localY);
                    cloneStampToolRef.current.clone(tempCtx, localX, localY);
                  } else if (activeTool === 'healing-brush' && healingBrushToolRef.current?.hasSource()) {
                    healingBrushToolRef.current.updateSettings({
                      size: healingBrushSettings.size * (img.naturalWidth / layer.transform.width),
                      hardness: healingBrushSettings.hardness,
                      aligned: healingBrushSettings.aligned,
                    });
                    healingBrushToolRef.current.setCanvases(tempCanvas, tempCanvas);
                    healingBrushToolRef.current.startHeal(localX, localY);
                    healingBrushToolRef.current.heal(tempCtx, localX, localY);
                  } else {
                    return;
                  }

                  if (!selectedLayerIds.includes(layerId)) {
                    selectLayer(layerId);
                  }
                  startDrag('paint', e.clientX, e.clientY);
                }
              }
            }
          }
        }
        return;
      }

      if (activeTool === 'zoom') {
        if (e.shiftKey || e.altKey) {
          setZoom(Math.max(0.1, zoom / 1.5));
        } else {
          setZoom(Math.min(32, zoom * 1.5));
        }
        return;
      }

      if (activeTool === 'eyedropper') {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (ctx && canvas) {
          const rect = canvas.getBoundingClientRect();
          const pixelX = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
          const pixelY = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
          const pixel = ctx.getImageData(pixelX, pixelY, 1, 1).data;
          const hex = `#${pixel[0].toString(16).padStart(2, '0')}${pixel[1].toString(16).padStart(2, '0')}${pixel[2].toString(16).padStart(2, '0')}`;
          setBrushSettings({ color: hex });
        }
        return;
      }

      if (activeTool === 'crop') {
        const layerId = findLayerAtPoint(x, y);
        if (layerId) {
          const layer = project?.layers[layerId];
          if (layer) {
            selectLayer(layerId);
            startCrop(layerId, {
              x: 0,
              y: 0,
              width: layer.transform.width,
              height: layer.transform.height,
            });
            startMarqueeSelect(x, y);
            startDrag('crop', e.clientX, e.clientY);
          }
        }
        return;
      }

      if (activeTool === 'select') {
        const handleHit = getHandleAtPoint(canvasX, canvasY);
        if (handleHit) {
          const layer = project?.layers[handleHit.layerId];
          if (layer) {
            initialTransformRef.current = {
              x: layer.transform.x,
              y: layer.transform.y,
              width: layer.transform.width,
              height: layer.transform.height,
              rotation: layer.transform.rotation,
            };
            if (handleHit.handle === 'rotate') {
              startDrag('rotate', e.clientX, e.clientY);
            } else {
              setActiveResizeHandle(handleHit.handle);
              startDrag('resize', e.clientX, e.clientY);
            }
            return;
          }
        }

        const layerId = findLayerAtPoint(x, y);
        if (layerId) {
          if (e.shiftKey) {
            selectLayer(layerId, true);
          } else if (!selectedLayerIds.includes(layerId)) {
            selectLayer(layerId);
          }
          startDrag('move', e.clientX, e.clientY);
        } else {
          deselectAllLayers();
          startMarqueeSelect(x, y);
          startDrag('marquee', e.clientX, e.clientY);
        }
      }
    },
    [activeTool, screenToCanvas, findLayerAtPoint, selectLayer, deselectAllLayers, startDrag, selectedLayerIds, startDrawing, startMarqueeSelect, getHandleAtPoint, project, setActiveResizeHandle, zoom, setZoom, startCrop, setBrushSettings, brushSettings, eraserSettings, magicWandSelect, maskEditLayerId, setMaskEditLayerId]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;

      // Freehand lasso in progress — accumulate the path.
      if (lassoDraftRef.current) {
        const { x, y } = screenToCanvas(e.clientX, e.clientY);
        lassoDraftRef.current.push({ x, y });
        scheduleRender();
        return;
      }

      if (drawing.isDrawing) {
        const { x, y } = screenToCanvas(e.clientX, e.clientY);
        addDrawingPoint({ x, y });
        scheduleRender();
        return;
      }

      if (gradientDrag && activeTool === 'gradient') {
        const { x, y } = screenToCanvas(e.clientX, e.clientY);
        setGradientDrag({ ...gradientDrag, endX: x, endY: y });
        scheduleRender();
        return;
      }

      if (isDragging && dragMode === 'paint' && paintLayerIdRef.current && paintCanvasRef.current) {
        if (activeTool === 'smudge' && smudgeToolRef.current) {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          const layer = project?.layers[paintLayerIdRef.current];
          if (layer) {
            const scale = paintCanvasRef.current.width / layer.transform.width;
            const localX = (x - layer.transform.x) * scale;
            const localY = (y - layer.transform.y) * scale;
            smudgeToolRef.current.continueStroke(localX, localY, 1);
          }
          return;
        }

        if (activeTool === 'eraser' && eraserToolRef.current) {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          const layer = project?.layers[paintLayerIdRef.current];
          if (layer && paintCanvasRef.current) {
            const scale = paintCanvasRef.current.width / layer.transform.width;
            const localX = (x - layer.transform.x) * scale;
            const localY = (y - layer.transform.y) * scale;
            eraserToolRef.current.continueErase(localX, localY, 1);

            const ctx = paintCanvasRef.current.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              const stroke = eraserToolRef.current.endErase();
              if (stroke) {
                eraserToolRef.current.applyErase(ctx, stroke);
                eraserToolRef.current.startErase(localX, localY, 1);
              }
            }
          }
          scheduleRender();
          return;
        }

        if (activeTool === 'brush' && brushToolRef.current) {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          const layer = project?.layers[paintLayerIdRef.current];
          if (layer && paintCanvasRef.current) {
            const scale = paintCanvasRef.current.width / layer.transform.width;
            const localX = (x - layer.transform.x) * scale;
            const localY = (y - layer.transform.y) * scale;

            const ctx = paintCanvasRef.current.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              brushToolRef.current.apply(ctx, localX, localY, 1);
            }
          }
          scheduleRender();
          return;
        }

        if ((activeTool === 'blur' || activeTool === 'sharpen') && blurSharpenToolRef.current) {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          const layer = project?.layers[paintLayerIdRef.current];
          if (layer && paintCanvasRef.current) {
            const scale = paintCanvasRef.current.width / layer.transform.width;
            const localX = (x - layer.transform.x) * scale;
            const localY = (y - layer.transform.y) * scale;
            blurSharpenToolRef.current.continueStroke(localX, localY, 1);

            const ctx = paintCanvasRef.current.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              blurSharpenToolRef.current.apply(ctx, localX, localY, 1);
            }
          }
          return;
        }

        if ((activeTool === 'dodge' || activeTool === 'burn') && dodgeBurnToolRef.current) {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          const layer = project?.layers[paintLayerIdRef.current];
          if (layer && paintCanvasRef.current) {
            const scale = paintCanvasRef.current.width / layer.transform.width;
            const localX = (x - layer.transform.x) * scale;
            const localY = (y - layer.transform.y) * scale;
            dodgeBurnToolRef.current.continueStroke(localX, localY, 1);

            const ctx = paintCanvasRef.current.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              dodgeBurnToolRef.current.apply(ctx, localX, localY, 1);
            }
          }
          return;
        }

        if (activeTool === 'sponge' && spongeToolRef.current) {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          const layer = project?.layers[paintLayerIdRef.current];
          if (layer && paintCanvasRef.current) {
            const scale = paintCanvasRef.current.width / layer.transform.width;
            const localX = (x - layer.transform.x) * scale;
            const localY = (y - layer.transform.y) * scale;
            spongeToolRef.current.continueStroke(localX, localY, 1);

            const ctx = paintCanvasRef.current.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              spongeToolRef.current.apply(ctx, localX, localY, 1);
            }
          }
          return;
        }

        if (activeTool === 'spot-healing' && spotHealingToolRef.current) {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          const layer = project?.layers[paintLayerIdRef.current];
          if (layer && paintCanvasRef.current) {
            const scale = paintCanvasRef.current.width / layer.transform.width;
            const localX = (x - layer.transform.x) * scale;
            const localY = (y - layer.transform.y) * scale;

            const ctx = paintCanvasRef.current.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              spotHealingToolRef.current.heal(ctx, localX, localY);
            }
          }
          return;
        }

        if (activeTool === 'clone-stamp' && cloneStampToolRef.current?.hasSource()) {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          const layer = project?.layers[paintLayerIdRef.current];
          if (layer && paintCanvasRef.current) {
            const scale = paintCanvasRef.current.width / layer.transform.width;
            const localX = (x - layer.transform.x) * scale;
            const localY = (y - layer.transform.y) * scale;

            const ctx = paintCanvasRef.current.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              cloneStampToolRef.current.clone(ctx, localX, localY);
            }
          }
          return;
        }

        if (activeTool === 'healing-brush' && healingBrushToolRef.current?.hasSource()) {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          const layer = project?.layers[paintLayerIdRef.current];
          if (layer && paintCanvasRef.current) {
            const scale = paintCanvasRef.current.width / layer.transform.width;
            const localX = (x - layer.transform.x) * scale;
            const localY = (y - layer.transform.y) * scale;

            const ctx = paintCanvasRef.current.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              healingBrushToolRef.current.heal(ctx, localX, localY);
            }
          }
          return;
        }
      }

      if (!isDragging && canvas && (activeTool === 'select' || activeTool === 'free-transform') && selectedLayerIds.length === 1) {
        const rect = canvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;
        const handleHit = getHandleAtPoint(canvasX, canvasY);
        const newCursor = getCursorForHandle(handleHit?.handle ?? null);
        setCursorStyle(newCursor);
      }

      if (!isDragging) return;

      updateDrag(e.clientX, e.clientY);

      if (dragMode === 'marquee' || dragMode === 'crop') {
        const { x, y } = screenToCanvas(e.clientX, e.clientY);
        updateMarqueeSelect(x, y);
        if (dragMode === 'crop' && crop.layerId && marqueeRect) {
          const layer = project?.layers[crop.layerId];
          if (layer) {
            const relX = marqueeRect.x - layer.transform.x;
            const relY = marqueeRect.y - layer.transform.y;
            let width = Math.min(marqueeRect.width, layer.transform.width - relX);
            let height = Math.min(marqueeRect.height, layer.transform.height - relY);

            if (crop.lockAspect && crop.initialAspectRatio) {
              const currentAspect = width / height;
              if (currentAspect > crop.initialAspectRatio) {
                width = height * crop.initialAspectRatio;
              } else {
                height = width / crop.initialAspectRatio;
              }
            }

            updateCropRect({
              x: Math.max(0, relX),
              y: Math.max(0, relY),
              width,
              height,
            });
          }
        }
        scheduleRender();
        return;
      }

      if (dragMode === 'pan') {
        const dx = e.clientX - dragCurrentX;
        const dy = e.clientY - dragCurrentY;
        setPan(panX + dx, panY + dy);
      } else if (dragMode === 'rotate' && selectedLayerIds.length === 1 && artboard && canvas && initialTransformRef.current) {
        const layerId = selectedLayerIds[0];
        const layer = project?.layers[layerId];
        if (layer) {
          const centerX = canvas.width / 2 + panX;
          const centerY = canvas.height / 2 + panY;
          const artboardX = centerX - (artboard.size.width * zoom) / 2;
          const artboardY = centerY - (artboard.size.height * zoom) / 2;

          const layerCenterX = artboardX + (initialTransformRef.current.x + initialTransformRef.current.width / 2) * zoom;
          const layerCenterY = artboardY + (initialTransformRef.current.y + initialTransformRef.current.height / 2) * zoom;

          const rect = canvas.getBoundingClientRect();
          const startDx = dragStartX - rect.left - layerCenterX;
          const startDy = dragStartY - rect.top - layerCenterY;
          const currentDx = e.clientX - rect.left - layerCenterX;
          const currentDy = e.clientY - rect.top - layerCenterY;

          const startAngle = Math.atan2(startDy, startDx);
          const currentAngle = Math.atan2(currentDy, currentDx);
          const deltaAngle = (currentAngle - startAngle) * (180 / Math.PI);

          let newRotation = initialTransformRef.current.rotation + deltaAngle;

          if (e.shiftKey) {
            newRotation = Math.round(newRotation / 15) * 15;
          }

          while (newRotation > 360) newRotation -= 360;
          while (newRotation < 0) newRotation += 360;

          updateLayerTransform(layerId, { rotation: newRotation });
        }
      } else if (dragMode === 'resize' && selectedLayerIds.length === 1 && activeResizeHandle && initialTransformRef.current) {
        const layerId = selectedLayerIds[0];
        const layer = project?.layers[layerId];
        if (layer) {
          const dx = (e.clientX - dragStartX) / zoom;
          const dy = (e.clientY - dragStartY) / zoom;

          const init = initialTransformRef.current;
          let newX = init.x;
          let newY = init.y;
          let newWidth = init.width;
          let newHeight = init.height;

          const maintainAspect = e.shiftKey;
          const aspectRatio = init.width / init.height;

          switch (activeResizeHandle) {
            case 'nw':
              newX = init.x + dx;
              newY = init.y + dy;
              newWidth = init.width - dx;
              newHeight = init.height - dy;
              if (maintainAspect) {
                const delta = Math.max(-dx, -dy);
                newWidth = init.width + delta;
                newHeight = newWidth / aspectRatio;
                newX = init.x + init.width - newWidth;
                newY = init.y + init.height - newHeight;
              }
              break;
            case 'n':
              newY = init.y + dy;
              newHeight = init.height - dy;
              if (maintainAspect) {
                newWidth = newHeight * aspectRatio;
                newX = init.x + (init.width - newWidth) / 2;
              }
              break;
            case 'ne':
              newY = init.y + dy;
              newWidth = init.width + dx;
              newHeight = init.height - dy;
              if (maintainAspect) {
                const delta = Math.max(dx, -dy);
                newWidth = init.width + delta;
                newHeight = newWidth / aspectRatio;
                newY = init.y + init.height - newHeight;
              }
              break;
            case 'e':
              newWidth = init.width + dx;
              if (maintainAspect) {
                newHeight = newWidth / aspectRatio;
                newY = init.y + (init.height - newHeight) / 2;
              }
              break;
            case 'se':
              newWidth = init.width + dx;
              newHeight = init.height + dy;
              if (maintainAspect) {
                const delta = Math.max(dx, dy);
                newWidth = init.width + delta;
                newHeight = newWidth / aspectRatio;
              }
              break;
            case 's':
              newHeight = init.height + dy;
              if (maintainAspect) {
                newWidth = newHeight * aspectRatio;
                newX = init.x + (init.width - newWidth) / 2;
              }
              break;
            case 'sw':
              newX = init.x + dx;
              newWidth = init.width - dx;
              newHeight = init.height + dy;
              if (maintainAspect) {
                const delta = Math.max(-dx, dy);
                newWidth = init.width + delta;
                newHeight = newWidth / aspectRatio;
                newX = init.x + init.width - newWidth;
              }
              break;
            case 'w':
              newX = init.x + dx;
              newWidth = init.width - dx;
              if (maintainAspect) {
                newHeight = newWidth / aspectRatio;
                newY = init.y + (init.height - newHeight) / 2;
              }
              break;
          }

          const minSize = 10;
          if (newWidth < minSize) {
            if (activeResizeHandle.includes('w')) {
              newX = init.x + init.width - minSize;
            }
            newWidth = minSize;
          }
          if (newHeight < minSize) {
            if (activeResizeHandle.includes('n')) {
              newY = init.y + init.height - minSize;
            }
            newHeight = minSize;
          }

          updateLayerTransform(layerId, {
            x: newX,
            y: newY,
            width: newWidth,
            height: newHeight,
          });
        }
      } else if (dragMode === 'move' && selectedLayerIds.length > 0 && artboard) {
        const dx = (e.clientX - dragCurrentX) / zoom;
        const dy = (e.clientY - dragCurrentY) / zoom;

        const firstLayerId = selectedLayerIds[0];
        const firstLayer = project?.layers[firstLayerId];

        if (firstLayer) {
          const newX = firstLayer.transform.x + dx;
          const newY = firstLayer.transform.y + dy;

          const otherLayers = Object.values(project?.layers ?? {}).filter(
            (l) => l && !selectedLayerIds.includes(l.id)
          );

          const snapResult = calculateSnap(
            { x: newX, y: newY, width: firstLayer.transform.width, height: firstLayer.transform.height },
            otherLayers as Layer[],
            { x: 0, y: 0, width: artboard.size.width, height: artboard.size.height },
            guides,
            { snapToObjects, snapToGuides, snapToGrid, gridSize, threshold: 8 }
          );

          const adjustedDx = snapResult.x - firstLayer.transform.x;
          const adjustedDy = snapResult.y - firstLayer.transform.y;

          selectedLayerIds.forEach((layerId) => {
            const layer = project?.layers[layerId];
            if (layer) {
              updateLayerTransform(layerId, {
                x: layer.transform.x + adjustedDx,
                y: layer.transform.y + adjustedDy,
              });
            }
          });

          setSmartGuides(snapResult.guides);
        }
      }
    },
    [isDragging, dragMode, dragCurrentX, dragCurrentY, dragStartX, dragStartY, panX, panY, setPan, zoom, selectedLayerIds, project, updateLayerTransform, updateDrag, artboard, guides, snapToObjects, snapToGuides, snapToGrid, gridSize, setSmartGuides, drawing.isDrawing, screenToCanvas, addDrawingPoint, scheduleRender, updateMarqueeSelect, activeResizeHandle, activeTool, getHandleAtPoint, updateCropRect, crop, marqueeRect, gradientDrag]
  );

  const findLayersInRect = useCallback(
    (rect: { x: number; y: number; width: number; height: number }): string[] => {
      if (!artboard || !project) return [];

      const found: string[] = [];
      for (const layerId of artboard.layerIds) {
        const layer = project.layers[layerId];
        if (!layer || !layer.visible || layer.locked) continue;

        const { transform } = layer;
        const layerLeft = transform.x;
        const layerRight = transform.x + transform.width;
        const layerTop = transform.y;
        const layerBottom = transform.y + transform.height;

        const rectLeft = rect.x;
        const rectRight = rect.x + rect.width;
        const rectTop = rect.y;
        const rectBottom = rect.y + rect.height;

        const intersects = !(layerRight < rectLeft || layerLeft > rectRight || layerBottom < rectTop || layerTop > rectBottom);

        if (intersects) {
          found.push(layerId);
        }
      }
      return found;
    },
    [artboard, project]
  );

  const handleMouseUp = useCallback(() => {
    // Commit a freehand lasso selection.
    if (lassoDraftRef.current) {
      const pts = lassoDraftRef.current;
      lassoDraftRef.current = null;
      commitLassoSelection(pts);
      scheduleRender();
      return;
    }

    if (drawing.isDrawing) {
      const path = finishDrawing();
      if (path && path.length > 1) {
        if (activeTool === 'brush') {
          addPathLayer(path, brushSettings.color, brushSettings.size);
        } else {
          addPathLayer(path, penSettings.color, penSettings.width);
        }
      }
      scheduleRender();
      return;
    }

    if (gradientDrag && activeTool === 'gradient') {
      const dx = gradientDrag.endX - gradientDrag.startX;
      const dy = gradientDrag.endY - gradientDrag.startY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > 5 && artboard) {
        const minX = Math.min(gradientDrag.startX, gradientDrag.endX);
        const minY = Math.min(gradientDrag.startY, gradientDrag.endY);
        const maxX = Math.max(gradientDrag.startX, gradientDrag.endX);
        const maxY = Math.max(gradientDrag.startY, gradientDrag.endY);

        const width = Math.max(maxX - minX, 50);
        const height = Math.max(maxY - minY, 50);

        const angle = Math.atan2(dy, dx) * (180 / Math.PI);

        const colors = gradientSettings.reverse
          ? [...gradientSettings.colors].reverse()
          : gradientSettings.colors;

        const stops = colors.map((color, i) => ({
          offset: i / Math.max(colors.length - 1, 1),
          color,
        }));

        addShapeLayer('rectangle', {
          x: minX,
          y: minY,
          width,
          height,
        });

        const newLayerId = Object.keys(project?.layers ?? {}).find(
          (id) => !selectedLayerIds.includes(id) && project?.layers[id]?.name === 'Rectangle'
        );

        if (newLayerId) {
          updateLayer(newLayerId, {
            name: 'Gradient Fill',
            shapeStyle: {
              fill: null,
              stroke: null,
              strokeWidth: 0,
              fillOpacity: gradientSettings.opacity,
              strokeOpacity: 1,
              cornerRadius: 0,
              fillType: 'gradient',
              gradient: {
                type: gradientSettings.type,
                angle: gradientSettings.type === 'linear' ? angle : 0,
                stops,
              },
            },
          } as Partial<ShapeLayer>);
        }
      }

      setGradientDrag(null);
      endDrag();
      scheduleRender();
      return;
    }

    // Paint-on-mask: save the painted mask buffer back to the layer's mask.
    if (dragMode === 'paint' && paintingMaskRef.current && paintLayerIdRef.current && paintCanvasRef.current) {
      brushToolRef.current?.endStroke();
      const buf = paintCanvasRef.current;
      const out = document.createElement('canvas');
      out.width = buf.width;
      out.height = buf.height;
      out.getContext('2d')!.drawImage(buf, 0, 0);
      const dataUrl = out.toDataURL('image/png');
      const layerId = paintLayerIdRef.current;
      const layer = useProjectStore.getState().project?.layers[layerId];
      if (layer?.mask) {
        useProjectStore.getState().updateLayer(layerId, { mask: { ...layer.mask, data: dataUrl } });
        getCachedImage(dataUrl); // warm the cache so the saved mask renders next frame
      }
      brushToolRef.current = null;
      paintCanvasRef.current = null;
      paintLayerIdRef.current = null;
      paintingMaskRef.current = false;
      liveMaskPaint = null;
      forceRender();
      endDrag();
      return;
    }

    if (dragMode === 'paint' && paintLayerIdRef.current && paintCanvasRef.current) {
      const hasActiveTool =
        (activeTool === 'smudge' && smudgeToolRef.current) ||
        ((activeTool === 'blur' || activeTool === 'sharpen') && blurSharpenToolRef.current) ||
        ((activeTool === 'dodge' || activeTool === 'burn') && dodgeBurnToolRef.current) ||
        (activeTool === 'sponge' && spongeToolRef.current) ||
        (activeTool === 'spot-healing' && spotHealingToolRef.current) ||
        (activeTool === 'clone-stamp' && cloneStampToolRef.current) ||
        (activeTool === 'healing-brush' && healingBrushToolRef.current) ||
        (activeTool === 'eraser' && eraserToolRef.current) ||
        (activeTool === 'brush' && brushToolRef.current);

      if (hasActiveTool) {
        if (smudgeToolRef.current) {
          smudgeToolRef.current.endStroke();
        }
        if (blurSharpenToolRef.current) {
          blurSharpenToolRef.current.endStroke();
        }
        if (dodgeBurnToolRef.current) {
          dodgeBurnToolRef.current.endStroke();
        }
        if (spongeToolRef.current) {
          spongeToolRef.current.endStroke();
        }
        if (cloneStampToolRef.current) {
          cloneStampToolRef.current.endClone();
        }
        if (healingBrushToolRef.current) {
          healingBrushToolRef.current.endHeal();
        }
        if (eraserToolRef.current && paintCanvasRef.current) {
          const ctx = paintCanvasRef.current.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            const stroke = eraserToolRef.current.endErase();
            if (stroke) {
              eraserToolRef.current.applyErase(ctx, stroke);
            }
          }
        }
        if (brushToolRef.current) {
          brushToolRef.current.endStroke();
        }

        const tempCanvas = paintCanvasRef.current;
        const layerId = paintLayerIdRef.current;

        const currentLayer = project?.layers[layerId] as ImageLayer | undefined;
        const oldSourceId = currentLayer?.sourceId;

        // Confine brush/eraser strokes to the active selection (Photoshop clips
        // painting to the marquee). No selection => the whole stroke commits.
        let finalCanvas: OffscreenCanvas | HTMLCanvasElement = tempCanvas;
        const sel = useSelectionStore.getState().active;
        if (sel && sel.path.length > 2 && origPaintRef.current && currentLayer &&
            (activeTool === 'brush' || activeTool === 'eraser')) {
          finalCanvas = gateToSelection(tempCanvas as OffscreenCanvas, origPaintRef.current, sel.path, currentLayer.transform);
        }
        origPaintRef.current = null;

        const canvas = document.createElement('canvas');
        canvas.width = finalCanvas.width;
        canvas.height = finalCanvas.height;
        const ctx = canvas.getContext('2d');
        if (ctx && layerId) {
          ctx.drawImage(finalCanvas, 0, 0);
          // Phase 2: keep the painted pixels in the layer's PERSISTENT raster
          // buffer (the renderer draws it directly — instant, no reload). We do
          // NOT create a new asset; instead update the EXISTING asset in place
          // (same id, original name) so save/export/reload still work and the
          // Assets panel never fills up with "*-edited" copies.
          rasterBuffers.set(layerId, finalCanvas);
          const existing = oldSourceId ? useProjectStore.getState().project?.assets[oldSourceId] : undefined;
          const dataUrl = canvas.toDataURL('image/png');
          if (oldSourceId) {
            useProjectStore.getState().addAsset({
              id: oldSourceId,
              name: existing?.name ?? 'Image',
              type: 'image',
              mimeType: 'image/png',
              size: dataUrl.length,
              width: canvas.width,
              height: canvas.height,
              thumbnailUrl: dataUrl,
              dataUrl,
            });
            // Touch the layer so the project is marked dirty (autosave/history)
            // without changing sourceId.
            useProjectStore.getState().updateLayer(layerId, {});
            // Warm the image cache for the updated asset so the NEXT stroke's
            // "is the source image loaded?" guard passes (the renderer itself
            // draws the raster buffer, so it never loads this dataURL).
            getCachedImage(dataUrl);
          }
          paintCanvasRef.current = null;
          paintLayerIdRef.current = null;
          forceRender();
        } else {
          paintCanvasRef.current = null;
          paintLayerIdRef.current = null;
        }

        smudgeToolRef.current = null;
        blurSharpenToolRef.current = null;
        dodgeBurnToolRef.current = null;
        spongeToolRef.current = null;
        spotHealingToolRef.current = null;
        eraserToolRef.current = null;
        brushToolRef.current = null;
      }

      endDrag();
      return;
    }

    if (dragMode === 'marquee') {
      const rect = endMarqueeSelect();
      if (rect && rect.width > 2 && rect.height > 2) {
        if (activeTool === 'marquee-rect' || activeTool === 'marquee-ellipse') {
          // Turn the dragged rect into a real pixel selection (marching ants).
          commitMarqueeSelection(rect, activeTool === 'marquee-ellipse');
        } else {
          const layerIds = findLayersInRect(rect);
          if (layerIds.length > 0) {
            selectLayers(layerIds);
          }
        }
      }
      endDrag();
      scheduleRender();
      return;
    }

    if (dragMode === 'crop') {
      endMarqueeSelect();
      endDrag();
      scheduleRender();
      return;
    }

    initialTransformRef.current = null;
    setActiveResizeHandle(null);
    endDrag();
    clearSmartGuides();
  }, [endDrag, clearSmartGuides, drawing.isDrawing, finishDrawing, addPathLayer, penSettings, brushSettings, scheduleRender, dragMode, endMarqueeSelect, findLayersInRect, selectLayers, setActiveResizeHandle, activeTool, gradientDrag, gradientSettings, artboard, addShapeLayer, updateLayer, project, selectedLayerIds, commitLassoSelection, commitMarqueeSelection]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const { x, y } = screenToCanvas(e.clientX, e.clientY);
      const layerId = findLayerAtPoint(x, y);

      let menuType: ContextMenuType = 'canvas';

      if (layerId) {
        if (!selectedLayerIds.includes(layerId)) {
          selectLayer(layerId);
        }

        if (selectedLayerIds.length > 1 || (selectedLayerIds.length === 1 && selectedLayerIds[0] !== layerId)) {
          const count = selectedLayerIds.includes(layerId) ? selectedLayerIds.length : 1;
          if (count > 1) {
            menuType = 'multi-layer';
          } else {
            const layer = project?.layers[layerId];
            menuType = layer?.type === 'group' ? 'group' : 'layer';
          }
        } else {
          const layer = project?.layers[layerId];
          menuType = layer?.type === 'group' ? 'group' : 'layer';
        }
      } else if (selectedLayerIds.length > 1) {
        menuType = 'multi-layer';
      } else if (selectedLayerIds.length === 1) {
        const layer = project?.layers[selectedLayerIds[0]];
        menuType = layer?.type === 'group' ? 'group' : 'layer';
      }

      setContextMenu({
        position: { x: e.clientX, y: e.clientY },
        type: menuType,
      });
    },
    [screenToCanvas, findLayerAtPoint, selectedLayerIds, selectLayer, project]
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleFlipHorizontal = useCallback(() => {
    selectedLayerIds.forEach((id) => {
      const layer = project?.layers[id];
      if (layer) {
        updateLayer(id, { flipHorizontal: !layer.flipHorizontal });
      }
    });
  }, [selectedLayerIds, project, updateLayer]);

  const handleFlipVertical = useCallback(() => {
    selectedLayerIds.forEach((id) => {
      const layer = project?.layers[id];
      if (layer) {
        updateLayer(id, { flipVertical: !layer.flipVertical });
      }
    });
  }, [selectedLayerIds, project, updateLayer]);

  const handleResetTransform = useCallback(() => {
    selectedLayerIds.forEach((id) => {
      updateLayerTransform(id, {
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        skewX: 0,
        skewY: 0,
      });
      updateLayer(id, { flipHorizontal: false, flipVertical: false });
    });
  }, [selectedLayerIds, updateLayerTransform, updateLayer]);

  const handleToggleVisibility = useCallback(() => {
    selectedLayerIds.forEach((id) => {
      const layer = project?.layers[id];
      if (layer) {
        updateLayer(id, { visible: !layer.visible });
      }
    });
  }, [selectedLayerIds, project, updateLayer]);

  const handleToggleLock = useCallback(() => {
    selectedLayerIds.forEach((id) => {
      const layer = project?.layers[id];
      if (layer) {
        updateLayer(id, { locked: !layer.locked });
      }
    });
  }, [selectedLayerIds, project, updateLayer]);

  const handleSelectAll = useCallback(() => {
    if (artboard) {
      selectLayers(artboard.layerIds);
    }
  }, [artboard, selectLayers]);

  const handleZoomFit = useCallback(() => {
    if (artboard && containerRef.current) {
      const containerWidth = containerRef.current.clientWidth;
      const containerHeight = containerRef.current.clientHeight;
      const scaleX = (containerWidth - 100) / artboard.size.width;
      const scaleY = (containerHeight - 100) / artboard.size.height;
      const newZoom = Math.min(scaleX, scaleY, 1);
      setZoom(newZoom);
      setPan(0, 0);
    }
  }, [artboard, setZoom, setPan]);

  const handleAlignLeft = useCallback(() => {
    if (selectedLayerIds.length < 2 || !project) return;
    const layers = selectedLayerIds.map((id) => project.layers[id]).filter(Boolean);
    const minX = Math.min(...layers.map((l) => l.transform.x));
    layers.forEach((layer) => {
      updateLayerTransform(layer.id, { x: minX });
    });
  }, [selectedLayerIds, project, updateLayerTransform]);

  const handleAlignCenter = useCallback(() => {
    if (selectedLayerIds.length < 2 || !project) return;
    const layers = selectedLayerIds.map((id) => project.layers[id]).filter(Boolean);
    const centers = layers.map((l) => l.transform.x + l.transform.width / 2);
    const avgCenter = centers.reduce((a, b) => a + b, 0) / centers.length;
    layers.forEach((layer) => {
      updateLayerTransform(layer.id, { x: avgCenter - layer.transform.width / 2 });
    });
  }, [selectedLayerIds, project, updateLayerTransform]);

  const handleAlignRight = useCallback(() => {
    if (selectedLayerIds.length < 2 || !project) return;
    const layers = selectedLayerIds.map((id) => project.layers[id]).filter(Boolean);
    const maxRight = Math.max(...layers.map((l) => l.transform.x + l.transform.width));
    layers.forEach((layer) => {
      updateLayerTransform(layer.id, { x: maxRight - layer.transform.width });
    });
  }, [selectedLayerIds, project, updateLayerTransform]);

  const handleAlignTop = useCallback(() => {
    if (selectedLayerIds.length < 2 || !project) return;
    const layers = selectedLayerIds.map((id) => project.layers[id]).filter(Boolean);
    const minY = Math.min(...layers.map((l) => l.transform.y));
    layers.forEach((layer) => {
      updateLayerTransform(layer.id, { y: minY });
    });
  }, [selectedLayerIds, project, updateLayerTransform]);

  const handleAlignMiddle = useCallback(() => {
    if (selectedLayerIds.length < 2 || !project) return;
    const layers = selectedLayerIds.map((id) => project.layers[id]).filter(Boolean);
    const middles = layers.map((l) => l.transform.y + l.transform.height / 2);
    const avgMiddle = middles.reduce((a, b) => a + b, 0) / middles.length;
    layers.forEach((layer) => {
      updateLayerTransform(layer.id, { y: avgMiddle - layer.transform.height / 2 });
    });
  }, [selectedLayerIds, project, updateLayerTransform]);

  const handleAlignBottom = useCallback(() => {
    if (selectedLayerIds.length < 2 || !project) return;
    const layers = selectedLayerIds.map((id) => project.layers[id]).filter(Boolean);
    const maxBottom = Math.max(...layers.map((l) => l.transform.y + l.transform.height));
    layers.forEach((layer) => {
      updateLayerTransform(layer.id, { y: maxBottom - layer.transform.height });
    });
  }, [selectedLayerIds, project, updateLayerTransform]);

  const selectedLayer = selectedLayerIds.length === 1 ? project?.layers[selectedLayerIds[0]] : null;

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const canvas = canvasRef.current;
      // Ctrl/Cmd OR Alt + wheel = zoom anchored to the cursor (Photoshop). The
      // point of the artboard under the pointer stays put while zooming.
      if ((e.ctrlKey || e.metaKey || e.altKey) && canvas && artboard) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const before = screenToCanvas(e.clientX, e.clientY); // artboard pt pre-zoom
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        useUIStore.getState().setZoom(zoom * delta);
        const z1 = useUIStore.getState().zoom; // read back the clamped value
        // Solve pan so `before` maps back under the cursor at the new zoom.
        const panX1 = cx - canvas.width / 2 + (artboard.size.width * z1) / 2 - before.x * z1;
        const panY1 = cy - canvas.height / 2 + (artboard.size.height * z1) / 2 - before.y * z1;
        setPan(panX1, panY1);
      } else {
        // Plain wheel = pan; Shift makes a vertical wheel scroll horizontally.
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        setPan(panX - dx, panY - dy);
      }
    },
    [zoom, panX, panY, setPan, screenToCanvas, artboard]
  );

  // Attach wheel as a NON-passive native listener so preventDefault() works
  // (React's onWheel is passive, which throws when we preventDefault to stop the
  // browser's own Ctrl+wheel page zoom).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Animate the marching-ants while a selection exists.
  useEffect(() => {
    if (!activeSelection) return;
    let raf = 0;
    const tick = () => {
      marchingOffsetRef.current = (marchingOffsetRef.current + 0.4) % 8;
      scheduleRender();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [activeSelection, scheduleRender]);

  const effectiveCursor = (() => {
    if ((activeTool === 'select' || activeTool === 'free-transform') && cursorStyle !== 'default') {
      return cursorStyle;
    }
    return getToolCursor(activeTool, isDragging, dragMode);
  })();

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-hidden relative"
      style={{ cursor: effectiveCursor }}
    >
      {showRulers && (
        <Rulers
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
        />
      )}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
        className="absolute"
        style={{
          top: showRulers ? RULER_SIZE : 0,
          left: showRulers ? RULER_SIZE : 0,
          width: showRulers ? `calc(100% - ${RULER_SIZE}px)` : '100%',
          height: showRulers ? `calc(100% - ${RULER_SIZE}px)` : '100%',
          cursor: effectiveCursor,
        }}
      />

      {contextMenu && (
        <ContextMenu
          position={contextMenu.position}
          type={contextMenu.type}
          onClose={closeContextMenu}
          onCut={cutLayers}
          onCopy={copyLayers}
          onPaste={pasteLayers}
          onDuplicate={() => selectedLayerIds.forEach((id) => duplicateLayer(id))}
          onDelete={() => selectedLayerIds.forEach((id) => removeLayer(id))}
          onSelectAll={handleSelectAll}
          onToggleVisibility={handleToggleVisibility}
          onToggleLock={handleToggleLock}
          onBringToFront={() => selectedLayerIds.forEach((id) => moveLayerToTop(id))}
          onBringForward={() => selectedLayerIds.forEach((id) => moveLayerUp(id))}
          onSendBackward={() => selectedLayerIds.forEach((id) => moveLayerDown(id))}
          onSendToBack={() => selectedLayerIds.forEach((id) => moveLayerToBottom(id))}
          onGroup={() => groupLayers(selectedLayerIds)}
          onUngroup={() => selectedLayerIds.length === 1 && ungroupLayers(selectedLayerIds[0])}
          onFlipHorizontal={handleFlipHorizontal}
          onFlipVertical={handleFlipVertical}
          onResetTransform={handleResetTransform}
          onCopyStyle={copyLayerStyle}
          onPasteStyle={pasteLayerStyle}
          onAddText={() => addTextLayer('New Text')}
          onAddShape={addShapeLayer}
          onToggleGrid={toggleGrid}
          onToggleRulers={toggleRulers}
          onZoomIn={() => setZoom(zoom * 1.2)}
          onZoomOut={() => setZoom(zoom / 1.2)}
          onZoomFit={handleZoomFit}
          onAlignLeft={handleAlignLeft}
          onAlignCenter={handleAlignCenter}
          onAlignRight={handleAlignRight}
          onAlignTop={handleAlignTop}
          onAlignMiddle={handleAlignMiddle}
          onAlignBottom={handleAlignBottom}
          isVisible={selectedLayer?.visible ?? true}
          isLocked={selectedLayer?.locked ?? false}
          showGrid={showGrid}
          showRulers={showRulers}
          hasClipboard={copiedLayers.length > 0}
          hasStyleClipboard={copiedStyle !== null}
          selectedCount={selectedLayerIds.length}
          hasSelection={!!activeSelection}
          onGenerativeFill={() => setGenerativeFillOpen(true)}
        />
      )}
    </div>
  );
}

const BLEND_MODE_MAP: Record<string, GlobalCompositeOperation> = {
  'normal': 'source-over',
  'multiply': 'multiply',
  'screen': 'screen',
  'overlay': 'overlay',
  'darken': 'darken',
  'lighten': 'lighten',
  'color-dodge': 'color-dodge',
  'color-burn': 'color-burn',
  'hard-light': 'hard-light',
  'soft-light': 'soft-light',
  'difference': 'difference',
  'exclusion': 'exclusion',
  'hue': 'hue',
  'saturation': 'saturation',
  'color': 'color',
  'luminosity': 'luminosity',
};

function renderLayerWithChildren(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  project: { layers: Record<string, Layer>; assets: Record<string, { dataUrl?: string; blobUrl?: string }> }
) {
  if (layer.type === 'group') {
    const group = layer as GroupLayer;
    if (!group.visible) return;

    const { transform } = group;
    const w = Math.max(1, Math.ceil(transform.width));
    const h = Math.max(1, Math.ceil(transform.height));

    // Render the group's children into its OWN local space on an offscreen so we
    // can treat the group as a unit — apply its mask, blend mode and opacity to
    // the MERGED result (Photoshop group semantics). Children recurse through
    // renderLayerWithChildren so nested groups render too.
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    if (octx) {
      const sortedChildIds = [...group.childIds].reverse();
      sortedChildIds.forEach((childId) => {
        const child = project.layers[childId];
        if (child && child.visible) renderLayerWithChildren(octx, child, project);
      });

      // Group mask — luminance reveals/hides, density fades (same as image masks).
      if (group.mask?.enabled && group.mask.data) {
        const maskImg = getCachedImage(group.mask.data);
        if (maskImg && maskImg.complete && maskImg.naturalWidth > 0) {
          octx.globalCompositeOperation = 'destination-in';
          octx.drawImage(maskToAlphaCanvas(maskImg, w, h, !!group.mask.invert, group.mask.density ?? 100), 0, 0);
          octx.globalCompositeOperation = 'source-over';
        }
      }

      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.rotate((transform.rotation * Math.PI) / 180);
      ctx.scale(transform.scaleX, transform.scaleY);
      ctx.globalAlpha *= transform.opacity;
      ctx.globalCompositeOperation = BLEND_MODE_MAP[group.blendMode?.mode] ?? 'source-over';
      ctx.drawImage(off, 0, 0);
      ctx.restore();
    }
  } else {
    renderLayer(ctx, layer, project);
  }
}

type RenderContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function renderLayerToOffscreen(
  layer: Layer,
  project: { assets: Record<string, { dataUrl?: string; blobUrl?: string }> }
): OffscreenCanvas | null {
  if (typeof OffscreenCanvas === 'undefined') return null;

  const { width, height } = layer.transform;
  const ceilWidth = Math.ceil(width);
  const ceilHeight = Math.ceil(height);

  if (ceilWidth <= 0 || ceilHeight <= 0) return null;

  const shadow = layer.shadow ?? { enabled: false, color: 'rgba(0, 0, 0, 0.5)', blur: 10, offsetX: 0, offsetY: 4 };
  const innerShadow = layer.innerShadow ?? { enabled: false, color: 'rgba(0, 0, 0, 0.5)', blur: 10, offsetX: 2, offsetY: 2 };
  const glow = layer.glow ?? { enabled: false, color: '#ffffff', blur: 20, intensity: 1 };

  const padding = Math.max(
    shadow.enabled ? shadow.blur + Math.abs(shadow.offsetX) + Math.abs(shadow.offsetY) : 0,
    glow.enabled ? glow.blur * (glow.intensity ?? 1) * 2 : 0
  );

  const offscreen = new OffscreenCanvas(ceilWidth + padding * 2, ceilHeight + padding * 2);
  const offCtx = offscreen.getContext('2d') as RenderContext | null;
  if (!offCtx) return null;

  offCtx.translate(padding, padding);

  if (glow.enabled && glow.blur > 0) {
    offCtx.save();
    offCtx.shadowColor = glow.color;
    offCtx.shadowBlur = glow.blur * (glow.intensity ?? 1);
    offCtx.shadowOffsetX = 0;
    offCtx.shadowOffsetY = 0;

    for (let i = 0; i < 3; i++) {
      renderLayerContentInternal(offCtx, layer, project);
    }
    offCtx.restore();
  }

  if (shadow.enabled) {
    offCtx.shadowColor = shadow.color;
    offCtx.shadowBlur = shadow.blur;
    offCtx.shadowOffsetX = shadow.offsetX;
    offCtx.shadowOffsetY = shadow.offsetY;
  }

  renderLayerContentInternal(offCtx, layer, project);

  offCtx.shadowColor = 'transparent';
  offCtx.shadowBlur = 0;
  offCtx.shadowOffsetX = 0;
  offCtx.shadowOffsetY = 0;

  if (innerShadow.enabled && innerShadow.blur > 0) {
    renderInnerShadowInternal(offCtx, layer, innerShadow);
  }

  return offscreen;
}

function renderLayer(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  project: { layers?: Record<string, Layer>; assets: Record<string, { dataUrl?: string; blobUrl?: string }> }
) {
  const { transform } = layer;
  const blendMode = layer.blendMode?.mode ?? 'normal';

  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.scale(transform.scaleX, transform.scaleY);

  const skewX = transform.skewX ?? 0;
  const skewY = transform.skewY ?? 0;
  if (skewX !== 0 || skewY !== 0) {
    ctx.transform(1, Math.tan(skewY * Math.PI / 180), Math.tan(skewX * Math.PI / 180), 1, 0, 0);
  }

  ctx.globalAlpha = transform.opacity;
  ctx.globalCompositeOperation = BLEND_MODE_MAP[blendMode] ?? 'source-over';

  // Phase 4: layer mask — composite the image through its mask. The mask's
  // LUMINANCE controls visibility (white reveals, black hides); `invert` flips
  // it. Isolated on a temp canvas so layers below are untouched. Works for
  // painted (buffer) and plain image layers.
  if (layer.type === 'image' && layer.mask?.enabled && (layer.mask.data || liveMaskPaint?.layerId === layer.id)) {
    const asset = project.assets[(layer as ImageLayer).sourceId];
    const content = rasterBuffers.get(layer.id) ?? getCachedImage(asset?.dataUrl ?? asset?.blobUrl ?? '');
    // Use the in-progress mask buffer during a mask stroke; else the saved mask.
    const liveMask = liveMaskPaint?.layerId === layer.id ? liveMaskPaint.maskCanvas : null;
    const maskSrc: CanvasImageSource | null = liveMask ?? getCachedImage(layer.mask.data ?? '');
    const maskReady = !!liveMask || (maskSrc instanceof HTMLImageElement && maskSrc.complete && maskSrc.naturalWidth > 0);
    if (maskSrc && maskReady && content) {
      const w = Math.max(1, Math.ceil(transform.width));
      const h = Math.max(1, Math.ceil(transform.height));
      const temp = new OffscreenCanvas(w, h);
      const tctx = temp.getContext('2d');
      if (tctx) {
        tctx.drawImage(content, 0, 0, w, h);
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(maskToAlphaCanvas(maskSrc, w, h, !!layer.mask.invert, layer.mask.density ?? 100), 0, 0);
        tctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(temp, 0, 0, transform.width, transform.height);
        ctx.restore();
        return;
      }
    }
  }

  // Phase 2: a painted image layer is rendered straight from its persistent
  // raster buffer (instant, no asset decode/reload, no per-stroke asset).
  const raster = layer.type === 'image' ? rasterBuffers.get(layer.id) : undefined;
  if (raster) {
    ctx.drawImage(raster, 0, 0, transform.width, transform.height);
    ctx.restore();
    return;
  }

  const cachedCanvas = getCachedLayerCanvas(layer, project);
  if (cachedCanvas) {
    const shadow = layer.shadow ?? { enabled: false, color: 'rgba(0, 0, 0, 0.5)', blur: 10, offsetX: 0, offsetY: 4 };
    const glow = layer.glow ?? { enabled: false, color: '#ffffff', blur: 20, intensity: 1 };
    const padding = Math.max(
      shadow.enabled ? shadow.blur + Math.abs(shadow.offsetX) + Math.abs(shadow.offsetY) : 0,
      glow.enabled ? glow.blur * (glow.intensity ?? 1) * 2 : 0
    );
    ctx.drawImage(cachedCanvas, -padding, -padding);
    ctx.restore();
    return;
  }

  const offscreen = renderLayerToOffscreen(layer, project);
  if (offscreen) {
    const hash = getLayerHash(layer, project.assets);
    setCachedLayerCanvas(layer.id, offscreen, hash, Math.ceil(transform.width), Math.ceil(transform.height));

    const shadow = layer.shadow ?? { enabled: false, color: 'rgba(0, 0, 0, 0.5)', blur: 10, offsetX: 0, offsetY: 4 };
    const glow = layer.glow ?? { enabled: false, color: '#ffffff', blur: 20, intensity: 1 };
    const padding = Math.max(
      shadow.enabled ? shadow.blur + Math.abs(shadow.offsetX) + Math.abs(shadow.offsetY) : 0,
      glow.enabled ? glow.blur * (glow.intensity ?? 1) * 2 : 0
    );
    ctx.drawImage(offscreen, -padding, -padding);
    ctx.restore();
    return;
  }

  const shadow = layer.shadow ?? { enabled: false, color: 'rgba(0, 0, 0, 0.5)', blur: 10, offsetX: 0, offsetY: 4 };
  const innerShadow = layer.innerShadow ?? { enabled: false, color: 'rgba(0, 0, 0, 0.5)', blur: 10, offsetX: 2, offsetY: 2 };
  const glow = layer.glow ?? { enabled: false, color: '#ffffff', blur: 20, intensity: 1 };

  if (glow.enabled && glow.blur > 0) {
    ctx.save();
    ctx.shadowColor = glow.color;
    ctx.shadowBlur = glow.blur * (glow.intensity ?? 1);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    for (let i = 0; i < 3; i++) {
      renderLayerContent(ctx, layer, project);
    }
    ctx.restore();
  }

  if (shadow.enabled) {
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur;
    ctx.shadowOffsetX = shadow.offsetX;
    ctx.shadowOffsetY = shadow.offsetY;
  }

  renderLayerContent(ctx, layer, project);

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  if (innerShadow.enabled && innerShadow.blur > 0) {
    renderInnerShadow(ctx, layer, innerShadow);
  }

  ctx.restore();
}

function renderLayerContent(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  project: { assets: Record<string, { dataUrl?: string; blobUrl?: string }> }
) {
  renderLayerContentInternal(ctx, layer, project);
}

function renderLayerContentInternal(
  ctx: RenderContext,
  layer: Layer,
  project: { assets: Record<string, { dataUrl?: string; blobUrl?: string }> }
) {
  switch (layer.type) {
    case 'image':
      renderImageLayerInternal(ctx, layer as ImageLayer, project);
      break;
    case 'text':
      renderTextLayerInternal(ctx, layer as TextLayer);
      break;
    case 'shape':
      renderShapeLayerInternal(ctx, layer as ShapeLayer);
      break;
  }
}

function renderInnerShadow(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  innerShadow: { color: string; blur: number; offsetX: number; offsetY: number }
) {
  renderInnerShadowInternal(ctx, layer, innerShadow);
}

function renderInnerShadowInternal(
  ctx: RenderContext,
  layer: Layer,
  innerShadow: { color: string; blur: number; offsetX: number; offsetY: number }
) {
  const { width, height } = layer.transform;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();

  ctx.shadowColor = innerShadow.color;
  ctx.shadowBlur = innerShadow.blur;
  ctx.shadowOffsetX = innerShadow.offsetX;
  ctx.shadowOffsetY = innerShadow.offsetY;

  ctx.fillStyle = 'rgba(0, 0, 0, 1)';
  ctx.globalCompositeOperation = 'source-atop';

  const spread = innerShadow.blur + Math.max(Math.abs(innerShadow.offsetX), Math.abs(innerShadow.offsetY)) + 50;

  ctx.beginPath();
  ctx.moveTo(-spread, -spread);
  ctx.lineTo(width + spread, -spread);
  ctx.lineTo(width + spread, height + spread);
  ctx.lineTo(-spread, height + spread);
  ctx.closePath();

  ctx.moveTo(0, 0);
  ctx.lineTo(0, height);
  ctx.lineTo(width, height);
  ctx.lineTo(width, 0);
  ctx.closePath();

  ctx.fill('evenodd');

  ctx.restore();
}

function applyMotionBlur(
  ctx: RenderContext,
  img: HTMLImageElement,
  width: number,
  height: number,
  amount: number,
  angle: number
) {
  const steps = Math.min(Math.ceil(amount / 2), 20);
  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians) * (amount / steps);
  const dy = Math.sin(radians) * (amount / steps);

  for (let i = -steps; i <= steps; i++) {
    const alpha = 1 / (Math.abs(i) + 1);
    ctx.globalAlpha = alpha / (steps * 2);
    ctx.drawImage(img, i * dx, i * dy, width, height);
  }
  ctx.globalAlpha = 1;
}

function applyRadialBlur(
  ctx: RenderContext,
  img: HTMLImageElement,
  width: number,
  height: number,
  amount: number
) {
  const steps = Math.min(Math.ceil(amount / 2), 15);
  const centerX = width / 2;
  const centerY = height / 2;

  for (let i = 0; i < steps; i++) {
    const scale = 1 + (i * amount) / (steps * 100);
    const alpha = 1 / (i + 1);
    ctx.globalAlpha = alpha / steps;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -centerY);
    ctx.drawImage(img, 0, 0, width, height);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawImageWithCrop(
  ctx: RenderContext,
  img: HTMLImageElement,
  layerWidth: number,
  layerHeight: number,
  cropRect: { x: number; y: number; width: number; height: number } | null
) {
  if (!cropRect) {
    ctx.drawImage(img, 0, 0, layerWidth, layerHeight);
    return;
  }

  ctx.drawImage(img, cropRect.x, cropRect.y, cropRect.width, cropRect.height, 0, 0, layerWidth, layerHeight);
}

function renderImageLayerInternal(
  ctx: RenderContext,
  layer: ImageLayer,
  project: { assets: Record<string, { dataUrl?: string; blobUrl?: string }> }
) {
  const asset = project.assets[layer.sourceId];
  if (!asset) {
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(0, 0, layer.transform.width, layer.transform.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Image', layer.transform.width / 2, layer.transform.height / 2);
    return;
  }

  const src = asset.dataUrl ?? asset.blobUrl ?? '';
  const img = getCachedImage(src);

  if (!img) {
    ctx.fillStyle = '#27272a';
    ctx.fillRect(0, 0, layer.transform.width, layer.transform.height);
    ctx.fillStyle = '#71717a';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading...', layer.transform.width / 2, layer.transform.height / 2);
    return;
  }

  const flipH = layer.flipHorizontal ?? false;
  const flipV = layer.flipVertical ?? false;
  const { cropRect } = layer;

  const adjustments: LayerAdjustments = {
    levels: layer.levels,
    curves: layer.curves,
    colorBalance: layer.colorBalance,
    selectiveColor: layer.selectiveColor,
    blackWhite: layer.blackWhite,
    photoFilter: layer.photoFilter,
    channelMixer: layer.channelMixer,
    gradientMap: layer.gradientMap,
    posterize: layer.posterize,
    threshold: layer.threshold,
  };

  const needsAdjustments = hasActiveAdjustments(adjustments);

  if (flipH || flipV) {
    ctx.save();
    ctx.translate(
      flipH ? layer.transform.width : 0,
      flipV ? layer.transform.height : 0
    );
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  }

  const { filters } = layer;
  const filterParts: string[] = [];

  let effectiveBrightness = filters.brightness;
  if (filters.exposure !== 0) {
    effectiveBrightness = effectiveBrightness * (1 + filters.exposure / 100);
  }
  if (filters.highlights > 0) {
    effectiveBrightness = effectiveBrightness * (1 + filters.highlights / 200);
  }
  if (filters.shadows > 0) {
    effectiveBrightness = effectiveBrightness * (1 + filters.shadows / 300);
  }
  if (effectiveBrightness !== 100) {
    filterParts.push(`brightness(${Math.round(effectiveBrightness)}%)`);
  }

  let effectiveContrast = filters.contrast;
  if (filters.clarity !== 0) {
    effectiveContrast = effectiveContrast * (1 + filters.clarity / 150);
  }
  if (filters.highlights < 0) {
    effectiveContrast = effectiveContrast * (1 + filters.highlights / 400);
  }
  if (filters.shadows < 0) {
    effectiveContrast = effectiveContrast * (1 + filters.shadows / 400);
  }
  if (effectiveContrast !== 100) {
    filterParts.push(`contrast(${Math.round(effectiveContrast)}%)`);
  }

  let effectiveSaturation = filters.saturation;
  if (filters.vibrance !== 0) {
    effectiveSaturation = effectiveSaturation * (1 + filters.vibrance / 150);
  }
  if (effectiveSaturation !== 100) {
    filterParts.push(`saturate(${Math.round(effectiveSaturation)}%)`);
  }

  if (filters.hue !== 0) {
    filterParts.push(`hue-rotate(${filters.hue}deg)`);
  }
  if (filters.sepia > 0) {
    filterParts.push(`sepia(${filters.sepia}%)`);
  }
  if (filters.invert > 0) {
    filterParts.push(`invert(${filters.invert}%)`);
  }

  if (filters.blur > 0 && filters.blurType === 'gaussian') {
    filterParts.push(`blur(${filters.blur}px)`);
  }

  const width = Math.ceil(layer.transform.width);
  const height = Math.ceil(layer.transform.height);

  if (needsAdjustments && typeof OffscreenCanvas !== 'undefined' && width > 0 && height > 0) {
    const tempCanvas = new OffscreenCanvas(width, height);
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) {
      if (filterParts.length > 0) {
        tempCtx.filter = filterParts.join(' ');
      }

      if (filters.blur > 0 && filters.blurType === 'motion') {
        applyMotionBlur(tempCtx, img, width, height, filters.blur, filters.blurAngle);
      } else if (filters.blur > 0 && filters.blurType === 'radial') {
        applyRadialBlur(tempCtx, img, width, height, filters.blur);
      } else {
        drawImageWithCrop(tempCtx, img, width, height, cropRect);
      }

      tempCtx.filter = 'none';

      let imageData = tempCtx.getImageData(0, 0, width, height);
      imageData = applyAllAdjustments(imageData, adjustments);
      tempCtx.putImageData(imageData, 0, 0);

      ctx.drawImage(tempCanvas, 0, 0, layer.transform.width, layer.transform.height);
    }
  } else {
    if (filterParts.length > 0) {
      ctx.filter = filterParts.join(' ');
    }

    if (filters.blur > 0 && filters.blurType === 'motion') {
      applyMotionBlur(ctx, img, layer.transform.width, layer.transform.height, filters.blur, filters.blurAngle);
    } else if (filters.blur > 0 && filters.blurType === 'radial') {
      applyRadialBlur(ctx, img, layer.transform.width, layer.transform.height, filters.blur);
    } else {
      drawImageWithCrop(ctx, img, layer.transform.width, layer.transform.height, cropRect);
    }

    ctx.filter = 'none';
  }

  if (flipH || flipV) {
    ctx.restore();
  }
}

function renderTextLayerInternal(ctx: RenderContext, layer: TextLayer) {
  const { style, content, transform } = layer;
  const flipH = layer.flipHorizontal ?? false;
  const flipV = layer.flipVertical ?? false;

  if (flipH || flipV) {
    ctx.save();
    ctx.translate(
      flipH ? transform.width : 0,
      flipV ? transform.height : 0
    );
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  }

  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  ctx.textAlign = style.textAlign as CanvasTextAlign;
  ctx.textBaseline = 'top';

  const lines = content.split('\n');
  const lineHeight = style.fontSize * style.lineHeight;

  let textX = 0;
  if (style.textAlign === 'center') textX = transform.width / 2;
  else if (style.textAlign === 'right') textX = transform.width;

  if (style.backgroundColor) {
    const padding = style.backgroundPadding ?? 8;
    const radius = style.backgroundRadius ?? 4;
    const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const textHeight = lines.length * lineHeight;

    let bgX = -padding;
    if (style.textAlign === 'center') bgX = (transform.width - textWidth) / 2 - padding;
    else if (style.textAlign === 'right') bgX = transform.width - textWidth - padding;

    ctx.fillStyle = style.backgroundColor;
    ctx.beginPath();
    const bgW = textWidth + padding * 2;
    const bgH = textHeight + padding * 2;
    const bgY = -padding;
    const r = Math.min(radius, bgW / 2, bgH / 2);
    ctx.moveTo(bgX + r, bgY);
    ctx.lineTo(bgX + bgW - r, bgY);
    ctx.quadraticCurveTo(bgX + bgW, bgY, bgX + bgW, bgY + r);
    ctx.lineTo(bgX + bgW, bgY + bgH - r);
    ctx.quadraticCurveTo(bgX + bgW, bgY + bgH, bgX + bgW - r, bgY + bgH);
    ctx.lineTo(bgX + r, bgY + bgH);
    ctx.quadraticCurveTo(bgX, bgY + bgH, bgX, bgY + bgH - r);
    ctx.lineTo(bgX, bgY + r);
    ctx.quadraticCurveTo(bgX, bgY, bgX + r, bgY);
    ctx.closePath();
    ctx.fill();
  }

  let fillStyle: string | CanvasGradient = style.color;
  if (style.fillType === 'gradient' && style.gradient && lines.length > 0) {
    const lineWidths = lines.map((line) => ctx.measureText(line).width);
    const textWidth = lineWidths.length > 0 ? Math.max(...lineWidths) : 0;
    const textHeight = lines.length * lineHeight;

    if (textWidth > 0 && textHeight > 0) {
      let gradientStartX = 0;
      if (style.textAlign === 'center') gradientStartX = (transform.width - textWidth) / 2;
      else if (style.textAlign === 'right') gradientStartX = transform.width - textWidth;

      if (style.gradient.type === 'linear') {
        const angleRad = (style.gradient.angle * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        const halfWidth = textWidth / 2;
        const halfHeight = textHeight / 2;
        const len = Math.abs(halfWidth * cos) + Math.abs(halfHeight * sin);

        const centerX = gradientStartX + halfWidth;
        const centerY = halfHeight;
        const gradient = ctx.createLinearGradient(
          centerX - len * cos,
          centerY - len * sin,
          centerX + len * cos,
          centerY + len * sin
        );
        style.gradient.stops.forEach((stop) => {
          gradient.addColorStop(stop.offset, stop.color);
        });
        fillStyle = gradient;
      } else {
        const centerX = gradientStartX + textWidth / 2;
        const centerY = textHeight / 2;
        const radius = Math.max(textWidth, textHeight) / 2;
        const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
        style.gradient.stops.forEach((stop) => {
          gradient.addColorStop(stop.offset, stop.color);
        });
        fillStyle = gradient;
      }
    }
  }

  const textShadow = style.textShadow;
  if (textShadow?.enabled) {
    ctx.shadowColor = textShadow.color ?? 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = textShadow.blur ?? 4;
    ctx.shadowOffsetX = textShadow.offsetX ?? 0;
    ctx.shadowOffsetY = textShadow.offsetY ?? 2;
  }

  lines.forEach((line, i) => {
    const y = i * lineHeight;

    if (style.strokeColor && (style.strokeWidth ?? 0) > 0) {
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = style.strokeWidth ?? 1;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeText(line, textX, y);
    }

    ctx.fillStyle = fillStyle;
    ctx.fillText(line, textX, y);
  });

  if (textShadow?.enabled) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  if (flipH || flipV) {
    ctx.restore();
  }
}

function renderShapeLayerInternal(ctx: RenderContext, layer: ShapeLayer) {
  const { shapeType, shapeStyle, transform } = layer;
  const { width, height } = transform;
  const flipH = layer.flipHorizontal ?? false;
  const flipV = layer.flipVertical ?? false;

  if (flipH || flipV) {
    ctx.save();
    ctx.translate(
      flipH ? width : 0,
      flipV ? height : 0
    );
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  }

  ctx.beginPath();

  switch (shapeType) {
    case 'rectangle': {
      let tl = 0, tr = 0, br = 0, bl = 0;

      if (shapeStyle.individualCorners && shapeStyle.corners) {
        tl = Math.min(shapeStyle.corners.topLeft, width / 2, height / 2);
        tr = Math.min(shapeStyle.corners.topRight, width / 2, height / 2);
        br = Math.min(shapeStyle.corners.bottomRight, width / 2, height / 2);
        bl = Math.min(shapeStyle.corners.bottomLeft, width / 2, height / 2);
      } else if (shapeStyle.cornerRadius > 0) {
        const r = Math.min(shapeStyle.cornerRadius, width / 2, height / 2);
        tl = tr = br = bl = r;
      }

      if (tl > 0 || tr > 0 || br > 0 || bl > 0) {
        ctx.moveTo(tl, 0);
        ctx.lineTo(width - tr, 0);
        if (tr > 0) ctx.quadraticCurveTo(width, 0, width, tr);
        else ctx.lineTo(width, 0);
        ctx.lineTo(width, height - br);
        if (br > 0) ctx.quadraticCurveTo(width, height, width - br, height);
        else ctx.lineTo(width, height);
        ctx.lineTo(bl, height);
        if (bl > 0) ctx.quadraticCurveTo(0, height, 0, height - bl);
        else ctx.lineTo(0, height);
        ctx.lineTo(0, tl);
        if (tl > 0) ctx.quadraticCurveTo(0, 0, tl, 0);
        else ctx.lineTo(0, 0);
        ctx.closePath();
      } else {
        ctx.rect(0, 0, width, height);
      }
      break;
    }

    case 'ellipse':
      ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      break;

    case 'triangle':
      ctx.moveTo(width / 2, 0);
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      break;

    case 'polygon': {
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) / 2;
      const sides = layer.sides ?? 6;
      for (let i = 0; i < sides; i++) {
        const angle = (i * 2 * Math.PI) / sides - Math.PI / 2;
        const px = cx + radius * Math.cos(angle);
        const py = cy + radius * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }

    case 'star': {
      const cx = width / 2;
      const cy = height / 2;
      const outerRadius = Math.min(width, height) / 2;
      const innerRatio = layer.innerRadius ?? 0.4;
      const innerRadius = outerRadius * innerRatio;
      const points = layer.sides ?? 5;
      for (let i = 0; i < points * 2; i++) {
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = (i * Math.PI) / points - Math.PI / 2;
        const px = cx + radius * Math.cos(angle);
        const py = cy + radius * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }

    case 'line':
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      break;

    case 'arrow': {
      const arrowHeadSize = Math.min(width, height) * 0.3;
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width - arrowHeadSize, height / 2);
      ctx.moveTo(width, height / 2);
      ctx.lineTo(width - arrowHeadSize, height / 2 - arrowHeadSize / 2);
      ctx.moveTo(width, height / 2);
      ctx.lineTo(width - arrowHeadSize, height / 2 + arrowHeadSize / 2);
      break;
    }

    case 'path':
      if (layer.points && layer.points.length > 1) {
        ctx.moveTo(layer.points[0].x, layer.points[0].y);
        for (let i = 1; i < layer.points.length; i++) {
          ctx.lineTo(layer.points[i].x, layer.points[i].y);
        }
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }
      break;

    default:
      ctx.rect(0, 0, width, height);
  }

  const fillType = shapeStyle.fillType ?? 'solid';
  const hasFill = fillType === 'solid' ? !!shapeStyle.fill : fillType === 'gradient' ? !!shapeStyle.gradient : fillType === 'noise' ? !!shapeStyle.noise : false;

  if (hasFill) {
    ctx.globalAlpha *= shapeStyle.fillOpacity;

    if (fillType === 'noise' && shapeStyle.noise) {
      ctx.fillStyle = shapeStyle.noise.baseColor;
      ctx.fill();

      ctx.save();
      ctx.clip();

      const { noise } = shapeStyle;
      const noiseSize = noise.size;
      const density = noise.density;

      ctx.fillStyle = noise.noiseColor;
      for (let y = 0; y < height; y += noiseSize) {
        for (let x = 0; x < width; x += noiseSize) {
          if (Math.random() < density) {
            ctx.fillRect(x, y, noiseSize, noiseSize);
          }
        }
      }

      ctx.restore();
    } else if (fillType === 'gradient' && shapeStyle.gradient) {
      let gradient: CanvasGradient;
      if (shapeStyle.gradient.type === 'linear') {
        const angleRad = (shapeStyle.gradient.angle * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        const halfW = width / 2;
        const halfH = height / 2;
        const len = Math.abs(halfW * cos) + Math.abs(halfH * sin);
        gradient = ctx.createLinearGradient(
          halfW - len * cos,
          halfH - len * sin,
          halfW + len * cos,
          halfH + len * sin
        );
      } else {
        const radius = Math.max(width, height) / 2;
        gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, radius);
      }
      shapeStyle.gradient.stops.forEach((stop) => {
        gradient.addColorStop(stop.offset, stop.color);
      });
      ctx.fillStyle = gradient;
      ctx.fill();
    } else if (shapeStyle.fill) {
      ctx.fillStyle = shapeStyle.fill;
      ctx.fill();
    }

    ctx.globalAlpha /= shapeStyle.fillOpacity;
  }

  if (shapeStyle.stroke) {
    ctx.strokeStyle = shapeStyle.stroke;
    ctx.lineWidth = shapeStyle.strokeWidth;
    ctx.globalAlpha *= shapeStyle.strokeOpacity;

    const sw = shapeStyle.strokeWidth;
    switch (shapeStyle.strokeDash ?? 'solid') {
      case 'dashed':
        ctx.setLineDash([sw * 3, sw * 2]);
        break;
      case 'dotted':
        ctx.setLineDash([sw, sw * 2]);
        ctx.lineCap = 'round';
        break;
      case 'dash-dot':
        ctx.setLineDash([sw * 4, sw * 2, sw, sw * 2]);
        break;
      case 'long-dash':
        ctx.setLineDash([sw * 6, sw * 3]);
        break;
      default:
        ctx.setLineDash([]);
    }

    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (flipH || flipV) {
    ctx.restore();
  }
}
