import { useProjectStore } from '../../../stores/project-store';
import type { Layer, BlendMode } from '../../../types/project';

interface Props {
  layer: Layer;
}

// Photoshop groups its blend modes; we list the 16 the canvas compositor
// supports natively, grouped the same way (separators between groups).
const BLEND_MODE_GROUPS: { label: string; modes: BlendMode['mode'][] }[] = [
  { label: 'Normal', modes: ['normal'] },
  { label: 'Darken', modes: ['darken', 'multiply', 'color-burn'] },
  { label: 'Lighten', modes: ['lighten', 'screen', 'color-dodge'] },
  { label: 'Contrast', modes: ['overlay', 'soft-light', 'hard-light'] },
  { label: 'Comparative', modes: ['difference', 'exclusion'] },
  { label: 'Component', modes: ['hue', 'saturation', 'color', 'luminosity'] },
];

export function AppearanceSection({ layer }: Props) {
  const { updateLayer } = useProjectStore();

  const handleBlendModeChange = (mode: BlendMode['mode']) => {
    updateLayer(layer.id, { blendMode: { mode } });
  };

  const handleShadowToggle = () => {
    updateLayer(layer.id, {
      shadow: { ...layer.shadow, enabled: !layer.shadow.enabled },
    });
  };

  const handleShadowChange = (key: string, value: string | number) => {
    updateLayer(layer.id, {
      shadow: { ...layer.shadow, [key]: value },
    });
  };

  const handleStrokeToggle = () => {
    updateLayer(layer.id, {
      stroke: { ...layer.stroke, enabled: !layer.stroke.enabled },
    });
  };

  const handleStrokeChange = (key: string, value: string | number) => {
    updateLayer(layer.id, {
      stroke: { ...layer.stroke, [key]: value },
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-[10px] text-muted-foreground mb-1">Blend Mode</label>
        <select
          value={layer.blendMode.mode}
          onChange={(e) => handleBlendModeChange(e.target.value as BlendMode['mode'])}
          className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary capitalize"
        >
          {BLEND_MODE_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.modes.map((mode) => (
                <option key={mode} value={mode} className="capitalize">
                  {mode.replace('-', ' ')}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] text-muted-foreground">Drop Shadow</label>
          <button
            onClick={handleShadowToggle}
            className={`w-8 h-5 rounded-full transition-colors ${
              layer.shadow.enabled ? 'bg-primary' : 'bg-secondary'
            }`}
          >
            <div
              className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${
                layer.shadow.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {layer.shadow.enabled && (
          <div className="pl-2 border-l-2 border-border space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-muted-foreground w-12">Color</label>
              <input
                type="color"
                value={layer.shadow.color.replace(/rgba?\([^)]+\)/, '#000000')}
                onChange={(e) => handleShadowChange('color', e.target.value)}
                className="w-6 h-6 rounded border border-input cursor-pointer"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-muted-foreground w-12">Blur</label>
              <input
                type="range"
                value={layer.shadow.blur}
                onChange={(e) => handleShadowChange('blur', Number(e.target.value))}
                min={0}
                max={50}
                className="flex-1 h-1 accent-primary"
              />
              <span className="text-[10px] text-muted-foreground w-6 text-right">
                {layer.shadow.blur}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-muted-foreground w-12">X</label>
              <input
                type="number"
                value={layer.shadow.offsetX}
                onChange={(e) => handleShadowChange('offsetX', Number(e.target.value))}
                className="w-16 px-2 py-1 text-xs bg-background border border-input rounded-md"
              />
              <label className="text-[10px] text-muted-foreground w-4">Y</label>
              <input
                type="number"
                value={layer.shadow.offsetY}
                onChange={(e) => handleShadowChange('offsetY', Number(e.target.value))}
                className="w-16 px-2 py-1 text-xs bg-background border border-input rounded-md"
              />
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] text-muted-foreground">Stroke</label>
          <button
            onClick={handleStrokeToggle}
            className={`w-8 h-5 rounded-full transition-colors ${
              layer.stroke.enabled ? 'bg-primary' : 'bg-secondary'
            }`}
          >
            <div
              className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${
                layer.stroke.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {layer.stroke.enabled && (
          <div className="pl-2 border-l-2 border-border space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-muted-foreground w-12">Color</label>
              <input
                type="color"
                value={layer.stroke.color}
                onChange={(e) => handleStrokeChange('color', e.target.value)}
                className="w-6 h-6 rounded border border-input cursor-pointer"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-muted-foreground w-12">Width</label>
              <input
                type="range"
                value={layer.stroke.width}
                onChange={(e) => handleStrokeChange('width', Number(e.target.value))}
                min={1}
                max={20}
                className="flex-1 h-1 accent-primary"
              />
              <span className="text-[10px] text-muted-foreground w-6 text-right">
                {layer.stroke.width}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
