import { useState, useRef, useEffect } from 'react';
import { Plus, Trash2, Copy, MoreHorizontal, ChevronUp, ChevronDown, Sparkles } from 'lucide-react';
import { useProjectStore } from '../../../stores/project-store';
import { useUIStore } from '../../../stores/ui-store';
import { exportArtboard } from '../../../services/export-service';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@openreel/ui';

export function PagesBar() {
  const {
    project,
    selectedArtboardId,
    selectArtboard,
    addArtboard,
    removeArtboard,
    updateArtboard,
  } = useProjectStore();

  const setGenerateImageOpen = useUIStore((s) => s.setGenerateImageOpen);

  const [isExpanded, setIsExpanded] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Real rendered previews per page (artboardId → dataUrl). To avoid thrashing
  // the browser's image decoder (which was starving the canvas's own image
  // loads → pages stuck on "Loading"), we regenerate ONLY the page that
  // actually changed — the currently-selected/edited one — plus any page that
  // doesn't have a thumbnail yet. Other pages don't change when you edit a
  // different page, so their thumbnails are reused untouched.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRef = useRef<Record<string, string>>({});
  thumbsRef.current = thumbs;
  const inputRef = useRef<HTMLInputElement>(null);

  const artboardIds = project?.artboards.map((a) => a.id).join(',') ?? '';
  const projectRev = project?.updatedAt ?? 0;
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const have = thumbsRef.current;
      const targets = project.artboards.filter((ab) => !have[ab.id] || ab.id === selectedArtboardId);
      for (const ab of targets) {
        try {
          const scale = Math.min(1, 160 / Math.max(ab.size.width, ab.size.height));
          const blob = await exportArtboard(project, ab, { scale, format: 'jpg', quality: 'low', background: 'include' });
          if (cancelled) return;
          const dataUrl = await new Promise<string>((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result as string);
            fr.onerror = () => resolve('');
            fr.readAsDataURL(blob);
          });
          if (cancelled || !dataUrl) continue;
          setThumbs((prev) => ({ ...prev, [ab.id]: dataUrl }));
        } catch { /* leave this page's swatch fallback */ }
      }
      // Drop thumbnails for pages that no longer exist.
      const live = new Set(project.artboards.map((a) => a.id));
      const stale = Object.keys(have).filter((id) => !live.has(id));
      if (stale.length) setThumbs((prev) => {
        const next = { ...prev };
        for (const id of stale) delete next[id];
        return next;
      });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artboardIds, projectRev, selectedArtboardId]);

  if (!project) return null;

  const artboards = project.artboards;

  const handleAddPage = () => {
    const currentArtboard = artboards.find((a) => a.id === selectedArtboardId);
    const size = currentArtboard?.size ?? { width: 1080, height: 1080 };
    const newId = addArtboard(`Page ${artboards.length + 1}`, size);
    selectArtboard(newId);
  };

  const handleDuplicatePage = (artboardId: string) => {
    const artboard = artboards.find((a) => a.id === artboardId);
    if (!artboard) return;
    const newId = addArtboard(`${artboard.name} copy`, artboard.size);
    selectArtboard(newId);
  };

  const handleDeletePage = (artboardId: string) => {
    if (artboards.length <= 1) return;
    removeArtboard(artboardId);
  };

  const handleRename = (artboardId: string, newName: string) => {
    if (newName.trim()) {
      updateArtboard(artboardId, { name: newName.trim() });
    }
    setEditingId(null);
  };

  const handleStartRename = (artboardId: string) => {
    setEditingId(artboardId);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  return (
    <div className="bg-card border-t border-border">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          <span>Pages</span>
          <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full">
            {artboards.length}
          </span>
        </button>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setGenerateImageOpen(true, true)}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded transition-colors"
            title="Generate a new page with AI"
          >
            <Sparkles size={13} />
            <span>Generate</span>
          </button>
          <button
            onClick={handleAddPage}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <Plus size={14} />
            <span>Add Page</span>
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="px-3 pb-3 overflow-x-auto">
          <div className="flex gap-2">
            {artboards.map((artboard) => {
              const isSelected = artboard.id === selectedArtboardId;
              const aspectRatio = artboard.size.width / artboard.size.height;
              const thumbHeight = 64;
              const thumbWidth = Math.min(thumbHeight * aspectRatio, 100);

              return (
                <div
                  key={artboard.id}
                  className={`group relative flex-shrink-0 rounded-lg border-2 transition-all cursor-pointer ${
                    isSelected
                      ? 'border-primary ring-2 ring-primary/20'
                      : 'border-border hover:border-muted-foreground'
                  }`}
                  onClick={() => selectArtboard(artboard.id)}
                >
                  <div
                    className="bg-muted rounded-md overflow-hidden"
                    style={{ width: thumbWidth, height: thumbHeight }}
                  >
                    {thumbs[artboard.id] ? (
                      // Real rendered preview of the page's composited content.
                      <img
                        src={thumbs[artboard.id]}
                        alt={artboard.name}
                        className="w-full h-full object-cover"
                        style={{
                          backgroundColor:
                            artboard.background.type === 'color' ? artboard.background.color : '#ffffff',
                        }}
                      />
                    ) : (
                      // Fallback swatch until the first render lands.
                      <div
                        className="w-full h-full"
                        style={{
                          backgroundColor:
                            artboard.background.type === 'color'
                              ? artboard.background.color
                              : artboard.background.type === 'transparent'
                              ? 'transparent'
                              : '#ffffff',
                          backgroundImage:
                            artboard.background.type === 'transparent'
                              ? 'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)'
                              : undefined,
                          backgroundSize: '8px 8px',
                          backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
                        }}
                      />
                    )}
                  </div>

                  <div className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="w-5 h-5 flex items-center justify-center bg-background border border-border rounded shadow-sm hover:bg-accent transition-colors"
                        >
                          <MoreHorizontal size={12} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onClick={() => handleStartRename(artboard.id)}>
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDuplicatePage(artboard.id)}>
                          <Copy size={14} className="mr-2" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDeletePage(artboard.id)}
                          disabled={artboards.length <= 1}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 size={14} className="mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="absolute -bottom-5 left-0 right-0 text-center">
                    {editingId === artboard.id ? (
                      <input
                        ref={inputRef}
                        type="text"
                        defaultValue={artboard.name}
                        onBlur={(e) => handleRename(artboard.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleRename(artboard.id, e.currentTarget.value);
                          } else if (e.key === 'Escape') {
                            setEditingId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full text-[10px] text-center bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"
                        autoFocus
                      />
                    ) : (
                      <span
                        className={`text-[10px] truncate max-w-full inline-block ${
                          isSelected ? 'text-foreground font-medium' : 'text-muted-foreground'
                        }`}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          handleStartRename(artboard.id);
                        }}
                      >
                        {artboard.name}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            <button
              onClick={handleAddPage}
              className="flex-shrink-0 w-16 h-16 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border hover:border-muted-foreground hover:bg-accent/50 transition-all"
            >
              <Plus size={20} className="text-muted-foreground" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
