import { useState, useEffect, useRef, memo } from 'react';
import {
  Layers,
  Image,
  Type,
  Shapes,
  LayoutTemplate,
  Upload,
  RefreshCw,
  Search,
  Plus,
  Folder,
  Sparkles,
  Star,
  Heart,
  Zap,
  Cloud,
  Sun,
  Moon,
  Circle,
  Square,
  Triangle,
  Hexagon,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  Check,
  X,
  AlertCircle,
  Info,
  HelpCircle,
  MapPin,
  Home,
  Settings,
  User,
  Users,
  Mail,
  Phone,
  Camera,
  Music,
  Video,
  Mic,
  Bookmark,
  Flag,
  Award,
  Gift,
  Coffee,
  Loader2,
} from 'lucide-react';
import { PanelHeader } from '@openreel/ui';
import { TemplatesPanel } from './TemplatesPanel';
import { useUIStore, Panel } from '../../../stores/ui-store';
import { useProjectStore } from '../../../stores/project-store';
import { LayerPanel } from '../layers/LayerPanel';
import {
  SCOPE_LABEL, KIND_LABEL, gridColumns, setAssetFavourite, uploadToLibrary,
  loadBlockCatalogue, refreshBlockCatalogue, blockCatalogueError,
  searchBlocks, searchPlaceholder, lazyBlockPreview, ensureBlockPreviewStyles,
  type BlockInfo,
} from '@openreel/asset-browser';
import {
  fetchVoidspaceLibrary,
  libraryImageToAsset,
  withMediaToken,
  type VoidspaceLibraryItem,
} from '../../../services/voidspace-storage';


const panels: { id: Panel; icon: React.ElementType; label: string }[] = [
  { id: 'layers', icon: Layers, label: 'Layers' },
  { id: 'elements', icon: Sparkles, label: 'Elements' },
  { id: 'templates', icon: LayoutTemplate, label: 'Templates' },
  { id: 'assets', icon: Image, label: 'Assets' },
  { id: 'text', icon: Type, label: 'Text' },
  { id: 'shapes', icon: Shapes, label: 'Shapes' },
  { id: 'uploads', icon: Upload, label: 'Uploads' },
];

export const LeftPanel = memo(function LeftPanel() {
  const { activePanel, setActivePanel, togglePanelCollapsed } = useUIStore();
  const activeLabel = panels.find((p) => p.id === activePanel)?.label ?? 'Panel';

  return (
    <div className="h-full flex">
      <div className="w-14 bg-background border-r border-border flex flex-col py-2">
        {panels.map((panel) => {
          const Icon = panel.icon;
          return (
            <button
              key={panel.id}
              onClick={() => setActivePanel(panel.id)}
              className={`flex flex-col items-center justify-center py-3 transition-colors ${
                activePanel === panel.id
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
              title={panel.label}
            >
              <Icon size={20} />
              <span className="text-[10px] mt-1 font-medium">{panel.label}</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* HEADER. This column had none: the tool rail said which panel was
            selected and the body launched straight into a segmented control,
            so the column was the only one in any editor with no name on it and
            nowhere to hang the collapse control. Same 48px row, same title
            weight, same trailing collapse button as the video editor's Assets
            and Inspector headers. */}
        <PanelHeader
          title={activeLabel}
          side="left"
          collapsed={false}
          onToggle={togglePanelCollapsed}
        />
        <div className="flex-1 overflow-hidden">
          {activePanel === 'layers' && <LayerPanel />}
          {activePanel === 'elements' && <ElementsPanel />}
          {activePanel === 'templates' && <TemplatesPanel />}
          {activePanel === 'assets' && <AssetsPanel />}
          {activePanel === 'text' && <TextPanel />}
          {activePanel === 'shapes' && <ShapesPanel />}
          {activePanel === 'uploads' && <UploadsPanel />}
        </div>
      </div>
    </div>
  );
});


/**
 * `library` reads `/api/studio/library` — AI generations and renders.
 *
 * It was LABELLED "Library", which was the third name for that one source: the
 * board called it "My files" and the video editor calls it "Generated". The id
 * stays as it is (it is threaded through this component), the label comes from
 * the shared package, and all three editors now say the same word for the same
 * thing.
 */
type AssetTab = 'project' | 'library' | 'blocks';

/**
 * A BLOCK TILE — the same one the board and the video editor show.
 *
 * Zero preview images exist on disk and a block is layout, typography AND
 * MOTION, so the honest thumbnail is to run it. `lazyBlockPreview` is shared
 * (`@openreel/asset-browser`) — the sandboxed iframe, the `__hyperframes` shim
 * every block calls on its first line, and the budget that stops 124 tiles
 * running 124 live documents. Hover replays the motion.
 *
 * Clicking places it as a composition layer on the open page, which is this
 * editor's equivalent of dropping one on a timeline: the layer holds the block
 * and its slot values, and the pixels arrive when the render does.
 */
const BlockTile: React.FC<{ block: BlockInfo; onPlace: (b: BlockInfo) => void }> = ({ block: b, onPlace }) => {
  const host = useRef<HTMLDivElement | null>(null);
  const preview = useRef<ReturnType<typeof lazyBlockPreview> | null>(null);

  useEffect(() => {
    if (!host.current) return;
    ensureBlockPreviewStyles();
    const lazy = lazyBlockPreview(host.current, { priority: 'tile' });
    lazy.set(b.name);
    preview.current = lazy;
    return () => { preview.current = null; lazy.destroy(); };
  }, [b.name]);

  const credit = b.tier === 'starter' ? 'Voidspace' : b.credit;
  const detail = [
    b.category,
    b.slots.length ? `${b.slots.length} slot${b.slots.length === 1 ? '' : 's'}` : 'no slots',
    b.fill === 'adapt' ? 'needs adapting' : '',
    b.overlay ? 'overlay' : '',
    ...b.tags.slice(0, 3),
  ].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      onClick={() => onPlace(b)}
      onPointerEnter={() => preview.current?.setLoop(true)}
      onPointerLeave={() => preview.current?.setLoop(false)}
      title={`${b.name}${b.description ? ` — ${b.description}` : ''} — click to place on this page`}
      className="group flex flex-col rounded-lg border border-border bg-secondary overflow-hidden
                 hover:border-primary/50 transition-colors text-left"
    >
      <div
        ref={host}
        data-block-preview
        className="relative w-full aspect-video bg-black/40 overflow-hidden
                   flex items-center justify-center text-muted-foreground/40 text-lg"
      >
        ◫
      </div>
      <div className="px-2 py-1.5 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] font-medium text-foreground truncate">{b.name}</span>
          {b.tier !== 'starter' && (
            <span className="shrink-0 px-1 py-px rounded text-[9px] uppercase tracking-wide
                             bg-primary/15 text-primary">
              {b.tier}
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground/80 truncate">{detail}</p>
        {credit && <p className="text-[10px] text-muted-foreground/60 truncate">by {credit}</p>}
      </div>
    </button>
  );
};

function AssetsPanel() {
  const { project, addAsset, addImageLayer } = useProjectStore();
  const [tab, setTab] = useState<AssetTab>('project');
  const [searchQuery, setSearchQuery] = useState('');
  /** The block library — metadata only, held whole and searched in memory. */
  const [blocks, setBlocks] = useState<BlockInfo[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const assets = project ? Object.values(project.assets) : [];

  // Shared Voidspace Library (same store video generations use). Loaded lazily
  // when the Library tab is opened, so signed-out users never see an error.
  const [libItems, setLibItems] = useState<VoidspaceLibraryItem[]>([]);
  const [libToken, setLibToken] = useState<string | null>(null);
  const [libLoading, setLibLoading] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [debounced, setDebounced] = useState('');
  const [uploading, setUploading] = useState(false);
  /** Starred ids, optimistic. Reverted if the write is refused, so a tick never
   *  claims something the server did not record. */
  const [starred, setStarred] = useState<Record<string, boolean>>({});
  const toggleStar = async (id: string) => {
    const next = !starred[id];
    setStarred((m) => ({ ...m, [id]: next }));
    const ok = await setAssetFavourite({ getIdToken: async () => libToken }, id, next);
    if (!ok) setStarred((m) => ({ ...m, [id]: !next }));
  };
  /** Bumping this re-runs the library effect — the seam a manual Refresh and a
   *  finished upload both need, so neither has to duplicate the fetch. */
  const [libRev, setLibRev] = useState(0);
  const reloadLibrary = async () => { setLibRev((n) => n + 1); };

  /**
   * Add files to the library, through the SHARED uploader.
   *
   * Same endpoint, dedupe and ownership rule as the video editor's Add and the
   * board's — one ingest path means a file added here is the same asset
   * everywhere, not a second copy under a different owner.
   */
  const pickAndUpload = () => {
    if (uploading) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*';
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      setUploading(true);
      try {
        const { ok, failed } = await uploadToLibrary(
          { getIdToken: async () => libToken },
          files,
        );
        if (failed.length) console.warn('[assets] upload failed for:', failed.join(', '));
        // Land the user where the file went: telling someone it worked while
        // they look at an unchanged grid is not telling them it worked.
        if (ok) { setTab('library'); await reloadLibrary(); }
      } finally {
        setUploading(false);
      }
    };
    input.click();
  };

  useEffect(() => {
    const t = setTimeout(() => setDebounced(searchQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    if (tab !== 'library') return;
    let cancelled = false;
    setLibLoading(true);
    setLibError(null);
    fetchVoidspaceLibrary({ type: 'image', q: debounced })
      .then((r) => {
        if (cancelled) return;
        setLibItems(r.items);
        setLibToken(r.token);
        if (!r.token) setLibError('Sign in on Voidspace to see your image library.');
      })
      .catch((e) => { if (!cancelled) setLibError(e?.message ?? 'Failed to load library'); })
      .finally(() => { if (!cancelled) setLibLoading(false); });
    return () => { cancelled = true; };
  }, [tab, debounced, libRev]);

  // Hide legacy per-stroke intermediates ("*-edited", "filled-*") that the old
  // flatten path used to spawn — Phase 2 edits in place, so these are just junk.
  const isJunkAsset = (name: string) => /-edited$/i.test(name) || /^filled-/i.test(name);
  const visibleAssets = assets.filter((a) => !isJunkAsset(a.name));
  const filteredAssets = searchQuery
    ? visibleAssets.filter((a) => a.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : visibleAssets;

  /**
   * Fetch the block library the first time the tab is opened — not on mount,
   * because most sessions never open it and the request reaches the user's
   * machine.
   */
  useEffect(() => {
    if (tab !== 'blocks' || blocks.length || blocksLoading) return;
    setBlocksLoading(true);
    void loadBlockCatalogue()
      .then(setBlocks)
      .finally(() => setBlocksLoading(false));
  }, [tab, blocks.length, blocksLoading]);

  /**
   * Place a block as a composition layer on the open page.
   *
   * The same shape `img_place_composition` writes, because it is the same
   * thing: the layer carries the block and its (empty, for now) slots, and its
   * pixels come from a render that happens after. `fillMode: 'preview'` so an
   * unfilled block shows the designer's own content rather than an empty
   * rectangle — the user picked it for how it looks, and fills it in next.
   */
  const handlePlaceBlock = (b: BlockInfo) => {
    const layerId = addImageLayer('');
    if (!layerId) return;
    useProjectStore.getState().updateLayer(layerId, {
      name: b.name,
      composition: {
        block: b.name,
        tier: b.tier,
        slots: {},
        fillMode: 'preview',
        poseTime: 'end',
        renderHash: '',
      },
    } as never);
  };

  /** The Blocks tab's grid, searched by the same box as the other tabs. */
  const renderBlocks = () => {
    const shown = searchBlocks(blocks, searchQuery);
    if (blocksLoading && !blocks.length) {
      return (
        <div className="flex items-center justify-center py-10 text-muted-foreground gap-2 text-xs">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading your block library…
        </div>
      );
    }
    if (!blocks.length) {
      return (
        <div className="text-center py-10 text-muted-foreground">
          <p className="text-sm">No blocks available</p>
          <p className="text-[11px] mt-1 leading-relaxed px-4">
            {blockCatalogueError() || 'Blocks are designs you can place straight onto a page.'}
          </p>
          <button
            type="button"
            onClick={() => {
              setBlocksLoading(true);
              void refreshBlockCatalogue().then(setBlocks).finally(() => setBlocksLoading(false));
            }}
            className="mt-3 px-3 py-1.5 text-[11px] rounded-md border border-input
                       text-muted-foreground hover:text-foreground transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    if (!shown.length) {
      return (
        <p className="text-center py-10 text-xs text-muted-foreground">
          No blocks match “{searchQuery}”.
        </p>
      );
    }
    return (
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${gridColumns('grid')}, minmax(0, 1fr))` }}>
        {shown.map((b) => <BlockTile key={b.name} block={b} onPlace={handlePlaceBlock} />)}
      </div>
    );
  };

  const handleAddProjectAsset = (assetId: string) => addImageLayer(assetId);

  const handleAddLibraryImage = async (item: VoidspaceLibraryItem) => {
    if (addingId) return;
    setAddingId(item.id);
    try {
      const asset = await libraryImageToAsset(item, libToken);
      addAsset(asset);        // also lands in project.assets for reuse
      addImageLayer(asset.id); // place on the canvas
    } catch (e) {
      console.warn('[assets] add library image failed:', e);
    } finally {
      setAddingId(null);
    }
  };

  return (
    <div className="p-3 h-full overflow-y-auto flex flex-col">
      {/* Project / Library toggle */}
      {/* Scope segmented control — the SAME shape the video editor's Library
          uses: a tinted track with the active segment lifted in the accent at
          low opacity, not a solid primary fill. A solid fill reads as a
          committed action (a button you pressed) rather than as "you are
          looking at this one of four". */}
      <div className="flex gap-0.5 mb-3 p-0.5 bg-secondary rounded-lg">
        {(['project', 'library', 'blocks'] as AssetTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
              tab === t ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'project' ? SCOPE_LABEL.project
              : t === 'library' ? SCOPE_LABEL.generated
              /* The same word the board and the video editor use for the same
                 library — one vocabulary across the editors. */
              : KIND_LABEL.block}
          </button>
        ))}
      </div>

      {/* Add — the same ingest the video editor and the board use, so a file
          added from any surface lands in one library with one dedupe rule. */}
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={pickAndUpload}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-input bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-60"
          title="Add a file to your library"
        >
          <Upload size={13} />
          {uploading ? 'Adding…' : 'Add'}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => { void reloadLibrary(); }}
          className="h-8 w-8 grid place-items-center rounded-lg border border-input bg-secondary text-muted-foreground hover:text-foreground"
          title="Refresh library"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="mb-3">
        <div className="relative">
          {/* Matches the video editor's search box exactly: 36px tall, 12px
              text, tertiary fill, 6px radius, 36px left inset for the icon. */}
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder={
              tab === 'blocks'
                /* The same sentence the board and the video editor show, so the
                   box promises the same thing everywhere. */
                ? searchPlaceholder('mine', { kind: 'block' })
                : tab === 'library' ? 'Search your images…' : 'Search assets...'
            }
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-9 pl-9 pr-3 text-xs bg-secondary border border-input rounded-md focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      {tab === 'blocks' ? (
        renderBlocks()
      ) : tab === 'project' ? (
        visibleAssets.length === 0 ? (
          <div className="text-center py-8">
            <Folder size={32} className="mx-auto text-muted-foreground mb-2" />
            <p className="text-xs text-muted-foreground">No assets in this project</p>
            <p className="text-xs text-muted-foreground mt-1">Upload images, or pull from your Library</p>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="text-center py-8">
            <Search size={32} className="mx-auto text-muted-foreground mb-2" />
            <p className="text-xs text-muted-foreground">No matching assets</p>
          </div>
        ) : (
          <div className="grid gap-1.5" style={{ gridTemplateColumns: gridColumns('grid') }}>
            {filteredAssets.map((asset) => (
              <button
                key={asset.id}
                onClick={() => handleAddProjectAsset(asset.id)}
                className="group relative aspect-square rounded-lg bg-muted overflow-hidden hover:ring-2 hover:ring-primary transition-all"
                title={`Add "${asset.name}" to canvas`}
              >
                <img src={asset.thumbnailUrl} alt={asset.name} className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                  <Plus size={24} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/60 to-transparent">
                  <p className="text-[9px] text-white truncate">{asset.name}</p>
                </div>
              </button>
            ))}
          </div>
        )
      ) : libLoading && libItems.length === 0 ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground gap-2 text-xs">
          <Loader2 size={16} className="animate-spin" /> Loading your library…
        </div>
      ) : libError ? (
        <div className="text-center py-8">
          <Folder size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-xs text-muted-foreground px-3">{libError}</p>
        </div>
      ) : libItems.length === 0 ? (
        <div className="text-center py-8">
          <Folder size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-xs text-muted-foreground">No images in your library yet</p>
          <p className="text-xs text-muted-foreground mt-1">Generated &amp; saved images show up here</p>
        </div>
      ) : (
        <div className="grid gap-1.5" style={{ gridTemplateColumns: gridColumns('grid') }}>
          {libItems.map((item) => (
            <div key={item.id} className="group relative aspect-square">
            {/* Star sits OUTSIDE the tile button: a button inside a button is
                invalid, and the outer click would swallow it. */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void toggleStar(item.id); }}
              className={`absolute top-1 left-1 z-10 w-6 h-6 grid place-items-center rounded-md bg-black/45 text-xs transition-colors ${
                starred[item.id] ? 'text-amber-400' : 'text-white/80 hover:text-white'
              }`}
              title={starred[item.id] ? 'Remove from Favourites' : 'Add to Favourites'}
              aria-pressed={starred[item.id] ? 'true' : 'false'}
            >
              {starred[item.id] ? '★' : '☆'}
            </button>
            <button
              onClick={() => handleAddLibraryImage(item)}
              disabled={addingId === item.id}
              className="w-full h-full relative rounded-lg bg-muted overflow-hidden hover:ring-2 hover:ring-primary transition-all disabled:opacity-60"
              title={`Add "${item.label}" to canvas`}
            >
              <img
                src={withMediaToken(item.thumbnailUrl || item.url, libToken)}
                alt={item.label}
                loading="lazy"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                {addingId === item.id ? (
                  <Loader2 size={20} className="text-white animate-spin" />
                ) : (
                  <Plus size={24} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </div>
              <div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/60 to-transparent">
                <p className="text-[9px] text-white truncate">{item.label}</p>
              </div>
            </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TextPanel() {
  const { addTextLayer } = useProjectStore();

  const textStyles = [
    { label: 'Add a heading', fontSize: 48, fontWeight: 700 },
    { label: 'Add a subheading', fontSize: 32, fontWeight: 600 },
    { label: 'Add body text', fontSize: 18, fontWeight: 400 },
    { label: 'Add a caption', fontSize: 14, fontWeight: 400 },
  ];

  return (
    <div className="p-3">
      {/* No local heading: the column's shared PanelHeader names the panel.
          Two titles stacked is what "two panels bolted together" looks like. */}
      <div className="space-y-2">
        {textStyles.map((style) => (
          <button
            key={style.label}
            onClick={() => addTextLayer(style.label)}
            className="w-full p-3 text-left rounded-lg bg-background border border-border hover:border-primary hover:bg-primary/5 transition-all"
          >
            <span
              className="block text-foreground"
              style={{ fontSize: `${Math.min(style.fontSize / 3, 16)}px`, fontWeight: style.fontWeight }}
            >
              {style.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ShapesPanel() {
  const { addShapeLayer } = useProjectStore();

  const shapes: { type: 'rectangle' | 'ellipse' | 'triangle' | 'polygon' | 'star' | 'line'; label: string }[] = [
    { type: 'rectangle', label: 'Rectangle' },
    { type: 'ellipse', label: 'Circle' },
    { type: 'triangle', label: 'Triangle' },
    { type: 'polygon', label: 'Polygon' },
    { type: 'star', label: 'Star' },
    { type: 'line', label: 'Line' },
  ];

  return (
    <div className="p-3">
      {/* No local heading: the column's shared PanelHeader names the panel.
          Two titles stacked is what "two panels bolted together" looks like. */}
      <div className="grid grid-cols-3 gap-2">
        {shapes.map((shape) => (
          <button
            key={shape.type}
            onClick={() => addShapeLayer(shape.type)}
            className="aspect-square flex flex-col items-center justify-center rounded-lg bg-background border border-border hover:border-primary hover:bg-primary/5 transition-all"
          >
            <Shapes size={24} className="text-muted-foreground mb-1" />
            <span className="text-[10px] text-muted-foreground">{shape.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const ELEMENT_CATEGORIES = [
  {
    name: 'Basic Shapes',
    items: [
      { icon: Circle, label: 'Circle', shapeType: 'ellipse' as const },
      { icon: Square, label: 'Square', shapeType: 'rectangle' as const },
      { icon: Triangle, label: 'Triangle', shapeType: 'triangle' as const },
      { icon: Hexagon, label: 'Hexagon', shapeType: 'polygon' as const },
      { icon: Star, label: 'Star', shapeType: 'star' as const },
    ],
  },
  {
    name: 'Arrows',
    items: [
      { icon: ArrowRight, label: 'Right' },
      { icon: ArrowLeft, label: 'Left' },
      { icon: ArrowUp, label: 'Up' },
      { icon: ArrowDown, label: 'Down' },
    ],
  },
  {
    name: 'Status',
    items: [
      { icon: Check, label: 'Check' },
      { icon: X, label: 'Cross' },
      { icon: AlertCircle, label: 'Alert' },
      { icon: Info, label: 'Info' },
      { icon: HelpCircle, label: 'Help' },
    ],
  },
  {
    name: 'Icons',
    items: [
      { icon: Heart, label: 'Heart' },
      { icon: Sparkles, label: 'Sparkle' },
      { icon: Zap, label: 'Zap' },
      { icon: Sun, label: 'Sun' },
      { icon: Moon, label: 'Moon' },
      { icon: Cloud, label: 'Cloud' },
      { icon: MapPin, label: 'Pin' },
      { icon: Home, label: 'Home' },
      { icon: Settings, label: 'Settings' },
      { icon: User, label: 'User' },
      { icon: Users, label: 'Users' },
      { icon: Mail, label: 'Mail' },
      { icon: Phone, label: 'Phone' },
      { icon: Camera, label: 'Camera' },
      { icon: Music, label: 'Music' },
      { icon: Video, label: 'Video' },
      { icon: Mic, label: 'Mic' },
      { icon: Bookmark, label: 'Bookmark' },
      { icon: Flag, label: 'Flag' },
      { icon: Award, label: 'Award' },
      { icon: Gift, label: 'Gift' },
      { icon: Coffee, label: 'Coffee' },
    ],
  },
];

function ElementsPanel() {
  const { addShapeLayer } = useProjectStore();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredCategories = ELEMENT_CATEGORIES.map((category) => ({
    ...category,
    items: category.items.filter((item) =>
      item.label.toLowerCase().includes(searchQuery.toLowerCase())
    ),
  })).filter((category) => category.items.length > 0);

  const handleAddElement = (item: typeof ELEMENT_CATEGORIES[0]['items'][0]) => {
    if ('shapeType' in item && item.shapeType) {
      addShapeLayer(item.shapeType);
    }
  };

  return (
    <div className="p-3 h-full overflow-y-auto">
      <div className="mb-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search elements..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
      </div>

      <div className="space-y-5">
        {filteredCategories.map((category) => (
          <div key={category.name}>
            <h4 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
              {category.name}
            </h4>
            <div className="grid grid-cols-4 gap-1.5">
              {category.items.map((item) => {
                const Icon = item.icon;
                const isShape = 'shapeType' in item && item.shapeType;
                return (
                  <button
                    key={item.label}
                    onClick={() => handleAddElement(item)}
                    className={`aspect-square flex flex-col items-center justify-center rounded-lg border transition-all ${
                      isShape
                        ? 'bg-background border-border hover:border-primary hover:bg-primary/5 cursor-pointer'
                        : 'bg-muted/30 border-transparent cursor-not-allowed opacity-50'
                    }`}
                    disabled={!isShape}
                    title={isShape ? `Add ${item.label}` : `${item.label} (coming soon)`}
                  >
                    <Icon size={20} className="text-muted-foreground mb-0.5" />
                    <span className="text-[9px] text-muted-foreground truncate max-w-full px-1">
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {filteredCategories.length === 0 && (
          <div className="text-center py-8">
            <Search size={32} className="mx-auto text-muted-foreground mb-2" />
            <p className="text-xs text-muted-foreground">No elements found</p>
          </div>
        )}
      </div>
    </div>
  );
}

function UploadsPanel() {
  const { project, addAsset, addImageLayer } = useProjectStore();
  const [isDragging, setIsDragging] = useState(false);
  const assets = project ? Object.values(project.assets) : [];

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/')
    );

    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new window.Image();
        img.onload = () => {
          addAsset({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: file.name,
            type: 'image',
            mimeType: file.type,
            size: file.size,
            width: img.width,
            height: img.height,
            thumbnailUrl: reader.result as string,
            dataUrl: reader.result as string,
          });
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new window.Image();
        img.onload = () => {
          addAsset({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: file.name,
            type: 'image',
            mimeType: file.type,
            size: file.size,
            width: img.width,
            height: img.height,
            thumbnailUrl: reader.result as string,
            dataUrl: reader.result as string,
          });
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });
  };

  const handleAddToCanvas = (assetId: string) => {
    addImageLayer(assetId);
  };

  return (
    <div className="p-3 h-full overflow-y-auto">
      {/* No local heading: the column's shared PanelHeader names the panel.
          Two titles stacked is what "two panels bolted together" looks like. */}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-4 text-center transition-all ${
          isDragging
            ? 'border-primary bg-primary/10'
            : 'border-border hover:border-muted-foreground'
        }`}
      >
        <Upload size={24} className="mx-auto text-muted-foreground mb-2" />
        <p className="text-xs text-foreground mb-1">
          Drag & drop or click to browse
        </p>
        <label className="inline-block px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium cursor-pointer hover:bg-primary/90 transition-colors">
          Browse Files
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileInput}
            className="hidden"
          />
        </label>
        <p className="text-[10px] text-muted-foreground mt-2">
          PNG, JPG, SVG, WebP
        </p>
      </div>

      {assets.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Your Uploads ({assets.length})
          </h4>
          <div className="grid grid-cols-3 gap-1.5">
            {assets.map((asset) => (
              <button
                key={asset.id}
                onClick={() => handleAddToCanvas(asset.id)}
                className="group relative aspect-square rounded-md bg-muted overflow-hidden hover:ring-2 hover:ring-primary transition-all"
                title={`Add "${asset.name}" to canvas`}
              >
                <img
                  src={asset.thumbnailUrl}
                  alt={asset.name}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                  <Plus
                    size={16}
                    className="text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
