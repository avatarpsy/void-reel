import { useState, useEffect, useCallback } from 'react';
import {
  ArrowRight, FolderOpen, Layout, Square, Smartphone, Image as ImageIcon, Plus,
  Presentation as PresentationIcon, Frame,
} from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useUIStore } from '../../stores/ui-store';
import { CANVAS_PRESETS, Project } from '../../types/project';
import { CosmicField } from '../CosmicField';
import { onTopLinkClick } from '../../services/navigate-top';

// Voidspace brand mark (the gradient "S"), bundled at /image/images/logo.png.
const LOGO_SRC = `${import.meta.env.BASE_URL}images/logo.png`;

type Category = 'all' | 'Social Media' | 'Presentation' | 'Print' | 'Desktop' | 'Mobile' | 'Logo';
type ViewMode = 'home' | 'formats';

/**
 * The formats on the front door.
 *
 * This offered Post, Story and Thumbnail, under a line that said the editor was
 * for "images, graphics, and thumbnails". Presentations and posters were both
 * fully supported and neither was named anywhere on this screen — reaching
 * either meant knowing to click "Browse all formats" and then to filter by a
 * category. Somebody arriving to make a deck had to already believe the image
 * editor made decks.
 *
 * Six tiles in two rows: the social three that most sessions start with, then
 * the three long-form ones. The full preset list is still one click away.
 */
interface FormatOption {
  id: string;
  label: string;
  description: string;
  width: number;
  height: number;
  dimensions: string;
  icon: React.ElementType;
  gradient: string;
}

const FORMAT_OPTIONS: FormatOption[] = [
  {
    id: 'post', label: 'Post', description: 'Instagram, Facebook',
    width: 1080, height: 1080, dimensions: '1080 × 1080',
    icon: Square, gradient: 'from-orange-500/20 to-rose-500/20',
  },
  {
    id: 'story', label: 'Story', description: 'Stories, Reels, Pinterest',
    width: 1080, height: 1920, dimensions: '1080 × 1920',
    icon: Smartphone, gradient: 'from-violet-500/20 to-fuchsia-500/20',
  },
  {
    id: 'thumbnail', label: 'Thumbnail', description: 'YouTube, blog covers',
    width: 1280, height: 720, dimensions: '1280 × 720',
    icon: ImageIcon, gradient: 'from-blue-500/20 to-cyan-500/20',
  },
  {
    id: 'presentation', label: 'Presentation', description: 'Slides for a talk',
    width: 1920, height: 1080, dimensions: '1920 × 1080',
    icon: PresentationIcon, gradient: 'from-emerald-500/20 to-teal-500/20',
  },
  {
    id: 'poster', label: 'Poster', description: 'Print, 18 × 24 at 300 DPI',
    width: 5400, height: 7200, dimensions: '5400 × 7200',
    icon: Frame, gradient: 'from-amber-500/20 to-orange-500/20',
  },
  {
    id: 'document', label: 'Document', description: 'A4, print or PDF',
    width: 2480, height: 3508, dimensions: '2480 × 3508',
    icon: Layout, gradient: 'from-slate-500/20 to-zinc-500/20',
  },
];

const categories: { id: Category; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'Social Media', label: 'Social Media' },
  { id: 'Presentation', label: 'Presentation' },
  { id: 'Print', label: 'Print' },
  { id: 'Desktop', label: 'Desktop' },
  { id: 'Mobile', label: 'Mobile' },
  { id: 'Logo', label: 'Logo' },
];

export function WelcomeScreen() {
  const [viewMode, setViewMode] = useState<ViewMode>('home');
  const [hoveredFormat, setHoveredFormat] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category>('all');
  const [showCustomSize, setShowCustomSize] = useState(false);
  const [customWidth, setCustomWidth] = useState(1920);
  const [customHeight, setCustomHeight] = useState(1080);

  const { createProject, loadProject } = useProjectStore();
  const { setCurrentView } = useUIStore();

  // Esc: from the all-formats view, back to the hero.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewMode !== 'home') setViewMode('home');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewMode]);

  const create = useCallback((name: string, width: number, height: number) => {
    createProject(name, { width, height });
    setCurrentView('editor');
  }, [createProject, setCurrentView]);

  const handleImportProject = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.orimg,application/json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const project = JSON.parse(await file.text()) as Project;
        if (project && project.id && project.artboards) {
          loadProject(project);
          setCurrentView('editor');
        }
      } catch (err) {
        console.error('Failed to load project file:', err);
      }
    };
    input.click();
  };

  const filteredPresets = selectedCategory === 'all'
    ? CANVAS_PRESETS
    : CANVAS_PRESETS.filter((p) => p.category === selectedCategory);

  // ───────────────────────── All-formats view ─────────────────────────
  if (viewMode === 'formats') {
    return (
      <div className="fixed inset-0 z-50 bg-background overflow-hidden flex flex-col">
        <CosmicField />
        <header className="relative z-10 flex items-center justify-between px-6 py-4 border-b border-border">
          <button
            onClick={() => setViewMode('home')}
            className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            <ArrowRight className="rotate-180" size={16} /> Back
          </button>
          <h2 className="text-sm font-medium text-text-primary">All formats</h2>
          <button
            onClick={() => setShowCustomSize((v) => !v)}
            className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            <Plus size={16} /> Custom size
          </button>
        </header>
        <div className="relative z-10 flex-1 overflow-y-auto p-6">
          {showCustomSize && (
            <div className="mb-6 p-5 rounded-xl bg-background-secondary border border-border max-w-xl">
              <div className="flex items-end gap-4">
                <div>
                  <label className="block text-sm text-text-muted mb-2">Width (px)</label>
                  <input type="number" value={customWidth} min={1} max={8000}
                    onChange={(e) => setCustomWidth(Number(e.target.value))}
                    className="w-32 px-3 py-2.5 rounded-lg bg-background border border-input text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
                </div>
                <span className="text-text-muted pb-2.5">×</span>
                <div>
                  <label className="block text-sm text-text-muted mb-2">Height (px)</label>
                  <input type="number" value={customHeight} min={1} max={8000}
                    onChange={(e) => setCustomHeight(Number(e.target.value))}
                    className="w-32 px-3 py-2.5 rounded-lg bg-background border border-input text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
                </div>
                <button onClick={() => create('Untitled Design', customWidth, customHeight)}
                  className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 active:scale-[0.98] transition-all">
                  Create
                </button>
              </div>
            </div>
          )}
          <div className="flex gap-2 mb-6 flex-wrap">
            {categories.map((cat) => (
              <button key={cat.id} onClick={() => setSelectedCategory(cat.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  selectedCategory === cat.id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background-secondary text-text-secondary hover:bg-background-tertiary'
                }`}>
                {cat.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredPresets.map((preset) => (
              <button key={preset.name} onClick={() => create(preset.name, preset.width, preset.height)}
                className="group flex flex-col items-center justify-center p-6 rounded-xl border border-border bg-background-secondary hover:border-primary/40 hover:bg-background-tertiary transition-all aspect-square">
                <div className="bg-background-tertiary rounded-lg mb-3 flex items-center justify-center"
                  style={{
                    width: Math.min(80, (preset.width / Math.max(preset.width, preset.height)) * 80),
                    height: Math.min(80, (preset.height / Math.max(preset.width, preset.height)) * 80),
                  }}>
                  <Layout size={20} className="text-text-muted group-hover:text-primary transition-colors" />
                </div>
                <span className="text-sm font-medium text-text-primary text-center">{preset.name}</span>
                <span className="text-xs text-text-muted mt-1">{preset.width} × {preset.height}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ───────────────────────────── Home hero ─────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-background overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.08),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,rgba(139,92,246,0.05),transparent_50%)]" />

      {/* Voidspace cosmic field — stars + crescent moons, matching the studio. */}
      <CosmicField />

      {/* Back to the Voidspace Studio projects hub, landing on the Images tab. */}
      <a href="/studio/projects?tab=images"
        onClick={onTopLinkClick('/studio/projects?tab=images')}
        className="absolute top-5 left-6 z-20 inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors">
        <ArrowRight className="rotate-180" size={14} /> My Projects
      </a>
      <button onClick={handleImportProject}
        className="absolute top-5 right-6 z-20 inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors">
        <FolderOpen size={14} /> Open Project
      </button>

      <div className="relative z-10 h-full flex flex-col items-center justify-center px-6 overflow-y-auto py-16">
        <div className="w-full max-w-3xl">
          <div className="flex flex-col items-center text-center mb-12">
            <img src={LOGO_SRC} alt="Voidspace" className="w-12 h-12 mb-6" />
            <h1 className="text-4xl sm:text-5xl font-bold text-text-primary tracking-tight mb-3">
              From idea to export.
            </h1>
            <p className="text-xl text-text-secondary mb-8">In your browser.</p>
            <p className="text-base text-text-muted max-w-md">
              Pick a format and start designing — posts, slides, posters and thumbnails.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {FORMAT_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isHovered = hoveredFormat === option.id;
              return (
                <button key={option.id}
                  onClick={() => create(option.label, option.width, option.height)}
                  onMouseEnter={() => setHoveredFormat(option.id)}
                  onMouseLeave={() => setHoveredFormat(null)}
                  className={`group relative flex flex-col items-center p-5 rounded-2xl bg-background-secondary border border-border hover:border-primary/40 hover:bg-background-tertiary transition-all duration-200 ${isHovered ? 'scale-[1.02] shadow-lg shadow-primary/5' : ''}`}>
                  <div className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${option.gradient} opacity-0 group-hover:opacity-100 transition-opacity duration-300`} />
                  <div className="relative z-10 flex flex-col items-center">
                    <div className="w-12 h-12 mb-3 rounded-xl flex items-center justify-center bg-background-tertiary group-hover:bg-primary/10 transition-colors duration-200">
                      <Icon size={22} className="text-text-muted group-hover:text-primary transition-colors" />
                    </div>
                    <h3 className="text-base font-semibold text-text-primary mb-1">{option.label}</h3>
                    <p className="text-sm text-text-muted mb-3 text-center">{option.description}</p>
                    <span className="text-xs font-mono text-text-muted/70 bg-background-tertiary px-2 py-1 rounded">
                      {option.dimensions}
                    </span>
                  </div>
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 text-sm font-medium text-primary opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-200">
                    Start creating <ArrowRight size={14} />
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-6 flex items-center justify-center gap-2">
            <button onClick={() => { setShowCustomSize(false); setViewMode('formats'); }}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-text-secondary bg-background-secondary border border-border hover:border-primary/40 hover:text-text-primary transition-all">
              <Layout size={15} /> Browse all formats
            </button>
            <button onClick={() => { setShowCustomSize(true); setViewMode('formats'); }}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-text-secondary bg-background-secondary border border-border hover:border-primary/40 hover:text-text-primary transition-all">
              <Plus size={15} /> Custom size
            </button>
          </div>
        </div>

        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <p className="text-xs text-text-muted/45">
            Voidspace Image — graphic & photo editing in your browser
          </p>
        </div>
      </div>
    </div>
  );
}

export default WelcomeScreen;
