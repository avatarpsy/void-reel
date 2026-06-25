export type SelectionType =
  | 'rectangular'
  | 'elliptical'
  | 'lasso'
  | 'polygonal'
  | 'magic-wand'
  | 'color-range';

export type SelectionMode = 'new' | 'add' | 'subtract' | 'intersect';

export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Selection {
  id: string;
  type: SelectionType;
  bounds: SelectionBounds;
  path: { x: number; y: number }[];
  feather: number;
  antiAlias: boolean;
  opacity: number;
  /** When true the active region is the canvas MINUS this shape (Select →
   *  Inverse, ⌘⇧I). `canvasBounds` is the outer rectangle to subtract from. */
  inverted?: boolean;
  canvasBounds?: SelectionBounds;
}

export interface MagicWandOptions {
  tolerance: number;
  contiguous: boolean;
  sampleAllLayers: boolean;
}

export interface ColorRangeOptions {
  fuzziness: number;
  range: 'sampled' | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'highlights' | 'midtones' | 'shadows';
  invert: boolean;
}

export interface SelectionState {
  active: Selection | null;
  saved: Selection[];
  mode: SelectionMode;
  isSelecting: boolean;
  marching: boolean;
  magicWandOptions: MagicWandOptions;
  colorRangeOptions: ColorRangeOptions;
  tempPath: { x: number; y: number }[];
  startPoint: { x: number; y: number } | null;
}

export const DEFAULT_MAGIC_WAND_OPTIONS: MagicWandOptions = {
  tolerance: 32,
  contiguous: true,
  sampleAllLayers: false,
};

export const DEFAULT_COLOR_RANGE_OPTIONS: ColorRangeOptions = {
  fuzziness: 40,
  range: 'sampled',
  invert: false,
};

export function createEmptySelection(): Selection {
  return {
    id: '',
    type: 'rectangular',
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    path: [],
    feather: 0,
    antiAlias: true,
    opacity: 1,
  };
}

export function selectionToPath2D(selection: Selection): Path2D {
  const path = new Path2D();

  // Inverted selection: the region is the whole canvas with the shape cut out.
  // Add the canvas rectangle as an outer subpath; the shape below becomes a
  // hole under the even-odd fill rule, and stroking draws marching ants on both
  // the canvas border and the shape (no bridging seam).
  if (selection.inverted && selection.canvasBounds) {
    const cb = selection.canvasBounds;
    path.rect(cb.x, cb.y, cb.width, cb.height);
  }

  if (selection.type === 'rectangular') {
    path.rect(
      selection.bounds.x,
      selection.bounds.y,
      selection.bounds.width,
      selection.bounds.height
    );
  } else if (selection.type === 'elliptical') {
    const cx = selection.bounds.x + selection.bounds.width / 2;
    const cy = selection.bounds.y + selection.bounds.height / 2;
    const rx = selection.bounds.width / 2;
    const ry = selection.bounds.height / 2;
    path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  } else if (selection.path.length > 0) {
    path.moveTo(selection.path[0].x, selection.path[0].y);
    for (let i = 1; i < selection.path.length; i++) {
      path.lineTo(selection.path[i].x, selection.path[i].y);
    }
    path.closePath();
  }

  return path;
}

export function boundsFromPath(points: { x: number; y: number }[]): SelectionBounds {
  if (points.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function isPointInSelection(
  x: number,
  y: number,
  selection: Selection,
  ctx?: CanvasRenderingContext2D
): boolean {
  if (!ctx) return false;

  const path = selectionToPath2D(selection);
  return ctx.isPointInPath(path, x, y);
}

export function combineSelections(
  existing: Selection,
  newSelection: Selection,
  mode: SelectionMode
): Selection {
  if (mode === 'new') {
    return newSelection;
  }

  const combined: Selection = {
    ...newSelection,
    id: existing.id || newSelection.id,
  };

  if (mode === 'add') {
    combined.path = [...existing.path, ...newSelection.path];
    combined.bounds = boundsFromPath(combined.path);
  } else if (mode === 'subtract') {
    combined.path = existing.path;
    combined.bounds = existing.bounds;
  } else if (mode === 'intersect') {
    combined.path = existing.path;
    combined.bounds = existing.bounds;
  }

  return combined;
}

export function getSelectionMask(
  selection: Selection,
  width: number,
  height: number
): ImageData {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = 'white';
  const path = selectionToPath2D(selection);
  // even-odd so an inverted selection's shape is cut out of the canvas rect.
  ctx.fill(path, 'evenodd');

  if (selection.feather > 0) {
    ctx.filter = `blur(${selection.feather}px)`;
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = 'none';
  }

  return ctx.getImageData(0, 0, width, height);
}
