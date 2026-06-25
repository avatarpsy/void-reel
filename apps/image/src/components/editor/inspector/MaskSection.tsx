import { useProjectStore } from '../../../stores/project-store';
import { useSelectionStore } from '../../../stores/selection-store';
import type { Layer } from '../../../types/project';
import { buildMaskData } from '../../../utils/mask-builder';
import {
  Circle,
  Eye,
  EyeOff,
  Unlink,
  Trash2,
  RotateCcw,
  Plus,
  Download,
} from 'lucide-react';

interface Props {
  layer: Layer;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

function Slider({ label, value, min, max, step = 1, onChange }: SliderProps) {
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">{label}</span>
        <span className="text-[10px] font-mono text-muted-foreground">
          {value.toFixed(step < 1 ? 0 : 0)}
          {label === 'Density' || label === 'Feather' ? '%' : 'px'}
        </span>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 appearance-none bg-secondary rounded-full cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:w-2.5
          [&::-webkit-slider-thumb]:h-2.5
          [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-primary
          [&::-webkit-slider-thumb]:shadow-sm
          [&::-webkit-slider-thumb]:cursor-pointer"
        style={{
          background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${percentage}%, hsl(var(--secondary)) ${percentage}%, hsl(var(--secondary)) 100%)`,
        }}
      />
    </div>
  );
}

export function MaskSection({ layer }: Props) {
  const { updateLayer, addAsset, addImageLayer } = useProjectStore();
  const { active: selection, clearSelection } = useSelectionStore();

  const mask = layer.mask;
  const hasMask = mask !== null;
  const hasSelection = selection !== null;

  const handleAddMask = async (reveal: boolean) => {
    const data = await buildMaskData(layer, selection, reveal);
    updateLayer(layer.id, {
      mask: {
        id: `mask-${Date.now()}`,
        type: 'pixel',
        enabled: true,
        linked: true,
        density: 100,
        feather: 0,
        // With a selection: reveal => show inside, hide => show outside (invert).
        invert: selection ? !reveal : false,
        data,
        vectorPath: selection ? [...selection.path] : null,
      },
    });
    if (selection) clearSelection();
  };

  const handleLoadSelection = async () => {
    if (!mask || !selection) return;
    const data = await buildMaskData(layer, selection, true);
    updateLayer(layer.id, { mask: { ...mask, data, invert: false } });
    clearSelection();
  };

  const handleDeleteMask = () => {
    updateLayer(layer.id, { mask: null });
  };

  const handleToggleMaskEnabled = () => {
    if (!mask) return;
    updateLayer(layer.id, {
      mask: { ...mask, enabled: !mask.enabled },
    });
  };

  // "Separate mask to layer": pop the mask off this layer and drop its bitmap
  // onto a new image layer (named "<layer> Mask") at the same position — the
  // mask becomes an ordinary, editable layer. Reuses addAsset + addImageLayer +
  // updateLayer; no re-link (keep it simple).
  const handleSeparateMask = () => {
    if (!mask?.data) return;
    const t = layer.transform;
    const w = Math.max(1, Math.round(t.width));
    const h = Math.max(1, Math.round(t.height));
    const assetId = `mask-layer-${Date.now()}`;
    addAsset({
      id: assetId,
      name: `${layer.name} Mask`,
      type: 'image',
      mimeType: 'image/png',
      size: mask.data.length,
      width: w,
      height: h,
      thumbnailUrl: mask.data,
      dataUrl: mask.data,
    });
    addImageLayer(assetId, { x: t.x, y: t.y, width: t.width, height: t.height });
    updateLayer(layer.id, { mask: null });
  };

  const handleToggleMaskInvert = () => {
    if (!mask) return;
    updateLayer(layer.id, {
      mask: { ...mask, invert: !mask.invert },
    });
  };

  const handleDensityChange = (density: number) => {
    if (!mask) return;
    updateLayer(layer.id, {
      mask: { ...mask, density },
    });
  };

  const handleFeatherChange = (feather: number) => {
    if (!mask) return;
    updateLayer(layer.id, {
      mask: { ...mask, feather },
    });
  };

  const handleToggleClippingMask = () => {
    updateLayer(layer.id, { clippingMask: !layer.clippingMask });
  };

  return (
    <div className="border-b border-border">
      <div className="px-3 py-2">
        <span className="text-xs font-medium">Masks</span>
      </div>

      <div className="px-3 pb-3 space-y-3">
        {!hasMask ? (
          <div className="space-y-2">
            <p className="text-[10px] text-muted-foreground">
              {hasSelection
                ? 'Create mask from current selection'
                : 'Add a mask to control layer visibility'}
            </p>

            <div className="flex gap-1.5">
              <button
                onClick={() => handleAddMask(true)}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] rounded bg-secondary hover:bg-secondary/80 transition-colors"
              >
                <Plus size={10} />
                Reveal All
              </button>
              <button
                onClick={() => handleAddMask(false)}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] rounded bg-secondary hover:bg-secondary/80 transition-colors"
              >
                <Plus size={10} />
                Hide All
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-2 rounded bg-secondary/50">
              <div className="w-8 h-8 rounded bg-gradient-to-br from-white to-black border border-border" />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-medium truncate">
                  {mask.type === 'pixel' ? 'Pixel Mask' : 'Vector Mask'}
                </p>
                <p className="text-[9px] text-muted-foreground">
                  {mask.enabled ? 'Enabled' : 'Disabled'}
                  {mask.invert ? ' • Inverted' : ''}
                </p>
              </div>
            </div>

            <div className="flex gap-1">
              <button
                onClick={handleToggleMaskEnabled}
                className={`flex-1 p-1.5 rounded transition-colors ${
                  mask.enabled
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                }`}
                title={mask.enabled ? 'Disable Mask' : 'Enable Mask'}
              >
                {mask.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
              <button
                onClick={handleSeparateMask}
                className="flex-1 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                title="Separate mask into its own layer"
              >
                <Unlink size={12} />
              </button>
              <button
                onClick={handleToggleMaskInvert}
                className={`flex-1 p-1.5 rounded transition-colors ${
                  mask.invert
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                }`}
                title={mask.invert ? 'Remove Invert' : 'Invert Mask'}
              >
                <RotateCcw size={12} />
              </button>
              <button
                onClick={handleDeleteMask}
                className="flex-1 p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                title="Delete Mask"
              >
                <Trash2 size={12} />
              </button>
            </div>

            <Slider
              label="Density"
              value={mask.density}
              min={0}
              max={100}
              onChange={handleDensityChange}
            />

            <Slider
              label="Feather"
              value={mask.feather}
              min={0}
              max={250}
              onChange={handleFeatherChange}
            />

          </div>
        )}

        <div className="pt-2 border-t border-border">
          <button
            onClick={handleToggleClippingMask}
            className={`w-full flex items-center gap-2 px-2 py-1.5 text-[10px] rounded transition-colors ${
              layer.clippingMask
                ? 'bg-primary/10 text-primary'
                : 'bg-secondary hover:bg-secondary/80'
            }`}
          >
            <Circle size={10} className={layer.clippingMask ? 'fill-primary' : ''} />
            <span>{layer.clippingMask ? 'Release Clipping Mask' : 'Create Clipping Mask'}</span>
          </button>
        </div>

        {hasMask && hasSelection && (
          <div className="flex gap-1.5">
            <button
              onClick={handleLoadSelection}
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] rounded bg-secondary hover:bg-secondary/80 transition-colors"
              title="Replace this mask with the current selection"
            >
              <Download size={10} />
              Mask from Selection
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
