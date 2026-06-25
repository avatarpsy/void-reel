import { useState, useRef, useEffect } from 'react';
import { Eye, EyeOff, Lock, Unlock, Trash2, Copy, ChevronUp, ChevronDown, ChevronRight, CornerDownRight, ArrowUp, ArrowDown, ArrowUpToLine, ArrowDownToLine, Clipboard, ClipboardCopy, Scissors, Paintbrush, Search, X, Image, Type, Hexagon, Folder, FolderPlus, FolderOpen, ChevronsDown, SquareStack } from 'lucide-react';
import { useProjectStore } from '../../../stores/project-store';
import { useSelectionStore } from '../../../stores/selection-store';
import { useUIStore } from '../../../stores/ui-store';
import { buildMaskData } from '../../../utils/mask-builder';
import type { Layer, LayerType, ImageLayer, GroupLayer } from '../../../types/project';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuCheckboxItem,
  Slider,
} from '@openreel/ui';

type FilterType = 'all' | LayerType;

const LAYER_TYPE_ICONS: Record<LayerType, React.ReactNode> = {
  image: <Image size={12} />,
  text: <Type size={12} />,
  shape: <Hexagon size={12} />,
  group: <Folder size={12} />,
  'smart-object': <FolderOpen size={12} />,
};

export function LayerPanel() {
  const {
    project,
    selectedLayerIds,
    selectedArtboardId,
    copiedStyle,
    selectLayer,
    selectLayers,
    updateLayer,
    updateLayerTransform,
    removeLayer,
    duplicateLayer,
    moveLayerUp,
    moveLayerDown,
    moveLayerToTop,
    moveLayerToBottom,
    copyLayers,
    cutLayers,
    pasteLayers,
    copyLayerStyle,
    pasteLayerStyle,
    groupLayers,
    ungroupLayers,
    mergeDown,
    reorderLayers,
  } = useProjectStore();
  const activeSelection = useSelectionStore((s) => s.active);
  const clearSelection = useSelectionStore((s) => s.clearSelection);
  const maskEditLayerId = useUIStore((s) => s.maskEditLayerId);
  const setMaskEditLayerId = useUIStore((s) => s.setMaskEditLayerId);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  // Drag-to-reorder. The ref is the source of truth for handlers (state can lag
  // between rapid drag events); the state just drives the visual feedback.
  const [dragId, setDragId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const [dropInfo, setDropInfo] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);

  const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);
  const allLayers = artboard?.layerIds.map((id) => project?.layers[id]).filter(Boolean) as Layer[] ?? [];

  const layers = allLayers.filter((layer) => {
    const matchesSearch = searchQuery === '' || layer.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = filterType === 'all' || layer.type === filterType;
    return matchesSearch && matchesType;
  });

  // Flatten the layer tree into depth-tagged rows so groups render NESTED
  // (children indented under their group, respecting `expanded`). When a search
  // or type filter is active we fall back to the flat filtered list.
  const filterActive = searchQuery.trim() !== '' || filterType !== 'all';
  const buildTree = (ids: string[], depth: number, out: { layer: Layer; depth: number }[]) => {
    for (const id of ids) {
      const l = project?.layers[id];
      if (!l) continue;
      out.push({ layer: l, depth });
      if (l.type === 'group' && (l as GroupLayer).expanded) {
        buildTree((l as GroupLayer).childIds, depth + 1, out);
      }
    }
    return out;
  };
  const entries = filterActive
    ? layers.map((l) => ({ layer: l, depth: 0 }))
    : buildTree(artboard?.layerIds ?? [], 0, []);

  const handleSelectAllByType = (type: LayerType) => {
    const layerIds = allLayers.filter((l) => l.type === type).map((l) => l.id);
    if (layerIds.length > 0) {
      selectLayers(layerIds);
    }
  };

  const handleStartRename = (layer: Layer) => {
    setEditingLayerId(layer.id);
    setEditingName(layer.name);
  };

  const handleFinishRename = () => {
    if (editingLayerId && editingName.trim()) {
      updateLayer(editingLayerId, { name: editingName.trim() });
    }
    setEditingLayerId(null);
    setEditingName('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleFinishRename();
    } else if (e.key === 'Escape') {
      setEditingLayerId(null);
      setEditingName('');
    }
  };

  useEffect(() => {
    if (editingLayerId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingLayerId]);

  const handleToggleVisibility = (layer: Layer, e: React.MouseEvent) => {
    e.stopPropagation();
    updateLayer(layer.id, { visible: !layer.visible });
  };

  const handleToggleLock = (layer: Layer, e: React.MouseEvent) => {
    e.stopPropagation();
    updateLayer(layer.id, { locked: !layer.locked });
  };

  const handleDelete = (layerId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeLayer(layerId);
  };

  const handleDuplicate = (layerId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    duplicateLayer(layerId);
  };

  // Photoshop-style layer-mask actions (the mask UI lives on each layer row).
  const handleAddMask = async (layer: Layer, e: React.MouseEvent) => {
    e.stopPropagation();
    if (layer.mask?.data) return;
    const data = await buildMaskData(layer, activeSelection, true);
    updateLayer(layer.id, {
      mask: {
        id: `mask-${Date.now()}`, type: 'pixel', enabled: true, linked: true,
        density: 100, feather: 0, invert: false, data,
        vectorPath: activeSelection ? [...activeSelection.path] : null,
      },
    });
    if (activeSelection) clearSelection();
  };

  // Click the mask thumbnail to TARGET it (brush/eraser then paint on the mask
  // — black hides, white reveals). Shift-click toggles the mask on/off.
  const handleSelectMask = (layer: Layer, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!layer.mask) return;
    if (e.shiftKey) {
      updateLayer(layer.id, { mask: { ...layer.mask, enabled: !layer.mask.enabled } });
      return;
    }
    selectLayer(layer.id);
    setMaskEditLayerId(layer.id);
  };

  // Click the layer thumbnail to edit its PIXELS (not the mask).
  const handleSelectPixels = (layer: Layer, e: React.MouseEvent) => {
    e.stopPropagation();
    selectLayer(layer.id);
    setMaskEditLayerId(null);
  };

  // Drag-to-reorder, including moving a layer INTO or OUT OF a group. The drop
  // lands relative to `targetId`, so the source joins whatever container the
  // target lives in (root or a group). Children are stored group-local, so when
  // a layer changes container we re-base its transform to keep it visually put.
  const handleReorderDrop = (targetId: string) => {
    const sourceId = dragIdRef.current;
    const di = dropInfo;
    dragIdRef.current = null;
    setDragId(null);
    setDropInfo(null);
    if (!sourceId || sourceId === targetId || !project || !artboard) return;

    const layers = project.layers;
    const groupOf = (id: string) =>
      Object.values(layers).find(
        (l): l is GroupLayer => l.type === 'group' && (l as GroupLayer).childIds.includes(id),
      );
    const srcContainerId = groupOf(sourceId)?.id ?? null; // null = root
    const tgtContainerId = groupOf(targetId)?.id ?? null;
    const pos = di?.pos ?? 'before';

    // Never drop a group into itself or one of its own descendants.
    let anc: string | null = tgtContainerId;
    for (let guard = 0; anc && guard < 100; guard++) {
      if (anc === sourceId) return;
      anc = layers[anc]?.parentId ?? null;
    }

    const containerArr = (cid: string | null) =>
      cid ? [...(layers[cid] as GroupLayer).childIds] : [...artboard.layerIds];
    const setContainer = (cid: string | null, arr: string[]) =>
      cid ? updateLayer(cid, { childIds: arr }) : reorderLayers(arr);

    // Same container → plain reorder.
    if (srcContainerId === tgtContainerId) {
      const a = containerArr(srcContainerId).filter((x) => x !== sourceId);
      const ti = a.indexOf(targetId);
      if (ti < 0) return;
      a.splice(pos === 'before' ? ti : ti + 1, 0, sourceId);
      setContainer(srcContainerId, a);
      return;
    }

    // Cross container → remove from source, insert into target.
    const newSrc = containerArr(srcContainerId).filter((x) => x !== sourceId);
    const tgtArr = containerArr(tgtContainerId).filter((x) => x !== sourceId);
    const ti = tgtArr.indexOf(targetId);
    if (ti < 0) return;
    tgtArr.splice(pos === 'before' ? ti : ti + 1, 0, sourceId);

    // Absolute origin of a container (sum of group offsets up the parent chain).
    const absOffset = (cid: string | null) => {
      let ox = 0, oy = 0, id: string | null = cid;
      for (let guard = 0; id && guard < 100; guard++) {
        const g = layers[id];
        if (!g) break;
        ox += g.transform.x; oy += g.transform.y;
        id = g.parentId ?? null;
      }
      return { x: ox, y: oy };
    };
    const srcOff = absOffset(srcContainerId);
    const tgtOff = absOffset(tgtContainerId);
    const src = layers[sourceId];

    setContainer(srcContainerId, newSrc);
    setContainer(tgtContainerId, tgtArr);
    updateLayer(sourceId, {
      parentId: tgtContainerId,
      transform: {
        ...src.transform,
        x: src.transform.x + srcOff.x - tgtOff.x,
        y: src.transform.y + srcOff.y - tgtOff.y,
      },
    });
  };

  const handleMergeDown = (layerId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    void mergeDown(layerId);
  };

  const imageThumb = (layer: Layer): string | null => {
    if (layer.type !== 'image') return null;
    const asset = project?.assets[(layer as ImageLayer).sourceId];
    return asset?.thumbnailUrl ?? asset?.dataUrl ?? null;
  };

  const canMergeDown = (layerId: string): boolean => {
    const i = allLayers.findIndex((l) => l.id === layerId);
    return i >= 0 && i < allLayers.length - 1;
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-xs font-medium text-foreground">Layers</h3>
        <span className="text-[10px] text-muted-foreground">
          {layers.length}/{allLayers.length}
        </span>
      </div>

      <div className="px-2 py-2 border-b border-border space-y-2">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search layers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-7 pr-7 py-1.5 text-[11px] bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="flex gap-1">
          <button
            onClick={() => setFilterType('all')}
            className={`flex-1 px-1.5 py-1 text-[10px] rounded transition-colors ${
              filterType === 'all' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'
            }`}
          >
            All
          </button>
          {(['image', 'text', 'shape', 'group', 'smart-object'] as LayerType[]).map((type) => (
            <button
              key={type}
              onClick={() => setFilterType(filterType === type ? 'all' : type)}
              onDoubleClick={() => handleSelectAllByType(type)}
              aria-label={`Filter ${type} layers`}
              className={`p-1.5 rounded transition-colors ${
                filterType === type ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'
              }`}
              title={`Filter ${type}s (double-click to select all)`}
            >
              {LAYER_TYPE_ICONS[type]}
            </button>
          ))}
        </div>
      </div>

      {/* Photoshop-style blend mode + opacity for the active layer (reuses the
          same updateLayer/updateLayerTransform the inspector uses). */}
      {selectedLayerIds.length === 1 && project?.layers[selectedLayerIds[0]] && !maskEditLayerId && (() => {
        const sl = project.layers[selectedLayerIds[0]];
        const opacityPct = Math.round((sl.transform.opacity ?? 1) * 100);
        const BLEND_MODES = ['normal', 'darken', 'multiply', 'color-burn', 'lighten', 'screen', 'color-dodge', 'overlay', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
        return (
          <div className="px-2 py-2 border-b border-border space-y-2">
            <select
              value={sl.blendMode?.mode ?? 'normal'}
              onChange={(e) => updateLayer(sl.id, { blendMode: { mode: e.target.value as Layer['blendMode']['mode'] } })}
              className="w-full px-2 py-1 text-[11px] bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary capitalize"
              title="Blend mode"
            >
              {BLEND_MODES.map((m) => <option key={m} value={m}>{m.replace(/-/g, ' ')}</option>)}
            </select>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-12 shrink-0">Opacity</span>
              <input
                type="range" min={0} max={100} value={opacityPct}
                onChange={(e) => updateLayerTransform(sl.id, { opacity: Number(e.target.value) / 100 })}
                className="flex-1 h-1.5 appearance-none bg-secondary rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
              />
              <span className="text-[10px] font-mono text-muted-foreground w-8 text-right">{opacityPct}%</span>
            </div>
          </div>
        );
      })()}

      {/* Mask-edit hint + mask-only actions (disable / delete) — these act on the
          MASK, not the layer, so the layer's own opacity/delete stay separate. */}
      {maskEditLayerId && project?.layers[maskEditLayerId]?.mask && (() => {
        const maskLayer = project.layers[maskEditLayerId];
        const mask = maskLayer.mask!;
        return (
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] bg-primary/10 border-b border-primary/30 text-foreground">
            <span className="flex-1 min-w-0 truncate">Editing <b>mask</b> — black hides, white reveals.</span>
            <button
              onClick={() => updateLayer(maskEditLayerId, { mask: { ...mask, enabled: !mask.enabled } })}
              className="shrink-0 px-1.5 py-0.5 rounded bg-secondary hover:bg-accent text-secondary-foreground"
              title={mask.enabled ? 'Disable this mask (keep it)' : 'Enable this mask'}
            >
              {mask.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => { updateLayer(maskEditLayerId, { mask: null }); setMaskEditLayerId(null); }}
              className="shrink-0 px-1.5 py-0.5 rounded bg-secondary hover:bg-destructive/20 hover:text-destructive text-secondary-foreground"
              title="Delete this mask only (keeps the layer)"
            >
              Delete
            </button>
            <button
              onClick={() => setMaskEditLayerId(null)}
              className="shrink-0 px-1.5 py-0.5 rounded bg-secondary hover:bg-accent text-secondary-foreground"
              title="Switch back to editing the layer's pixels"
            >
              Edit pixels
            </button>
          </div>
        );
      })()}

      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-4">
            <p className="text-xs text-muted-foreground">No layers yet</p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Add text, shapes, or images
            </p>
          </div>
        ) : (
          <div className="py-1">
            {entries.map(({ layer, depth }) => {
              const isSelected = selectedLayerIds.includes(layer.id);
              const isGroup = layer.type === 'group';

              return (
                <ContextMenu key={layer.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      onClick={() => { selectLayer(layer.id); setMaskEditLayerId(null); }}
                      draggable={editingLayerId !== layer.id}
                      onDragStart={(e) => { dragIdRef.current = layer.id; setDragId(layer.id); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={(e) => {
                        const src = dragIdRef.current;
                        if (!src || src === layer.id) return;
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        setDropInfo({ id: layer.id, pos: e.clientY - r.top < r.height / 2 ? 'before' : 'after' });
                      }}
                      onDrop={(e) => { e.preventDefault(); handleReorderDrop(layer.id); }}
                      onDragEnd={() => { dragIdRef.current = null; setDragId(null); setDropInfo(null); }}
                      style={{ paddingLeft: 12 + depth * 14 }}
                      className={`group flex items-center gap-2 pr-3 py-2 cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-primary/20 border-l-2 border-primary'
                          : 'hover:bg-accent border-l-2 border-transparent'
                      } ${dragId === layer.id ? 'opacity-40' : ''} ${
                        dropInfo?.id === layer.id ? (dropInfo.pos === 'before' ? 'border-t-2 border-t-primary' : 'border-b-2 border-b-primary') : ''
                      }`}
                    >
                      {/* Expand/collapse chevron for groups (nested rendering). */}
                      {isGroup ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); updateLayer(layer.id, { expanded: !(layer as GroupLayer).expanded }); }}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          title={(layer as GroupLayer).expanded ? 'Collapse group' : 'Expand group'}
                        >
                          {(layer as GroupLayer).expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      ) : (
                        <span className="shrink-0 w-[13px]" />
                      )}

                      {/* Layer thumbnail + (optional) mask thumbnail — Photoshop style.
                          The active edit target (pixels vs mask) gets a primary ring. */}
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={(e) => handleSelectPixels(layer, e)}
                          className={`w-8 h-8 rounded border bg-muted overflow-hidden flex items-center justify-center text-muted-foreground ${
                            isSelected && maskEditLayerId !== layer.id ? 'ring-2 ring-primary border-primary' : 'border-border'
                          }`}
                          title="Edit layer pixels"
                        >
                          {imageThumb(layer) ? (
                            <img src={imageThumb(layer)!} alt="" className="w-full h-full object-cover" />
                          ) : (
                            LAYER_TYPE_ICONS[layer.type]
                          )}
                        </button>
                        {layer.mask?.data && (
                          <button
                            onClick={(e) => handleSelectMask(layer, e)}
                            className={`w-8 h-8 rounded border-2 overflow-hidden shrink-0 ${
                              maskEditLayerId === layer.id ? 'ring-2 ring-primary border-primary' : 'border-white/70'
                            }`}
                            title="Layer mask — click to paint on it (black hides, white reveals). Shift-click to toggle."
                          >
                            <img src={layer.mask.data} alt="" className={`w-full h-full object-cover ${layer.mask.enabled ? '' : 'opacity-30'}`} />
                          </button>
                        )}
                      </div>

                      {/* Clipped-to-layer-below indicator (Photoshop shows a down arrow). */}
                      {layer.clippingMask && (
                        <CornerDownRight size={12} className="shrink-0 text-muted-foreground" aria-label="Clipped to layer below" />
                      )}

                      {editingLayerId === layer.id ? (
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onBlur={handleFinishRename}
                          onKeyDown={handleRenameKeyDown}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 text-xs bg-background border border-primary rounded px-1 py-0.5 focus:outline-none"
                        />
                      ) : (
                        <span
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            handleStartRename(layer);
                          }}
                          className={`flex-1 text-xs truncate ${
                            layer.visible ? 'text-foreground' : 'text-muted-foreground'
                          } ${layer.locked ? 'italic' : ''}`}
                          title="Double-click to rename"
                        >
                          {layer.name}
                        </span>
                      )}

                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => handleToggleVisibility(layer, e)}
                          className="p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground"
                          title={layer.visible ? 'Hide' : 'Show'}
                        >
                          {layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                        </button>

                        <button
                          onClick={(e) => handleToggleLock(layer, e)}
                          className="p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground"
                          title={layer.locked ? 'Unlock' : 'Lock'}
                        >
                          {layer.locked ? <Lock size={12} /> : <Unlock size={12} />}
                        </button>

                        <button
                          onClick={(e) => handleDuplicate(layer.id, e)}
                          className="p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground"
                          title="Duplicate"
                        >
                          <Copy size={12} />
                        </button>

                        <button
                          onClick={(e) => handleDelete(layer.id, e)}
                          className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onClick={() => { selectLayer(layer.id); copyLayers(); }}>
                      <ClipboardCopy size={14} className="mr-2" />
                      Copy
                      <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => { selectLayer(layer.id); cutLayers(); }}>
                      <Scissors size={14} className="mr-2" />
                      Cut
                      <ContextMenuShortcut>⌘X</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={pasteLayers}>
                      <Clipboard size={14} className="mr-2" />
                      Paste
                      <ContextMenuShortcut>⌘V</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => duplicateLayer(layer.id)}>
                      <Copy size={14} className="mr-2" />
                      Duplicate
                      <ContextMenuShortcut>⌘D</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {selectedLayerIds.length > 1 && (
                      <ContextMenuItem onClick={() => groupLayers(selectedLayerIds)}>
                        <FolderPlus size={14} className="mr-2" />
                        Group Selection
                        <ContextMenuShortcut>⌘G</ContextMenuShortcut>
                      </ContextMenuItem>
                    )}
                    {layer.type === 'group' && (
                      <ContextMenuItem onClick={() => ungroupLayers(layer.id)}>
                        <FolderOpen size={14} className="mr-2" />
                        Ungroup
                        <ContextMenuShortcut>⌘⇧G</ContextMenuShortcut>
                      </ContextMenuItem>
                    )}
                    {(selectedLayerIds.length > 1 || layer.type === 'group') && <ContextMenuSeparator />}
                    {(layer.type === 'image' || layer.type === 'group') && !layer.mask?.data && (
                      <ContextMenuItem onClick={(e) => handleAddMask(layer, e as unknown as React.MouseEvent)}>
                        <SquareStack size={14} className="mr-2" />
                        Add Layer Mask
                      </ContextMenuItem>
                    )}
                    {(() => {
                      const topIdx = artboard?.layerIds.indexOf(layer.id) ?? -1;
                      const canClip = topIdx >= 0 && topIdx < (artboard?.layerIds.length ?? 0) - 1;
                      if (!canClip && !layer.clippingMask) return null;
                      return (
                        <ContextMenuItem onClick={() => updateLayer(layer.id, { clippingMask: !layer.clippingMask })}>
                          <CornerDownRight size={14} className="mr-2" />
                          {layer.clippingMask ? 'Release Clipping Mask' : 'Create Clipping Mask'}
                          <ContextMenuShortcut>⌘⌥G</ContextMenuShortcut>
                        </ContextMenuItem>
                      );
                    })()}
                    {canMergeDown(layer.id) && (
                      <ContextMenuItem onClick={() => handleMergeDown(layer.id)}>
                        <ChevronsDown size={14} className="mr-2" />
                        Merge Down
                        <ContextMenuShortcut>⌘E</ContextMenuShortcut>
                      </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => { selectLayer(layer.id); copyLayerStyle(); }}>
                      <Paintbrush size={14} className="mr-2" />
                      Copy Style
                    </ContextMenuItem>
                    <ContextMenuItem onClick={pasteLayerStyle} disabled={!copiedStyle}>
                      <Paintbrush size={14} className="mr-2" />
                      Paste Style
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => moveLayerToTop(layer.id)}>
                      <ArrowUpToLine size={14} className="mr-2" />
                      Bring to Front
                      <ContextMenuShortcut>⌘⇧]</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => moveLayerUp(layer.id)}>
                      <ArrowUp size={14} className="mr-2" />
                      Bring Forward
                      <ContextMenuShortcut>⌘]</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => moveLayerDown(layer.id)}>
                      <ArrowDown size={14} className="mr-2" />
                      Send Backward
                      <ContextMenuShortcut>⌘[</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => moveLayerToBottom(layer.id)}>
                      <ArrowDownToLine size={14} className="mr-2" />
                      Send to Back
                      <ContextMenuShortcut>⌘⇧[</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuCheckboxItem
                      checked={layer.visible}
                      onCheckedChange={() => updateLayer(layer.id, { visible: !layer.visible })}
                    >
                      {layer.visible ? <Eye size={14} className="mr-2" /> : <EyeOff size={14} className="mr-2" />}
                      Visible
                    </ContextMenuCheckboxItem>
                    <ContextMenuCheckboxItem
                      checked={layer.locked}
                      onCheckedChange={() => updateLayer(layer.id, { locked: !layer.locked })}
                    >
                      {layer.locked ? <Lock size={14} className="mr-2" /> : <Unlock size={14} className="mr-2" />}
                      Locked
                    </ContextMenuCheckboxItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => removeLayer(layer.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 size={14} className="mr-2" />
                      Delete
                      <ContextMenuShortcut>⌫</ContextMenuShortcut>
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        )}
      </div>

      {selectedLayerIds.length > 1 && (
        <div className="p-2 border-t border-border">
          <button
            onClick={() => groupLayers(selectedLayerIds)}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            <FolderPlus size={14} />
            Group {selectedLayerIds.length} Layers
          </button>
        </div>
      )}

      {selectedLayerIds.length === 1 && (
        <div className="p-2 border-t border-border space-y-2">
          {project?.layers[selectedLayerIds[0]]?.type === 'group' && (
            <button
              onClick={() => ungroupLayers(selectedLayerIds[0])}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors mb-2"
            >
              <FolderOpen size={14} />
              Ungroup
            </button>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-12">Opacity</span>
            <Slider
              value={[project?.layers[selectedLayerIds[0]]?.transform.opacity ?? 1]}
              onValueChange={([opacity]) => updateLayerTransform(selectedLayerIds[0], { opacity })}
              min={0}
              max={1}
              step={0.01}
              className="flex-1"
            />
            <span className="text-[10px] text-muted-foreground w-8 text-right">
              {Math.round((project?.layers[selectedLayerIds[0]]?.transform.opacity ?? 1) * 100)}%
            </span>
          </div>
          <div className="flex items-center justify-center gap-1">
            <button
              onClick={() => moveLayerUp(selectedLayerIds[0])}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              title="Move up (Cmd+])"
            >
              <ChevronUp size={14} />
            </button>
            <button
              onClick={() => moveLayerDown(selectedLayerIds[0])}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              title="Move down (Cmd+[)"
            >
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Photoshop-style bottom toolbar (acts on the active layer). */}
      <div className="flex items-center justify-center gap-2 px-2 py-2 border-t border-border">
        <button
          onClick={(e) => { const l = project?.layers[selectedLayerIds[0]]; if (l) void handleAddMask(l, e); }}
          disabled={!selectedLayerIds.length || !['image', 'group'].includes(project?.layers[selectedLayerIds[0]]?.type ?? '') || !!project?.layers[selectedLayerIds[0]]?.mask?.data}
          className={`p-1.5 rounded hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent ${
            activeSelection && !project?.layers[selectedLayerIds[0]]?.mask?.data ? 'ring-2 ring-primary animate-pulse' : ''
          }`}
          title={activeSelection ? 'Add mask from selection' : 'Add layer mask (reveal all)'}
        >
          <span className="block w-4 h-4 rounded-sm bg-gradient-to-br from-white to-black border border-border" />
        </button>
        <button
          onClick={() => { if (selectedLayerIds.length > 0) groupLayers(selectedLayerIds); }}
          disabled={selectedLayerIds.length === 0}
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          title="Group selection (Cmd+G)"
        >
          <FolderPlus size={15} />
        </button>
        <button
          onClick={() => selectedLayerIds[0] && handleMergeDown(selectedLayerIds[0])}
          disabled={!selectedLayerIds.length || !canMergeDown(selectedLayerIds[0])}
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          title="Merge down (Cmd+E)"
        >
          <ChevronsDown size={15} />
        </button>
        <button
          onClick={() => selectedLayerIds[0] && duplicateLayer(selectedLayerIds[0])}
          disabled={!selectedLayerIds.length}
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          title="Duplicate layer"
        >
          <Copy size={15} />
        </button>
        <button
          onClick={() => selectedLayerIds.forEach((id) => removeLayer(id))}
          disabled={!selectedLayerIds.length}
          className="p-1.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:hover:bg-transparent"
          title="Delete layer"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
