import { useState, useEffect, memo } from 'react';
import {
  Layers,
  Image,
  Type,
  Shapes,
  Upload,
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
import { useUIStore, Panel } from '../../../stores/ui-store';
import { useProjectStore } from '../../../stores/project-store';
import { LayerPanel } from '../layers/LayerPanel';
import {
  fetchVoidspaceLibrary,
  libraryImageToAsset,
  withMediaToken,
  type VoidspaceLibraryItem,
} from '../../../services/voidspace-storage';


const panels: { id: Panel; icon: React.ElementType; label: string }[] = [
  { id: 'layers', icon: Layers, label: 'Layers' },
  { id: 'elements', icon: Sparkles, label: 'Elements' },
  { id: 'assets', icon: Image, label: 'Assets' },
  { id: 'text', icon: Type, label: 'Text' },
  { id: 'shapes', icon: Shapes, label: 'Shapes' },
  { id: 'uploads', icon: Upload, label: 'Uploads' },
];

export const LeftPanel = memo(function LeftPanel() {
  const { activePanel, setActivePanel } = useUIStore();

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

      <div className="flex-1 overflow-hidden">
        {activePanel === 'layers' && <LayerPanel />}
        {activePanel === 'elements' && <ElementsPanel />}
        {activePanel === 'assets' && <AssetsPanel />}
        {activePanel === 'text' && <TextPanel />}
        {activePanel === 'shapes' && <ShapesPanel />}
        {activePanel === 'uploads' && <UploadsPanel />}
      </div>
    </div>
  );
});


type AssetTab = 'project' | 'library';

function AssetsPanel() {
  const { project, addAsset, addImageLayer } = useProjectStore();
  const [tab, setTab] = useState<AssetTab>('project');
  const [searchQuery, setSearchQuery] = useState('');
  const assets = project ? Object.values(project.assets) : [];

  // Shared Voidspace Library (same store video generations use). Loaded lazily
  // when the Library tab is opened, so signed-out users never see an error.
  const [libItems, setLibItems] = useState<VoidspaceLibraryItem[]>([]);
  const [libToken, setLibToken] = useState<string | null>(null);
  const [libLoading, setLibLoading] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [debounced, setDebounced] = useState('');

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
  }, [tab, debounced]);

  // Hide legacy per-stroke intermediates ("*-edited", "filled-*") that the old
  // flatten path used to spawn — Phase 2 edits in place, so these are just junk.
  const isJunkAsset = (name: string) => /-edited$/i.test(name) || /^filled-/i.test(name);
  const visibleAssets = assets.filter((a) => !isJunkAsset(a.name));
  const filteredAssets = searchQuery
    ? visibleAssets.filter((a) => a.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : visibleAssets;

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
      <div className="flex gap-1 mb-3 p-0.5 bg-secondary rounded-lg">
        {(['project', 'library'] as AssetTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
              tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'project' ? 'This project' : 'Library'}
          </button>
        ))}
      </div>

      <div className="mb-3">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder={tab === 'library' ? 'Search your images…' : 'Search assets...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
      </div>

      {tab === 'project' ? (
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
          <div className="grid grid-cols-2 gap-2">
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
        <div className="grid grid-cols-2 gap-2">
          {libItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleAddLibraryImage(item)}
              disabled={addingId === item.id}
              className="group relative aspect-square rounded-lg bg-muted overflow-hidden hover:ring-2 hover:ring-primary transition-all disabled:opacity-60"
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
      <h3 className="text-sm font-medium text-foreground mb-3">Add Text</h3>
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
      <h3 className="text-sm font-medium text-foreground mb-3">Shapes</h3>
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
      <h3 className="text-sm font-medium text-foreground mb-3">Upload Files</h3>

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
