import { useState, useEffect, useCallback } from 'react';
import {
  ArrowRight, FolderOpen, Layout, Square, Smartphone, Image as ImageIcon,
  Trash2, Clock, MoreVertical, Plus,
} from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useUIStore } from '../../stores/ui-store';
import { CANVAS_PRESETS, Project } from '../../types/project';
import { loadSavedProject, getSavedProjectIds, deleteSavedProject } from '../../hooks/useAutoSave';
import { CosmicField } from '../CosmicField';

// Voidspace brand mark (the gradient "S"), bundled at /image/images/logo.png.
const LOGO_SRC = `${import.meta.env.BASE_URL}images/logo.png`;

type Category = 'all' | 'Social Media' | 'Presentation' | 'Print' | 'Desktop' | 'Mobile' | 'Logo';
type ViewMode = 'home' | 'formats';

interface SavedProjectInfo {
  id: string;
  name: string;
  updatedAt: number;
  size: { width: number; height: number };
}

// The three primary on-ramp formats — real image use-cases (not video
// orientations). The full preset list is one click away under "Browse all".
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
  const [recentProjects, setRecentProjects] = useState<SavedProjectInfo[]>([]);
  const [projectMenuOpen, setProjectMenuOpen] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const { createProject, loadProject } = useProjectStore();
  const { setCurrentView } = useUIStore();

  useEffect(() => { loadRecentProjects(); }, []);

  useEffect(() => {
    const handleClickOutside = () => setProjectMenuOpen(null);
    if (projectMenuOpen) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [projectMenuOpen]);

  // Esc: from the all-formats view, back to the hero.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewMode !== 'home') setViewMode('home');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewMode]);

  const loadRecentProjects = async () => {
    const ids = await getSavedProjectIds();
    const projects: SavedProjectInfo[] = [];
    for (const id of ids) {
      const project = await loadSavedProject(id);
      if (project) {
        projects.push({
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt,
          size: project.artboards?.[0]?.size ?? { width: 0, height: 0 },
        });
      }
    }
    projects.sort((a, b) => b.updatedAt - a.updatedAt);
    setRecentProjects(projects);
  };

  const create = useCallback((name: string, width: number, height: number) => {
    createProject(name, { width, height });
    setCurrentView('editor');
  }, [createProject, setCurrentView]);

  const handleOpenProject = async (projectId: string) => {
    const project = await loadSavedProject(projectId);
    if (project) { loadProject(project); setCurrentView('editor'); }
  };

  const handleDeleteProject = (projectId: string) => {
    deleteSavedProject(projectId);
    setRecentProjects((prev) => prev.filter((p) => p.id !== projectId));
    setDeleteConfirmId(null);
    setProjectMenuOpen(null);
  };

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

  const formatDate = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const days = Math.floor(diff / 86_400_000);
    if (days === 0) {
      const hours = Math.floor(diff / 3_600_000);
      if (hours === 0) {
        const minutes = Math.floor(diff / 60_000);
        return minutes <= 1 ? 'Just now' : `${minutes} minutes ago`;
      }
      return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    }
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(timestamp).toLocaleDateString();
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

      {/* Back to the Voidspace Studio projects hub (where Create Image lives). */}
      <a href="/studio/projects"
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
              Pick a format and start designing — images, graphics, and thumbnails.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4">
            {FORMAT_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isHovered = hoveredFormat === option.id;
              return (
                <button key={option.id}
                  onClick={() => create(option.label, option.width, option.height)}
                  onMouseEnter={() => setHoveredFormat(option.id)}
                  onMouseLeave={() => setHoveredFormat(null)}
                  className={`group relative flex flex-col items-center p-6 rounded-2xl bg-background-secondary border border-border hover:border-primary/40 hover:bg-background-tertiary transition-all duration-200 ${isHovered ? 'scale-[1.02] shadow-lg shadow-primary/5' : ''}`}>
                  <div className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${option.gradient} opacity-0 group-hover:opacity-100 transition-opacity duration-300`} />
                  <div className="relative z-10 flex flex-col items-center">
                    <div className="w-16 h-16 mb-4 rounded-xl flex items-center justify-center bg-background-tertiary group-hover:bg-primary/10 transition-colors duration-200">
                      <Icon size={28} className="text-text-muted group-hover:text-primary transition-colors" />
                    </div>
                    <h3 className="text-lg font-semibold text-text-primary mb-1">{option.label}</h3>
                    <p className="text-sm text-text-muted mb-3">{option.description}</p>
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

          {recentProjects.length > 0 && (
            <div className="mt-12">
              <h2 className="text-sm font-medium text-text-secondary mb-4 text-center">Recent projects</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {recentProjects.slice(0, 8).map((project) => (
                  <div key={project.id}
                    className="group relative flex flex-col p-4 rounded-xl border border-border bg-background-secondary hover:border-primary/40 transition-all cursor-pointer"
                    onClick={() => handleOpenProject(project.id)}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="bg-background-tertiary rounded-lg flex items-center justify-center"
                        style={{
                          width: Math.min(48, (project.size.width / Math.max(project.size.width, project.size.height, 1)) * 48),
                          height: Math.min(48, (project.size.height / Math.max(project.size.width, project.size.height, 1)) * 48),
                        }}>
                        <Layout size={14} className="text-text-muted" />
                      </div>
                      <div className="relative">
                        <button
                          onClick={(e) => { e.stopPropagation(); setProjectMenuOpen(projectMenuOpen === project.id ? null : project.id); }}
                          className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-background-tertiary transition-all">
                          <MoreVertical size={16} className="text-text-muted" />
                        </button>
                        {projectMenuOpen === project.id && (
                          <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-border bg-popover shadow-lg py-1">
                            <button onClick={(e) => { e.stopPropagation(); handleOpenProject(project.id); }}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-background-tertiary transition-colors flex items-center gap-2">
                              <FolderOpen size={14} /> Open
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(project.id); }}
                              className="w-full px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-2">
                              <Trash2 size={14} /> Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    <h3 className="text-sm font-medium text-text-primary truncate mb-1">{project.name}</h3>
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <Clock size={12} /><span>{formatDate(project.updatedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <p className="text-xs text-text-muted/45">
            Voidspace Image — graphic & photo editing in your browser
          </p>
        </div>
      </div>

      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDeleteConfirmId(null)}>
          <div className="bg-background-secondary border border-border rounded-xl p-6 max-w-sm mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-text-primary mb-2">Delete Project?</h3>
            <p className="text-sm text-text-muted mb-6">
              This action cannot be undone. The project will be permanently deleted from your browser storage.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleteConfirmId(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-background-tertiary transition-colors">
                Cancel
              </button>
              <button onClick={() => handleDeleteProject(deleteConfirmId)}
                className="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium hover:bg-destructive/90 transition-colors">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default WelcomeScreen;
